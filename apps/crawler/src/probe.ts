import {
  DKIM_GENERIC_SELECTORS,
  DKIM_REFRESH_DAYS,
  DKIM_SELECTORS_BY_PROVIDER,
  RECORD_PREFIXES,
  type BimiState,
  type DkimState,
  type DmarcState,
  type DnssecState,
  type DomainSnapshot,
  type LookupStatus,
  type MtaStsState,
  type MxState,
  type SpfState,
  type TlsRptState,
} from '@observatory/core';
import type { DnsAnswer, Resolver } from '@observatory/dns';
import { selectByPrefix } from '@observatory/dns';
import {
  parseBimi,
  parseDmarc,
  parseMtaStsTxt,
  parseMx,
  parseSpf,
  parseTlsRpt,
  redactReportingAddresses,
} from '@observatory/parsers';

export interface ProbeInput {
  domain: string;
  rank: number;
  listId: string;
  /**
   * The crawl run's timestamp, shared by every domain in the run.
   *
   * Uniform rather than per-domain on purpose: a per-domain timestamp changes
   * every line of the snapshot on every crawl, so git can no longer tell an
   * unchanged domain from a changed one. Within a run that finishes in minutes
   * the extra precision carries no information anyway.
   */
  crawledAt?: string | undefined;
  /**
   * The previous observation, when there is one. Used only to decide whether
   * the DKIM selectors still need probing — see probeDkim.
   */
  previous?: DomainSnapshot | undefined;
  /** Days a DKIM probe stays good for. */
  dkimRefreshDays?: number | undefined;
}

/**
 * Composes one DomainSnapshot for one domain.
 *
 * MX resolves first because it chooses the DKIM selectors: probing the two
 * selectors a domain's actual mail provider uses beats brute-forcing fifteen
 * generic ones on both cost and hit rate.
 *
 * MTA-STS policy fetches are NOT done here. They are HTTPS requests against
 * ~2% of domains, and a slow web server must never be able to stall the DNS
 * pass, so they run as a separate pass afterwards.
 */
export async function probeDomain(resolver: Resolver, input: ProbeInput): Promise<DomainSnapshot> {
  const { domain, rank, listId } = input;
  const crawledAt = input.crawledAt ?? new Date().toISOString();

  const mxAnswer = await resolver.query(domain, 'MX');
  const mx = toMxState(mxAnswer);

  const [apex, dmarcAnswer, bimiAnswer, mtaStsAnswer, tlsRptAnswer] = await Promise.all([
    resolver.query(domain, 'TXT'),
    resolver.query(`${RECORD_PREFIXES.dmarc}.${domain}`, 'TXT'),
    resolver.query(`${RECORD_PREFIXES.bimi}.${domain}`, 'TXT'),
    resolver.query(`${RECORD_PREFIXES.mtaSts}.${domain}`, 'TXT'),
    resolver.query(`${RECORD_PREFIXES.tlsRpt}.${domain}`, 'TXT'),
  ]);

  const spf = toSpfState(apex);
  const dmarc = toDmarcState(dmarcAnswer);

  const dkim = await probeDkim(resolver, domain, {
    provider: mx.provider,
    crawledAt,
    previous: input.previous,
    refreshDays: input.dkimRefreshDays ?? DKIM_REFRESH_DAYS,
    // A domain with no MX, no SPF and no DMARC is not sending mail, so there is
    // nothing for DKIM to sign. Measured on a real shard: 3,035 such domains
    // cost 24,280 lookups and yielded 10 findings out of 5,571.
    sendsMail: mx.present || spf.present || dmarc.present,
  });

  return {
    domain,
    rank,
    listId,
    crawledAt,
    dnssec: toDnssec([mxAnswer, apex, dmarcAnswer, bimiAnswer, mtaStsAnswer, tlsRptAnswer]),
    spf,
    dmarc,
    bimi: toBimiState(bimiAnswer),
    mtaSts: toMtaStsState(mtaStsAnswer),
    tlsRpt: toTlsRptState(tlsRptAnswer),
    mx,
    dkim,
  };
}

function meta(answer: DnsAnswer): {
  status: LookupStatus;
  rcode: string;
  resolver: DnsAnswer['resolver'];
  ad: boolean;
} {
  return {
    status: answer.status,
    rcode: answer.rcode,
    resolver: answer.resolver,
    ad: answer.ad,
  };
}

/**
 * DNSSEC status for the domain as a whole.
 *
 * A single AD flag anywhere proves the zone is signed and validated. Absence of
 * AD across all responses means unsigned — but only if at least one lookup
 * actually succeeded. If every lookup failed we know nothing, and saying
 * "unsigned" would be an invention.
 */
