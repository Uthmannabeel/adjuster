import type { Registration } from "./types";

/** A near match found by perceptual fingerprint. */
export interface NearMatch {
  record: Registration;
  distance: number; // Hamming distance, 0-64
}

/**
 * Storage-agnostic registry interface (Repository pattern). Business logic
 * depends only on this; concrete backends (local file vs DynamoDB) are swapped
 * via getStore() with no call-site changes.
 */
export interface ProvenanceStore {
  put(record: Registration): Promise<void>;
  getById(id: string): Promise<Registration | null>;
  findByContentHash(contentHash: string): Promise<Registration | null>;
  /**
   * Nearest perceptual match within maxDistance. When excludeRegistrant is
   * given, records registered by that party are skipped — so a claimant's own
   * earlier upload cannot mask a cross-policy match sitting slightly farther.
   */
  findNearest(
    phash: string,
    maxDistance: number,
    excludeRegistrant?: string,
  ): Promise<NearMatch | null>;
  list(limit: number): Promise<Registration[]>;
}

let cached: ProvenanceStore | null = null;

/**
 * Resolve the active store. Explicit DATA_BACKEND wins; otherwise infer from
 * configured credentials (Supabase, then DynamoDB), falling back to a local
 * JSON file for zero-setup dev.
 */
export async function getStore(): Promise<ProvenanceStore> {
  if (cached) return cached;

  const backend =
    process.env.DATA_BACKEND ??
    (process.env.SUPABASE_URL
      ? "supabase"
      : process.env.DYNAMODB_TABLE
        ? "dynamodb"
        : "local");

  if (backend === "supabase") {
    const { SupabaseStore } = await import("./supabase-store");
    cached = new SupabaseStore();
  } else if (backend === "dynamodb") {
    const { DynamoStore } = await import("./dynamo-store");
    cached = new DynamoStore();
  } else {
    const { LocalStore } = await import("./local-store");
    cached = new LocalStore();
  }
  return cached;
}
