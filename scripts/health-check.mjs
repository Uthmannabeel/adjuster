// Pre-demo and during-judging health check. Everything a judge could click on
// depends on one of these being true, and most of them decay on their own:
// wallets drain, the payout pool empties, attestation quotes expire hourly,
// and Google rotates the signing keys the on-chain verifier is pinned to.
//
// Usage:
//   node scripts/health-check.mjs
//   node scripts/health-check.mjs --enclave http://ENCLAVE:8080 --app https://APP_URL
//
// Exit code is 1 if any check FAILs, so this can be a cron/CI gate.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Contract, JsonRpcProvider, formatEther } from "ethers";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// Below these, a demo can fail mid-click in front of a judge. Sized against
// the ACTUAL cost of one action at current FTSO FLR/USD (~$0.006): a single
// $0.15 payout is ~25 C2FLR, so a 30-floor pool passes while being one click
// from an InsufficientPool revert. The pool floor covers ~2 payouts + margin;
// the deployer floor covers a day of hourly enclave re-attestation (~30/day).
const MIN_DEPLOYER_C2FLR = 40;
const MIN_POOL_C2FLR = 60;
const RPC_TIMEOUT_MS = 15_000;

const CLAIMS_ABI = [
  "function policyCount() view returns (uint256)",
  "function policies(uint256) view returns (address holder, string date, string lat, string lon,"
  + " uint256 rainThresholdMmE2, uint256 payoutUsdE2, uint256 premiumWei, bool evidenceApproved,"
  + " bool evidenceAttested, bytes32 evidenceHash, bool settled, bool paidOut, uint256 paidWei)",
];
const VTPM_ABI = [
  "function getRegisteredQuote(address) view returns ((bytes32 digest, (bytes hwmodel, bytes swname,"
  + " bytes imageDigest, bytes iss, bool secboot) base, uint256 exp, uint256 iat))",
];

function envLocal(name) {
  try {
    const m = readFileSync(join(root, ".env.local"), "utf8").match(new RegExp(`^${name}=(.+)$`, "m"));
    return m ? m[1].trim() : null;
  } catch {
    return null;
  }
}

/** A deployment record that has not been written yet is a missing file, not an error. */
function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i !== -1 ? process.argv[i + 1] : null;
}

const results = [];
function record(status, label, detail) {
  results.push({ status, label, detail });
  const mark = status === "PASS" ? "  ok  " : status === "WARN" ? " warn " : " FAIL ";
  console.log(`[${mark}] ${label}${detail ? ` — ${detail}` : ""}`);
}

