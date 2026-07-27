import { describe, it, expect } from "vitest";
import sharp from "sharp";
import {
  bands,
  bitCount,
  contentHash,
  hammingDistance,
  isDegeneratePerceptualHash,
  perceptualHash,
} from "./hash";

describe("hammingDistance", () => {
  it("is 0 for identical fingerprints", () => {
    expect(hammingDistance("0cd2d2d2d2c40800", "0cd2d2d2d2c40800")).toBe(0);
  });

  it("counts differing bits", () => {
    expect(hammingDistance("0", "1")).toBe(1); // 0000 vs 0001
    expect(hammingDistance("f", "0")).toBe(4); // 1111 vs 0000
  });
});

describe("bitCount", () => {
  it("counts set bits across the fingerprint", () => {
    expect(bitCount("0000000000000000")).toBe(0);
    expect(bitCount("ffffffffffffffff")).toBe(64);
    expect(bitCount("0000000000000001")).toBe(1);
  });
});

describe("isDegeneratePerceptualHash", () => {
  it("flags the all-zeros and all-ones poles a flat image collapses to", () => {
    expect(isDegeneratePerceptualHash("0000000000000000")).toBe(true);
    expect(isDegeneratePerceptualHash("ffffffffffffffff")).toBe(true);
  });

  it("flags anything close enough to a pole to match every other flat image", () => {
    // 5 set bits: two such fingerprints are at most 10 apart — exactly the
    // near-match threshold, so a "match" between them proves nothing.
    expect(bitCount("0000001800000007")).toBe(5);
    expect(isDegeneratePerceptualHash("0000001800000007")).toBe(true);
  });

  it("accepts fingerprints with real detail", () => {
    expect(isDegeneratePerceptualHash("53393132e2b7cb59")).toBe(false);
    expect(isDegeneratePerceptualHash("0cd2d2d2d2c40800")).toBe(false);
  });

  it("tracks the threshold it is given", () => {
    const sixBits = "000000180000000f"; // 6 set bits
    expect(bitCount(sixBits)).toBe(6);
    expect(isDegeneratePerceptualHash(sixBits, 10)).toBe(false);
    expect(isDegeneratePerceptualHash(sixBits, 12)).toBe(true);
  });
});

describe("bands (LSH)", () => {
  it("splits a 16-char fingerprint into 8 bands", () => {
    const b = bands("0123456789abcdef");
    expect(b).toHaveLength(8);
    expect(b[0]).toBe("0:01");
    expect(b[7]).toBe("7:ef");
  });

  it("two near-identical fingerprints share at least one band", () => {
    const a = "0cd2d2d2d2c40800";
    const close = "0cd2d2d2d2c40801"; // differs only in the final band
    const shared = bands(a).filter((band) => bands(close).includes(band));
    expect(shared.length).toBeGreaterThan(0);
  });
});

describe("perceptualHash", () => {
  it("is deterministic and 16 hex chars", async () => {
    const img = await sharp({
      create: { width: 64, height: 64, channels: 3, background: { r: 10, g: 120, b: 200 } },
    })
      .png()
      .toBuffer();
    const h1 = await perceptualHash(img);
    const h2 = await perceptualHash(img);
    expect(h1).toBe(h2);
    expect(h1).toHaveLength(16);
  });
});

describe("contentHash", () => {
  it("differs when bytes differ", () => {
    expect(contentHash(Buffer.from("a"))).not.toBe(contentHash(Buffer.from("b")));
  });
});
