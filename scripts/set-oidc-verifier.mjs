// Deploy OidcSignatureVerification and wire it into FlareVtpmAttestation as the
// OIDC token-type verifier. Separate from deploy-claims.mjs so the verifier can
// be replaced without touching ClaimPayout — ClaimPayout points at the vTPM
// registry, and the registry resolves the verifier, so swapping it is safe.
//
// Registered signing keys do NOT carry over to a new verifier; run
// scripts/register-oidc-keys.mjs afterwards.
//
// Usage: node scripts/set-oidc-verifier.mjs   (NODE_OPTIONS=--use-system-ca here)
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Contract, ContractFactory, JsonRpcProvider, Wallet, formatEther, toUtf8Bytes } from "ethers";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const envPath = join(root, ".env.local");
const deploymentPath = join(root, "contracts", "deployment.claims.coston2.json");

const VTPM_ABI = [
  "function setTokenTypeVerifier(address verifier)",
  "function tokenTypeVerifiers(bytes) view returns (address)",
  "function owner() view returns (address)",
];

function envLocal(name) {
  const content = readFileSync(envPath, "utf8");
  const m = content.match(new RegExp(`^${name}=(.+)$`, "m"));
  return m ? m[1].trim() : null;
}

const pk = envLocal("FLARE_DEPLOYER_PRIVATE_KEY");
const rpc = envLocal("FLARE_RPC_URL") ?? "https://coston2-api.flare.network/ext/C/rpc";
const vtpmAddress = envLocal("FLARE_VTPM_ADDRESS");
if (!pk || !vtpmAddress) {
  console.error("FLARE_DEPLOYER_PRIVATE_KEY and FLARE_VTPM_ADDRESS must be set in .env.local.");
  process.exit(1);
}

const provider = new JsonRpcProvider(rpc, 114, { staticNetwork: true });
const wallet = new Wallet(pk, provider);
const vtpm = new Contract(vtpmAddress, VTPM_ABI, wallet);

const owner = await vtpm.owner();
if (owner.toLowerCase() !== wallet.address.toLowerCase()) {
  console.error(`Signer ${wallet.address} is not the vTPM owner (${owner}).`);
  process.exit(1);
}

const previous = await vtpm.tokenTypeVerifiers(toUtf8Bytes("OIDC"));
console.log(`Deployer: ${wallet.address} (${formatEther(await provider.getBalance(wallet.address))} C2FLR)`);
console.log(`vTPM:     ${vtpmAddress}`);
console.log(`Current OIDC verifier: ${previous}`);

const artifact = JSON.parse(
  readFileSync(join(root, "contracts", "artifacts", "OidcSignatureVerification.json"), "utf8"),
);
const verifier = await new ContractFactory(artifact.abi, artifact.bytecode, wallet).deploy();
await verifier.waitForDeployment();
const address = await verifier.getAddress();
console.log(`Deployed OidcSignatureVerification at ${address}`);

await (await vtpm.setTokenTypeVerifier(address)).wait();

const wired = await vtpm.tokenTypeVerifiers(toUtf8Bytes("OIDC"));
if (wired.toLowerCase() !== address.toLowerCase()) {
  console.error(`Wiring failed — registry still points at ${wired}.`);
  process.exit(1);
}
console.log("Wired as the OIDC token-type verifier (confirmed on-chain).");

const content = readFileSync(envPath, "utf8");
const line = `OIDC_VERIFIER_ADDRESS=${address}`;
writeFileSync(
  envPath,
  /^OIDC_VERIFIER_ADDRESS=.*$/m.test(content)
    ? content.replace(/^OIDC_VERIFIER_ADDRESS=.*$/m, line)
    : `${content}${line}\n`,
);

if (existsSync(deploymentPath)) {
  const record = JSON.parse(readFileSync(deploymentPath, "utf8"));
  record.oidcVerifier = address;
  record.oidcVerifierReplacedAt = new Date().toISOString();
  record.oidcVerifierPrevious = previous;
  writeFileSync(deploymentPath, JSON.stringify(record, null, 2));
  console.log(`Deployment record updated → ${deploymentPath}`);
}

console.log("\nNext: node scripts/register-oidc-keys.mjs");
