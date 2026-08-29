import { TIER1_MAX_RANK, type Aggregate, type ChangeEvent } from '@observatory/core';
import { classifyDirection } from './diff.js';

export interface ReportInput {
  date: string;
  events: readonly ChangeEvent[];
  aggregate: Aggregate | undefined;
  /** Nameservers responsible for a suspicious share of unknown results. */
  unknownClusters?: readonly { nameserver: string; count: number }[] | undefined;
}

export interface Cluster {
  provider: string;
  field: string;
  from: string;
  to: string;
  domains: string[];
}

/** Human names for fields. Users recognise "policy", not "dmarc.p". */
const FIELD_LABELS: Record<string, string> = {
  'dmarc.p': 'DMARC policy',
  'dmarc.sp': 'DMARC subdomain policy',
  'dmarc.pct': 'DMARC sampling rate',
  'dmarc.present': 'DMARC',
  'dmarc.adkim': 'DKIM alignment',
  'dmarc.aspf': 'SPF alignment',
  'spf.allQualifier': 'SPF enforcement',
  'spf.present': 'SPF',
  'spf.exceedsLookupLimit': 'SPF lookup limit',
  'mtaSts.mode': 'MTA-STS mode',
  'mtaSts.present': 'MTA-STS',
  'bimi.present': 'BIMI',
  'bimi.hasLogo': 'BIMI logo',
  'bimi.hasVmc': 'BIMI verified mark',
  'tlsRpt.present': 'TLS reporting',
  'mx.provider': 'mail provider',
  'mx.isNullMx': 'null MX',
  dnssec: 'DNSSEC',
};

function label(field: string): string {
  return FIELD_LABELS[field] ?? field;
}

function value(v: ChangeEvent['from']): string {
  if (v === null) return 'none';
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  return String(v);
}

/**
 * A cluster is >=5 domains on the same MX provider making the SAME field
 * change on the SAME day.
 *
 * This is the highest-value finding the project produces: individual domains
 * change policy constantly, but forty domains on one provider changing
 * identically overnight is a provider-side default change — a fact about the
 * industry rather than about any one company. Self-hosted domains are excluded
 * because "self-hosted" is not an operator and cannot make a coordinated
 * change.
 */
export function findClusters(events: readonly ChangeEvent[], minSize = 5): Cluster[] {
  const groups = new Map<string, Cluster>();

  for (const event of events) {
    if (event.mxProvider === undefined) continue;
    if (event.mxProvider === 'none' || event.mxProvider === 'self-hosted') continue;
    if (event.kind === 'first_seen') continue;

    const key = `${event.mxProvider} ${event.field} ${value(event.from)} ${value(event.to)}`;
    const existing = groups.get(key);
    if (existing) {
      existing.domains.push(event.domain);
    } else {
      groups.set(key, {
        provider: event.mxProvider,
        field: event.field,
        from: value(event.from),
        to: value(event.to),
        domains: [event.domain],
      });
    }
  }

  return [...groups.values()]
    .filter((c) => c.domains.length >= minSize)
    .sort((a, b) => b.domains.length - a.domains.length);
}

const HIGH_RANK_FIELDS = new Set(['dmarc.p', 'mtaSts.mode', 'spf.allQualifier']);

/** Any top-1000 domain changing policy, enforcement or MTA-STS mode. */
export function findHighRankMovers(events: readonly ChangeEvent[]): ChangeEvent[] {
  return events
    .filter((e) => e.rank <= TIER1_MAX_RANK && HIGH_RANK_FIELDS.has(e.field))
    .sort((a, b) => a.rank - b.rank);
}

/**
 * Weakening moves at any rank. These are rarer than strengthening moves and
 * more interesting, so every one is listed however small the day.
 */
export function findWeakening(events: readonly ChangeEvent[]): ChangeEvent[] {
  return events
    .filter((e) => e.kind !== 'first_seen' && classifyDirection(e) === 'weakening')
    .sort((a, b) => a.rank - b.rank);
}

export function findFirstTimeAdopters(events: readonly ChangeEvent[]): {
  total: number;
  byProvider: [string, number][];
} {
  const adopters = events.filter(
    (e) => e.field === 'dmarc.present' && e.to === true && e.kind !== 'first_seen',
  );
  const byProvider = new Map<string, number>();
  for (const e of adopters) {
    const provider = e.mxProvider ?? 'unknown';
    byProvider.set(provider, (byProvider.get(provider) ?? 0) + 1);
  }
  return {
    total: adopters.length,
    byProvider: [...byProvider.entries()].sort((a, b) => b[1] - a[1]),
  };
}

function pct(n: number): string {
  return `${(n * 100).toFixed(2)}%`;
}

function describe(event: ChangeEvent): string {
  if (event.kind === 'added') {
    return `**${event.domain}** (#${event.rank}) published ${label(event.field)} \`${value(event.to)}\``;
  }
  if (event.kind === 'removed') {
    return `**${event.domain}** (#${event.rank}) withdrew ${label(event.field)} (was \`${value(event.from)}\`)`;
  }
  return `**${event.domain}** (#${event.rank}) moved ${label(event.field)} \`${value(event.from)}\` to \`${value(event.to)}\``;
}

/**
 * Renders the daily report.
 *
 * On a day with nothing notable this writes a short report saying so. Padding
 * it would be worse than useless: a one-line report on a quiet day is what
 * makes the report on a loud day credible.
 */
