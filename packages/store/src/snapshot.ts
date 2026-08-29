import { z } from 'zod';
import {
  TIER1_MAX_RANK,
  TIER2_SHARDS,
  storedSnapshotSchema,
  type DomainSnapshot,
} from '@mailscape/core';
import { readJson, readJsonl, writeJson, writeJsonl, type ReadOptions } from './jsonl.js';
import { SHARD_NAMES, paths } from './paths.js';

/**
 * FNV-1a over the domain name.
 *
 * It hashes the DOMAIN, not the rank, so a domain stays in the same shard
 * across Tranco list rollovers. Sharding by rank would reshuffle most of the
 * long tail every quarter and make the per-shard diffs meaningless.
 */
export function shardFor(domain: string, shards: number = TIER2_SHARDS): number {
  let h = 2166136261;
  for (let i = 0; i < domain.length; i++) {
    h ^= domain.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h) % shards;
}

/** Tier 2 rotates one shard per day. */
export function shardForDayOfYear(date: Date, shards: number = TIER2_SHARDS): number {
  const start = Date.UTC(date.getUTCFullYear(), 0, 0);
  const dayOfYear = Math.floor((date.getTime() - start) / 86_400_000);
  return dayOfYear % shards;
}

export function isTier1(rank: number): boolean {
  return rank <= TIER1_MAX_RANK;
}

export function shardName(tier: 1 | 2, shard: number): string {
  return tier === 1 ? SHARD_NAMES.tier1 : SHARD_NAMES.tier2(shard);
}

/** Every shard file that makes up a complete picture of the dataset. */
export function allShardNames(shards: number = TIER2_SHARDS): string[] {
  return [SHARD_NAMES.tier1, ...Array.from({ length: shards }, (_, i) => SHARD_NAMES.tier2(i))];
}

const shardMetaSchema = z.object({
  shard: z.string(),
  crawledAt: z.string(),
  domains: z.number().int().nonnegative(),
});

/**
 * Writes a snapshot shard, sorted by domain, with the run timestamp held once
 * for the whole file rather than repeated on every line.
 *
 * Sorting alone is not enough to keep the diffs small. A per-record timestamp
 * changes every line on every crawl, so git cannot tell an unchanged domain
 * from a changed one — measured at 949 of 1,000 lines rewritten for 51 real
 * changes, which is the same whole-file diff an unsorted file produces. The
 * timestamp describes the run, and a shard is written by exactly one run, so it
 * belongs to the file. Records that were carried forward still carry their own
 * `lastSeenAt`, which is the per-record timing that actually matters.
 *
 * This is a storage encoding only: readSnapshot puts `crawledAt` back on every
 * record, so nothing downstream can tell the difference.
 */
export async function writeSnapshot(
  shard: string,
  snapshots: readonly DomainSnapshot[],
  crawledAt?: string,
): Promise<number> {
  const sorted = [...snapshots].sort((a, b) => a.domain.localeCompare(b.domain, 'en'));
  const stamp = crawledAt ?? sorted[0]?.crawledAt ?? new Date().toISOString();

  const stripped = sorted.map((snapshot) => {
    // The run timestamp goes in the sidecar, not on every line.
    const line: Omit<DomainSnapshot, 'crawledAt'> & { crawledAt?: string } = { ...snapshot };
    delete line.crawledAt;
    return line;
  });

  const count = await writeJsonl(paths.snapshot(shard), stripped);
  await writeJson(paths.snapshotMeta(shard), { shard, crawledAt: stamp, domains: count });
  return count;
}

/** The run timestamp for a shard, or undefined if it has never been written. */
export async function readSnapshotCrawledAt(shard: string): Promise<string | undefined> {
  const meta = await readJson(paths.snapshotMeta(shard), shardMetaSchema);
  return meta?.crawledAt;
}

export async function* readSnapshot(
  shard: string,
  options: ReadOptions = {},
): AsyncGenerator<DomainSnapshot> {
  const crawledAt = (await readSnapshotCrawledAt(shard)) ?? '1970-01-01T00:00:00.000Z';
  for await (const stored of readJsonl(paths.snapshot(shard), storedSnapshotSchema, options)) {
    // Put the run timestamp back, so the domain model is unchanged.
    yield { ...stored, crawledAt: stored.crawledAt ?? crawledAt };
  }
}

/** Loads a shard keyed by domain, for diffing against a fresh crawl. */
export async function loadSnapshotMap(
  shard: string,
  options: ReadOptions = {},
): Promise<Map<string, DomainSnapshot>> {
  const map = new Map<string, DomainSnapshot>();
  for await (const snapshot of readSnapshot(shard, options)) {
    map.set(snapshot.domain, snapshot);
  }
  return map;
}