function withTimeout(promise, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${RPC_TIMEOUT_MS}ms`)), RPC_TIMEOUT_MS);
    }),
  ]).finally(() => clearTimeout(timer));
}

const deployment = JSON.parse(
  readFileSync(join(root, "contracts", "deployment.claims.coston2.json"), "utf8"),
);
const rpc = envLocal("FLARE_RPC_URL") ?? "https://coston2-api.flare.network/ext/C/rpc";
const provider = new JsonRpcProvider(rpc, 114, { staticNetwork: true });

console.log(`Adjuster health check — ${new Date().toISOString()}`);
console.log(`Coston2 RPC ${rpc}\n`);

// --- chain reachable -------------------------------------------------------
let blockNumber = null;
try {
  blockNumber = await withTimeout(provider.getBlockNumber(), "getBlockNumber");
  record("PASS", "Coston2 RPC reachable", `block ${blockNumber}`);
} catch (error) {
  record("FAIL", "Coston2 RPC reachable", error.message);
  // Nothing else on-chain can be checked; report and stop.
  process.exit(1);
}

// --- wallets ---------------------------------------------------------------
async function balanceCheck(label, address, minimum) {
  if (!address) {
    record("WARN", label, "address not configured");
    return;
  }
  try {
    const wei = await withTimeout(provider.getBalance(address), label);
    const flr = Number(formatEther(wei));
    const detail = `${flr.toFixed(2)} C2FLR (${address})`;
    record(flr >= minimum ? "PASS" : "FAIL", label, flr >= minimum ? detail : `${detail} — below ${minimum}`);
  } catch (error) {
    record("FAIL", label, error.message);
  }
}

await balanceCheck("Deployer / relay wallet funded", deployment.deployer, MIN_DEPLOYER_C2FLR);
await balanceCheck("ClaimPayout pool funded", deployment.claimPayout, MIN_POOL_C2FLR);

// --- contract answering ----------------------------------------------------
const claims = new Contract(deployment.claimPayout, CLAIMS_ABI, provider);
let policyCount = 0;
try {
  policyCount = Number(await withTimeout(claims.policyCount(), "policyCount"));
  record("PASS", "ClaimPayout responding", `${policyCount} policies`);
} catch (error) {
  record("FAIL", "ClaimPayout responding", error.message);
}

// A judge landing on the site sees the specimen claim file; it reads a real
// settled policy off-chain. If none is settled, the hero has nothing to show.
if (policyCount > 0) {
  try {
    const settled = [];
    for (let id = 0; id < policyCount; id += 1) {
      const p = await withTimeout(claims.policies(id), `policies(${id})`);
      if (p.paidOut) settled.push(`#${id} ${Number(formatEther(p.paidWei)).toFixed(2)} C2FLR`);
    }
    record(
      settled.length > 0 ? "PASS" : "FAIL",
      "A paid-out policy exists for the demo hero",
      settled.length > 0 ? settled.join(", ") : "no policy has paid out",
    );
  } catch (error) {
    record("WARN", "A paid-out policy exists for the demo hero", error.message);
  }
}

// --- attestation -----------------------------------------------------------
// Ask the running enclave who it is before checking the chain: the in-enclave
// key is regenerated on every boot, so any address recorded at deploy time goes
// stale the moment the VM is replaced — and checking the wrong address would
// report a healthy enclave as unattested, or worse, the reverse.
const enclaveUrl = argValue("--enclave") ?? envLocal("NEXT_PUBLIC_ENCLAVE_URL");
let enclaveHealth = null;
if (enclaveUrl) {
  try {
    const response = await fetch(`${enclaveUrl.replace(/\/$/, "")}/health`, {
      signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
    });
    if (response.ok) enclaveHealth = (await response.json())?.data ?? null;
  } catch {
    /* reported by the reachability check below */
  }
}

// The image digest gates every real attestation. What matters is the digest of
// the enclave actually deployed, not whatever the contract deployment recorded.
const enclaveDeployment = readJson(join(root, "contracts", "deployment.enclave.json")) ?? {};
const pinnedDigest = enclaveDeployment.imageDigest
  ?? deployment.confidentialSpaceConfig?.imageDigest
  ?? "";
// This is the LOCAL deployment record only — the contract's required digest is
// internal storage with no getter, so the chain cannot be asked directly. The
// live-quote check below is the real proof: a quote can only register while the
// enclave's digest matches the on-chain requirement, so an unexpired quote whose
// digest equals this one confirms the pin. (2026-08-13: the local record said
// 0bf838cc while the chain still required 55d698 — this check alone is not enough.)
record(
  /^sha256:[0-9a-f]{64}$/.test(pinnedDigest) ? "PASS" : "WARN",
  "vTPM image digest recorded locally (chain value not directly readable)",
  pinnedDigest.startsWith("sha256:pending")
    ? "still the placeholder — run set-image-digest.mjs after the Confidential Space build"
    : pinnedDigest,
);

