/*
 * Optional properties here are written `x?: T | undefined` rather than `x?: T`.
 * The project compiles with `exactOptionalPropertyTypes`, under which those two
 * differ: the second forbids an explicitly-undefined value. These records are
 * produced by zod parsing at the read boundary, and zod's `.optional()` yields
 * `T | undefined`, so the wider form is the one that is actually true of the
 * data. JSON.stringify drops undefined values either way, so nothing reaches
 * disk differently.
 */

/**
 * The four-state rule (plan section 1.1) lives in this union and nowhere else.
 *
 * `nodata` and `nxdomain` are genuine absence: the domain really does not
 * publish this record. `unknown` means *we* failed — SERVFAIL, REFUSED, a
 * timeout, a network error. Collapsing `unknown` into absence turns one bad
 * morning at the resolver into a fabricated finding ("8,000 domains dropped
 * DMARC overnight") in a dataset whose entire premise is that the deltas are
 * trustworthy. Never reduce this to a boolean.
 */
export type LookupStatus = 'ok' | 'nodata' | 'nxdomain' | 'unknown';

export type ResolverTier = 'local' | 'doh-cloudflare' | 'doh-google';

export type DnssecState = 'signed' | 'unsigned' | 'unknown';

/**
 * What is persisted about a lookup.
 *
 * Note what is NOT here: per-lookup latency. It is real telemetry and it lives
 * on the resolver's DnsAnswer and in the run summary's percentiles, but storing
 * it per record would change every line of every snapshot on every crawl. That
 * defeats git delta compression completely — measured at 949 of 1,000 lines
 * rewritten for 51 real changes — and the dataset is the git history, so that
 * cost compounds forever in exchange for a number nobody queries.
 */
export interface LookupMeta {
  status: LookupStatus;
  /** 'NOERROR' | 'NXDOMAIN' | 'SERVFAIL' | 'REFUSED' | 'TIMEOUT' | ... */
  rcode: string;
  /** Which tier answered. Provenance: a DoH answer may come from a shared cache. */
  resolver: ResolverTier;
  /** DNSSEC Authenticated Data flag. */
  ad: boolean;
  /**
   * True when this value was carried forward from a previous crawl because
   * the current lookup returned `unknown`.
   */
  stale?: boolean | undefined;
  /** ISO 8601, only when stale. */
  lastSeenAt?: string | undefined;
}

export type SpfQualifier = '+' | '-' | '~' | '?';

export interface SpfState extends LookupMeta {
  present: boolean;
  raw?: string | undefined;
  /**
   * RFC 7208 section 4.5: more than one v=spf1 record is a permerror at the
   * receiver. Recording it is more interesting than hiding it.
   */
  multipleRecords: boolean;
  recordCount: number;
  /** The qualifier on the final `all` mechanism. */
  allQualifier?: SpfQualifier | undefined;
  /** Terms in this record that require a DNS lookup. More than 10 is invalid. */
  lookupCount?: number | undefined;
  exceedsLookupLimit?: boolean | undefined;
  hasRedirect: boolean;
  includes: string[];
  parseError?: string | undefined;
}

export type DmarcPolicy = 'none' | 'quarantine' | 'reject';

export type DmarcAlignment = 'r' | 's';

export interface DmarcState extends LookupMeta {
  present: boolean;
  raw?: string | undefined;
  multipleRecords: boolean;
  p?: DmarcPolicy | undefined;
  /**
   * RFC 7489 section 6.3: sp defaults to p when absent. Stored as absent rather
   * than eagerly copied from p — copying destroys the ability to detect the day
   * someone explicitly adds an sp tag.
   */
  sp?: DmarcPolicy | undefined;
  /** 0-100, defaults to 100 when absent. */
  pct?: number | undefined;
  adkim?: DmarcAlignment | undefined;
  aspf?: DmarcAlignment | undefined;
  fo?: string | undefined;
  ri?: number | undefined;
  /** Number of aggregate report destinations. */
  ruaCount: number;
  rufCount: number;
  /** Domain parts only, never full mailto addresses — see plan section 4.1.1. */
  ruaHosts: string[];
  parseError?: string | undefined;
}

export interface BimiState extends LookupMeta {
  present: boolean;
  raw?: string | undefined;
  /** l= present and non-empty. */
  hasLogo: boolean;
  /** a= present (Verified Mark Certificate). */
  hasVmc: boolean;
  /** l= present but empty — an explicit opt-out, distinct from absent. */
  declined: boolean;
  parseError?: string | undefined;
}

export type MtaStsMode = 'enforce' | 'testing' | 'none';

