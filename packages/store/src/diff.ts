import type { ChangeEvent, ChangeValue, DomainSnapshot, LookupStatus } from '@mailscape/core';

/**
 * One tracked field: the dotted path that appears in a ChangeEvent, the value
 * to compare, and the lookup status that says whether that value is knowledge
 * or a failure.
 *
 * Fields are declared as data rather than walked reflectively so that adding a
 * field to the snapshot cannot accidentally start emitting change events for
 * noisy data. The deliberately untracked fields — spf.raw, dmarc.ruaHosts,
 * mx.hosts, dkim.selectorsFound, mtaSts.policyId — are stored in the snapshot
 * but would drown the changes file if diffed.
 */
interface TrackedField {
  path: string;
  value: (s: DomainSnapshot) => ChangeValue | undefined;
  status: (s: DomainSnapshot) => LookupStatus;
}

const spf = (s: DomainSnapshot): LookupStatus => s.spf.status;
const dmarc = (s: DomainSnapshot): LookupStatus => s.dmarc.status;
const bimi = (s: DomainSnapshot): LookupStatus => s.bimi.status;
const mtaSts = (s: DomainSnapshot): LookupStatus => s.mtaSts.status;
const tlsRpt = (s: DomainSnapshot): LookupStatus => s.tlsRpt.status;
const mx = (s: DomainSnapshot): LookupStatus => s.mx.status;

export const TRACKED_FIELDS: readonly TrackedField[] = [
  { path: 'spf.present', value: (s) => s.spf.present, status: spf },
  { path: 'spf.allQualifier', value: (s) => s.spf.allQualifier, status: spf },
  { path: 'spf.exceedsLookupLimit', value: (s) => s.spf.exceedsLookupLimit, status: spf },

  { path: 'dmarc.present', value: (s) => s.dmarc.present, status: dmarc },
  { path: 'dmarc.p', value: (s) => s.dmarc.p, status: dmarc },
  { path: 'dmarc.sp', value: (s) => s.dmarc.sp, status: dmarc },
  { path: 'dmarc.pct', value: (s) => s.dmarc.pct, status: dmarc },
  { path: 'dmarc.adkim', value: (s) => s.dmarc.adkim, status: dmarc },
  { path: 'dmarc.aspf', value: (s) => s.dmarc.aspf, status: dmarc },

  { path: 'bimi.present', value: (s) => s.bimi.present, status: bimi },
  { path: 'bimi.hasLogo', value: (s) => s.bimi.hasLogo, status: bimi },
  { path: 'bimi.hasVmc', value: (s) => s.bimi.hasVmc, status: bimi },

  { path: 'mtaSts.present', value: (s) => s.mtaSts.present, status: mtaSts },
  { path: 'mtaSts.mode', value: (s) => s.mtaSts.mode, status: mtaSts },

  { path: 'tlsRpt.present', value: (s) => s.tlsRpt.present, status: tlsRpt },

  { path: 'mx.provider', value: (s) => s.mx.provider, status: mx },
  { path: 'mx.isNullMx', value: (s) => s.mx.isNullMx, status: mx },

  {
    path: 'dnssec',
    value: (s) => s.dnssec,
    status: (s) => (s.dnssec === 'unknown' ? 'unknown' : 'ok'),
  },
];

export interface DiffResult {
  /** Events to append to today's changes file. */
  events: ChangeEvent[];
  /**
   * The snapshot to persist. Where the new crawl returned `unknown`, the
   * previous known value is carried forward and marked stale — so `latest/`
   * always holds the best knowledge we have, not the most recent attempt.
   */
  snapshot: DomainSnapshot;
}

/**
 * Diffs one domain against its previous snapshot.
 *
 * The rules that matter (plan section 1.1 and 4.4):
 *
 *  - `unknown` in the NEW snapshot emits nothing and carries the previous
 *    value forward with `stale: true`. We failed to look; the domain did not
 *    change.
 *  - `unknown` in the PREVIOUS snapshot emits nothing either. We did not know
 *    before, so today is not an observed change — it is the first observation.
 *  - A domain we have never seen emits exactly one `first_seen` event, never
 *    a per-field 'added' storm. Otherwise every Tranco rollover floods the
 *    changes file with thousands of fabricated "adoptions".
 */
export function diffDomain(previous: DomainSnapshot | undefined, next: DomainSnapshot): DiffResult {
  if (!previous) {
    return {
      events: [
        {
          domain: next.domain,
          rank: next.rank,
          field: 'domain',
          kind: 'first_seen',
          from: null,
          to: next.domain,
          ts: next.crawledAt,
        },
      ],
      snapshot: next,
    };
  }

  const events: ChangeEvent[] = [];
  const snapshot = carryForwardUnknowns(previous, next);

  for (const field of TRACKED_FIELDS) {
    const newStatus = field.status(next);
    const oldStatus = field.status(previous);

    // We failed to look this time. Nothing observed, nothing to report.
    if (newStatus === 'unknown') continue;

    // We did not know last time, so this is not an observed transition.
    if (oldStatus === 'unknown') continue;

    const from = field.value(previous);
    const to = field.value(snapshot);
    if (from === to) continue;

    const kind = from === undefined ? 'added' : to === undefined ? 'removed' : 'modified';

    events.push({
      domain: next.domain,
      rank: next.rank,
      field: field.path,
      kind,
      from: from ?? null,
      to: to ?? null,
      ts: next.crawledAt,
    });
  }

  return { events, snapshot };
}

