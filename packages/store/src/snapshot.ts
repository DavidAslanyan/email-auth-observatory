import {
  TIER1_MAX_RANK,
  TIER2_SHARDS,
  domainSnapshotSchema,
  type DomainSnapshot,
} from '@mailscape/core';
import { readJsonl, writeJsonl, type ReadOptions } from './jsonl.js';
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

/**
 * Writes a snapshot shard, sorted by domain.
 *
 * Sorting is what makes git's delta compression effective. An unsorted file
 * produces a whole-file diff on every run and the repository balloons — the
 * plan calls this out specifically as an anti-pattern.
 */
export async function writeSnapshot(
  shard: string,
  snapshots: readonly DomainSnapshot[],
): Promise<number> {
  const sorted = [...snapshots].sort((a, b) => a.domain.localeCompare(b.domain, 'en'));
  return writeJsonl(paths.snapshot(shard), sorted);
}

export function readSnapshot(
  shard: string,
  options: ReadOptions = {},
): AsyncGenerator<DomainSnapshot> {
  return readJsonl(paths.snapshot(shard), domainSnapshotSchema, options);
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
