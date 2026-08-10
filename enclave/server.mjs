// Proof of Real — confidential verifier enclave.
//
// Receives an image DIRECTLY from the user's browser, fingerprints it entirely
// in enclave memory, and queries the public registry BY HASH ONLY — the image
// never leaves the TEE and is never written to disk. The verdict returns with
// a Google-signed attestation token whose nonce is the file's SHA-256, proving
// this exact file was verified by this exact code on confidential hardware.
//
// Env: PORT (default 8080), REGISTRY_URL (default http://localhost:3000),
//      ATTESTATION_AUDIENCE (default proof-of-real-verifier)
import { createServer } from "node:http";
import { contentHash, perceptualHash } from "./hash.mjs";
import { fetchAttestationToken, decodeClaims, inConfidentialSpace } from "./attestation.mjs";
import { extractExif } from "./exif.mjs";
import { runClaimChecks } from "./claim.mjs";
import { encodeSettlement, signActionResult, teeWallet } from "./fcc.mjs";
import { attestationWallet, startAttestationLoop } from "./attest.mjs";
import { startTls, tlsConfig } from "./tls.mjs";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const TEE_WALLET = teeWallet();
const FLARE_RPC = process.env.FLARE_RPC_URL ?? "https://coston2-api.flare.network/ext/C/rpc";

// Minimal read surface of ClaimPayout — the enclave verifies evidence against
// what the CONTRACT says the policy insures, never against caller-supplied
// coordinates (a caller could otherwise tailor the "policy" to their photo).
const POLICY_ABI = [
  "function policies(uint256) view returns (address holder, string date, string lat, string lon,"
  + " uint256 rainThresholdMmE2, uint256 payoutUsdE2, uint256 premiumWei, bool evidenceApproved,"
  + " bool evidenceAttested, bytes32 evidenceHash, bool settled, bool paidOut, uint256 paidWei)",
];

async function readPolicyFromChain(contractAddr, policyId) {
  const { Contract, JsonRpcProvider } = await import("ethers");
  const provider = new JsonRpcProvider(FLARE_RPC, 114, { staticNetwork: true });
  const contract = new Contract(contractAddr, POLICY_ABI, provider);
  const p = await contract.policies(policyId);
  if (p.holder === ZERO_ADDRESS) throw new Error(`policy ${policyId} does not exist on ${contractAddr}`);
  return { lat: Number(p.lat), lon: Number(p.lon), date: p.date };
}

// Keeps this enclave's vTPM quote registered on Flare so ClaimPayout accepts
// its settlements on attestation alone. No-op outside Confidential Space.
const ATTESTATION = startAttestationLoop({
  wallet: attestationWallet(TEE_WALLET.privateKey, FLARE_RPC),
  vtpmAddress: process.env.FLARE_VTPM_ADDRESS ?? null,
  audience: process.env.ATTESTATION_AUDIENCE ?? "proof-of-real-verifier",
});

