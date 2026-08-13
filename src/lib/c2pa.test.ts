import { describe, it, expect } from "vitest";
import {
  SOFT_BINDING_ALG,
  decodeSoftBindingValue,
  presentedKey,
  resolveByBinding,
  similarityScore,
} from "./c2pa";
import type { NearMatch } from "./store";
import type { Registration } from "./types";

const record = { id: "rec-123", phash: "0cd2d2d2d2c40800" } as Registration;
const noMatch = async (): Promise<NearMatch | null> => null;
const matchAt = (distance: number) => async (): Promise<NearMatch | null> => ({ record, distance });

// base64 of 8 bytes 0c d2 d2 d2 d2 c4 08 00
const VALUE = Buffer.from("0cd2d2d2d2c40800", "hex").toString("base64");

describe("decodeSoftBindingValue", () => {
  it("decodes 8 base64 bytes to a 16-hex-char fingerprint", () => {
    expect(decodeSoftBindingValue(VALUE)).toBe("0cd2d2d2d2c40800");
  });

  it("rejects values that are not 8 bytes", () => {
    expect(decodeSoftBindingValue(Buffer.from("0cd2d2", "hex").toString("base64"))).toBeNull();
    expect(decodeSoftBindingValue(Buffer.alloc(9).toString("base64"))).toBeNull();
  });

  it("rejects strings that are not base64", () => {
    expect(decodeSoftBindingValue("not base64!!")).toBeNull();
  });
});

describe("similarityScore", () => {
  it("maps distance 0 to 100 and distance 64 to 0", () => {
    expect(similarityScore(0)).toBe(100);
    expect(similarityScore(64)).toBe(0);
  });

  it("maps the near-match threshold sensibly", () => {
    expect(similarityScore(10)).toBe(84);
  });

  it("clamps out-of-range distances", () => {
    expect(similarityScore(-3)).toBe(100);
    expect(similarityScore(400)).toBe(0);
  });
});

describe("presentedKey", () => {
  it("prefers the enclave header, falls back to Bearer", () => {
    expect(presentedKey("Bearer abc", null)).toBe("abc");
    expect(presentedKey("Bearer abc", "xyz")).toBe("xyz");
    expect(presentedKey(null, null)).toBeNull();
    expect(presentedKey("Basic abc", null)).toBeNull();
  });
});

describe("resolveByBinding", () => {
  it("returns a spec-shaped match with a similarity score", async () => {
    const result = await resolveByBinding({ alg: SOFT_BINDING_ALG, value: VALUE, maxResults: null }, matchAt(3));
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ matches: [{ manifestId: "rec-123", similarityScore: 95 }] });
  });

  it("returns an empty matches array when nothing resolves", async () => {
    const result = await resolveByBinding({ alg: SOFT_BINDING_ALG, value: VALUE, maxResults: null }, noMatch);
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ matches: [] });
  });

  it("rejects an unknown algorithm", async () => {
    const result = await resolveByBinding({ alg: "com.example.other", value: VALUE, maxResults: null }, noMatch);
    expect(result.status).toBe(400);
  });

  it("rejects a missing or malformed value", async () => {
    expect((await resolveByBinding({ alg: SOFT_BINDING_ALG, value: null, maxResults: null }, noMatch)).status).toBe(400);
    expect((await resolveByBinding({ alg: SOFT_BINDING_ALG, value: "abc", maxResults: null }, noMatch)).status).toBe(400);
  });

  it("rejects a degenerate fingerprint instead of matching noise", async () => {
    const allZeros = Buffer.alloc(8).toString("base64");
    const result = await resolveByBinding({ alg: SOFT_BINDING_ALG, value: allZeros, maxResults: null }, matchAt(0));
    expect(result.status).toBe(400);
    if (result.status === 400) expect(result.body.error).toMatch(/degenerate/i);
  });

  it("validates maxResults", async () => {
    expect(
      (await resolveByBinding({ alg: SOFT_BINDING_ALG, value: VALUE, maxResults: "0" }, noMatch)).status,
    ).toBe(400);
    expect(
      (await resolveByBinding({ alg: SOFT_BINDING_ALG, value: VALUE, maxResults: "abc" }, noMatch)).status,
    ).toBe(400);
    expect(
      (await resolveByBinding({ alg: SOFT_BINDING_ALG, value: VALUE, maxResults: "5" }, matchAt(1))).status,
    ).toBe(200);
  });
});