function toDnssec(answers: readonly DnsAnswer[]): DnssecState {
  if (answers.some((a) => a.ad)) return 'signed';
  return answers.some((a) => a.status !== 'unknown') ? 'unsigned' : 'unknown';
}

function toSpfState(answer: DnsAnswer): SpfState {
  const base = meta(answer);
  const records = selectByPrefix(answer.txt, 'v=spf1');
  const state: SpfState = {
    ...base,
    present: records.length > 0,
    multipleRecords: records.length > 1,
    recordCount: records.length,
    hasRedirect: false,
    includes: [],
  };

  const first = records[0];
  if (first === undefined) return state;

  state.raw = first;
  const parsed = parseSpf(first);
  if (!parsed.ok) {
    state.parseError = parsed.error;
    return state;
  }

  state.lookupCount = parsed.value.lookupCount;
  state.exceedsLookupLimit = parsed.value.exceedsLookupLimit;
  state.hasRedirect = parsed.value.hasRedirect;
  state.includes = parsed.value.includes;
  if (parsed.value.allQualifier !== undefined) state.allQualifier = parsed.value.allQualifier;
  return state;
}

function toDmarcState(answer: DnsAnswer): DmarcState {
  const records = selectByPrefix(answer.txt, 'v=dmarc1');
  const state: DmarcState = {
    ...meta(answer),
    present: records.length > 0,
    multipleRecords: records.length > 1,
    ruaCount: 0,
    rufCount: 0,
    ruaHosts: [],
  };

  const first = records[0];
  if (first === undefined) return state;

  // Plan section 4.1.1: the raw record names mailboxes; the dataset is public.
  state.raw = redactReportingAddresses(first);
  const parsed = parseDmarc(first);
  if (!parsed.ok) {
    state.parseError = parsed.error;
    return state;
  }

  const v = parsed.value;
  state.ruaCount = v.ruaCount;
  state.rufCount = v.rufCount;
  state.ruaHosts = v.ruaHosts;
  if (v.p !== undefined) state.p = v.p;
  if (v.sp !== undefined) state.sp = v.sp;
  if (v.pct !== undefined) state.pct = v.pct;
  if (v.adkim !== undefined) state.adkim = v.adkim;
  if (v.aspf !== undefined) state.aspf = v.aspf;
  if (v.fo !== undefined) state.fo = v.fo;
  if (v.ri !== undefined) state.ri = v.ri;
  return state;
}

function toBimiState(answer: DnsAnswer): BimiState {
  const records = selectByPrefix(answer.txt, 'v=bimi1');
  const state: BimiState = {
    ...meta(answer),
    present: records.length > 0,
    hasLogo: false,
    hasVmc: false,
    declined: false,
  };

  const first = records[0];
  if (first === undefined) return state;

  state.raw = first;
  const parsed = parseBimi(first);
  if (!parsed.ok) {
    state.parseError = parsed.error;
    return state;
  }
  state.hasLogo = parsed.value.hasLogo;
  state.hasVmc = parsed.value.hasVmc;
  state.declined = parsed.value.declined;
  return state;
}

function toMtaStsState(answer: DnsAnswer): MtaStsState {
  const records = selectByPrefix(answer.txt, 'v=stsv1');
  const state: MtaStsState = {
    ...meta(answer),
    present: records.length > 0,
    policyFetched: false,
  };

  const first = records[0];
  if (first === undefined) return state;

  const parsed = parseMtaStsTxt(first);
  if (!parsed.ok) {
    state.policyError = parsed.error;
    return state;
  }
  state.policyId = parsed.value.policyId;
  return state;
}

function toTlsRptState(answer: DnsAnswer): TlsRptState {
  const records = selectByPrefix(answer.txt, 'v=tlsrptv1');
  const state: TlsRptState = {
    ...meta(answer),
    present: records.length > 0,
    ruaCount: 0,
    ruaHosts: [],
  };

  const first = records[0];
  if (first === undefined) return state;

  state.raw = redactReportingAddresses(first);
  const parsed = parseTlsRpt(first);
  if (!parsed.ok) {
    state.parseError = parsed.error;
    return state;
  }
  state.ruaCount = parsed.value.ruaCount;
  state.ruaHosts = parsed.value.ruaHosts;
  return state;
}

function toMxState(answer: DnsAnswer): MxState {
  const parsed = parseMx(answer.mx);
  const state: MxState = {
    ...meta(answer),
    // A null MX is a present, deliberate record — RFC 7505 — not a missing one.
    present: answer.mx.length > 0,
    hosts: parsed.hosts,
    isNullMx: parsed.isNullMx,
  };
  if (parsed.provider !== undefined) state.provider = parsed.provider;
  return state;
}