export interface MtaStsState extends LookupMeta {
  /** TXT record at _mta-sts. The policy file is fetched in a separate pass. */
  present: boolean;
  policyId?: string | undefined;
  policyFetched: boolean;
  mode?: MtaStsMode | undefined;
  maxAge?: number | undefined;
  mxPatternCount?: number | undefined;
  policyError?: string | undefined;
}

export interface TlsRptState extends LookupMeta {
  present: boolean;
  raw?: string | undefined;
  ruaCount: number;
  ruaHosts: string[];
  parseError?: string | undefined;
}

export interface MxState extends LookupMeta {
  present: boolean;
  /** Lowercased, trailing dot stripped, sorted by preference then name. */
  hosts: string[];
  /** 'google' | 'microsoft' | ... | 'self-hosted' | 'unknown' */
  provider?: string | undefined;
  /**
   * RFC 7505: a single MX with exchange "." and preference 0 means the domain
   * explicitly receives no mail. This is a *good* configuration and must never
   * be counted as a missing MX.
   */
  isNullMx: boolean;
}

export type DkimProbeStrategy = 'mx-conditional' | 'generic-fallback' | 'skipped';

export interface DkimState {
  status: LookupStatus;
  /**
   * ALWAYS a lower bound. DKIM selectors cannot be enumerated from DNS, only
   * guessed, so absence proves nothing. There is deliberately no `hasDkim`
   * field anywhere in this codebase.
   */
  selectorsFound: string[];
  selectorsProbed: string[];
  probeStrategy: DkimProbeStrategy;
}

export interface DomainSnapshot {
  domain: string;
  rank: number;
  listId: string;
  /** ISO 8601 UTC. */
  crawledAt: string;
  dnssec: DnssecState;
  spf: SpfState;
  dmarc: DmarcState;
  bimi: BimiState;
  mtaSts: MtaStsState;
  tlsRpt: TlsRptState;
  mx: MxState;
  dkim: DkimState;
}

export type ChangeKind = 'added' | 'removed' | 'modified' | 'first_seen';

export type ChangeValue = string | number | boolean | null;

export interface ChangeEvent {
  domain: string;
  rank: number;
  /** Dotted path, e.g. 'dmarc.p', 'mtaSts.mode'. */
  field: string;
  kind: ChangeKind;
  from: ChangeValue;
  to: ChangeValue;
  /** ISO 8601. */
  ts: string;
  /** Populated by the report generator for clustering, not by the differ. */
  mxProvider?: string | undefined;
}

/** Counts keyed by an enum-ish string, e.g. { '-all': 3201, '~all': 8102 }. */
export type Tally = Record<string, number>;

export interface AggregateTotals {
  spf: { present: number; allQualifier: Tally; exceedsLookupLimit: number };
  dmarc: { present: number; p: Tally; pctBelow100: number };
  bimi: { present: number; hasVmc: number; declined: number };
  mtaSts: { present: number; mode: Tally };
  tlsRpt: { present: number };
  dnssec: Tally;
  mx: { present: number; isNullMx: number };
}

export interface AggregateSlice {
  domainsObserved: number;
  totals: AggregateTotals;
}

export interface Aggregate {
  /** YYYY-MM-DD, UTC. */
  date: string;
  listId: string;
  domainsObserved: number;
  unknownRate: number;
  /**
   * True when unknownRate exceeded the threshold. A degraded day is published
   * with the flag set, never silently dropped and never silently trusted.
   */
  degraded: boolean;
  totals: AggregateTotals;
  byTld: Record<string, AggregateSlice>;
  byMxProvider: Record<string, AggregateSlice>;
  byRankBucket: Record<string, AggregateSlice>;
}

/**
 * One line of data/aggregates/history.jsonl: the aggregate minus the byTld and
 * byMxProvider breakdowns, so the whole time series stays a single small fetch
 * for the dashboard's trend charts.
 */
export type AggregateHistoryEntry = Omit<Aggregate, 'byTld' | 'byMxProvider'>;

export interface RunSummary {
  command: string;
  startedAt: string;
  finishedAt: string;
  elapsedMs: number;
  listId: string;
  domainsAttempted: number;
  domainsCompleted: number;
  lookupsTotal: number;
  unknownLookups: number;
  unknownRate: number;
  degraded: boolean;
  byResolver: Record<ResolverTier, number>;
  /** Lookup latency, aggregated. Per-record timing is deliberately not stored. */
  latencyMs?: { median: number; p95: number } | undefined;
  changesEmitted: number;
  /**
   * Claimed disappearances a second lookup contradicted. Above zero means the
   * resolver returned an incomplete answer set at least once during the run.
   */
  disappearancesRetracted?: number | undefined;
}
