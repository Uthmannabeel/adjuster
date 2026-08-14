import sharp from "sharp";

/**
 * Generate a demo claim photo with EXIF GPS + capture time baked in, matching
 * a given policy's insured location and coverage date. Mirrors
 * scripts/make-claim-photo.mjs — the two MUST stay in sync.
 *
 * The scene MUST carry contrast at the fingerprint's own scale. dHash
 * downsamples to 9x8 and compares each cell with its right neighbour, so a
 * smooth gradient makes every comparison agree and collapses to an all-zeros
 * or all-ones hash — which the enclave then rejects as degenerate ("too
 * little visual detail"). An earlier version of this generator did exactly
 * that: a gradient background with a few blocks on top, and the enclave
 * correctly refused its own demo photo. The luminance of each of the 9x8
 * cells is therefore randomised per seed, with softer decoration on top.
 */

function toDms(dec: number): string {
  const abs = Math.abs(dec);
  const d = Math.floor(abs);
  const m = Math.floor((abs - d) * 60);
  const s = Math.round(((abs - d) * 60 - m) * 60 * 100);
  return `${d}/1 ${m}/1 ${s}/100`;
}

/** splitmix-style per-seed mixing so nearby seeds produce unrelated scenes. */
function makeRng(seed: number): (n: number) => number {
  return (n: number) => {
    let x = (seed * 0x9e3779b9 + n * 0x85ebca6b) >>> 0;
    x ^= x >>> 16;
    x = (x * 0x45d9f3b) >>> 0;
    x ^= x >>> 16;
    return x / 0xffffffff;
  };
}

export interface ClaimPhotoInput {
  lat: number;
  lon: number;
  /** EXIF DateTimeOriginal, "YYYY:MM:DD HH:MM:SS". */
  when: string;
  seed: number;
}

const COLS = 9;
const ROWS = 8;
const CELL_W = 320 / COLS;
const CELL_H = 240 / ROWS;

export async function makeClaimPhoto(input: ClaimPhotoInput): Promise<Buffer> {
  const rng = makeRng(input.seed);

  // One randomised cell per fingerprint sample point — this is what gives the
  // fingerprint its entropy.
  const cells = Array.from({ length: COLS * ROWS }, (_, i) => {
    const col = i % COLS;
    const row = Math.floor(i / COLS);
    // Spread across the full range so neighbouring comparisons go both ways.
    const level = Math.floor(30 + rng(i * 3 + 200) * 200);
    const tintR = Math.floor(level * (0.75 + rng(i * 3 + 201) * 0.5));
    const tintB = Math.floor(level * (0.75 + rng(i * 3 + 202) * 0.5));
    return `<rect x="${(col * CELL_W).toFixed(2)}" y="${(row * CELL_H).toFixed(2)}"`
      + ` width="${(CELL_W + 0.5).toFixed(2)}" height="${(CELL_H + 0.5).toFixed(2)}"`
      + ` fill="rgb(${Math.min(255, tintR)},${level},${Math.min(255, tintB)})"/>`;
  }).join("");

  // Larger shapes on top: scene-like structure, low enough opacity that it
  // does not wash the per-cell contrast back out.
  const nBlocks = 5 + Math.floor(rng(1) * 5);
  const blocks = Array.from({ length: nBlocks }, (_, i) => {
    const x = Math.floor(rng(i * 5 + 10) * 280) - 20;
    const y = Math.floor(rng(i * 5 + 11) * 220) - 20;
    const w = 20 + Math.floor(rng(i * 5 + 12) * 120);
    const h = 15 + Math.floor(rng(i * 5 + 13) * 90);
    const r = Math.floor(rng(i * 5 + 14) * 255);
    const g = Math.floor(rng(i * 7 + 15) * 255);
    const b = Math.floor(rng(i * 11 + 16) * 255);
    return `<rect x="${x}" y="${y}" width="${w}" height="${h}"`
      + ` fill="rgb(${r},${g},${b})" fill-opacity="0.45"/>`;
  }).join("");

  const svg = `<svg width="320" height="240" xmlns="http://www.w3.org/2000/svg">${cells}${blocks}</svg>`;

  return sharp(Buffer.from(svg))
    .jpeg({ quality: 92 })
    .withExif({
      IFD0: { Make: "TestCam", Model: "Adjuster-Demo" },
      IFD2: { DateTimeOriginal: input.when },
      IFD3: {
        GPSLatitudeRef: input.lat >= 0 ? "N" : "S",
        GPSLatitude: toDms(input.lat),
        GPSLongitudeRef: input.lon >= 0 ? "E" : "W",
        GPSLongitude: toDms(input.lon),
      },
    })
    .toBuffer();
}
