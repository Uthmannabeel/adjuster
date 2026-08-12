import { promises as fs } from "node:fs";
import path from "node:path";
import type { Registration } from "./types";
import type { NearMatch, ProvenanceStore } from "./store";
import { hammingDistance } from "./hash";

const DATA_FILE = path.join(process.cwd(), ".data", "registrations.json");

/**
 * File-backed registry for local development and tests — mirrors the DynamoStore
 * semantics exactly so the app behaves identically with zero cloud setup.
 */
export class LocalStore implements ProvenanceStore {
  async put(record: Registration): Promise<void> {
    const all = await readAll();
    const next = [record, ...all.filter((r) => r.id !== record.id)];
    await writeAll(next);
  }

  async getById(id: string): Promise<Registration | null> {
    const all = await readAll();
    return all.find((r) => r.id === id) ?? null;
  }

  async findByContentHash(contentHash: string): Promise<Registration | null> {
    const all = await readAll();
    return all.find((r) => r.contentHash === contentHash) ?? null;
  }

  async findNearest(
    phash: string,
    maxDistance: number,
    excludeRegistrant?: string,
  ): Promise<NearMatch | null> {
    const all = await readAll();
    let best: NearMatch | null = null;
    for (const record of all) {
      if (excludeRegistrant && record.registrant === excludeRegistrant) continue;
      const distance = hammingDistance(phash, record.phash);
      if (distance <= maxDistance && (best === null || distance < best.distance)) {
        best = { record, distance };
      }
    }
    return best;
  }

  async list(limit: number): Promise<Registration[]> {
    const all = await readAll();
    return all
      .slice()
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit);
  }
}

async function readAll(): Promise<Registration[]> {
  try {
    const raw = await fs.readFile(DATA_FILE, "utf8");
    return JSON.parse(raw) as Registration[];
  } catch {
    return [];
  }
}

async function writeAll(records: Registration[]): Promise<void> {
  await fs.mkdir(path.dirname(DATA_FILE), { recursive: true });
  await fs.writeFile(DATA_FILE, JSON.stringify(records, null, 2), "utf8");
}
