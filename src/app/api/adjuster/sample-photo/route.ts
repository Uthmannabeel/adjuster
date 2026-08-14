import { randomInt } from "node:crypto";
import { fail } from "@/lib/api";
import { adjusterConfigured, getPolicy } from "@/lib/adjuster";
import { makeClaimPhoto } from "@/lib/claim-photo";
import { contentHash, isDegeneratePerceptualHash, perceptualHash } from "@/lib/hash";
import { NEAR_MATCH_MAX_DISTANCE } from "@/lib/registry";
import { getStore } from "@/lib/store";

export const runtime = "nodejs";

// The generated scenes have only a handful of dominant gradient directions, so
// random seeds DO collide perceptually with earlier evidence now and then. A
// sample that trips the cross-claim fraud check would derail the demo, so we
// reroll until the photo is clean against the registry.
const MAX_SEED_ATTEMPTS = 12;

/**
 * A demo claim photo tailored to a policy: EXIF GPS a few hundred meters from
 * the insured location, capture time on the coverage date, and a perceptual
 * fingerprint verified NOT to match any prior claim evidence. Judges get a
 * valid claim photo in one click.
 */
export async function GET(req: Request): Promise<Response> {
  if (!adjusterConfigured()) return fail("Adjuster is not configured on this deployment.", 503);

  const url = new URL(req.url);
  const policyIdRaw = url.searchParams.get("policyId");
  if (!/^\d+$/.test(policyIdRaw ?? "")) {
    return fail("'policyId' must be a non-negative integer.");
  }
  const policyId = Number(policyIdRaw);

  try {
    const [policy, store] = await Promise.all([getPolicy(policyId), getStore()]);
    const when = `${policy.date.replaceAll("-", ":")} 11:30:00`;

    for (let attempt = 0; attempt < MAX_SEED_ATTEMPTS; attempt++) {
      const seed = randomInt(1, 2 ** 31);
      const jitter = (n: number) => ((seed * 31 + n * 17) % 1000) / 1000;
      // ~±0.004° ≈ ±0.4 km — inside the 5 km policy radius, but not dead-center.
      const lat = Number(policy.lat) + (jitter(1) - 0.5) * 0.008;
      const lon = Number(policy.lon) + (jitter(2) - 0.5) * 0.008;

      const jpeg = await makeClaimPhoto({ lat, lon, when, seed });
      const [sha, phash] = [contentHash(jpeg), await perceptualHash(jpeg)];
      // The enclave rejects featureless fingerprints as uncomparable — a
      // sample the demo's own verifier refuses must never leave this route.
      if (isDegeneratePerceptualHash(phash)) continue;
      const exact = await store.findByContentHash(sha);
      const near = exact ? null : await store.findNearest(phash, NEAR_MATCH_MAX_DISTANCE);
      const match = exact ?? near?.record ?? null;
      // A match on THIS policy's own earlier evidence is a harmless re-upload.
      if (match && match.registrant !== `adjuster:policy:${policyId}`) continue;

      return new Response(new Uint8Array(jpeg), {
        headers: {
          "Content-Type": "image/jpeg",
          "Content-Disposition": `inline; filename="claim-policy-${policyId}.jpg"`,
          "Cache-Control": "no-store",
        },
      });
    }
    return fail("Could not generate a sample distinct from prior evidence — try again.", 503);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Sample photo generation failed.";
    return fail(message, 500);
  }
}
