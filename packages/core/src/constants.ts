/** DNS label prefixes for each record type, relative to the domain apex. */
export const RECORD_PREFIXES = {
  dmarc: '_dmarc',
  bimi: 'default._bimi',
  mtaSts: '_mta-sts',
  tlsRpt: '_smtp._tls',
} as const;

export const TIMEOUTS = {
  localMs: 5_000,
  dohMs: 10_000,
  /** MTA-STS policy fetch. Runs in its own pass, never blocking the DNS pass. */
  policyFetchMs: 10_000,
} as const;

export const RETRY = {
  localAttempts: 2,
  dohAttempts: 1,
} as const;

/** MX hostname suffix -> provider identity. Longest-suffix match wins. */
export const MX_PROVIDERS: Record<string, string> = {
  'aspmx.l.google.com': 'google',
  'googlemail.com': 'google',
  'google.com': 'google',
  'mail.protection.outlook.com': 'microsoft',
  'outlook.com': 'microsoft',
  'pphosted.com': 'proofpoint',
  'ppe-hosted.com': 'proofpoint',
  'mimecast.com': 'mimecast',
  'mimecast.co.za': 'mimecast',
  'zoho.com': 'zoho',
  'zoho.eu': 'zoho',
  'messagingengine.com': 'fastmail',
  'yandex.net': 'yandex',
  'qq.com': 'tencent',
  'amazonaws.com': 'amazon-ses',
  'secureserver.net': 'godaddy',
  'emailsrvr.com': 'rackspace',
  'barracudanetworks.com': 'barracuda',
  'antispamcloud.com': 'spamexperts',
  'hostedemail.com': 'openxchange',
  'improvmx.com': 'improvmx',
  'migadu.com': 'migadu',
  'protonmail.ch': 'proton',
  'zohomail.eu': 'zoho',
};

/** Returned by the MX parser when hosts are present but match no known suffix. */
export const PROVIDER_SELF_HOSTED = 'self-hosted';
/** Returned when there is no MX to classify at all. */
export const PROVIDER_UNKNOWN = 'unknown';

/**
 * DKIM selectors known to be used by each provider.
 * MX-conditional probing: resolve MX first, probe only the relevant selectors.
 * This turns a 15-lookup brute force into 1-3 lookups WITH a higher hit rate.
 */
export const DKIM_SELECTORS_BY_PROVIDER: Record<string, string[]> = {
  google: ['google'],
  microsoft: ['selector1', 'selector2'],
  zoho: ['zoho', 'zmail'],
  proofpoint: ['pps', 'selector1'],
  mimecast: ['mimecast'],
  fastmail: ['fm1', 'fm2', 'fm3'],
  yandex: ['mail'],
  // SES uses per-identity generated selectors; not enumerable.
  'amazon-ses': [],
  godaddy: ['default'],
  proton: ['protonmail', 'protonmail2', 'protonmail3'],
  migadu: ['key1', 'key2'],
  improvmx: [],
};

/** Used only when MX provider is unknown or self-hosted. Deliberately short. */
export const DKIM_GENERIC_SELECTORS = [
  'default',
  'selector1',
  'selector2',
  'dkim',
  's1',
  's2',
  'k1',
  'mail',
];

/**
 * Above this share of `unknown` lookups a run is marked degraded: its data is
 * still published, but flagged so nobody reads a resolver outage as a real
 * drop in adoption.
 */
export const UNKNOWN_RATE_DEGRADED_THRESHOLD = 0.02;

/**
 * How long a DKIM selector probe stays good for.
 *
 * Measured on a real long-tail shard: DKIM probes were 57% of every query the
 * crawl made. Selectors are a lower bound by definition and rotate on the order
 * of months, so re-deriving them on every observation buys almost nothing and
 * costs more than half the DNS budget. They are re-probed on this cadence, when
 * a domain is first seen, or when its mail provider changes — which is the event
 * that would actually change its selectors.
 */
export const DKIM_REFRESH_DAYS = 60;

/** Ranks 1..TIER1_MAX_RANK are crawled every twelve hours. */

export const TIER1_MAX_RANK = 1000;
/** Ranks TIER1_MAX_RANK+1..TIER2_MAX_RANK are split across TIER2_SHARDS. */
export const TIER2_MAX_RANK = 100_000;
/**
 * The long tail is split across this many shards, two of which are crawled per
 * day — so every long-tail domain is observed roughly fortnightly. Smaller,
 * more frequent shards also spread the load: the same coverage arrives as
 * several gentle bursts rather than one sustained hour at full rate.
 */
export const TIER2_SHARDS = 28;

/** RFC 7208 section 4.6.4. */
export const SPF_MAX_DNS_LOOKUPS = 10;

/** RFC 7489 section 6.3: ri defaults to one day. */
export const DMARC_DEFAULT_RI = 86_400;
/** RFC 7489 section 6.3: pct defaults to 100. */
export const DMARC_DEFAULT_PCT = 100;

export const RANK_BUCKETS: readonly { label: string; min: number; max: number }[] = [
  { label: '1-1000', min: 1, max: 1000 },
  { label: '1001-10000', min: 1001, max: 10_000 },
  { label: '10001-100000', min: 10_001, max: 100_000 },
];
