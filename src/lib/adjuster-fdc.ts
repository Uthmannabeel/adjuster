import { AbiCoder, Contract, JsonRpcProvider, Wallet, hexlify, toUtf8Bytes, zeroPadBytes } from "ethers";
import { explorerTx } from "./adjuster";
import type { SettlementPoll, SettlementTicket } from "./adjuster-types";

export type { SettlementPoll, SettlementTicket };

/**
 * FDC Web2Json settlement, serverless-shaped: `startSettlement` submits the
 * attestation request (one short call), `pollSettlement` checks finalization
 * + DA-layer proof and, once available, executes ClaimPayout.settle — each
 * call bounded to a few seconds so the browser can drive the loop.
 */

const DEFAULT_RPC = "https://coston2-api.flare.network/ext/C/rpc";
const VERIFIER_URL =
  "https://fdc-verifiers-testnet.flare.network/verifier/web2/Web2Json/prepareRequest";
const VERIFIER_API_KEY = "00000000-0000-0000-0000-000000000000"; // public testnet key
const DA_LAYER_URL =
  "https://ctn2-data-availability.flare.network/api/v1/fdc/proof-by-request-round-raw";
const FLARE_CONTRACT_REGISTRY = "0xaD67FE66660Fb8dFE9d6b1b4240d8650e30F6019";

const POST_PROCESS_JQ = "{precipitationMmE2: (.daily.precipitation_sum[0] * 100)}";
const ABI_SIGNATURE =
  '{"components": [{"internalType": "uint256","name": "precipitationMmE2","type": "uint256"}],"name": "task","type": "tuple"}';

const RESPONSE_TYPE =
  "tuple(bytes32 attestationType, bytes32 sourceId, uint64 votingRound, uint64 lowestUsedTimestamp," +
  " tuple(string url, string httpMethod, string headers, string queryParams, string body," +
  " string postProcessJq, string abiSignature) requestBody, tuple(bytes abiEncodedData) responseBody)";

const CLAIMS_MIN_ABI = [
  "function WEATHER_API_URL() view returns (string)",
  "function expectedQueryParams(uint256) view returns (string)",
  "function policies(uint256) view returns (address holder, string date, string lat, string lon,"
  + " uint256 rainThresholdMmE2, uint256 payoutUsdE2, uint256 premiumWei, bool evidenceApproved,"
  + " bool evidenceAttested, bytes32 evidenceHash, bool settled, bool paidOut, uint256 paidWei)",
  // Components must be NAMED — ethers cannot map object arguments (the
  // { merkleProof, data } proof) onto unnamed tuple components.
  "function settle(uint256 policyId, (bytes32[] merkleProof, (bytes32 attestationType, bytes32 sourceId,"
  + " uint64 votingRound, uint64 lowestUsedTimestamp, (string url, string httpMethod, string headers,"
  + " string queryParams, string body, string postProcessJq, string abiSignature) requestBody,"
  + " (bytes abiEncodedData) responseBody) data) proof)",
  "event Settled(uint256 indexed policyId, uint256 precipitationMmE2, bool triggered, uint256 paidWei, bool evidenceAttested)",
  // Declared so ethers can DECODE a settle() revert instead of surfacing
  // "unknown custom error" — the browser then shows the real cause rather
  // than spinning for eight minutes blaming the weather oracle.
  "error NoSuchPolicy()",
  "error AlreadySettled()",
  "error EvidenceMissing()",
  "error InvalidFdcProof()",
  "error WrongAttestationType()",
  "error RequestMismatch()",
  "error InsufficientPool()",
];

/** Map a ClaimPayout settle() revert to a plain, judge-readable reason. */
function settleRevertReason(error: unknown): string | null {
  const e = error as { code?: string; revert?: { name?: string }; shortMessage?: string; info?: unknown };
  const name = e?.revert?.name;
  switch (name) {
    case "InsufficientPool":
      return "The demo payout pool is temporarily empty — it is being topped up. Try again shortly.";
    case "AlreadySettled":
      return "This policy has already been settled.";
    case "EvidenceMissing":
      return "No approved evidence is on-chain for this policy yet — file a claim first.";
    case "RequestMismatch":
      return "The weather request did not match this policy's pinned parameters.";
    case "WrongAttestationType":
    case "InvalidFdcProof":
      return "The Flare Data Connector proof did not verify on-chain. Retry the settlement.";
    case "NoSuchPolicy":
      return "That policy does not exist on the contract.";
    default:
      // A genuine contract revert (CALL_EXCEPTION) with no decoded name is
      // still permanent — do not let the caller treat it as a transient blip.
      return e?.code === "CALL_EXCEPTION"
        ? "The settlement transaction reverted on-chain. Retry the settlement."
        : null;
  }
}

