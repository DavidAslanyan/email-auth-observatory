import type { LookupStatus } from '@mailscape/core';

/** Numeric RCODE to name, per the IANA DNS RCODE registry. */
export const RCODE_NAMES: Record<number, string> = {
  0: 'NOERROR',
  1: 'FORMERR',
  2: 'SERVFAIL',
  3: 'NXDOMAIN',
  4: 'NOTIMP',
  5: 'REFUSED',
  6: 'YXDOMAIN',
  7: 'YXRRSET',
  8: 'NXRRSET',
  9: 'NOTAUTH',
  10: 'NOTZONE',
};

/** Synthetic rcodes for conditions that never reach a response header. */
export const SYNTHETIC_RCODES = {
  timeout: 'TIMEOUT',
  networkError: 'NETWORK_ERROR',
  truncatedRetryFailed: 'TRUNCATED_RETRY_FAILED',
  malformedResponse: 'MALFORMED_RESPONSE',
} as const;

/**
 * The enforcement point for the four-state rule (plan section 1.1).
 *
 * A DNS lookup has four outcomes, never two. `nodata` and `nxdomain` are
 * genuine absence — the domain really does not publish this record. Everything
 * else is OUR failure, and must be recorded as `unknown` so that downstream it
 * produces no change event and carries the previous value forward.
 *
 * Note the deliberate absence of a "close enough" default: an rcode this
 * function has never heard of is `unknown`, never absence.
 */
export function toLookupStatus(rcode: string, answerCount: number): LookupStatus {
  switch (rcode) {
    case 'NOERROR':
      return answerCount > 0 ? 'ok' : 'nodata';
    case 'NXDOMAIN':
      return 'nxdomain';
    default:
      // SERVFAIL, REFUSED, NOTIMP, FORMERR, TIMEOUT, NETWORK_ERROR and anything
      // unrecognised. We failed; they did not answer.
      return 'unknown';
  }
}

/**
 * True when a lookup should be retried at the next resolver tier.
 *
 * Only `unknown` qualifies. A `nodata` answer is a real observation and
 * escalating it would spend the DoH budget on the large fraction of lookups
 * that legitimately have no record.
 */
export function isFailure(status: LookupStatus): boolean {
  return status === 'unknown';
}

export function rcodeName(rcode: number): string {
  return RCODE_NAMES[rcode] ?? `RCODE_${rcode}`;
}
