import type { DomainSnapshot, LookupStatus } from '@mailscape/core';

interface Overrides {
  domain?: string;
  rank?: number;
  crawledAt?: string;
  dnssec?: DomainSnapshot['dnssec'];
  spf?: Partial<DomainSnapshot['spf']>;
  dmarc?: Partial<DomainSnapshot['dmarc']>;
  bimi?: Partial<DomainSnapshot['bimi']>;
  mtaSts?: Partial<DomainSnapshot['mtaSts']>;
  tlsRpt?: Partial<DomainSnapshot['tlsRpt']>;
  mx?: Partial<DomainSnapshot['mx']>;
  dkim?: Partial<DomainSnapshot['dkim']>;
}

const meta = (status: LookupStatus = 'ok') => ({
  status,
  rcode: status === 'ok' ? 'NOERROR' : status === 'unknown' ? 'SERVFAIL' : 'NOERROR',
  resolver: 'local' as const,
  elapsedMs: 12,
  ad: false,
});

/** A snapshot with every mechanism absent but successfully observed. */
export function snapshot(overrides: Overrides = {}): DomainSnapshot {
  return {
    domain: overrides.domain ?? 'example.com',
    rank: overrides.rank ?? 42,
    listId: 'TESTLIST',
    crawledAt: overrides.crawledAt ?? '2026-08-29T00:00:00.000Z',
    dnssec: overrides.dnssec ?? 'unsigned',
    spf: {
      ...meta(),
      present: false,
      multipleRecords: false,
      recordCount: 0,
      hasRedirect: false,
      includes: [],
      ...overrides.spf,
    },
    dmarc: {
      ...meta(),
      present: false,
      multipleRecords: false,
      ruaCount: 0,
      rufCount: 0,
      ruaHosts: [],
      ...overrides.dmarc,
    },
    bimi: {
      ...meta(),
      present: false,
      hasLogo: false,
      hasVmc: false,
      declined: false,
      ...overrides.bimi,
    },
    mtaSts: { ...meta(), present: false, policyFetched: false, ...overrides.mtaSts },
    tlsRpt: { ...meta(), present: false, ruaCount: 0, ruaHosts: [], ...overrides.tlsRpt },
    mx: { ...meta(), present: false, hosts: [], isNullMx: false, ...overrides.mx },
    dkim: {
      status: 'ok',
      selectorsFound: [],
      selectorsProbed: [],
      probeStrategy: 'generic-fallback',
      ...overrides.dkim,
    },
  };
}

export const ALL_STATUSES: readonly LookupStatus[] = ['ok', 'nodata', 'nxdomain', 'unknown'];