/**
 * Builds the snapshot to persist, substituting the previous value for any
 * record whose fresh lookup returned `unknown`.
 *
 * The carried-forward record keeps its previous content and gains `stale: true`
 * plus `lastSeenAt`, so a consumer can always tell observed data from
 * remembered data.
 */
export function carryForwardUnknowns(
  previous: DomainSnapshot,
  next: DomainSnapshot,
): DomainSnapshot {
  const lastSeenAt = previous.crawledAt;

  return {
    ...next,
    dnssec: next.dnssec === 'unknown' ? previous.dnssec : next.dnssec,
    spf: carry(previous.spf, next.spf, lastSeenAt),
    dmarc: carry(previous.dmarc, next.dmarc, lastSeenAt),
    bimi: carry(previous.bimi, next.bimi, lastSeenAt),
    mtaSts: carry(previous.mtaSts, next.mtaSts, lastSeenAt),
    tlsRpt: carry(previous.tlsRpt, next.tlsRpt, lastSeenAt),
    mx: carry(previous.mx, next.mx, lastSeenAt),
    // DKIM is a lower bound already; a failed probe carries forward the same
    // way, so an outage never looks like a domain removing its selectors.
    dkim: next.dkim.status === 'unknown' ? previous.dkim : next.dkim,
  };
}

function carry<
  T extends { status: LookupStatus; stale?: boolean | undefined; lastSeenAt?: string | undefined },
>(previous: T, next: T, lastSeenAt: string): T {
  if (next.status !== 'unknown') {
    // A fresh observation clears any staleness carried from earlier runs.
    const fresh = { ...next };
    delete fresh.stale;
    delete fresh.lastSeenAt;
    return fresh;
  }
  return {
    ...previous,
    stale: true,
    // The timestamp of the last SUCCESSFUL observation, not of this attempt.
    lastSeenAt: previous.stale === true ? (previous.lastSeenAt ?? lastSeenAt) : lastSeenAt,
  };
}

/** Diffs a whole shard. */
export function diffSnapshots(
  previous: ReadonlyMap<string, DomainSnapshot>,
  next: readonly DomainSnapshot[],
): { events: ChangeEvent[]; snapshots: DomainSnapshot[] } {
  const events: ChangeEvent[] = [];
  const snapshots: DomainSnapshot[] = [];

  for (const snapshot of next) {
    const result = diffDomain(previous.get(snapshot.domain), snapshot);
    events.push(...result.events);
    snapshots.push(result.snapshot);
  }

  return { events, snapshots };
}

/**
 * Strengthening and weakening classification, used by the report.
 *
 * Weakening moves are rarer than strengthening ones and far more interesting,
 * so the report always lists them individually at any rank.
 */
const POLICY_RANK: Record<string, number> = { none: 0, quarantine: 1, reject: 2 };
const QUALIFIER_RANK: Record<string, number> = { '+': 0, '?': 1, '~': 2, '-': 3 };
const MODE_RANK: Record<string, number> = { none: 0, testing: 1, enforce: 2 };

const DIRECTION_SCALES: Record<string, Record<string, number>> = {
  'dmarc.p': POLICY_RANK,
  'dmarc.sp': POLICY_RANK,
  'spf.allQualifier': QUALIFIER_RANK,
  'mtaSts.mode': MODE_RANK,
};

export type ChangeDirection = 'strengthening' | 'weakening' | 'neutral';

export function classifyDirection(event: ChangeEvent): ChangeDirection {
  const scale = DIRECTION_SCALES[event.field];
  if (scale) {
    const from = typeof event.from === 'string' ? scale[event.from] : undefined;
    const to = typeof event.to === 'string' ? scale[event.to] : undefined;
    if (from === undefined || to === undefined) {
      // Adding a policy where there was none is strengthening; removing one is
      // weakening. Either way one side is absent, so the scale cannot compare.
      if (to !== undefined && from === undefined) return 'strengthening';
      if (from !== undefined && to === undefined) return 'weakening';
      return 'neutral';
    }
    if (to > from) return 'strengthening';
    if (to < from) return 'weakening';
    return 'neutral';
  }

  // Publishing a mechanism is strengthening; withdrawing it is weakening.
  if (event.field.endsWith('.present') || event.field === 'bimi.hasVmc') {
    if (event.to === true) return 'strengthening';
    if (event.to === false) return 'weakening';
  }

  if (event.field === 'spf.exceedsLookupLimit') {
    return event.to === true ? 'weakening' : 'strengthening';
  }

  if (event.field === 'dmarc.pct') {
    const from = typeof event.from === 'number' ? event.from : 0;
    const to = typeof event.to === 'number' ? event.to : 0;
    if (to > from) return 'strengthening';
    if (to < from) return 'weakening';
  }

  return 'neutral';
}
