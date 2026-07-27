// Register Google's Confidential Space signing keys on OidcSignatureVerification.
//
// On-chain RS256 verification needs the issuer's RSA public keys. Google rotates
// the Confidential Space signer keys, so this script is re-runnable: it fetches
// the live JWKS, diffs it against what the contract has already recorded, and
// registers only what is missing. Run it before any real attestation and again
// on a schedule while the demo is live — a rotated-in key that isn't registered
// makes verifyAndAttest revert with "Public key not found".
//
// Usage:
//   node scripts/register-oidc-keys.mjs           register missing keys
//   node scripts/register-oidc-keys.mjs --check    report only, send no tx
// (NODE_OPTIONS=--use-system-ca on this machine — see docs/enclave.md)
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Contract, JsonRpcProvider, Wallet, formatEther, toUtf8Bytes } from "ethers";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const envPath = join(root, ".env.local");

const DISCOVERY_URL = "https://confidentialcomputing.googleapis.com/.well-known/openid-configuration";
// Used only if discovery is unreachable; discovery is authoritative.
const JWKS_FALLBACK =
  "https://www.googleapis.com/service_accounts/v1/metadata/jwk/signer@confidentialspace-sign.iam.gserviceaccount.com";

const VTPM_ABI = ["function tokenTypeVerifiers(bytes) view returns (address)"];
const OIDC_ABI = [
  "function addPubKey(bytes kid, bytes e, bytes n)",
  "function hasPubKey(bytes kid) view returns (bool)",
  "function owner() view returns (address)",
  "event PubKeyAdded(bytes indexed kid, bytes e, bytes n)",
];

const checkOnly = process.argv.includes("--check");

function envLocal(name) {
  const content = readFileSync(envPath, "utf8");
  const m = content.match(new RegExp(`^${name}=(.+)$`, "m"));
  return m ? m[1].trim() : null;
}

/** base64url → Buffer (JWKS encodes RSA modulus/exponent this way). */
function b64url(value) {
  return Buffer.from(value, "base64url");
}

async function fetchJwks() {
  let jwksUri = JWKS_FALLBACK;
  try {
    const discovery = await (await fetch(DISCOVERY_URL)).json();
    if (discovery.jwks_uri) jwksUri = discovery.jwks_uri;
    console.log(`Issuer:  ${discovery.issuer}`);
  } catch (error) {
    console.warn(`Discovery failed (${error.message}) — using the known JWKS URL.`);
  }
  console.log(`JWKS:    ${jwksUri}`);

  const jwks = await (await fetch(jwksUri)).json();
  const keys = (jwks.keys ?? []).filter((k) => k.kty === "RSA" && k.alg === "RS256" && k.n && k.e);
  if (keys.length === 0) throw new Error("JWKS contained no usable RS256 keys.");
  return keys;
}

/**
 * Which of the live kids the contract already holds. Uses the hasPubKey view;
 * event history is not an option (Flare's public RPC caps eth_getLogs at 30
 * blocks). If the deployed verifier predates that view, every key is treated as
 * missing — addPubKey overwrites by kid, so re-registering is safe.
 */
async function findMissing(oidc, keys) {
  try {
    const present = await Promise.all(keys.map((k) => oidc.hasPubKey(toUtf8Bytes(k.kid))));
    return keys.filter((_, i) => !present[i]);
  } catch (error) {
    console.warn(`hasPubKey unavailable on this verifier (${error.shortMessage ?? error.message}).`);
    console.warn("Registering every live key — addPubKey overwrites by kid, so this is safe.");
    return keys;
  }
}

const pk = envLocal("FLARE_DEPLOYER_PRIVATE_KEY");
const rpc = envLocal("FLARE_RPC_URL") ?? "https://coston2-api.flare.network/ext/C/rpc";
const vtpmAddress = process.env.FLARE_VTPM_ADDRESS ?? envLocal("FLARE_VTPM_ADDRESS");
if (!vtpmAddress) {
  console.error("FLARE_VTPM_ADDRESS not set — deploy the suite first (scripts/deploy-claims.mjs).");
  process.exit(1);
}
if (!pk && !checkOnly) {
  console.error("FLARE_DEPLOYER_PRIVATE_KEY not set — needed to send addPubKey (owner-only).");
  process.exit(1);
}

const provider = new JsonRpcProvider(rpc, 114, { staticNetwork: true });
const wallet = pk ? new Wallet(pk, provider) : null;

// The verifier address comes from the vTPM registry itself, so this always
// targets the verifier that is actually wired in.
const vtpm = new Contract(vtpmAddress, VTPM_ABI, provider);
const oidcAddress = await vtpm.tokenTypeVerifiers(toUtf8Bytes("OIDC"));
if (oidcAddress === "0x0000000000000000000000000000000000000000") {
  console.error(`No OIDC verifier registered on FlareVtpmAttestation ${vtpmAddress}.`);
  process.exit(1);
}
console.log(`vTPM:    ${vtpmAddress}`);
console.log(`Verifier: ${oidcAddress}`);

const oidc = new Contract(oidcAddress, OIDC_ABI, wallet ?? provider);
const owner = await oidc.owner();
if (wallet && owner.toLowerCase() !== wallet.address.toLowerCase()) {
  console.error(`Signer ${wallet.address} is not the verifier owner (${owner}).`);
  process.exit(1);
}

const keys = await fetchJwks();
console.log(`Live keys: ${keys.length}`);

const missing = await findMissing(oidc, keys);

for (const key of keys) {
  const isNew = missing.includes(key);
  console.log(`  ${key.kid}  ${isNew ? "MISSING" : "registered"}  (${b64url(key.n).length * 8}-bit)`);
}

if (missing.length === 0) {
  console.log("\nAll live signing keys are registered on-chain. Nothing to do.");
  process.exit(0);
}
if (checkOnly) {
  console.log(`\n${missing.length} key(s) missing. Re-run without --check to register them.`);
  process.exit(1);
}

const balance = await provider.getBalance(wallet.address);
console.log(`\nOwner ${wallet.address} (${formatEther(balance)} C2FLR) registering ${missing.length} key(s)…`);

for (const key of missing) {
  const kid = toUtf8Bytes(key.kid);
  const e = b64url(key.e);
  const n = b64url(key.n);

  const tx = await oidc.addPubKey(kid, e, n);
  const receipt = await tx.wait();

  // Verify what actually landed on-chain rather than trusting the send.
  const event = receipt.logs
    .map((log) => {
      try {
        return oidc.interface.parseLog(log);
      } catch {
        return null;
      }
    })
    .find((parsed) => parsed?.name === "PubKeyAdded");
  if (!event) throw new Error(`No PubKeyAdded event in ${tx.hash} for kid ${key.kid}`);

  const emittedE = Buffer.from(event.args.e.slice(2), "hex");
  const emittedN = Buffer.from(event.args.n.slice(2), "hex");
  if (!emittedE.equals(e) || !emittedN.equals(n)) {
    throw new Error(`On-chain key material for ${key.kid} does not match the JWKS.`);
  }

  console.log(`  ✓ ${key.kid}  tx ${tx.hash}`);
}

console.log("\nDone. Re-run after any Google key rotation (--check is cheap and read-only).");
