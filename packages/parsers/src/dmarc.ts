import {
  type DmarcAlignment,
  type DmarcPolicy,
  type ParseResult,
  err,
  ok,
} from '@observatory/core';
import { parseTagValue, reportingUriHost, splitUriList, uniqueSorted } from './tag-value.js';

/**
 * The parsed content of a DMARC record.
 *
 * Every optional field is stored exactly as published: absent means the tag was
 * not present, never "the default was applied". Eagerly materialising defaults
 * would make the day a domain explicitly writes `sp=reject` or `pct=100`
 * indistinguishable from the day before it — and those explicit additions are
 * precisely the changes this project exists to record. Consumers apply
 * defaults; the dataset stores facts.
 */
export interface ParsedDmarc {
  p?: DmarcPolicy;
  sp?: DmarcPolicy;
  pct?: number;
  adkim?: DmarcAlignment;
  aspf?: DmarcAlignment;
  fo?: string;
  ri?: number;
  ruaCount: number;
  rufCount: number;
  ruaHosts: string[];
}

const POLICIES: readonly string[] = ['none', 'quarantine', 'reject'];

export function parseDmarc(raw: string): ParseResult<ParsedDmarc> {
  const input = raw.trim();
  if (input === '') return err('empty record');

  const { tags, order } = parseTagValue(input);

  const version = tags.get('v');
  if (version === undefined) return err('missing v tag');
  // RFC 7489 section 6.3: the v tag value is case-sensitive, unlike tag names.
  if (version !== 'DMARC1') return err(`invalid version: ${version}`);
  // RFC 7489 section 6.3: v MUST be the first tag. A record that puts it later
  // is invalid, and silently accepting it would overstate DMARC adoption.
  if (order[0] !== 'v') return err('v tag is not first');

  // RFC 7489 section 6.3: p is required in a policy record.
  const pRaw = tags.get('p');
  if (pRaw === undefined) return err('missing required p tag');
  const p = toPolicy(pRaw);
  if (p === undefined) return err(`invalid p value: ${pRaw}`);

  const result: ParsedDmarc = { p, ruaCount: 0, rufCount: 0, ruaHosts: [] };

  const spRaw = tags.get('sp');
  if (spRaw !== undefined) {
    const sp = toPolicy(spRaw);
    if (sp === undefined) return err(`invalid sp value: ${spRaw}`);
    result.sp = sp;
  }

  const pctRaw = tags.get('pct');
  if (pctRaw !== undefined) {
    const pct = toInteger(pctRaw);
    if (pct === undefined || pct < 0 || pct > 100) return err(`invalid pct value: ${pctRaw}`);
    result.pct = pct;
  }

  const adkimRaw = tags.get('adkim');
  if (adkimRaw !== undefined) {
    const adkim = toAlignment(adkimRaw);
    if (adkim === undefined) return err(`invalid adkim value: ${adkimRaw}`);
    result.adkim = adkim;
  }

  const aspfRaw = tags.get('aspf');
  if (aspfRaw !== undefined) {
    const aspf = toAlignment(aspfRaw);
    if (aspf === undefined) return err(`invalid aspf value: ${aspfRaw}`);
    result.aspf = aspf;
  }

  const riRaw = tags.get('ri');
  if (riRaw !== undefined) {
    const ri = toInteger(riRaw);
    if (ri === undefined || ri < 0) return err(`invalid ri value: ${riRaw}`);
    result.ri = ri;
  }

  const fo = tags.get('fo');
  if (fo !== undefined && fo !== '') result.fo = fo;

  const rua = tags.get('rua');
  if (rua !== undefined) {
    const uris = splitUriList(rua);
    result.ruaCount = uris.length;
    // Plan section 4.1.1: domain parts only. Mailbox names never leave here.
    result.ruaHosts = uniqueSorted(
      uris.map(reportingUriHost).filter((host): host is string => host !== undefined),
    );
  }

  const ruf = tags.get('ruf');
  if (ruf !== undefined) result.rufCount = splitUriList(ruf).length;

  // Unknown tags are ignored rather than rejected: RFC 7489 section 6.3 requires
  // it, and new tags appear in the wild before they appear in an RFC.
  return ok(result);
}

function toPolicy(value: string): DmarcPolicy | undefined {
  const lower = value.toLowerCase();
  return POLICIES.includes(lower) ? (lower as DmarcPolicy) : undefined;
}

function toAlignment(value: string): DmarcAlignment | undefined {
  const lower = value.toLowerCase();
  return lower === 'r' || lower === 's' ? lower : undefined;
}

function toInteger(value: string): number | undefined {
  if (!/^\d+$/.test(value.trim())) return undefined;
  const n = Number.parseInt(value.trim(), 10);
  return Number.isSafeInteger(n) ? n : undefined;
}
