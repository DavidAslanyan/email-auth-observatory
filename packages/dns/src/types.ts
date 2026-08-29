import type { LookupStatus, ResolverTier } from '@mailscape/core';

export type RecordType = 'TXT' | 'MX' | 'A' | 'AAAA' | 'NS' | 'SOA' | 'CNAME';

export interface MxAnswer {
  preference: number;
  exchange: string;
}

/**
 * One resolver's answer, normalised across the raw-wire and DoH-JSON paths so
 * nothing downstream needs to know which tier produced it.
 */
export interface DnsAnswer {
  status: LookupStatus;
  rcode: string;
  resolver: ResolverTier;
  elapsedMs: number;
  /** DNSSEC Authenticated Data flag from the response header. */
  ad: boolean;
  /** TXT records, each already joined from its chunks. */
  txt: string[];
  mx: MxAnswer[];
  /** Nameservers seen in the authority section, used for outage attribution. */
  authority: string[];
}

export interface QueryOptions {
  timeoutMs: number;
  /** Set the EDNS0 DO bit so the resolver reports DNSSEC validation status. */
  dnssecOk?: boolean;
}

export interface ResolverStats {
  total: number;
  byStatus: Record<LookupStatus, number>;
  byResolver: Record<ResolverTier, number>;
  unknownRate: number;
  /** Rcode counts, for spotting an authoritative-server outage in the report. */
  byRcode: Record<string, number>;
}
