// Fund the enclave's signing wallet so it can pay for its own attestation.
//
// Inside Confidential Space the signing key is generated in-enclave and never
// leaves it, so a fresh address appears on every boot with a zero balance —
// and on-chain RSA verification is gas-heavy. This reads the address the
// enclave reports and tops it up from the deployer wallet.
//
// Usage:
//   node scripts/fund-tee.mjs --from http://ENCLAVE_IP:8080
//   node scripts/fund-tee.mjs --address 0x… [--target 2]
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { JsonRpcProvider, Wallet, formatEther, isAddress, parseEther } from "ethers";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const envPath = join(root, ".env.local");

/** Enough for many attestation transactions; each RSA verification is ~1M gas. */
const DEFAULT_TARGET_C2FLR = "2";

function envLocal(name) {
  const content = readFileSync(envPath, "utf8");
  const m = content.match(new RegExp(`^${name}=(.+)$`, "m"));
  return m ? m[1].trim() : null;
}

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i !== -1 ? process.argv[i + 1] : null;
}

const from = argValue("--from") ?? process.env.ENCLAVE_URL ?? null;
let address = argValue("--address");
let reported = null;

if (!address && from) {
  const health = await (await fetch(`${from.replace(/\/$/, "")}/health`)).json();
  address = health?.data?.teeAddress;
  reported = health?.data?.attestation ?? null;
  if (!address) throw new Error(`${from}/health did not report a teeAddress.`);
}
if (!address || !isAddress(address)) {
  console.error("Pass --from http://ENCLAVE:8080 or --address 0x…");
  process.exit(1);
}

const pk = envLocal("FLARE_DEPLOYER_PRIVATE_KEY");
const rpc = envLocal("FLARE_RPC_URL") ?? "https://coston2-api.flare.network/ext/C/rpc";
if (!pk) {
  console.error("FLARE_DEPLOYER_PRIVATE_KEY not set in .env.local.");
  process.exit(1);
}

const provider = new JsonRpcProvider(rpc, 114, { staticNetwork: true });
const wallet = new Wallet(pk, provider);
const target = parseEther(argValue("--target") ?? DEFAULT_TARGET_C2FLR);

const balance = await provider.getBalance(address);
console.log(`Enclave signer: ${address}`);
if (reported) {
  console.log(`  in Confidential Space: ${reported.enabled}`);
  console.log(`  on-chain attested:     ${reported.onChain}${reported.lastError ? ` (${reported.lastError})` : ""}`);
}
console.log(`  balance: ${formatEther(balance)} C2FLR (target ${formatEther(target)})`);

if (balance >= target) {
  console.log("Already funded — nothing to do.");
  process.exit(0);
}

const topUp = target - balance;
const deployerBalance = await provider.getBalance(wallet.address);
if (deployerBalance < topUp) {
  console.error(
    `Deployer ${wallet.address} holds ${formatEther(deployerBalance)} C2FLR — not enough to send `
    + `${formatEther(topUp)}. Top up at https://faucet.flare.network/coston2`,
  );
  process.exit(1);
}

const tx = await wallet.sendTransaction({ to: address, value: topUp });
await tx.wait();
console.log(`Sent ${formatEther(topUp)} C2FLR — tx ${tx.hash}`);
console.log(`New balance: ${formatEther(await provider.getBalance(address))} C2FLR`);
console.log("The enclave retries attestation automatically (backoff caps at 5 min).");
