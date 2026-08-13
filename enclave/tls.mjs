// TLS that terminates *inside* the enclave.
//
// The whole confidentiality claim is that the image is seen only by measured
// code running on confidential hardware. A load balancer, an nginx front, or a
// tunnel provider would each hold the plaintext — so the enclave obtains its own
// certificate and serves HTTPS itself. The private key is generated in enclave
// memory, never written to disk, and never leaves; on restart a fresh one is
// generated and a fresh certificate issued.
//
// Env:
//   TLS_DOMAIN   hostname whose A record points at this VM. Unset ⇒ plain HTTP.
//   TLS_EMAIL    ACME account contact (optional but recommended).
//   TLS_STAGING  "true" ⇒ Let's Encrypt staging, for rehearsal without burning
//                the production rate limit (certs are untrusted by browsers).
import { X509Certificate } from "node:crypto";
import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";

const ACME_PREFIX = "/.well-known/acme-challenge/";

/** Certificates last 90 days; re-check daily so a long-lived enclave renews itself. */
const RENEW_CHECK_MS = 24 * 60 * 60 * 1000;
const RENEW_BEFORE_MS = 30 * 24 * 60 * 60 * 1000;

export function tlsConfig(env = process.env) {
  const domain = env.TLS_DOMAIN?.trim();
  return {
    enabled: Boolean(domain),
    domain: domain ?? null,
    email: env.TLS_EMAIL?.trim() || null,
    staging: env.TLS_STAGING === "true",
    httpsPort: Number(env.TLS_PORT ?? 443),
    challengePort: Number(env.ACME_PORT ?? 80),
  };
}

/**
 * Serves the HTTP-01 challenge and redirects everything else to HTTPS. Held open
 * for the enclave's lifetime so renewals do not need to re-bind port 80.
 */
function startChallengeServer({ port, domain, tokens }) {
  const server = createHttpServer((req, res) => {
    if (req.url?.startsWith(ACME_PREFIX)) {
      const token = req.url.slice(ACME_PREFIX.length);
      const value = tokens.get(token);
      if (value) {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end(value);
        return;
      }
      res.writeHead(404).end();
      return;
    }
    // Anything else on :80 is a browser that should not be sending us bytes in
    // the clear — send it to the TLS listener before it uploads anything.
    res.writeHead(308, { Location: `https://${domain}${req.url ?? "/"}` });
    res.end();
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, () => resolve(server));
  });
}

async function issueCertificate({ domain, email, staging, tokens }) {
  const acme = await import("acme-client");
  const accountKey = await acme.crypto.createPrivateKey();
  const client = new acme.Client({
    directoryUrl: staging
      ? acme.directory.letsencrypt.staging
      : acme.directory.letsencrypt.production,
    accountKey,
  });

  const [certificateKey, csr] = await acme.crypto.createCsr({ commonName: domain });
  const certificate = await client.auto({
    csr,
    email: email ?? undefined,
    termsOfServiceAgreed: true,
    challengePriority: ["http-01"],
    // The library's pre-flight fetches the challenge through the VM's own
    // public address — a hairpin GCP does not reliably support, and a silent
    // hang here kept the enclave stuck at "issuing" through two boots. Let's
    // Encrypt's validators reach the challenge from OUTSIDE, which is the only
    // path that matters; skip the self-check.
    skipChallengeVerification: true,
    challengeCreateFn: async (_authz, challenge, keyAuthorization) => {
      tokens.set(challenge.token, keyAuthorization);
    },
    challengeRemoveFn: async (_authz, challenge) => {
      tokens.delete(challenge.token);
    },
  });

  return { key: certificateKey.toString(), cert: certificate.toString() };
}

const ISSUE_ATTEMPT_TIMEOUT_MS = 3 * 60 * 1000;
const RETRY_BASE_MS = 30 * 1000;
const RETRY_CAP_MS = 10 * 60 * 1000;

function withDeadline(promise, ms, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms / 1000}s`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * Brings up HTTPS in front of `handler`, obtaining a certificate for TLS_DOMAIN.
 * Resolves to a description of what actually happened — the caller decides how
 * loudly to report it, and an enclave that cannot get a certificate keeps
 * serving plain HTTP rather than going dark.
 */
export async function startTls(handler, config = tlsConfig()) {
  if (!config.enabled) return { active: false, reason: "TLS_DOMAIN not set" };

  const tokens = new Map();
  let challengeServer;
  try {
    challengeServer = await startChallengeServer({
      port: config.challengePort,
      domain: config.domain,
      tokens,
    });
  } catch (error) {
    return { active: false, reason: `could not bind :${config.challengePort} — ${error.message}` };
  }

  // Issuance retries forever with capped backoff and a hard per-attempt
  // deadline: a hung ACME order or a transient Let's Encrypt outage must never
  // leave a booted enclave silently stuck at "issuing" — it either gets a
  // certificate or says loudly, every attempt, why it hasn't yet.
  let material = null;
  for (let attempt = 1; material === null; attempt += 1) {
    try {
      material = await withDeadline(
        issueCertificate({ ...config, tokens }),
        ISSUE_ATTEMPT_TIMEOUT_MS,
        "certificate issuance",
      );
    } catch (error) {
      const delay = Math.min(RETRY_CAP_MS, RETRY_BASE_MS * 2 ** (attempt - 1));
      console.error(
        `tls: issuance attempt ${attempt} failed — ${error.message}; retrying in ${Math.round(delay / 1000)}s`,
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  const server = createHttpsServer({ key: material.key, cert: material.cert }, handler);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.httpsPort, resolve);
  });

  scheduleRenewal({ config, tokens, server, material });

  return {
    active: true,
    url: `https://${config.domain}`,
    staging: config.staging,
    expiresAt: certificateExpiry(material.cert),
  };
}

function certificateExpiry(certPem) {
  try {
    return new X509Certificate(certPem).validTo;
  } catch {
    return null;
  }
}

/**
 * Re-issues before expiry and swaps the certificate into the running listener,
 * so a long judging window does not end with an expired cert.
 */
function scheduleRenewal({ config, tokens, server, material }) {
  let current = material;
  const timer = setInterval(async () => {
    const expiry = certificateExpiry(current.cert);
    if (expiry && new Date(expiry).getTime() - Date.now() > RENEW_BEFORE_MS) return;
    try {
      current = await issueCertificate({ ...config, tokens });
      server.setSecureContext({ key: current.key, cert: current.cert });
      console.log("tls: certificate renewed");
    } catch (error) {
      console.error(`tls: renewal failed — ${error.message}`);
    }
  }, RENEW_CHECK_MS);
  timer.unref();
}
