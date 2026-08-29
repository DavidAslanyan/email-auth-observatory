import { MX_PROVIDERS, PROVIDER_SELF_HOSTED } from '@observatory/core';

export interface MxRecord {
  preference: number;
  exchange: string;
}

export interface ParsedMx {
  /** Lowercased, trailing dot stripped, sorted by preference then name. */
  hosts: string[];
  /**
   * RFC 7505: a single MX with exchange "." means the domain explicitly
   * receives no mail. This is a deliberate, correct configuration — never
   * count it as a missing MX.
   */
  isNullMx: boolean;
  /** Absent when there are no hosts to classify. */
  provider?: string;
}

export function parseMx(records: readonly MxRecord[]): ParsedMx {
  if (records.length === 0) return { hosts: [], isNullMx: false };

  // RFC 7505 requires preference 0, but the meaning of a lone "." exchange is
  // unambiguous whatever preference accompanies it, so only the "single record
  // whose exchange is a bare root" part is enforced.
  const nullMx = records.length === 1 && normaliseHost(records[0]?.exchange ?? '') === '';
  if (nullMx) return { hosts: [], isNullMx: true };

  const sorted = [...records]
    .map((r) => ({ preference: r.preference, host: normaliseHost(r.exchange) }))
    .filter((r) => r.host !== '')
    .sort((a, b) => a.preference - b.preference || a.host.localeCompare(b.host));

  const hosts = sorted.map((r) => r.host);
  if (hosts.length === 0) return { hosts: [], isNullMx: false };

  return { hosts, isNullMx: false, provider: classifyProvider(sorted.map((r) => r.host)) };
}

function normaliseHost(exchange: string): string {
  return exchange.trim().toLowerCase().replace(/\.+$/, '');
}

/**
 * Longest-suffix match against the known-provider table.
 *
 * Longest wins because the table contains overlapping entries on purpose:
 * `google.com` and `aspmx.l.google.com` both map to google, but
 * `mail.protection.outlook.com` must beat `outlook.com` if a more specific
 * mapping is ever added beneath it.
 */
export function classifyHost(host: string): string | undefined {
  let best: string | undefined;
  let bestLength = -1;

  for (const [suffix, provider] of Object.entries(MX_PROVIDERS)) {
    if (host === suffix || host.endsWith(`.${suffix}`)) {
      if (suffix.length > bestLength) {
        bestLength = suffix.length;
        best = provider;
      }
    }
  }
  return best;
}

/**
 * Picks one provider for a domain from its MX set.
 *
 * The most frequently matched provider wins, with ties broken by the
 * lowest-preference host — a domain whose primary MX is a known provider and
 * whose backup is a self-run box is that provider, not "self-hosted".
 */
function classifyProvider(hostsByPreference: readonly string[]): string {
  const counts = new Map<string, number>();
  let firstMatch: string | undefined;

  for (const host of hostsByPreference) {
    const provider = classifyHost(host);
    if (provider === undefined) continue;
    firstMatch ??= provider;
    counts.set(provider, (counts.get(provider) ?? 0) + 1);
  }

  if (firstMatch === undefined) return PROVIDER_SELF_HOSTED;

  let winner = firstMatch;
  let winnerCount = counts.get(firstMatch) ?? 0;
  for (const [provider, count] of counts) {
    if (count > winnerCount) {
      winner = provider;
      winnerCount = count;
    }
  }
  return winner;
}
