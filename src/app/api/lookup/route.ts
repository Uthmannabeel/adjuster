import { ok, fail } from "@/lib/api";
import { getStore } from "@/lib/store";
import { NEAR_MATCH_MAX_DISTANCE } from "@/lib/registry";

export const runtime = "nodejs";

const SHA256_HEX = /^[0-9a-f]{64}$/i;
const PHASH_HEX = /^[0-9a-f]{16}$/i;

/**
 * Hash-only registry lookup for the confidential verifier enclave. The enclave
 * computes fingerprints INSIDE the TEE and queries by hash, so the image itself
 * never reaches the registry server.
 *
 * When REGISTRY_LOOKUP_KEY is set, callers must present it — fingerprints are
 * not secrets, but an open endpoint would let anyone run membership tests
 * ("was this photo ever claimed?") against the registry. The enclave carries
 * the key; nothing else needs to.
 *
 * `exclude` names a registrant whose records are skipped in the NEAR search,
 * and forces the near search to run even when an exact match exists — a
 * claimant's own earlier upload must never mask a cross-policy match.
 */
export async function GET(request: Request): Promise<Response> {
  const requiredKey = process.env.REGISTRY_LOOKUP_KEY;
  if (requiredKey) {
    const presented = request.headers.get("x-registry-lookup-key");
    if (presented !== requiredKey) return fail("Lookup requires a valid key.", 401);
  }

  const url = new URL(request.url);
  const sha = url.searchParams.get("sha");
  const phash = url.searchParams.get("phash");
  const exclude = url.searchParams.get("exclude");

  if (!sha || !SHA256_HEX.test(sha)) return fail("Query param 'sha' must be 64 hex chars.");
  if (!phash || !PHASH_HEX.test(phash)) return fail("Query param 'phash' must be 16 hex chars.");

  try {
    const store = await getStore();
    const exact = await store.findByContentHash(sha.toLowerCase());
    const near =
      exact && !exclude
        ? null
        : await store.findNearest(phash.toLowerCase(), NEAR_MATCH_MAX_DISTANCE, exclude ?? undefined);
    return ok({ exact, near });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Lookup failed.";
    return fail(message, 500);
  }
}
