import type { EnclaveInfo } from "./types";

/**
 * Plain data shapes shared between the Adjuster server helpers, API routes,
 * and client components. No imports with side effects — safe for the browser
 * bundle (unlike ./adjuster, which pulls in ethers and env access).
 */

/** A policy as read from ClaimPayout.sol on Coston2. */
export interface AdjusterPolicy {
  policyId: number;
  holder: string;
  date: string;
  lat: string;
  lon: string;
  rainThresholdMmE2: number;
  payoutUsdE2: number;
  premiumWei: string;
  evidenceApproved: boolean;
  evidenceAttested: boolean;
  evidenceHash: string;
  settled: boolean;
  paidOut: boolean;
  paidWei: string;
}

/** GET /api/adjuster/policies */
export interface PoliciesResponse {
  configured: boolean;
  contract: string | null;
  policies: AdjusterPolicy[];
}

/** POST /api/adjuster/buy */
export interface BuyResult {
  policyId: number;
  txHash: string;
  txUrl: string;
}

/** The enclave's FCC ActionResult settlement — what ClaimPayout verifies. */
export interface FccSettlement {
  resultData: string;
  actionId: string;
  submissionTag: string;
  status: number;
  signature: string;
}

/** One evidence check the enclave ran, with its concrete finding. */
export interface ClaimCheck {
  id: "location-match" | "time-match" | "no-reuse" | string;
  pass: boolean;
  finding: string;
}

/** POST {enclave}/claim response data. */
export interface EnclaveClaimData {
  policyId: number;
  eligible: boolean;
  checks: ClaimCheck[];
  distanceKm: number | null;
  dayGap: number | null;
  exif: {
    gpsLat: number | null;
    gpsLon: number | null;
    takenAt: string | null;
    camera?: string | null;
  };
  evidenceSha256: string;
  recorded: boolean;
  enclave: EnclaveInfo;
  fcc: FccSettlement;
}

/** POST /api/adjuster/evidence */
export interface EvidenceResult {
  txHash: string;
  txUrl: string;
  attested: boolean;
  signer: string;
}

/** POST /api/adjuster/settle — the in-flight FDC attestation request. */
export interface SettlementTicket {
  policyId: number;
  roundId: number;
  abiEncodedRequest: string;
  submitTxUrl: string;
}

/** POST /api/adjuster/settle/poll */
export type SettlementPoll =
  | { state: "waiting-finalization" }
  | { state: "waiting-proof" }
  // A permanent, non-retryable outcome (pool empty, already settled, evidence
  // missing) — the browser must stop polling and show `reason`, never keep
  // spinning as if the round were still finalizing.
  | { state: "failed"; reason: string }
  | {
      state: "settled";
      precipitationMmE2: number;
      triggered: boolean;
      paidWei: string;
      evidenceAttested: boolean;
      txUrl: string;
      proofRound: number;
    };