export function renderReport(input: ReportInput): string {
  const { date, events, aggregate } = input;
  const substantive = events.filter((e) => e.kind !== 'first_seen');
  const firstSeen = events.filter((e) => e.kind === 'first_seen');
  const domains = new Set(substantive.map((e) => e.domain));

  const clusters = findClusters(events);
  const highRank = findHighRankMovers(substantive);
  const weakening = findWeakening(substantive);
  const adopters = findFirstTimeAdopters(events);
  const anomalies = renderAnomalies(input);

  const lines: string[] = [`# ${date}`, ''];

  if (events.length === 0) {
    lines.push('No changes observed.', '');
    lines.push(footer(aggregate));
    return `${lines.join('\n')}\n`;
  }

  if (substantive.length > 0) {
    lines.push(
      `**${substantive.length} ${substantive.length === 1 ? 'change' : 'changes'}** across ` +
        `${domains.size} ${domains.size === 1 ? 'domain' : 'domains'}.`,
    );
  } else {
    lines.push('No changes among domains already being tracked.');
  }

  if (firstSeen.length > 0) {
    lines.push('', `${firstSeen.length} domains entered the dataset for the first time.`);
  }

  if (aggregate?.degraded === true) {
    lines.push(
      '',
      `> Elevated unknown rate (${pct(aggregate.unknownRate)}). Some results were carried ` +
        'forward from the previous crawl and produced no change events. See Anomalies.',
    );
  }
  lines.push('');

  const enforcement: string[] = [];
  // Clusters first: they are the finding, individual movers are the detail.
  for (const cluster of clusters) {
    enforcement.push(
      `- **${cluster.domains.length} ${cluster.provider}-hosted domains** moved ` +
        `${label(cluster.field)} \`${cluster.from}\` to \`${cluster.to}\` on the same day, ` +
        'which points to a provider-side default change rather than ' +
        `${cluster.domains.length} independent decisions. ` +
        `Examples: ${cluster.domains.slice(0, 5).join(', ')}` +
        `${cluster.domains.length > 5 ? `, and ${cluster.domains.length - 5} more` : ''}.`,
    );
  }
  const clustered = new Set(clusters.flatMap((c) => c.domains));
  for (const event of highRank) {
    if (clustered.has(event.domain)) continue;
    if (classifyDirection(event) === 'weakening') continue;
    enforcement.push(`- ${describe(event)}`);
  }
  const pctRaises = substantive.filter(
    (e) => e.field === 'dmarc.pct' && classifyDirection(e) === 'strengthening',
  );
  if (pctRaises.length > 0) {
    enforcement.push(`- ${pctRaises.length} domains raised their DMARC sampling rate.`);
  }

  if (enforcement.length > 0) lines.push('## Enforcement moves', '', ...enforcement, '');

  if (weakening.length > 0) {
    lines.push('## Weakening', '');
    for (const event of weakening) lines.push(`- ${describe(event)}`);
    lines.push('');
  }

  if (adopters.total > 0) {
    lines.push('## First-time adopters', '');
    lines.push(
      `- ${adopters.total} ${adopters.total === 1 ? 'domain' : 'domains'} published DMARC for the first time.`,
    );
    for (const [provider, count] of adopters.byProvider.slice(0, 5)) {
      lines.push(`  - ${provider}: ${count}`);
    }
    lines.push('');
  }

  if (anomalies.length > 0) lines.push('## Anomalies', '', ...anomalies, '');

  // Only say this when there were changes to assess. If there were none, the
  // summary line above has already said so and repeating it reads as padding.
  if (
    substantive.length > 0 &&
    enforcement.length === 0 &&
    weakening.length === 0 &&
    adopters.total === 0
  ) {
    lines.push('No change met the notability rules today.', '');
  }

  lines.push(footer(aggregate));
  return `${lines.join('\n')}\n`;
}

function renderAnomalies(input: ReportInput): string[] {
  const out: string[] = [];
  const { aggregate, unknownClusters = [] } = input;

  if (aggregate?.degraded === true) {
    out.push(
      `- The unknown rate for this run was ${pct(aggregate.unknownRate)}, above the 2% threshold. ` +
        'Affected records were carried forward from their last successful observation and ' +
        'produced no change events, so no figure above reflects a resolver failure.',
    );
  }

  for (const cluster of unknownClusters) {
    // One nameserver dominating the failures is their outage, not a change in
    // the domains they serve.
    out.push(
      `- \`${cluster.nameserver}\` accounted for ${cluster.count} unresolved lookups, which ` +
        'points to an outage at that nameserver rather than any change at the domains it serves.',
    );
  }

  return out;
}

function footer(aggregate: Aggregate | undefined): string {
  const listId = aggregate?.listId ?? 'unknown';
  return `---\n*Generated from Tranco list \`${listId}\`. Methodology: [docs/METHODOLOGY.md](../docs/METHODOLOGY.md).*`;
}

/**
 * Attaches the MX provider to each event so the report can cluster by it. The
 * differ deliberately does not: provider is a property of the snapshot, not of
 * the change.
 */
export function annotateWithProvider(
  events: readonly ChangeEvent[],
  providerOf: (domain: string) => string | undefined,
): ChangeEvent[] {
  return events.map((event) => {
    const provider = providerOf(event.domain);
    return provider === undefined ? event : { ...event, mxProvider: provider };
  });
}
