import {
  RANK_BUCKETS,
  type Aggregate,
  type AggregateHistoryEntry,
  type AggregateSlice,
  type AggregateTotals,
  type DomainSnapshot,
  type Tally,
} from '@observatory/core';

function emptyTotals(): AggregateTotals {
  return {
    spf: { present: 0, allQualifier: {}, exceedsLookupLimit: 0 },
    dmarc: { present: 0, p: {}, pctBelow100: 0 },
    bimi: { present: 0, hasVmc: 0, declined: 0 },
    mtaSts: { present: 0, mode: {} },
    tlsRpt: { present: 0 },
    dnssec: {},
    mx: { present: 0, isNullMx: 0 },
  };
}

function bump(tally: Tally, key: string): void {
  tally[key] = (tally[key] ?? 0) + 1;
}

/**
 * Folds one domain into a totals bucket.
 *
 * Only observed values count. A record whose lookup returned `unknown` and was
 * carried forward still counts — it is the best knowledge available and the
 * `stale` marker records its provenance — but a field the parser could not read
 * contributes nothing rather than defaulting to "absent".
 */
export function accumulate(totals: AggregateTotals, s: DomainSnapshot): void {
  if (s.spf.present) {
    totals.spf.present += 1;
    if (s.spf.allQualifier !== undefined) {
      bump(totals.spf.allQualifier, `${s.spf.allQualifier}all`);
    }
  }
  if (s.spf.exceedsLookupLimit === true) totals.spf.exceedsLookupLimit += 1;

  if (s.dmarc.present) {
    totals.dmarc.present += 1;
    if (s.dmarc.p !== undefined) bump(totals.dmarc.p, s.dmarc.p);
    // pct is stored as published, so an absent pct means the RFC default of
    // 100 — it is not below 100.
    if (s.dmarc.pct !== undefined && s.dmarc.pct < 100) totals.dmarc.pctBelow100 += 1;
  }

  if (s.bimi.present) {
    totals.bimi.present += 1;
    if (s.bimi.hasVmc) totals.bimi.hasVmc += 1;
    if (s.bimi.declined) totals.bimi.declined += 1;
  }

  if (s.mtaSts.present) {
    totals.mtaSts.present += 1;
    if (s.mtaSts.mode !== undefined) bump(totals.mtaSts.mode, s.mtaSts.mode);
  }

  if (s.tlsRpt.present) totals.tlsRpt.present += 1;

  bump(totals.dnssec, s.dnssec);

  if (s.mx.present) totals.mx.present += 1;
  // A null MX is a deliberate "this domain sends and receives no mail", not a
  // missing MX, so it is counted separately rather than as an absence.
  if (s.mx.isNullMx) totals.mx.isNullMx += 1;
}

function slice(): AggregateSlice {
  return { domainsObserved: 0, totals: emptyTotals() };
}

function into(map: Record<string, AggregateSlice>, key: string, s: DomainSnapshot): void {
  const existing = map[key] ?? slice();
  existing.domainsObserved += 1;
  accumulate(existing.totals, s);
  map[key] = existing;
}

/** The registrable suffix is not derivable without a public-suffix list, so
 *  this is the last label — good enough to separate .com from .de. */
export function tldOf(domain: string): string {
  const dot = domain.lastIndexOf('.');
  return dot === -1 ? domain : domain.slice(dot + 1).toLowerCase();
}

export function rankBucketOf(rank: number): string {
  for (const bucket of RANK_BUCKETS) {
    if (rank >= bucket.min && rank <= bucket.max) return bucket.label;
  }
  return 'other';
}

export interface AggregateInput {
  date: string;
  listId: string;
  unknownRate: number;
  degraded: boolean;
}

/**
 * Rolls every shard up into one aggregate.
 *
 * Computed over ALL shards, not only the one crawled today: a long-tail domain
 * is observed weekly, and its last known state is what `latest/` holds. Counting
 * only today's shard would make the totals swing by a factor of seven each day.
 */
export function aggregate(snapshots: Iterable<DomainSnapshot>, input: AggregateInput): Aggregate {
  const totals = emptyTotals();
  const byTld: Record<string, AggregateSlice> = {};
  const byMxProvider: Record<string, AggregateSlice> = {};
  const byRankBucket: Record<string, AggregateSlice> = {};

  let domainsObserved = 0;

  for (const s of snapshots) {
    domainsObserved += 1;
    accumulate(totals, s);
    into(byTld, tldOf(s.domain), s);
    into(byMxProvider, s.mx.isNullMx ? 'null-mx' : (s.mx.provider ?? 'none'), s);
    into(byRankBucket, rankBucketOf(s.rank), s);
  }

  return {
    date: input.date,
    listId: input.listId,
    domainsObserved,
    unknownRate: input.unknownRate,
    degraded: input.degraded,
    totals,
    byTld,
    byMxProvider,
    byRankBucket,
  };
}

/**
 * Strips the wide breakdowns for the history file.
 *
 * history.jsonl is what makes the dashboard's trend charts a single fetch with
 * zero server-side work, so it must stay small: byTld and byMxProvider would
 * multiply each line by a factor of fifty.
 */
export function toHistoryEntry(full: Aggregate): AggregateHistoryEntry {
  // Listed field by field rather than by omission, so adding a wide breakdown
  // to Aggregate later cannot silently start bloating the history file.
  return {
    date: full.date,
    listId: full.listId,
    domainsObserved: full.domainsObserved,
    unknownRate: full.unknownRate,
    degraded: full.degraded,
    totals: full.totals,
    byRankBucket: full.byRankBucket,
  };
}