const teeAddress = argValue("--tee") ?? enclaveHealth?.teeAddress ?? deployment.devTeeSigner;
if (deployment.flareVtpmAttestation && teeAddress) {
  const vtpm = new Contract(deployment.flareVtpmAttestation, VTPM_ABI, provider);
  try {
    const quote = await withTimeout(vtpm.getRegisteredQuote(teeAddress), "getRegisteredQuote");
    const exp = Number(quote.exp);
    if (exp === 0) {
      record("WARN", "TEE has a live attestation quote", `no quote registered for ${teeAddress}`);
    } else {
      const secondsLeft = exp - Math.floor(Date.now() / 1000);
      record(
        secondsLeft > 0 ? "PASS" : "WARN",
        "TEE has a live attestation quote",
        secondsLeft > 0
          ? `${Math.floor(secondsLeft / 60)} min remaining (${teeAddress})`
          : `expired ${Math.floor(-secondsLeft / 60)} min ago — the enclave re-attestation loop should renew it`,
      );
      // The quote's digest was validated against the contract's internal
      // required digest when it registered — comparing it to the local record
      // is the only way to confirm the on-chain pin matches what we deployed.
      const quoteDigest = Buffer.from(quote.base.imageDigest.slice(2), "hex").toString("utf8");
      if (secondsLeft > 0) {
        record(
          quoteDigest === pinnedDigest ? "PASS" : "FAIL",
          "On-chain attested digest matches local deployment record",
          quoteDigest === pinnedDigest
            ? quoteDigest
            : `chain attested ${quoteDigest} but local record says ${pinnedDigest} — re-run set-image-digest.mjs or redeploy`,
        );
      }
    }
  } catch (error) {
    record("WARN", "TEE has a live attestation quote", error.message);
  }
}

// --- live services ---------------------------------------------------------
async function fetchCheck(label, url, validate) {
  if (!url) {
    record("WARN", label, "not configured — pass the flag to check it");
    return;
  }
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(RPC_TIMEOUT_MS) });
    if (!response.ok) {
      record("FAIL", label, `HTTP ${response.status} from ${url}`);
      return;
    }
    record("PASS", label, await validate(response));
  } catch (error) {
    record("FAIL", label, `${url} — ${error.message}`);
  }
}

await fetchCheck("Enclave reachable", enclaveUrl && `${enclaveUrl.replace(/\/$/, "")}/health`, async (r) => {
  const data = (await r.json())?.data ?? {};
  const inTee = data.inConfidentialSpace === true;
  const onChain = data.attestation?.onChain === true;
  const where = inTee ? "in Confidential Space" : "dev mode — NOT in Confidential Space";
  const chain = onChain
    ? "attested on-chain"
    : `not attested on-chain${data.attestation?.lastError ? ` — ${data.attestation.lastError}` : ""}`;
  return `${where}, ${chain}`;
});

// The quote expires hourly and each renewal costs real gas, so an enclave that
// is healthy today can go quietly unattested mid-judging. Watch the runway.
if (enclaveHealth?.teeAddress && enclaveHealth.attestation?.enabled) {
  try {
    const balance = await withTimeout(provider.getBalance(enclaveHealth.teeAddress), "teeBalance");
    const flr = Number(formatEther(balance));
    // Measured on Coston2: ~1.92M gas at 650 gwei per renewal, once an hour.
    const perDay = 1.25 * 24;
    const daysLeft = flr / perDay;
    record(
      daysLeft >= 2 ? "PASS" : "WARN",
      "Enclave has gas runway for re-attestation",
      `${flr.toFixed(2)} C2FLR ≈ ${daysLeft.toFixed(1)} day(s) at ~${perDay.toFixed(0)}/day — top up with fund-tee.mjs`,
    );
  } catch (error) {
    record("WARN", "Enclave has gas runway for re-attestation", error.message);
  }
}

const appUrl = argValue("--app");
await fetchCheck("App reachable", appUrl, async () => "200 OK");

// --- summary ---------------------------------------------------------------
const failed = results.filter((r) => r.status === "FAIL");
const warned = results.filter((r) => r.status === "WARN");
console.log(`\n${results.length - failed.length - warned.length} passed · ${warned.length} warnings · ${failed.length} failed`);
if (failed.length > 0) {
  console.log("\nBlocking before a demo:");
  for (const f of failed) console.log(`  - ${f.label}: ${f.detail}`);
  process.exit(1);
}
console.log("Also run: node scripts/register-oidc-keys.mjs --check  (Google rotates signing keys)");
