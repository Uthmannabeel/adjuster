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
import { Contract, Interface, JsonRpcProvider, Wallet } from "ethers";
import { fetchAttestationToken, inConfidentialSpace } from "./attestation.mjs";

const VTPM_ABI = [
  "function verifyAndAttest(bytes header, bytes payload, bytes signature) returns (bool)",
  "function getRegisteredQuote(address) view returns (tuple(bytes32 digest,"
  + " tuple(bytes hwmodel, bytes swname, bytes imageDigest, bytes iss, bool secboot) base,"
  + " uint256 exp, uint256 iat))",
  // Without these the chain's reason arrives as "unknown custom error", which
  // hides exactly the detail an operator needs. Every custom error reachable
  // from verifyAndAttest is listed, across the whole vendored verification
  // stack — the useful ones are the deep crypto failures, not the top-level checks.
  "error PayloadValidationFailed(string errorMsg)",
  "error SignatureVerificationFailed(string errorMsg)",
  "error InvalidVerifier()",
  "error InvalidAlgorithm()",
  "error InvalidJWTFormat()",
  "error InvalidJWTSignature()",
  "error InvalidPadding()",
  "error InvalidRSAKey()",
  "error InvalidSignatureLength()",
  "error DivisionByZero()",
  "error InvalidBignumLength()",
  "error NegativeNumber()",
  "error InvalidBase64()",
  "error InvalidCertificate()",
  "error InvalidSignature()",
  "error InvalidCertificateFormat()",
  "error InvalidCertificateChainError(string message)",
  "error ValidatePKIError(string message)",
  "error InvalidX5CLength(uint256 length)",
  "error NotOwner()",
];

/** Prefer the decoded custom error, which names the specific failing check. */
function revertMessage(error) {
  const revert = error?.revert;
  if (revert?.name) {
    const args = (revert.args ?? []).map(String).filter(Boolean).join(", ");
    return args ? `${revert.name}: ${args}` : revert.name;
  }
  return error?.shortMessage ?? error?.message ?? String(error);
}

/** Raw revert bytes, wherever ethers hung them off the error this time. */
function revertData(error) {
  const data = error?.data ?? error?.info?.error?.data ?? error?.error?.data ?? null;
  return typeof data === "string" && data.startsWith("0x") ? data : null;
}

/**
 * Decode the revert ourselves. Ethers does not always attach the contract's
 * interface to a gas-estimation failure, and these errors carry the one string
 * that says which check rejected the quote — losing it costs a deploy cycle.
 */
function decodeRevert(iface, error) {
  const data = revertData(error);
  if (!data) return null;
  try {
    const parsed = iface.parseError(data);
    if (!parsed) return null;
    const args = (parsed.args ?? []).map(String).filter(Boolean).join(", ");
    return args ? `${parsed.name}: ${args}` : parsed.name;
  } catch {
    return null;
  }
}

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
    tokenBase: null,
    lastRevertData: null,
    expiresAt: null,
    lastTxHash: null,
    lastAttemptAt: null,
    lastError: null,
    hint: null,
  };
}

/**
 * The contract rejects a quote whose `iat` is ahead of `block.timestamp`. A
 * token minted "now" loses that comparison against the latest block, which is
 * always a second or two in the past — so gas estimation reverts with
 * "Invalid issued at time" even though the transaction would be mined into a
 * later, perfectly valid block. Let the chain catch up first.
 */
export async function waitForChainTime(provider, iatSeconds, options = {}) {
  const { maxWaitMs = 90_000, pollMs = 2_000, now = () => Date.now() } = options;
  if (!iatSeconds) return null;
  const deadline = now() + maxWaitMs;
  for (;;) {
    const block = await provider.getBlock("latest");
    if (block && Number(block.timestamp) >= iatSeconds) return Number(block.timestamp);
    if (now() >= deadline) {
      throw new Error(
        `Chain time is still behind the token's issued-at (${iatSeconds}) after ${maxWaitMs}ms.`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

/** Submit one attestation token to the chain and confirm the quote landed. */
export async function attestOnce({ wallet, vtpmAddress, token, state }) {
  const { header, payload, signature } = splitJwt(token);
  const vtpm = new Contract(vtpmAddress, VTPM_ABI, wallet);

  await waitForChainTime(wallet.provider, jwtClaims(token).iat);

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
      const claims = jwtClaims(token);
      state.tokenImageDigest = claims.submods?.container?.image_digest ?? null;
      // The four values the chain's base config must match exactly. Publishing
      // them turns "execution reverted" into a diff an operator can read.
      state.tokenBase = {
        hwmodel: claims.hwmodel ?? null,
        swname: claims.swname ?? null,
        iss: claims.iss ?? null,
        secboot: claims.secboot ?? null,
      };

      const { exp, imageDigest, txHash } = await attestOnce({ wallet, vtpmAddress, token, state });
      attempt = 0;
      logger.log(`attestation: registered on-chain (${imageDigest}) tx ${txHash}, expires ${state.expiresAt}`);
      schedule(refreshDelayMs(exp));
    } catch (error) {
      attempt += 1;
      const iface = new Interface(VTPM_ABI);
      const message = decodeRevert(iface, error) ?? revertMessage(error);
      state.onChain = false;
      state.lastError = message;
      state.lastRevertData = revertData(error);
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