const PORT = Number(process.env.PORT ?? 8080);
const REGISTRY_URL = (process.env.REGISTRY_URL ?? "http://localhost:3000").replace(/\/$/, "");
const AUDIENCE = process.env.ATTESTATION_AUDIENCE ?? "proof-of-real-verifier";
const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;
const NEAR_MATCH_MAX_DISTANCE = 10; // must match src/lib/registry.ts
const ACCEPTED_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": process.env.ALLOWED_ORIGIN ?? "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
    ...CORS_HEADERS,
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_UPLOAD_BYTES) {
        reject(new Error("File exceeds the 15 MB limit."));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/**
 * What this enclave can prove about itself for one verified file: the Google
 * attestation token bound to the file's hash, plus whether Flare currently
 * holds a valid vTPM quote for the key that signed the verdict.
 */
async function enclaveProof(sha) {
  const token = await fetchAttestationToken(AUDIENCE, sha);
  const claims = token ? decodeClaims(token) : null;
  return {
    attested: Boolean(token),
    inConfidentialSpace: inConfidentialSpace(),
    nonceBound: Boolean(token),
    hwModel: claims?.hwmodel ?? null,
    swName: claims?.swname ?? null,
    imageDigest: claims?.submods?.container?.image_digest ?? null,
    issuedAt: claims?.iat ? new Date(claims.iat * 1000).toISOString() : null,
    token,
    teeAddress: TEE_WALLET.address,
    onChainAttested: ATTESTATION.onChain,
    attestationExpiresAt: ATTESTATION.expiresAt,
    attestationTx: ATTESTATION.lastTxHash,
  };
}

/** Same verdict rules as the registry's verifyMedia. */
function classify(exact, near) {
  if (exact) {
    return { status: "registered-original", registration: exact, distance: 0, confidence: 1 };
  }
  if (near) {
    return {
      status: "likely-altered",
      registration: near.record,
      distance: near.distance,
      confidence: Number((1 - near.distance / 64).toFixed(3)),
    };
  }
  return { status: "unregistered", registration: null, distance: null, confidence: 0 };
}

async function handleVerify(req, res) {
  const type = (req.headers["content-type"] ?? "").split(";")[0].trim();
  if (!ACCEPTED_TYPES.has(type)) {
    return json(res, 400, {
      success: false,
      error: `Unsupported type "${type}". Use PNG, JPEG, WebP, or GIF.`,
    });
  }

  let buf;
  try {
    buf = await readBody(req);
  } catch (error) {
    return json(res, 413, { success: false, error: error.message });
  }
  if (buf.length === 0) return json(res, 400, { success: false, error: "Empty upload." });

  // Fingerprint in enclave memory only.
  const sha = contentHash(buf);
  let phash;
  try {
    phash = await perceptualHash(buf);
  } catch {
    return json(res, 400, { success: false, error: "Not a decodable image." });
  }

  // Hash-only registry lookup — the image itself stays in the TEE.
  let lookup;
  try {
    const lookupRes = await fetch(`${REGISTRY_URL}/api/lookup?sha=${sha}&phash=${phash}`);
    lookup = await lookupRes.json();
    if (!lookup.success) throw new Error(lookup.error ?? "Registry lookup failed.");
  } catch (error) {
    return json(res, 502, { success: false, error: `Registry unreachable: ${error.message}` });
  }

  const verdict = classify(lookup.data.exact, lookup.data.near);

  // Attestation bound to this exact file via nonce = SHA-256.
  const enclave = await enclaveProof(sha);

  return json(res, 200, { success: true, data: { ...verdict, enclave } });
}

/**
 * Confidential claim-evidence verification. The claimant's photo is read into
 * enclave memory only: EXIF (GPS + capture time) is extracted, the registry is
 * queried by hash for evidence reuse, and the verdict is signed in the FCC
 * ActionResult format so ClaimPayout.sol can verify it with ecrecover.
 *
 * Query params: policyId (uint), lat, lon (decimal degrees), date (YYYY-MM-DD),
 *               contract (0x… ClaimPayout address), maxKm?, windowDays?
 */
async function handleClaim(req, res, url) {
  const type = (req.headers["content-type"] ?? "").split(";")[0].trim();
  if (!ACCEPTED_TYPES.has(type)) {
    return json(res, 400, {
      success: false,
      error: `Unsupported type "${type}". Use PNG, JPEG, WebP, or GIF.`,
    });
  }

  const q = url.searchParams;
  const policyId = q.get("policyId");
  const contractAddr = q.get("contract") ?? ZERO_ADDRESS;
  if (!/^\d+$/.test(policyId ?? "")) {
    return json(res, 400, { success: false, error: "Query param 'policyId' must be a non-negative integer." });
  }

  // Policy terms come from the chain when a contract is given (the signed
  // settlement binds to it). Caller-supplied lat/lon/date are accepted ONLY
  // in standalone mode (contract = zero address) — such results are unusable
  // on a real contract, which rejects foreign contractAddr values.
  let lat;
  let lon;
  let date;
  if (contractAddr !== ZERO_ADDRESS) {
    try {
      ({ lat, lon, date } = await readPolicyFromChain(contractAddr, policyId));
    } catch (error) {
      return json(res, 400, { success: false, error: `Policy lookup failed: ${error.message}` });
    }
  } else {
    lat = Number(q.get("lat"));
    lon = Number(q.get("lon"));
    date = q.get("date");
    if (Number.isNaN(lat) || Number.isNaN(lon)) {
      return json(res, 400, { success: false, error: "Query params 'lat' and 'lon' must be decimal degrees." });
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date ?? "")) {
      return json(res, 400, { success: false, error: "Query param 'date' must be YYYY-MM-DD." });
    }
  }

  let buf;
  try {
    buf = await readBody(req);
  } catch (error) {
    return json(res, 413, { success: false, error: error.message });
  }
  if (buf.length === 0) return json(res, 400, { success: false, error: "Empty upload." });

  // Fingerprint + EXIF in enclave memory only.
  const sha = contentHash(buf);
  let phash;
  try {
    phash = await perceptualHash(buf);
  } catch {
    return json(res, 400, { success: false, error: "Not a decodable image." });
  }
  const exif = await extractExif(buf);

  // Hash-only reuse lookup — catches evidence recycled across claims.
  let lookup;
  try {
    const lookupRes = await fetch(`${REGISTRY_URL}/api/lookup?sha=${sha}&phash=${phash}`);
    lookup = await lookupRes.json();
    if (!lookup.success) throw new Error(lookup.error ?? "Registry lookup failed.");
  } catch (error) {
    return json(res, 502, { success: false, error: `Registry unreachable: ${error.message}` });
  }

  const policy = {
    policyId: Number(policyId),
    lat,
    lon,
    date,
    maxKm: q.get("maxKm") ? Number(q.get("maxKm")) : undefined,
    windowDays: q.get("windowDays") ? Number(q.get("windowDays")) : undefined,
  };
  const verdict = runClaimChecks(exif, policy, lookup.data, phash);

  // Record the evidence fingerprint (hash only — never the image) so future
  // claims reusing this photo are caught. Non-fatal if the registry declines.
  let recorded = false;
  try {
    const rec = await fetch(`${REGISTRY_URL}/api/claims`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ policyId: Number(policyId), sha, phash }),
    });
    recorded = (await rec.json()).success === true;
  } catch {
    recorded = false;
  }

  // Attestation bound to this exact file via nonce = SHA-256.
  const enclave = await enclaveProof(sha);

  // Sign the settlement in the FCC ActionResult wire format.
  const resultData = encodeSettlement({
    contractAddr,
    policyId,
    evidenceSha256: sha,
    evidenceOk: verdict.eligible,
    reuseDetected: verdict.reuseDetected,
    exifLat: exif.gpsLat,
    exifLon: exif.gpsLon,
    takenAt: exif.takenAt,
  });
  const fcc = await signActionResult(TEE_WALLET, resultData);

  return json(res, 200, {
    success: true,
    data: {
      policyId: Number(policyId),
      eligible: verdict.eligible,
      checks: verdict.checks,
      distanceKm: verdict.distanceKm,
      dayGap: verdict.dayGap,
      exif: { ...exif, gpsLat: exif.gpsLat, gpsLon: exif.gpsLon },
      evidenceSha256: sha,
      recorded,
      enclave,
      fcc,
    },
  });
}

