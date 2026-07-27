// Fingerprinting inside the enclave — MUST match src/lib/hash.ts exactly so
// enclave verdicts agree with registry records (same sharp ops, same bit order).
import { createHash } from "node:crypto";
import sharp from "sharp";

/** SHA-256 of the exact bytes — exact-original detection. */
export function contentHash(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

/** dHash: 9x8 grayscale, row-wise right-neighbour comparison -> 64 bits -> 16 hex chars. */
export async function perceptualHash(buf) {
  const width = 9;
  const height = 8;
  const { data, info } = await sharp(buf)
    .resize(width, height, { fit: "fill" })
    .grayscale()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const channels = info.channels;
  const pixel = (row, col) => data[(row * width + col) * channels];

  let bits = "";
  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width - 1; col++) {
      bits += pixel(row, col) < pixel(row, col + 1) ? "1" : "0";
    }
  }
  let hex = "";
  for (let i = 0; i < bits.length; i += 4) {
    hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
  }
  return hex.padStart(16, "0");
}

/** Number of set bits in a 16-hex-char fingerprint. */
export function bitCount(phash) {
  let ones = 0;
  for (const char of phash) {
    let nibble = parseInt(char, 16);
    while (nibble) {
      ones += nibble & 1;
      nibble >>= 1;
    }
  }
  return ones;
}

/**
 * True when a fingerprint carries too little information to compare.
 *
 * An image with no texture at the 9x8 scale — a dark frame, a blank wall, a
 * smooth gradient — makes nearly every neighbour comparison agree, so its
 * fingerprint sits at the all-zeros or all-ones pole. Any two fingerprints
 * with k set bits are at most 2k apart, so once 2k falls inside the near-match
 * threshold, ALL such images "match" each other by construction regardless of
 * content.
 *
 * This matters twice over: it would accuse an honest claimant of recycling a
 * photo they never saw, and it hands a fraudster an escape hatch — submit a
 * featureless image to every policy and reuse detection can never fire.
 */
export function isDegeneratePerceptualHash(phash, nearMatchMaxDistance = 10) {
  const ones = bitCount(phash);
  return Math.min(ones, 64 - ones) * 2 <= nearMatchMaxDistance;
}
