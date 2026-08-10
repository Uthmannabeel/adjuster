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
    challengeCreateFn: async (_authz, challenge, keyAuthorization) => {
      tokens.set(challenge.token, keyAuthorization);
    },
    challengeRemoveFn: async (_authz, challenge) => {
      tokens.delete(challenge.token);
    },
  });

  return { key: certificateKey.toString(), cert: certificate.toString() };
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

  let material;
  try {
    material = await issueCertificate({ ...config, tokens });
  } catch (error) {
    challengeServer.close();
    return { active: false, reason: `certificate issuance failed — ${error.message}` };
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