/**
 * DKIM selector probe.
 *
 * Selectors cannot be enumerated from DNS, only guessed, so whatever this
 * finds is a LOWER BOUND. Finding none means "none of the selectors we tried",
 * never "this domain has no DKIM" — which is why there is no hasDkim field
 * anywhere in this codebase.
 */
interface DkimProbeContext {
  provider: string | undefined;
  crawledAt: string;
  previous: DomainSnapshot | undefined;
  refreshDays: number;
  sendsMail: boolean;
}

/**
 * DKIM selector probe.
 *
 * Selectors cannot be enumerated from DNS, only guessed, so whatever this finds
 * is a LOWER BOUND. Finding none means "none of the selectors we tried", never
 * "this domain has no DKIM" — which is why there is no hasDkim field anywhere
 * in this codebase.
 *
 * Probing is skipped in two cases, both of which are about not spending the
 * project's DNS budget re-learning what has not changed:
 *
 *  - The domain publishes no MX, no SPF and no DMARC, so it is not sending
 *    mail and has nothing to sign.
 *  - The selectors were probed recently and the mail provider has not changed.
 *    A provider change is the event that would actually change the selectors,
 *    so it forces a fresh probe regardless of the cadence.
 */
async function probeDkim(
  resolver: Resolver,
  domain: string,
  context: DkimProbeContext,
): Promise<DkimState> {
  const { provider, crawledAt, previous, refreshDays, sendsMail } = context;

  const cached = reusableDkim(previous, provider, crawledAt, refreshDays, sendsMail);
  if (cached) return cached;

  if (!sendsMail) {
    return {
      status: 'ok',
      selectorsFound: [],
      selectorsProbed: [],
      probeStrategy: 'skipped',
      probedAt: crawledAt,
    };
  }

  const known = provider === undefined ? undefined : DKIM_SELECTORS_BY_PROVIDER[provider];

  // A provider with an empty selector list (SES generates per-identity
  // selectors) is a deliberate "do not guess", not a reason to fall back.
  if (known?.length === 0) {
    return {
      status: 'ok',
      selectorsFound: [],
      selectorsProbed: [],
      probeStrategy: 'skipped',
      probedAt: crawledAt,
    };
  }

  const selectors = known ?? DKIM_GENERIC_SELECTORS;
  const strategy = known === undefined ? 'generic-fallback' : 'mx-conditional';

  const results = await Promise.all(
    selectors.map(async (selector) => {
      const answer = await resolver.query(`${selector}._domainkey.${domain}`, 'TXT');
      const found =
        answer.status === 'ok' && answer.txt.some((r) => r.toLowerCase().includes('p='));
      return { selector, found, status: answer.status };
    }),
  );

  return {
    // If every probe failed we learned nothing; saying "found none" would turn
    // an outage into an apparent removal.
    status: results.every((r) => r.status === 'unknown') ? 'unknown' : 'ok',
    selectorsFound: results.filter((r) => r.found).map((r) => r.selector),
    selectorsProbed: selectors,
    probeStrategy: strategy,
    probedAt: crawledAt,
  };
}

/** The previous DKIM result, when it is still good for this observation. */
function reusableDkim(
  previous: DomainSnapshot | undefined,
  provider: string | undefined,
  crawledAt: string,
  refreshDays: number,
  sendsMail: boolean,
): DkimState | undefined {
  if (previous === undefined) return undefined;
  // A provider change is exactly the event that changes a domain's selectors.
  if (previous.mx.provider !== provider) return undefined;

  // A domain that has started (or stopped) sending mail needs a fresh answer,
  // even though its provider did not change.
  const previouslySentMail = previous.mx.present || previous.spf.present || previous.dmarc.present;
  if (previouslySentMail !== sendsMail) return undefined;

  const probedAt = previous.dkim.probedAt;
  if (probedAt === undefined) return undefined;

  const ageMs = Date.parse(crawledAt) - Date.parse(probedAt);
  if (!Number.isFinite(ageMs) || ageMs < 0) return undefined;
  if (ageMs > refreshDays * 86_400_000) return undefined;

  return {
    status: previous.dkim.status,
    selectorsFound: previous.dkim.selectorsFound,
    selectorsProbed: previous.dkim.selectorsProbed,
    // A carried-forward skip stays a skip: re-stamping probedAt every crawl
    // would change the line on every run and defeat the stable-file encoding.
    probeStrategy: previous.dkim.probeStrategy === 'skipped' ? 'skipped' : 'cached',
    probedAt,
  };
}