const DA_FETCH_TIMEOUT_MS = 12_000;

async function fetchJson(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function provider(): JsonRpcProvider {
  return new JsonRpcProvider(process.env.FLARE_RPC_URL ?? DEFAULT_RPC, 114, { staticNetwork: true });
}

function registry(): Contract {
  return new Contract(
    FLARE_CONTRACT_REGISTRY,
    ["function getContractAddressByName(string) view returns (address)"],
    provider(),
  );
}

async function flareContract(name: string, abi: string[], signed = false): Promise<Contract> {
  const address = await registry().getContractAddressByName(name);
  if (signed) {
    const pk = process.env.FLARE_DEPLOYER_PRIVATE_KEY;
    if (!pk) throw new Error("FLARE_DEPLOYER_PRIVATE_KEY is not configured.");
    return new Contract(address, abi, new Wallet(pk, provider()));
  }
  return new Contract(address, abi, provider());
}

function claims(signed = false): Contract {
  const address = process.env.CLAIM_PAYOUT_ADDRESS;
  if (!address) throw new Error("CLAIM_PAYOUT_ADDRESS is not configured.");
  if (signed) {
    const pk = process.env.FLARE_DEPLOYER_PRIVATE_KEY;
    if (!pk) throw new Error("FLARE_DEPLOYER_PRIVATE_KEY is not configured.");
    return new Contract(address, CLAIMS_MIN_ABI, new Wallet(pk, provider()));
  }
  return new Contract(address, CLAIMS_MIN_ABI, provider());
}

const toUtf8Hex32 = (s: string) => zeroPadBytes(hexlify(toUtf8Bytes(s)), 32);

/** Step 1: prepare the attestation request and submit it to FdcHub. */
export async function startSettlement(policyId: number): Promise<SettlementTicket> {
  const c = claims();
  // Refuse to spend the FDC fee on a request that settle() would only reject.
  const policy = await c.policies(policyId);
  if (policy.settled) throw new Error("This policy has already been settled.");
  if (!policy.evidenceApproved) {
    throw new Error("No approved evidence is on-chain for this policy — file a claim first.");
  }
  const [apiUrl, queryParams] = await Promise.all([
    c.WEATHER_API_URL(),
    c.expectedQueryParams(policyId),
  ]);

  const prepared = await fetchJson(
    VERIFIER_URL,
    {
      method: "POST",
      headers: { "X-API-KEY": VERIFIER_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({
        attestationType: toUtf8Hex32("Web2Json"),
        sourceId: toUtf8Hex32("PublicWeb2"),
        requestBody: {
          url: apiUrl,
          httpMethod: "GET",
          headers: "{}",
          queryParams,
          body: "{}",
          postProcessJq: POST_PROCESS_JQ,
          abiSignature: ABI_SIGNATURE,
        },
      }),
    },
    DA_FETCH_TIMEOUT_MS,
  );
  const prepJson = (await prepared.json()) as { abiEncodedRequest?: string; status?: string };
  if (!prepJson.abiEncodedRequest) {
    throw new Error(`Verifier rejected the request: ${prepJson.status ?? "unknown"}`);
  }
  const abiEncodedRequest = prepJson.abiEncodedRequest;

  const feeConfig = await flareContract("FdcRequestFeeConfigurations", [
    "function getRequestFee(bytes) view returns (uint256)",
  ]);
  const fee = await feeConfig.getRequestFee(abiEncodedRequest);
  const fdcHub = await flareContract("FdcHub", ["function requestAttestation(bytes) payable"], true);
  const tx = await fdcHub.requestAttestation(abiEncodedRequest, { value: fee });
  const receipt = await tx.wait();

  const fsm = await flareContract("FlareSystemsManager", [
    "function firstVotingRoundStartTs() view returns (uint64)",
    "function votingEpochDurationSeconds() view returns (uint64)",
  ]);
  const block = await provider().getBlock(receipt.blockNumber);
  if (!block) throw new Error("Submission block not found.");
  const roundId = Number(
    (BigInt(block.timestamp) - (await fsm.firstVotingRoundStartTs())) /
      (await fsm.votingEpochDurationSeconds()),
  );

  return { policyId, roundId, abiEncodedRequest, submitTxUrl: explorerTx(tx.hash) };
}

/** Step 2 (repeat until settled): check finalization, fetch proof, settle. */
export async function pollSettlement(ticket: SettlementTicket): Promise<SettlementPoll> {
  // Terminal-state pre-check BEFORE any FDC work: if the policy is already
  // settled or has no approved evidence, the eventual settle() would revert —
  // catch it now and return a clear reason instead of burning a round.
  const readClaims = claims();
  const policy = await readClaims.policies(ticket.policyId);
  if (policy.settled) {
    return {
      state: "settled",
      precipitationMmE2: 0,
      triggered: policy.paidOut,
      paidWei: policy.paidWei.toString(),
      evidenceAttested: policy.evidenceAttested,
      txUrl: "",
      proofRound: ticket.roundId,
    };
  }
  if (!policy.evidenceApproved) {
    return { state: "failed", reason: "No approved evidence is on-chain for this policy — file a claim first." };
  }

  const fdcVerification = await flareContract("FdcVerification", [
    "function fdcProtocolId() view returns (uint8)",
  ]);
  const relay = await flareContract("Relay", [
    "function isFinalized(uint256,uint256) view returns (bool)",
  ]);
  const protocolId = await fdcVerification.fdcProtocolId();
  if (!(await relay.isFinalized(protocolId, ticket.roundId))) {
    return { state: "waiting-finalization" };
  }

  let proof: { response_hex?: string; proof?: string[] } = {};
  let proofRound = ticket.roundId;
  for (const r of [ticket.roundId, ticket.roundId + 1, ticket.roundId + 2, ticket.roundId + 3]) {
    const res = await fetchJson(
      DA_LAYER_URL,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ votingRoundId: r, requestBytes: ticket.abiEncodedRequest }),
      },
      DA_FETCH_TIMEOUT_MS,
    );
    const j = (await res.json().catch(() => ({}))) as { response_hex?: string; proof?: string[] };
    if (j.response_hex) {
      proof = j;
      proofRound = r;
      break;
    }
  }
  if (!proof.response_hex || !proof.proof) return { state: "waiting-proof" };

  const decoded = AbiCoder.defaultAbiCoder().decode([RESPONSE_TYPE], proof.response_hex)[0];
  const rb = decoded.requestBody;
  const data = {
    attestationType: decoded.attestationType,
    sourceId: decoded.sourceId,
    votingRound: decoded.votingRound,
    lowestUsedTimestamp: decoded.lowestUsedTimestamp,
    requestBody: {
      url: rb.url,
      httpMethod: rb.httpMethod,
      headers: rb.headers,
      queryParams: rb.queryParams,
      body: rb.body,
      postProcessJq: rb.postProcessJq,
      abiSignature: rb.abiSignature,
    },
    responseBody: { abiEncodedData: decoded.responseBody.abiEncodedData },
  };

  const c = claims(true);
  let tx: { hash: string; wait: () => Promise<{ logs: Array<{ topics: ReadonlyArray<string>; data: string }> }> };
  let receipt: { logs: Array<{ topics: ReadonlyArray<string>; data: string }> };
  try {
    tx = await c.settle(ticket.policyId, { merkleProof: proof.proof, data });
    receipt = await tx.wait();
  } catch (error: unknown) {
    const reason = settleRevertReason(error);
    // A decoded/CALL_EXCEPTION revert is permanent → surface it and stop.
    // Anything else (RPC blip mid-send) is left to throw so the caller's
    // transient path retries.
    if (reason) return { state: "failed", reason };
    throw error;
  }

  let precipitationMmE2 = 0;
  let triggered = false;
  let paidWei = "0";
  let evidenceAttested = false;
  for (const log of receipt.logs) {
    try {
      const parsed = c.interface.parseLog(log);
      if (parsed?.name === "Settled") {
        precipitationMmE2 = Number(parsed.args.precipitationMmE2);
        triggered = Boolean(parsed.args.triggered);
        paidWei = parsed.args.paidWei.toString();
        evidenceAttested = Boolean(parsed.args.evidenceAttested);
      }
    } catch {
      /* other logs */
    }
  }

  return {
    state: "settled",
    precipitationMmE2,
    triggered,
    paidWei,
    evidenceAttested,
    txUrl: explorerTx(tx.hash),
    proofRound,
  };
}
