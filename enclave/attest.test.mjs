import { describe, expect, test } from "vitest";
import {
  backoffMs,
  createAttestationState,
  explainAttestError,
  jwtClaims,
  refreshDelayMs,
  splitJwt,
} from "./attest.mjs";

/** A JWT shaped like a Confidential Space token (unsigned — only bytes matter here). */
function fakeJwt(payload = { exp: 1_800_000_000, hwmodel: "GCP_INTEL_TDX" }) {
  const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64url");
  return `${b64({ alg: "RS256", kid: "abc" })}.${b64(payload)}.${Buffer.from("sig").toString("base64url")}`;
}

describe("splitJwt", () => {
  test("decodes the three parts to the raw bytes the contract re-encodes", () => {
    const { header, payload, signature } = splitJwt(fakeJwt());

    expect(JSON.parse(header.toString("utf8")).kid).toBe("abc");
    expect(JSON.parse(payload.toString("utf8")).hwmodel).toBe("GCP_INTEL_TDX");
    expect(signature.toString("utf8")).toBe("sig");
  });

  test("round-trips through base64url without padding, matching Base64.encodeURL on-chain", () => {
    const token = fakeJwt();
    const { header, payload } = splitJwt(token);
    const [rawHeader, rawPayload] = token.split(".");

    expect(header.toString("base64url")).toBe(rawHeader);
    expect(payload.toString("base64url")).toBe(rawPayload);
  });

  test("rejects malformed tokens", () => {
    expect(() => splitJwt("only.two")).toThrow(/three dot-separated/);
    expect(() => splitJwt("header.payload.")).toThrow(/empty signature/);
  });
});

describe("jwtClaims", () => {
  test("reads the payload claims", () => {
    expect(jwtClaims(fakeJwt({ exp: 42, swname: "CONFIDENTIAL_SPACE" })).swname).toBe("CONFIDENTIAL_SPACE");
  });
});

describe("refreshDelayMs", () => {
  const now = 1_000_000_000_000;

  test("re-attests five minutes before the quote expires", () => {
    const exp = (now + 60 * 60 * 1000) / 1000; // one hour out
    expect(refreshDelayMs(exp, now)).toBe(30 * 60 * 1000); // capped at the 30-minute ceiling
  });

  test("never sleeps past the ceiling, so a stalled clock cannot park the loop", () => {
    const exp = (now + 24 * 60 * 60 * 1000) / 1000;
    expect(refreshDelayMs(exp, now)).toBe(30 * 60 * 1000);
  });

  test("retries promptly rather than never when the quote is already expiring", () => {
    const exp = (now + 60 * 1000) / 1000;
    expect(refreshDelayMs(exp, now)).toBe(30 * 1000);
  });

  test("stays positive for an already-expired quote", () => {
    expect(refreshDelayMs((now - 10_000) / 1000, now)).toBe(30 * 1000);
  });
});

describe("backoffMs", () => {
  test("backs off exponentially from the first attempt", () => {
    expect(backoffMs(1)).toBe(15_000);
    expect(backoffMs(2)).toBe(30_000);
    expect(backoffMs(3)).toBe(60_000);
  });

  test("caps so a long outage still retries every five minutes", () => {
    expect(backoffMs(20)).toBe(5 * 60 * 1000);
  });
});

describe("explainAttestError", () => {
  test("maps each real-deploy failure to the command that fixes it", () => {
    expect(explainAttestError('SignatureVerificationFailed("Public key not found")')).toMatch(
      /register-oidc-keys/,
    );
    expect(explainAttestError('PayloadValidationFailed("Invalid image digest")')).toMatch(
      /set-image-digest/,
    );
    expect(explainAttestError("insufficient funds for intrinsic transaction cost")).toMatch(/fund-tee/);
    expect(explainAttestError('PayloadValidationFailed("Invalid issuer")')).toMatch(/base config/);
  });

  test("returns null for failures with no known operator fix", () => {
    expect(explainAttestError("connection reset")).toBeNull();
  });
});

describe("createAttestationState", () => {
  test("starts unattested — an enclave claims nothing until the chain says so", () => {
    const state = createAttestationState("0xabc");
    expect(state).toMatchObject({ address: "0xabc", enabled: false, onChain: false, lastTxHash: null });
  });
});
