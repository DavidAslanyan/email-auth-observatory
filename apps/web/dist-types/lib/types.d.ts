export type Tally = Record<string, number>;
export interface AggregateTotals {
  spf: {
    present: number;
    allQualifier: Tally;
    exceedsLookupLimit: number;
  };
  dmarc: {
    present: number;
    p: Tally;
    pctBelow100: number;
  };
  bimi: {
    present: number;
    hasVmc: number;
    declined: number;
  };
  mtaSts: {
    present: number;
    mode: Tally;
  };
  tlsRpt: {
    present: number;
  };
  dnssec: Tally;
  mx: {
    present: number;
    isNullMx: number;
  };
}
export interface AggregateSlice {
  domainsObserved: number;
  totals: AggregateTotals;
}
export interface Aggregate {
  date: string;
  listId: string;
  domainsObserved: number;
  unknownRate: number;
  degraded: boolean;
  totals: AggregateTotals;
  byTld: Record<string, AggregateSlice>;
  byMxProvider: Record<string, AggregateSlice>;
  byRankBucket: Record<string, AggregateSlice>;
}
export type HistoryEntry = Omit<Aggregate, 'byTld' | 'byMxProvider'>;
export interface ChangeEvent {
  domain: string;
  rank: number;
  field: string;
  kind: 'added' | 'removed' | 'modified' | 'first_seen';
  from: string | number | boolean | null;
  to: string | number | boolean | null;
  ts: string;
  mxProvider?: string;
}
export interface IndexedDomain {
  domain: string;
  rank: number;
  dnssec: string;
  crawledAt: string;
  spf: {
    present: boolean;
    allQualifier: string | null;
    stale: boolean;
  };
  dmarc: {
    present: boolean;
    p: string | null;
    sp: string | null;
    pct: number | null;
    stale: boolean;
  };
  bimi: {
    present: boolean;
    hasVmc: boolean;
    declined: boolean;
  };
  mtaSts: {
    present: boolean;
    mode: string | null;
  };
  tlsRpt: {
    present: boolean;
  };
  mx: {
    provider: string | null;
    isNullMx: boolean;
    hosts: string[];
  };
  dkim: {
    selectorsFound: string[];
    probeStrategy: string;
  };
}
export interface Manifest {
  stagedAt: string;
  changes: string[];
  reports: string[];
  domainsIndexed: number;
}
