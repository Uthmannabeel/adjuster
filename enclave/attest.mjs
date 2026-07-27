// On-chain vTPM attestation — the enclave proves ITSELF to Flare.
//
// Confidential Space issues an OIDC token describing the hardware and the exact
// image digest running on it. FlareVtpmAttestation verifies that token's RS256
// signature fully on-chain and records the quote against the SENDER's address.
// So the enclave sends the transaction from its own signing key: afterwards the
// chain knows that key belongs to an attested workload, and ClaimPayout accepts
// its settlements without any owner having to vouch for the address.
//
// Quotes expire (~1 hour), so this runs as a loop and re-attests before expiry.
import { Contract, JsonRpcProvider, Wallet } from "ethers";
import { fetchAttestationToken, inConfidentialSpace } from "./attestation.mjs";

const VTPM_ABI = [
  "function verifyAndAttest(bytes header, bytes payload, bytes signature) returns (bool)",
  "function getRegisteredQuote(address) view returns (tuple(bytes32 digest,"
  + " tuple(bytes hwmodel, bytes swname, bytes imageDigest, bytes iss, bool secboot) base,"
  + " uint256 exp, uint256 iat))",
];

/** Re-attest this long before the quote expires. */
const REFRESH_MARGIN_MS = 5 * 60 * 1000;
/** Never sleep longer than this, so a stalled clock can't park the loop forever. */
const MAX_REFRESH_MS = 30 * 60 * 1000;
const MIN_REFRESH_MS = 30 * 1000;
const MAX_BACKOFF_MS = 5 * 60 * 1000;
/** Below this the wallet cannot pay for verifyAndAttest (RSA verification is gas-heavy). */
export const MIN_GAS_BALANCE_WEI = 10n ** 17n; // 0.1 C2FLR

/** Split a JWT into the raw byte arrays the contract verifies over. */
export function splitJwt(token) {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("Malformed JWT: expected three dot-separated parts.");
  const [header, payload, signature] = parts.map((p) => Buffer.from(p, "base64url"));
  if (signature.length === 0) throw new Error("Malformed JWT: empty signature.");
  return { header, payload, signature };
}

/** Decode a JWT payload without verifying it (the chain does the verifying). */
export function jwtClaims(token) {
  return JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
}

/** How long to wait before re-attesting, given the quote's expiry. */
export function refreshDelayMs(expSeconds, nowMs = Date.now()) {
  const untilExpiry = expSeconds * 1000 - nowMs;
  return Math.min(MAX_REFRESH_MS, Math.max(MIN_REFRESH_MS, untilExpiry - REFRESH_MARGIN_MS));
}

/** Exponential backoff for failed attempts, capped. */
export function backoffMs(attempt) {
  return Math.min(MAX_BACKOFF_MS, 15_000 * 2 ** Math.max(0, attempt - 1));
}

/**
 * Turn a revert into something an operator can act on. These are the failures
 * that actually happen in a real deploy, and each has a different fix.
 */
export function explainAttestError(message) {
  if (/Public key not found/i.test(message)) {
    return "Google rotated its signing keys — run: node scripts/register-oidc-keys.mjs";
  }
  if (/Invalid image digest/i.test(message)) {
    return "The on-chain required image digest does not match this image — run: node scripts/set-image-digest.mjs";
  }
  if (/Invalid issuer|Invalid hardware model|Invalid software name|secboot/i.test(message)) {
    return "This VM does not match the required Confidential Space base config (hwmodel/swname/iss/secboot).";
  }
  if (/insufficient funds/i.test(message)) {
    return "The enclave signing wallet is out of gas — fund it: node scripts/fund-tee.mjs";
  }
  return null;
}

/**
 * Live attestation state, surfaced on /health and in every claim verdict so a
 * relying party can see whether the chain currently vouches for this enclave.
 */
export function createAttestationState(address) {
  return {
    address,
    enabled: false,
    onChain: false,
    imageDigest: null,
    tokenImageDigest: null,
    expiresAt: null,
    lastTxHash: null,
    lastAttemptAt: null,
    lastError: null,
    hint: null,
  };
}

/** Submit one attestation token to the chain and confirm the quote landed. */
export async function attestOnce({ wallet, vtpmAddress, token, state }) {
  const { header, payload, signature } = splitJwt(token);
  const vtpm = new Contract(vtpmAddress, VTPM_ABI, wallet);

  const tx = await vtpm.verifyAndAttest(header, payload, signature);
  await tx.wait();

  // Trust the chain, not the receipt: read the quote back.
  const quote = await vtpm.getRegisteredQuote(wallet.address);
  const imageDigest = Buffer.from(quote.base.imageDigest.slice(2), "hex").toString("utf8");
  const exp = Number(quote.exp);
  if (exp * 1000 <= Date.now()) throw new Error("Quote registered but already expired.");

  state.onChain = true;
  state.imageDigest = imageDigest;
  state.expiresAt = new Date(exp * 1000).toISOString();
  state.lastTxHash = tx.hash;
  state.lastError = null;
  state.hint = null;
  return { exp, imageDigest, txHash: tx.hash };
}

/**
 * Keep this enclave's on-chain attestation fresh. No-op outside Confidential
 * Space — a dev-mode enclave has nothing real to prove and says so honestly.
 * Returns the mutable state object.
 */
export function startAttestationLoop({
  wallet,
  vtpmAddress,
  audience,
  logger = console,
  state = createAttestationState(wallet?.address ?? null),
}) {
  if (!inConfidentialSpace()) {
    logger.log("attestation: not in Confidential Space — on-chain attestation disabled (dev mode)");
    return state;
  }
  if (!vtpmAddress || !wallet) {
    state.lastError = "FLARE_VTPM_ADDRESS or signing wallet missing";
    logger.error(`attestation: ${state.lastError} — running unattested`);
    return state;
  }

  state.enabled = true;
  let attempt = 0;

  const run = async () => {
    state.lastAttemptAt = new Date().toISOString();
    try {
      const balance = await wallet.provider.getBalance(wallet.address);
      if (balance < MIN_GAS_BALANCE_WEI) {
        throw new Error(`insufficient funds: ${wallet.address} holds ${balance} wei`);
      }

      const token = await fetchAttestationToken(audience, null);
      if (!token) throw new Error("Confidential Space returned no attestation token.");

      // Record what Google says is running here even if the chain later rejects
      // it — on first deploy that mismatch IS the answer, and set-image-digest
      // reads this value to fix it.
      state.tokenImageDigest = jwtClaims(token).submods?.container?.image_digest ?? null;

      const { exp, imageDigest, txHash } = await attestOnce({ wallet, vtpmAddress, token, state });
      attempt = 0;
      logger.log(`attestation: registered on-chain (${imageDigest}) tx ${txHash}, expires ${state.expiresAt}`);
      schedule(refreshDelayMs(exp));
    } catch (error) {
      attempt += 1;
      const message = error.shortMessage ?? error.message ?? String(error);
      state.onChain = false;
      state.lastError = message;
      state.hint = explainAttestError(message);
      logger.error(`attestation: attempt ${attempt} failed — ${message}${state.hint ? ` | ${state.hint}` : ""}`);
      schedule(backoffMs(attempt));
    }
  };

  const schedule = (ms) => {
    const timer = setTimeout(run, ms);
    if (typeof timer.unref === "function") timer.unref();
  };

  run();
  return state;
}

/** Build the RPC-connected signing wallet the loop attests with. */
export function attestationWallet(privateKey, rpcUrl, chainId = 114) {
  const provider = new JsonRpcProvider(rpcUrl, chainId, { staticNetwork: true });
  return new Wallet(privateKey, provider);
}
