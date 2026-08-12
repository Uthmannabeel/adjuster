import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Registration } from "./types";
import type { NearMatch, ProvenanceStore } from "./store";
import { bands, hammingDistance } from "./hash";

const TABLE = "registrations";

interface Row {
  id: string;
  content_hash: string;
  phash: string;
  bands: string[];
  created_at: string;
  record: Registration;
}

/**
 * Supabase (Postgres) registry — the zero-AWS production backend. One table:
 * the sealed record as jsonb plus lookup columns, with LSH band pointers in a
 * GIN-indexed text[] so near-match is a single indexed overlap query
 * (bands && candidate bands), never a table scan — same scaling story as the
 * DynamoDB BAND# design.
 *
 * Server-side only: uses the service-role key; RLS blocks the public key.
 */
export class SupabaseStore implements ProvenanceStore {
  private readonly client: SupabaseClient;

  constructor(client?: SupabaseClient) {
    if (client) {
      this.client = client;
      return;
    }
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) {
      throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set");
    }
    this.client = createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }

  async put(record: Registration): Promise<void> {
    const row: Row = {
      id: record.id,
      content_hash: record.contentHash,
      phash: record.phash,
      bands: bands(record.phash),
      created_at: record.createdAt,
      record,
    };
    const { error } = await this.client.from(TABLE).upsert(row);
    if (error) throw new Error(`supabase put failed: ${error.message}`);
  }

  async getById(id: string): Promise<Registration | null> {
    const { data, error } = await this.client
      .from(TABLE)
      .select("record")
      .eq("id", id)
      .maybeSingle();
    if (error) throw new Error(`supabase getById failed: ${error.message}`);
    return data ? (data.record as Registration) : null;
  }

  async findByContentHash(contentHash: string): Promise<Registration | null> {
    const { data, error } = await this.client
      .from(TABLE)
      .select("record")
      .eq("content_hash", contentHash)
      .limit(1);
    if (error) throw new Error(`supabase findByContentHash failed: ${error.message}`);
    const row = data?.[0];
    return row ? (row.record as Registration) : null;
  }

  async findNearest(
    phash: string,
    maxDistance: number,
    excludeRegistrant?: string,
  ): Promise<NearMatch | null> {
    // One indexed overlap query: any row sharing >=1 LSH band is a candidate.
    const { data, error } = await this.client
      .from(TABLE)
      .select("record, phash")
      .overlaps("bands", bands(phash));
    if (error) throw new Error(`supabase findNearest failed: ${error.message}`);

    let best: NearMatch | null = null;
    for (const row of data ?? []) {
      if (excludeRegistrant && (row.record as Registration).registrant === excludeRegistrant)
        continue;
      const distance = hammingDistance(phash, row.phash as string);
      if (distance <= maxDistance && (best === null || distance < best.distance)) {
        best = { record: row.record as Registration, distance };
      }
    }
    return best;
  }

  async list(limit: number): Promise<Registration[]> {
    const { data, error } = await this.client
      .from(TABLE)
      .select("record")
      .order("created_at", { ascending: false })
      .limit(limit);
    if (error) throw new Error(`supabase list failed: ${error.message}`);
    return (data ?? []).map((row) => row.record as Registration);
  }
}
