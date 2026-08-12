import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  BatchWriteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
} from "@aws-sdk/lib-dynamodb";
import type { Registration } from "./types";
import type { NearMatch, ProvenanceStore } from "./store";
import { bands, hammingDistance } from "./hash";

const TABLE = process.env.DYNAMODB_TABLE ?? "proof-of-real";

interface MainItem {
  pk: string;
  sk: string;
  gsi1pk: string;
  gsi1sk: string;
  gsi3pk: string;
  gsi3sk: string;
  record: Registration;
}

interface BandItem {
  pk: string; // BAND#<i>:<value>
  sk: string; // REG#<id>
  id: string;
  phash: string;
}

/**
 * DynamoDB-backed registry. Single table:
 *   REG#<id>     (sk=META)  — full record; GSI1 (CONTENT#) exact, GSI3 (ALL) recent
 *   BAND#<i:val> (sk=REG#)  — LSH band pointers for scalable near-match
 *
 * Near-match is a fixed number of point queries (one per band) + a getById,
 * never a table scan — so it scales with traffic, not with registry size.
 */
export class DynamoStore implements ProvenanceStore {
  private readonly doc: DynamoDBDocumentClient;

  constructor() {
    const client = new DynamoDBClient({});
    this.doc = DynamoDBDocumentClient.from(client, {
      marshallOptions: { removeUndefinedValues: true },
    });
  }

  async put(record: Registration): Promise<void> {
    const main: MainItem = {
      pk: `REG#${record.id}`,
      sk: "META",
      gsi1pk: `CONTENT#${record.contentHash}`,
      gsi1sk: record.createdAt,
      gsi3pk: "ALL",
      gsi3sk: record.createdAt,
      record,
    };
    const bandItems: BandItem[] = bands(record.phash).map((b) => ({
      pk: `BAND#${b}`,
      sk: `REG#${record.id}`,
      id: record.id,
      phash: record.phash,
    }));

    const requests = [main, ...bandItems].map((Item) => ({ PutRequest: { Item } }));
    await this.doc.send(new BatchWriteCommand({ RequestItems: { [TABLE]: requests } }));
  }

  async getById(id: string): Promise<Registration | null> {
    const res = await this.doc.send(
      new GetCommand({ TableName: TABLE, Key: { pk: `REG#${id}`, sk: "META" } }),
    );
    return res.Item ? (res.Item as MainItem).record : null;
  }

  async findByContentHash(contentHash: string): Promise<Registration | null> {
    const res = await this.doc.send(
      new QueryCommand({
        TableName: TABLE,
        IndexName: "GSI1",
        KeyConditionExpression: "gsi1pk = :pk",
        ExpressionAttributeValues: { ":pk": `CONTENT#${contentHash}` },
        Limit: 1,
      }),
    );
    const item = res.Items?.[0] as MainItem | undefined;
    return item ? item.record : null;
  }

  async findNearest(
    phash: string,
    maxDistance: number,
    excludeRegistrant?: string,
  ): Promise<NearMatch | null> {
    // One point query per band, in parallel — bounded work, no scan.
    const perBand = await Promise.all(
      bands(phash).map((b) =>
        this.doc.send(
          new QueryCommand({
            TableName: TABLE,
            KeyConditionExpression: "pk = :pk",
            ExpressionAttributeValues: { ":pk": `BAND#${b}` },
          }),
        ),
      ),
    );

    const candidates = new Map<string, string>(); // id -> phash
    for (const res of perBand) {
      for (const raw of res.Items ?? []) {
        const item = raw as BandItem;
        if (!candidates.has(item.id)) candidates.set(item.id, item.phash);
      }
    }

    // Rank all in-range candidates, then walk closest-first so an excluded
    // registrant's record cannot mask the next-nearest match.
    const ranked = [...candidates]
      .map(([id, candidatePhash]) => ({ id, distance: hammingDistance(phash, candidatePhash) }))
      .filter((c) => c.distance <= maxDistance)
      .sort((a, b) => a.distance - b.distance);

    for (const candidate of ranked) {
      const record = await this.getById(candidate.id);
      if (!record) continue;
      if (excludeRegistrant && record.registrant === excludeRegistrant) continue;
      return { record, distance: candidate.distance };
    }
    return null;
  }

  async list(limit: number): Promise<Registration[]> {
    const res = await this.doc.send(
      new QueryCommand({
        TableName: TABLE,
        IndexName: "GSI3",
        KeyConditionExpression: "gsi3pk = :pk",
        ExpressionAttributeValues: { ":pk": "ALL" },
        ScanIndexForward: false,
        Limit: limit,
      }),
    );
    return (res.Items ?? []).map((i) => (i as MainItem).record);
  }
}
