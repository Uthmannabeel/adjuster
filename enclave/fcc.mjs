// FCC ActionResult signing — the enclave speaks Flare Confidential Compute's
// wire format natively, so ClaimPayout.sol verifies settlements exactly the
// way Flare's own FCC extension contracts do:
//   hash = keccak256(abi.encodePacked(keccak256(data), actionId, keccak256(tag), status))
//   signature = EIP-191 personal-sign over that 32-byte hash (ecrecover on-chain).
import {
  AbiCoder,
  Wallet,
  getBytes,
  hexlify,
  keccak256,
  randomBytes,
  solidityPacked,
  toUtf8Bytes,
} from "ethers";
import { inConfidentialSpace } from "./attestation.mjs";

export const SUBMISSION_TAG = "submit";
export const STATUS_SUCCESS = 1;

const SETTLEMENT_ABI = [
  "address", // contractAddr — the ClaimPayout this settlement is bound to
  "uint256", // policyId
  "bytes32", // evidenceHash — SHA-256 of the exact photo bytes (0x-prefixed)
  "bool",    // evidenceOk — all evidence checks passed
  "bool",    // reuseDetected — evidence matched a prior claim (fraud signal)
  "int256",  // exifLatE6 — photo GPS latitude × 1e6 (0 when absent)
  "int256",  // exifLonE6 — photo GPS longitude × 1e6 (0 when absent)
  "uint64",  // takenAt — photo capture time, unix seconds (0 when absent)
];

/**
 * The enclave's TEE signing identity.
 *
 * Inside Confidential Space the key is ALWAYS generated in-enclave and never
 * leaves it — nobody, including whoever runs the VM, can sign as this enclave.
 * The image's launch policy backs this up: TEE_SIGNING_KEY is not in the
 * allow_env_override list, so it cannot be injected at deploy time. The key
 * earns its authority by attesting on-chain (see attest.mjs), not by an owner
 * vouching for it.
 *
 * Outside Confidential Space, TEE_SIGNING_KEY gives local development a stable
 * address — one registered as a dev signer, which settlements label loudly.
 */
export function teeWallet() {
  if (inConfidentialSpace()) return Wallet.createRandom();
  const pk = process.env.TEE_SIGNING_KEY;
  return pk ? new Wallet(pk) : Wallet.createRandom();
}

/** ABI-encode a settlement result — field order MUST match ClaimPayout.sol. */
export function encodeSettlement(s) {
  const toE6 = (v) => (v === null ? 0n : BigInt(Math.round(v * 1e6)));
  return AbiCoder.defaultAbiCoder().encode(SETTLEMENT_ABI, [
    s.contractAddr,
    BigInt(s.policyId),
    `0x${s.evidenceSha256}`,
    s.evidenceOk,
    s.reuseDetected,
    toE6(s.exifLat),
    toE6(s.exifLon),
    s.takenAt ? BigInt(Math.floor(Date.parse(s.takenAt) / 1000)) : 0n,
  ]);
}

/** ActionResult.Hash() exactly as FCC contracts reconstruct it. */
export function actionResultHash(resultData, actionId, submissionTag, status) {
  return keccak256(
    solidityPacked(
      ["bytes32", "bytes32", "bytes32", "uint8"],
      [keccak256(resultData), actionId, keccak256(toUtf8Bytes(submissionTag)), status],
    ),
  );
}

/**
 * Sign a settlement in the FCC ActionResult format.
 * Returns everything ClaimPayout.settle() needs, ready to submit on-chain.
 */
export async function signActionResult(wallet, resultData, actionId = null) {
  const id = actionId ?? hexlify(randomBytes(32));
  const hash = actionResultHash(resultData, id, SUBMISSION_TAG, STATUS_SUCCESS);
  const signature = await wallet.signMessage(getBytes(hash));
  return {
    teeAddress: wallet.address,
    resultData,
    actionId: id,
    submissionTag: SUBMISSION_TAG,
    status: STATUS_SUCCESS,
    signature,
  };
}
