import { describe, it, expect } from "vitest";
import { makeClaimPhoto } from "./claim-photo";
import { hammingDistance, isDegeneratePerceptualHash, perceptualHash } from "./hash";

const INPUT = { lat: 4.8253, lon: 7.0552, when: "2026:07:22 11:30:00" };

describe("makeClaimPhoto", () => {
  it("never produces a degenerate fingerprint the enclave would reject", async () => {
    // The gradient-scene version of this generator failed exactly this test:
    // smooth scenes collapse to all-zeros/all-ones dHashes.
    for (let seed = 1; seed <= 25; seed++) {
      const jpeg = await makeClaimPhoto({ ...INPUT, seed });
      const phash = await perceptualHash(jpeg);
      expect(isDegeneratePerceptualHash(phash), `seed ${seed} → ${phash}`).toBe(false);
    }
  });

  it("produces perceptually distinct scenes across seeds", async () => {
    const hashes: string[] = [];
    for (let seed = 100; seed < 110; seed++) {
      hashes.push(await perceptualHash(await makeClaimPhoto({ ...INPUT, seed })));
    }
    for (let i = 0; i < hashes.length; i++) {
      for (let j = i + 1; j < hashes.length; j++) {
        expect(
          hammingDistance(hashes[i], hashes[j]),
          `seeds ${100 + i} vs ${100 + j}`,
        ).toBeGreaterThan(10);
      }
    }
  });
});