const TLS = tlsConfig();
// Replaced once startTls resolves; until then the plaintext port serves normally
// so dev mode and the ops scripts behave exactly as before.
let TLS_STATE = { active: false, reason: TLS.enabled ? "issuing" : "TLS_DOMAIN not set" };

function healthPayload() {
  return {
    success: true,
    data: {
      service: "proof-of-real-enclave",
      inConfidentialSpace: inConfidentialSpace(),
      registry: REGISTRY_URL,
      teeAddress: TEE_WALLET.address,
      attestation: ATTESTATION,
      tls: TLS_STATE,
    },
  };
}

async function handle(req, res, { encrypted }) {
  try {
    if (req.method === "OPTIONS") {
      res.writeHead(204, CORS_HEADERS);
      return res.end();
    }
    if (req.method === "GET" && req.url === "/health") {
      return json(res, 200, healthPayload());
    }
    // Once TLS is live, the plaintext port keeps answering /health for the ops
    // scripts but refuses anything carrying an image — a cleartext upload would
    // defeat the point of verifying it in a TEE.
    if (TLS_STATE.active && !encrypted) {
      return json(res, 426, {
        success: false,
        error: `This enclave accepts evidence over HTTPS only — use ${TLS_STATE.url}.`,
      });
    }
    if (req.method === "POST" && req.url === "/verify") {
      return await handleVerify(req, res);
    }
    if (req.method === "POST" && req.url?.startsWith("/claim")) {
      return await handleClaim(req, res, new URL(req.url, `http://${req.headers.host}`));
    }
    return json(res, 404, { success: false, error: "Not found." });
  } catch (error) {
    return json(res, 500, { success: false, error: error.message ?? "Internal error." });
  }
}

const server = createServer((req, res) => handle(req, res, { encrypted: false }));

server.listen(PORT, async () => {
  console.log(`proof-of-real enclave listening on :${PORT}`);
  console.log(`registry: ${REGISTRY_URL}`);
  console.log(
    inConfidentialSpace()
      ? "Confidential Space detected — attestation ENABLED"
      : "not in Confidential Space — dev mode, attestation unavailable",
  );

  if (!TLS.enabled) {
    console.log("tls: TLS_DOMAIN not set — serving plain HTTP (dev mode)");
    return;
  }
  console.log(`tls: requesting a certificate for ${TLS.domain}${TLS.staging ? " (STAGING)" : ""}`);
  const result = await startTls((req, res) => handle(req, res, { encrypted: true }), TLS);
  TLS_STATE = result;
  if (result.active) {
    console.log(`tls: serving ${result.url} — certificate expires ${result.expiresAt ?? "?"}`);
    if (result.staging) console.log("tls: STAGING certificate — browsers will not trust it");
  } else {
    console.error(`tls: NOT active — ${result.reason}`);
    console.error("tls: continuing on plain HTTP; browsers on an HTTPS page will refuse to reach us");
  }
});
