// Pin FlareVtpmAttestation to the image digest of the enclave that is actually
// deployed. Until this runs, the contract requires a placeholder digest and
// every real attestation fails with "Invalid image digest" — by design: the
// chain only vouches for code the owner has explicitly named.
//
// Usage:
//   node scripts/set-image-digest.mjs --digest sha256:abc123…
//   node scripts/set-image-digest.mjs --from http://ENCLAVE_IP:8080
//     (reads the digest Google reported to the running enclave)
//   node scripts/set-image-digest.mjs --show
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Contract, JsonRpcProvider, Wallet } from "ethers";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const envPath = join(root, ".env.local");

const VTPM_ABI = [
  "function setBaseQuoteConfig(string hwmodel, string swname, string imageDigest, string iss, bool secboot)",
  "function owner() view returns (address)",
  "event BaseQuoteConfigUpdated(string indexed imageDigest, string hwmodel, string swname, string iss, bool secboot)",
];

// Must match the deployed base config; only the digest changes here.
const BASE = {
  hwmodel: "GCP_INTEL_TDX",
  swname: "CONFIDENTIAL_SPACE",
  iss: "https://confidentialcomputing.googleapis.com",
  secboot: true,
};

function envLocal(name) {
  const content = readFileSync(envPath, "utf8");
  const m = content.match(new RegExp(`^${name}=(.+)$`, "m"));
  return m ? m[1].trim() : null;
}

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i !== -1 ? process.argv[i + 1] : null;
}

async function digestFromEnclave(url) {
  const health = await (await fetch(`${url.replace(/\/$/, "")}/health`)).json();
  const attestation = health?.data?.attestation;
  const digest = attestation?.tokenImageDigest ?? attestation?.imageDigest;
  if (!digest) {
    throw new Error(
      "The enclave has not reported an image digest — it is either not in Confidential Space "
      + "or has not yet obtained an attestation token.",
    );
  }
  return digest;
}

const pk = envLocal("FLARE_DEPLOYER_PRIVATE_KEY");
const rpc = envLocal("FLARE_RPC_URL") ?? "https://coston2-api.flare.network/ext/C/rpc";
const vtpmAddress = envLocal("FLARE_VTPM_ADDRESS");
if (!vtpmAddress) {
  console.error("FLARE_VTPM_ADDRESS not set in .env.local.");
  process.exit(1);
}

const provider = new JsonRpcProvider(rpc, 114, { staticNetwork: true });

if (process.argv.includes("--show")) {
  const record = JSON.parse(
    readFileSync(join(root, "contracts", "deployment.claims.coston2.json"), "utf8"),
  );
  console.log(`vTPM ${vtpmAddress}`);
  console.log(`Deployed with digest: ${record.confidentialSpaceConfig?.imageDigest}`);
  console.log("(the live value is internal to the contract; this is the deployment record)");
  process.exit(0);
}

let digest = argValue("--digest");
const from = argValue("--from");
if (!digest && from) digest = await digestFromEnclave(from);
if (!digest) {
  console.error("Pass --digest sha256:… or --from http://ENCLAVE:8080 (or --show).");
  process.exit(1);
}
if (!/^sha256:[0-9a-f]{64}$/.test(digest)) {
  console.error(`"${digest}" is not a sha256:<64 hex> image digest.`);
  process.exit(1);
}
if (!pk) {
  console.error("FLARE_DEPLOYER_PRIVATE_KEY not set — setBaseQuoteConfig is owner-only.");
  process.exit(1);
}

const wallet = new Wallet(pk, provider);
const vtpm = new Contract(vtpmAddress, VTPM_ABI, wallet);
const owner = await vtpm.owner();
if (owner.toLowerCase() !== wallet.address.toLowerCase()) {
  console.error(`Signer ${wallet.address} is not the vTPM owner (${owner}).`);
  process.exit(1);
}

console.log(`Pinning ${vtpmAddress} to image digest ${digest}`);
const tx = await vtpm.setBaseQuoteConfig(BASE.hwmodel, BASE.swname, digest, BASE.iss, BASE.secboot);
const receipt = await tx.wait();

const updated = receipt.logs
  .map((log) => {
    try {
      return vtpm.interface.parseLog(log);
    } catch {
      return null;
    }
  })
  .some((parsed) => parsed?.name === "BaseQuoteConfigUpdated");
if (!updated) {
  console.error(`No BaseQuoteConfigUpdated event in ${tx.hash} — config may not have changed.`);
  process.exit(1);
}

console.log(`Done — tx ${tx.hash}`);
console.log("The enclave's next attestation attempt (within ~5 min) should now succeed.");
