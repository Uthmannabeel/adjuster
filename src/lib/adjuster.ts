import { Contract, JsonRpcProvider, Wallet, formatEther, parseEther } from "ethers";
import type { AdjusterPolicy, FccSettlement } from "./adjuster-types";

export type { AdjusterPolicy, FccSettlement };

/**
 * Adjuster chain access — server-side helpers over the ClaimPayout contract
 * on Coston2. The demo relays transactions with the server wallet so judges
 * need no wallet or login (custody note in the limitations section); the
 * claim PHOTO never passes through here — browsers talk to the enclave
 * directly and only the signed FCC settlement reaches these helpers.
 */

const DEFAULT_RPC = "https://coston2-api.flare.network/ext/C/rpc";
const COSTON2_CHAIN_ID = 114;
const EXPLORER_BASE = "https://coston2-explorer.flare.network";
const RPC_TIMEOUT_MS = 15_000;

const CLAIMS_ABI = [
  "function policyCount() view returns (uint256)",
  "function policies(uint256) view returns (address holder, string date, string lat, string lon,"
  + " uint256 rainThresholdMmE2, uint256 payoutUsdE2, uint256 premiumWei, bool evidenceApproved,"
  + " bool evidenceAttested, bytes32 evidenceHash, bool settled, bool paidOut, uint256 paidWei)",
  "function buyPolicy(string date, string lat, string lon, uint256 rainThresholdMmE2, uint256 payoutUsdE2) payable returns (uint256)",
  "function submitEvidence(bytes resultData, bytes32 actionId, string submissionTag, uint8 status, bytes signature)",
  "function settle(uint256 policyId, (bytes32[] merkleProof, (bytes32 attestationType, bytes32 sourceId,"
  + " uint64 votingRound, uint64 lowestUsedTimestamp, (string url, string httpMethod, string headers,"
  + " string queryParams, string body, string postProcessJq, string abiSignature) requestBody,"
  + " (bytes abiEncodedData) responseBody) data) proof)",
  "function WEATHER_API_URL() view returns (string)",
  "function expectedQueryParams(uint256) view returns (string)",
  "function devSigners(address) view returns (bool)",
  "event EvidenceAccepted(uint256 indexed policyId, bytes32 evidenceHash, bool attested, address signer)",
  "event Settled(uint256 indexed policyId, uint256 precipitationMmE2, bool triggered, uint256 paidWei, bool evidenceAttested)",
];

export function adjusterConfigured(): boolean {
  return Boolean(process.env.CLAIM_PAYOUT_ADDRESS && process.env.FLARE_DEPLOYER_PRIVATE_KEY);
}

export function claimsAddress(): string | null {
  return process.env.CLAIM_PAYOUT_ADDRESS ?? null;
}

export function explorerTx(hash: string): string {
  return `${EXPLORER_BASE}/tx/${hash}`;
}

function provider(): JsonRpcProvider {
  return new JsonRpcProvider(process.env.FLARE_RPC_URL ?? DEFAULT_RPC, COSTON2_CHAIN_ID, {
    staticNetwork: true,
  });
}

function readContract(): Contract {
  const address = process.env.CLAIM_PAYOUT_ADDRESS;
  if (!address) throw new Error("CLAIM_PAYOUT_ADDRESS is not configured.");
  return new Contract(address, CLAIMS_ABI, provider());
}

function writeContract(): Contract {
  const pk = process.env.FLARE_DEPLOYER_PRIVATE_KEY;
  if (!pk) throw new Error("FLARE_DEPLOYER_PRIVATE_KEY is not configured.");
  const address = process.env.CLAIM_PAYOUT_ADDRESS;
  if (!address) throw new Error("CLAIM_PAYOUT_ADDRESS is not configured.");
  return new Contract(address, CLAIMS_ABI, new Wallet(pk, provider()));
}

