import Bottleneck from 'bottleneck';
import { RETRY, TIMEOUTS, type LookupStatus, type ResolverTier } from '@mailscape/core';
import { CLOUDFLARE_DOH, GOOGLE_DOH, queryDoh, type DohEndpoint } from './doh-client.js';
import { isFailure } from './rcode.js';
import { queryUdp, type UdpTarget } from './udp-client.js';
import type { DnsAnswer, RecordType, ResolverStats } from './types.js';

export interface ResolverConfig {
  local: UdpTarget;
  localAttempts: number;
  localTimeoutMs: number;
  dohTimeoutMs: number;
  /** Set false to skip the DoH tiers entirely, for offline testing. */
  useDoh: boolean;
  localConcurrency: number;
  dohConcurrency: number;
  dohMinTimeMs: number;
}

export const DEFAULT_RESOLVER_CONFIG: ResolverConfig = {
  local: { host: '127.0.0.1', port: 53 },
  localAttempts: RETRY.localAttempts,
  localTimeoutMs: TIMEOUTS.localMs,
  dohTimeoutMs: TIMEOUTS.dohMs,
  useDoh: true,
  localConcurrency: 100,
  dohConcurrency: 10,
  dohMinTimeMs: 20,
};

const EMPTY_STATUS_COUNTS = (): Record<LookupStatus, number> => ({
  ok: 0,
  nodata: 0,
  nxdomain: 0,
  unknown: 0,
});

const EMPTY_RESOLVER_COUNTS = (): Record<ResolverTier, number> => ({
  local: 0,
  'doh-cloudflare': 0,
  'doh-google': 0,
});

/**
 * Tiered resolution: local recursion first, then two DoH endpoints.
 *
 * The tiers exist so that a transient failure at one resolver does not become
 * an `unknown` in the dataset. Escalation happens ONLY on `unknown` — a
 * `nodata` answer is a real observation and re-asking a second resolver would
 * spend the whole DoH budget on the large fraction of names that legitimately
 * have no record.
 */
export class Resolver {
  readonly #config: ResolverConfig;
  readonly #localLimiter: Bottleneck;
  readonly #dohLimiter: Bottleneck;

  #total = 0;
  #byStatus = EMPTY_STATUS_COUNTS();
  #byResolver = EMPTY_RESOLVER_COUNTS();
  #byRcode: Record<string, number> = {};
  /** Nameserver -> count of unknown results, for outage attribution. */
  #unknownByAuthority = new Map<string, number>();

  constructor(config: Partial<ResolverConfig> = {}) {
    this.#config = { ...DEFAULT_RESOLVER_CONFIG, ...config };

    // Local recursion fans out to thousands of different authoritative servers,
    // so high concurrency with no spacing is correct.
    this.#localLimiter = new Bottleneck({ maxConcurrent: this.#config.localConcurrency });

    // DoH is ONE endpoint. It should only ever see 1-3% of traffic; if it sees
    // more, the local resolver is broken and raising these numbers would hide
    // that rather than fix it.
    this.#dohLimiter = new Bottleneck({
      maxConcurrent: this.#config.dohConcurrency,
      minTime: this.#config.dohMinTimeMs,
    });
  }

  async query(name: string, type: RecordType): Promise<DnsAnswer> {
    const answer = await this.#resolveThroughTiers(name, type);
    this.#record(answer);
    return answer;
  }

  async #resolveThroughTiers(name: string, type: RecordType): Promise<DnsAnswer> {
    let last: DnsAnswer | undefined;

    for (let attempt = 0; attempt < this.#config.localAttempts; attempt++) {
      const answer = await this.#localLimiter.schedule(() =>
        queryUdp(this.#config.local, name, type, {
          timeoutMs: this.#config.localTimeoutMs,
          dnssecOk: true,
        }),
      );
      if (!isFailure(answer.status)) return answer;
      last = answer;
    }

    if (this.#config.useDoh) {
      for (const endpoint of [CLOUDFLARE_DOH, GOOGLE_DOH] satisfies DohEndpoint[]) {
        const answer = await this.#dohLimiter.schedule(() =>
          queryDoh(endpoint, name, type, { timeoutMs: this.#config.dohTimeoutMs, dnssecOk: true }),
        );
        if (!isFailure(answer.status)) return answer;
        last = answer;
      }
    }

    // Every tier failed. This is `unknown`, and the caller must carry the
    // previous value forward rather than record an absence.
    return (
      last ?? {
        status: 'unknown',
        rcode: 'NO_RESOLVER',
        resolver: 'local',
        elapsedMs: 0,
        ad: false,
        txt: [],
        mx: [],
        authority: [],
      }
    );
  }

  #record(answer: DnsAnswer): void {
    this.#total += 1;
    this.#byStatus[answer.status] += 1;
    this.#byResolver[answer.resolver] += 1;
    this.#byRcode[answer.rcode] = (this.#byRcode[answer.rcode] ?? 0) + 1;

    if (answer.status === 'unknown') {
      for (const ns of answer.authority) {
        this.#unknownByAuthority.set(ns, (this.#unknownByAuthority.get(ns) ?? 0) + 1);
      }
    }
  }

  getStats(): ResolverStats {
    return {
      total: this.#total,
      byStatus: { ...this.#byStatus },
      byResolver: { ...this.#byResolver },
      byRcode: { ...this.#byRcode },
      unknownRate: this.#total === 0 ? 0 : this.#byStatus.unknown / this.#total,
    };
  }

  /**
   * Nameservers responsible for more than `threshold` unknown results.
   * A single server dominating the failures means their outage, not a change
   * in the domains they serve — the report says so explicitly.
   */
  getUnknownClusters(threshold: number): { nameserver: string; count: number }[] {
    return [...this.#unknownByAuthority.entries()]
      .filter(([, count]) => count > threshold)
      .map(([nameserver, count]) => ({ nameserver, count }))
      .sort((a, b) => b.count - a.count);
  }

  resetStats(): void {
    this.#total = 0;
    this.#byStatus = EMPTY_STATUS_COUNTS();
    this.#byResolver = EMPTY_RESOLVER_COUNTS();
    this.#byRcode = {};
    this.#unknownByAuthority = new Map();
  }

  async shutdown(): Promise<void> {
    await Promise.all([this.#localLimiter.stop(), this.#dohLimiter.stop()]);
  }
}
