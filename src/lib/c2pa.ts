import { isDegeneratePerceptualHash } from "./hash";
import { NEAR_MATCH_MAX_DISTANCE } from "./registry";
import type { NearMatch } from "./store";

/**
 * C2PA Soft Binding Resolution API (spec.c2pa.org, "Decoupled" soft bindings) —
 * the /matches/byBinding query semantics served over this registry.
 *
 * C2PA (ISO/IEC 22144) separates hard bindings (exact hashes) from soft
 * bindings (fingerprints/watermarks that survive re-encoding), and defines a
 * Web API for resolving a soft binding value to the manifests that carry it.
 * Our 64-bit dHash is exactly such a fingerprint, so the registry can answer
 * spec-shaped queries directly. The algorithm identifier below is
 * self-assigned: dHash is not yet on C2PA's authoritative algorithm list, and
 * matches resolve to registry record ids rather than C2PA manifest stores —
 * both stated plainly wherever this API is described.
 */
export const SOFT_BINDING_ALG = "org.proofofreal.dhash";

const FINGERPRINT_BYTES = 8; // 8×8 dHash = 64 bits
const DEFAULT_MAX_RESULTS = 10;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/** A single entry in the spec's `matches` response array. */
export interface SoftBindingMatch {
  manifestId: string;
  similarityScore: number; // 0-100 per spec
}

export type ByBindingResult =
  | { status: 200; body: { matches: SoftBindingMatch[] } }
  | { status: 400 | 401; body: { error: string } };

/**
 * Decode the spec's base64 `value` into our 16-hex-char fingerprint.
 * Returns null unless it is exactly the 8 raw bytes of an 8×8 dHash.
 */
export function decodeSoftBindingValue(value: string): string | null {
  if (!BASE64.test(value)) return null;
  const raw = Buffer.from(value, "base64");
  if (raw.length !== FINGERPRINT_BYTES) return null;
  return raw.toString("hex");
}

/** Map Hamming distance (0-64) onto the spec's 0-100 similarity scale. */
export function similarityScore(distance: number): number {
  const bits = FINGERPRINT_BYTES * 8;
  const clamped = Math.min(Math.max(distance, 0), bits);
  return Math.round(((bits - clamped) / bits) * 100);
}

/**
 * The key a caller presented, from either the spec-conventional OAuth Bearer
 * header or the header the enclave already uses for /api/lookup.
 */
export function presentedKey(
  authorization: string | null,
  registryLookupKey: string | null,
): string | null {
  if (registryLookupKey) return registryLookupKey;
  if (authorization?.startsWith("Bearer ")) return authorization.slice("Bearer ".length);
  return null;
}

/**
 * Resolve a /matches/byBinding query. Pure logic with the store lookup
 * injected, so every branch is unit-testable without a backend.
 */
export async function resolveByBinding(
  params: { alg: string | null; value: string | null; maxResults: string | null },
  findNearest: (phash: string, maxDistance: number) => Promise<NearMatch | null>,
): Promise<ByBindingResult> {
  const { alg, value, maxResults } = params;

  if (!alg || alg !== SOFT_BINDING_ALG) {
    return {
      status: 400,
      body: { error: `Unsupported soft binding algorithm. This service resolves "${SOFT_BINDING_ALG}".` },
    };
  }
  if (!value) {
    return { status: 400, body: { error: "Query parameter 'value' is required (base64, 8 bytes)." } };
  }

  const phash = decodeSoftBindingValue(value);
  if (!phash) {
    return {
      status: 400,
      body: { error: "Invalid soft binding value: expected base64 encoding exactly 8 bytes (a 64-bit dHash)." },
    };
  }

  // A near-uniform image collapses to a degenerate fingerprint that would
  // "match" everything similarly featureless — the same guard the claims
  // pipeline applies. Refusing is more honest than returning noise.
  if (isDegeneratePerceptualHash(phash)) {
    return {
      status: 400,
      body: { error: "Degenerate fingerprint: the source image is too featureless for perceptual matching." },
    };
  }

  let limit = DEFAULT_MAX_RESULTS;
  if (maxResults !== null) {
    limit = Number(maxResults);
    if (!Number.isInteger(limit) || limit < 1) {
      return { status: 400, body: { error: "Query parameter 'maxResults' must be a positive integer." } };
    }
  }

  const nearest = await findNearest(phash, NEAR_MATCH_MAX_DISTANCE);
  const matches = nearest
    ? [{ manifestId: nearest.record.id, similarityScore: similarityScore(nearest.distance) }]
    : [];
  return { status: 200, body: { matches: matches.slice(0, limit) } };
}