async function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label}: Flare RPC timed out.`)), RPC_TIMEOUT_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Retries a READ against the chain. The first RPC call from a cold serverless
 * function is the one most likely to time out, and that is exactly the request a
 * visitor's first page load triggers — one slow node should not read as an empty
 * book. Deliberately not applied to writes: resending a transaction is not safe.
 */
async function withReadRetry<T>(read: () => Promise<T>, attempts = 3): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await read();
    } catch (error: unknown) {
      lastError = error;
      if (attempt < attempts - 1) {
        await new Promise((resolve) => setTimeout(resolve, 600 * (attempt + 1)));
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Flare RPC read failed.");
}

function toPolicy(policyId: number, p: Record<string, unknown> & ArrayLike<unknown>): AdjusterPolicy {
  const raw = p as unknown as {
    holder: string; date: string; lat: string; lon: string;
    rainThresholdMmE2: bigint; payoutUsdE2: bigint; premiumWei: bigint;
    evidenceApproved: boolean; evidenceAttested: boolean; evidenceHash: string;
    settled: boolean; paidOut: boolean; paidWei: bigint;
  };
  return {
    policyId,
    holder: raw.holder,
    date: raw.date,
    lat: raw.lat,
    lon: raw.lon,
    rainThresholdMmE2: Number(raw.rainThresholdMmE2),
    payoutUsdE2: Number(raw.payoutUsdE2),
    premiumWei: raw.premiumWei.toString(),
    evidenceApproved: raw.evidenceApproved,
    evidenceAttested: raw.evidenceAttested,
    evidenceHash: raw.evidenceHash,
    settled: raw.settled,
    paidOut: raw.paidOut,
    paidWei: raw.paidWei.toString(),
  };
}

/** All policies, newest first. */
export async function listPolicies(limit = 50): Promise<AdjusterPolicy[]> {
  return withReadRetry(async () => {
    const contract = readContract();
    const count = Number(await withTimeout(contract.policyCount(), "policyCount"));
    const from = Math.max(0, count - limit);
    const out: AdjusterPolicy[] = [];
    for (let i = count - 1; i >= from; i--) {
      out.push(toPolicy(i, await withTimeout(contract.policies(i), `policies(${i})`)));
    }
    return out;
  });
}

export async function getPolicy(policyId: number): Promise<AdjusterPolicy> {
  const contract = readContract();
  return toPolicy(policyId, await withTimeout(contract.policies(policyId), `policies(${policyId})`));
}

/** Buy a policy with the relay wallet (premium in C2FLR). */
export async function buyPolicy(input: {
  date: string;
  lat: string;
  lon: string;
  rainThresholdMmE2: number;
  payoutUsdE2: number;
  premiumC2FLR: string;
}): Promise<{ policyId: number; txHash: string; txUrl: string }> {
  const contract = writeContract();
  const tx = await withTimeout(
    contract.buyPolicy(
      input.date,
      input.lat,
      input.lon,
      BigInt(input.rainThresholdMmE2),
      BigInt(input.payoutUsdE2),
      { value: parseEther(input.premiumC2FLR) },
    ),
    "buyPolicy",
  );
  await withTimeout(tx.wait(), "buyPolicy confirmation");
  const policyId = Number(await withTimeout(contract.policyCount(), "policyCount")) - 1;
  return { policyId, txHash: tx.hash, txUrl: explorerTx(tx.hash) };
}

/** Native-token balance of the payout pool (the contract's own balance). */
export async function poolBalanceWei(): Promise<string> {
  const address = process.env.CLAIM_PAYOUT_ADDRESS;
  if (!address) throw new Error("CLAIM_PAYOUT_ADDRESS is not configured.");
  const balance = await withReadRetry(() =>
    withTimeout(provider().getBalance(address), "poolBalance"),
  );
  return balance.toString();
}

/** Relay the enclave's FCC-signed evidence settlement on-chain. */
export async function submitEvidence(
  fcc: FccSettlement,
): Promise<{ txHash: string; txUrl: string; attested: boolean; signer: string }> {
  const contract = writeContract();
  const tx = await withTimeout(
    contract.submitEvidence(fcc.resultData, fcc.actionId, fcc.submissionTag, fcc.status, fcc.signature),
    "submitEvidence",
  );
  const receipt = (await withTimeout(tx.wait(), "submitEvidence confirmation")) as {
    logs: Array<{ topics: ReadonlyArray<string>; data: string }>;
  };
  let attested = false;
  let signer = "";
  for (const log of receipt.logs) {
    try {
      const parsed = contract.interface.parseLog(log);
      if (parsed?.name === "EvidenceAccepted") {
        attested = Boolean(parsed.args.attested);
        signer = String(parsed.args.signer);
      }
    } catch {
      /* other contracts' logs */
    }
  }
  return { txHash: tx.hash, txUrl: explorerTx(tx.hash), attested, signer };
}

export { formatEther };

/* ── Pre-upload attestation check ─────────────────────────────────────────
   The browser sends the claim photo to the enclave BEFORE any signature can
   prove what received it, so the claim page verifies the endpoint first: it
   asks the enclave who it is, then checks ON-CHAIN — independently of the
   enclave's self-report — that this key holds a live vTPM quote whose image
   digest matches the container the enclave claims to be running. An operator
   swapping in a non-TEE server fails this check before any photo is sent.
   (Residual gap, documented: the TLS key is not itself quote-bound — full
   RA-TLS channel binding is roadmap.) */

const VTPM_ABI = [
  "function getRegisteredQuote(address) view returns ((bytes32 digest, (bytes hwmodel, bytes swname,"
  + " bytes imageDigest, bytes iss, bool secboot) base, uint256 exp, uint256 iat))",
];

export interface EnclaveAttestationStatus {
  checked: boolean;
  attested: boolean;
  reason: string;
  teeAddress: string | null;
  expiresAt: string | null;
  imageDigest: string | null;
}

export async function enclaveAttestationStatus(): Promise<EnclaveAttestationStatus> {
  const enclaveUrl = (process.env.NEXT_PUBLIC_ENCLAVE_URL ?? "").replace(/\/$/, "");
  const vtpmAddress = process.env.FLARE_VTPM_ADDRESS;
  if (!enclaveUrl || !vtpmAddress) {
    return {
      checked: false,
      attested: false,
      reason: "Attestation check not configured.",
      teeAddress: null,
      expiresAt: null,
      imageDigest: null,
    };
  }

  let teeAddress: string | null = null;
  let reportedDigest: string | null = null;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    const health = await (await fetch(`${enclaveUrl}/health`, { signal: controller.signal })).json();
    clearTimeout(timer);
    teeAddress = health?.data?.teeAddress ?? null;
    reportedDigest =
      health?.data?.attestation?.tokenImageDigest ?? health?.data?.attestation?.imageDigest ?? null;
    if (!teeAddress) throw new Error("enclave did not report a signing address");
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "unreachable";
    return {
      checked: true,
      attested: false,
      reason: `Enclave unreachable (${message}).`,
      teeAddress: null,
      expiresAt: null,
      imageDigest: null,
    };
  }

  try {
    const vtpm = new Contract(vtpmAddress, VTPM_ABI, provider());
    const quote = await withReadRetry(() => withTimeout(vtpm.getRegisteredQuote(teeAddress), "getRegisteredQuote"));
    const exp = Number(quote.exp);
    const now = Math.floor(Date.now() / 1000);
    if (exp === 0) {
      return {
        checked: true,
        attested: false,
        reason: "No vTPM quote is registered on-chain for this enclave's key.",
        teeAddress,
        expiresAt: null,
        imageDigest: null,
      };
    }
    if (exp < now) {
      return {
        checked: true,
        attested: false,
        reason: "The enclave's on-chain quote has expired and not yet renewed.",
        teeAddress,
        expiresAt: new Date(exp * 1000).toISOString(),
        imageDigest: null,
      };
    }
    const chainDigest = Buffer.from(quote.base.imageDigest.slice(2), "hex").toString("utf8");
    if (reportedDigest && chainDigest && reportedDigest !== chainDigest) {
      return {
        checked: true,
        attested: false,
        reason: "The enclave reports a different container image than the chain attests.",
        teeAddress,
        expiresAt: new Date(exp * 1000).toISOString(),
        imageDigest: chainDigest,
      };
    }
    return {
      checked: true,
      attested: true,
      reason: "Live on-chain vTPM quote; image digest matches.",
      teeAddress,
      expiresAt: new Date(exp * 1000).toISOString(),
      imageDigest: chainDigest || reportedDigest,
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "read failed";
    return {
      checked: true,
      attested: false,
      reason: `Could not read the on-chain quote (${message}).`,
      teeAddress,
      expiresAt: null,
      imageDigest: null,
    };
  }
}
