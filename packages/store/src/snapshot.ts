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

/**
 * Which long-tail shard to crawl now.
 *
 * Two shards are crawled per day in separate runs, so each run passes its slot
 * and they advance together through the rotation. With 28 shards that is full
 * coverage of the long tail every fortnight, delivered as two modest bursts a
 * day rather than one sustained hour at full rate.
 */
export function shardForDayOfYear(
  date: Date,
  shards: number = TIER2_SHARDS,
  slot = 0,
  slotsPerDay = 1,
): number {
  const start = Date.UTC(date.getUTCFullYear(), 0, 0);
  const dayOfYear = Math.floor((date.getTime() - start) / 86_400_000);
  return (dayOfYear * slotsPerDay + slot) % shards;
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
  /** Run-uniform values hoisted out of every record. */
  listId: z.string().optional(),
  resolver: z.string().optional(),
});

/**
 * Values that are identical on essentially every record in a run.
 *
 * Measured on a real 20.6 MB shard: `resolver` repeated six times per domain
 * cost 2.37 MB, `rcode` a further 1.8 MB (it is always NOERROR when status is
 * ok, which `status` already says), and `listId` 0.23 MB. That is a fifth of
 * the file spent restating the same three facts 14,131 times. They are stored
 * once in the sidecar and restored on read, so only a reader parsing the JSONL
 * by hand sees the difference — which docs/SCHEMA.md documents.
 */
const RECORD_KEYS = ['spf', 'dmarc', 'bimi', 'mtaSts', 'tlsRpt', 'mx'] as const;

function compact(snapshot: DomainSnapshot, listId: string, resolver: string): unknown {
  const line: Record<string, unknown> = { ...snapshot };
  delete line.crawledAt;
  if (snapshot.listId === listId) delete line.listId;

  for (const key of RECORD_KEYS) {
    const record = { ...snapshot[key] } as Record<string, unknown>;
    if (record.resolver === resolver) delete record.resolver;
    // NOERROR is implied by status 'ok'; anything else is kept verbatim.
    if (record.status === 'ok' && record.rcode === 'NOERROR') delete record.rcode;
    if (record.ad === false) delete record.ad;
    line[key] = record;
  }
  return line;
}

function expand(
  stored: Record<string, unknown>,
  crawledAt: string,
  listId: string,
  resolver: string,
): DomainSnapshot {
  const out: Record<string, unknown> = { ...stored };
  out.crawledAt = stored.crawledAt ?? crawledAt;
  out.listId = stored.listId ?? listId;

  for (const key of RECORD_KEYS) {
    const record = { ...(stored[key] as Record<string, unknown>) };
    record.resolver ??= resolver;
    record.ad ??= false;
    record.rcode ??= record.status === 'ok' ? 'NOERROR' : 'UNKNOWN';
    out[key] = record;
  }
  return out as unknown as DomainSnapshot;
}

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

  const listId = sorted[0]?.listId ?? '';
  const resolver = commonestResolver(sorted);

  const count = await writeJsonl(
    paths.snapshot(shard),
    sorted.map((snapshot) => compact(snapshot, listId, resolver)),
  );
  await writeJson(paths.snapshotMeta(shard), {
    shard,
    crawledAt: stamp,
    domains: count,
    listId,
    resolver,
  });
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
  const meta = await readJson(paths.snapshotMeta(shard), shardMetaSchema);
  const crawledAt = meta?.crawledAt ?? '1970-01-01T00:00:00.000Z';
  const listId = meta?.listId ?? '';
  const resolver = meta?.resolver ?? 'local';

  for await (const stored of readJsonl(paths.snapshot(shard), storedSnapshotSchema, options)) {
    // Put the hoisted values back, so the domain model is unchanged.
    yield expand(stored, crawledAt, listId, resolver);
  }
}

/** The resolver tier that answered most records, which becomes the default. */
function commonestResolver(snapshots: readonly DomainSnapshot[]): string {
  const counts = new Map<string, number>();
  for (const s of snapshots) {
    for (const key of RECORD_KEYS) {
      const r = s[key].resolver;
      counts.set(r, (counts.get(r) ?? 0) + 1);
    }
  }
  let best = 'local';
  let bestCount = -1;
  for (const [r, c] of counts) {
    if (c > bestCount) {
      best = r;
      bestCount = c;
    }
  }
  return best;
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
