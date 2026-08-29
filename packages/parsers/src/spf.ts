import {
  SPF_MAX_DNS_LOOKUPS,
  type ParseResult,
  type SpfQualifier,
  err,
  ok,
} from '@observatory/core';

export interface ParsedSpf {
  /** Qualifier on the final `all` mechanism, absent when there is no `all`. */
  allQualifier?: SpfQualifier;
  /** Count of terms in THIS record that require a DNS lookup. */
  lookupCount: number;
  exceedsLookupLimit: boolean;
  hasRedirect: boolean;
  /** Domains named by `include:` terms, in the order they appear. */
  includes: string[];
}

/**
 * RFC 7208 section 4.6.4: these terms each cost one DNS lookup against the
 * limit of ten. `exp` is explicitly excluded from the count, and `ip4`/`ip6`
 * need no lookup at all.
 */
const LOOKUP_MECHANISMS: readonly string[] = ['include', 'a', 'mx', 'ptr', 'exists'];

const MECHANISM_NAMES: readonly string[] = [
  'all',
  'include',
  'a',
  'mx',
  'ptr',
  'ip4',
  'ip6',
  'exists',
];

const QUALIFIERS: readonly string[] = ['+', '-', '~', '?'];

const MECHANISM_NAME = /^[a-zA-Z][a-zA-Z0-9]*$/;
const MODIFIER_NAME = /^[a-zA-Z][a-zA-Z0-9_.-]*$/;

export function parseSpf(raw: string): ParseResult<ParsedSpf> {
  const input = raw.trim();
  if (input === '') return err('empty record');

  const tokens = input.split(/\s+/);
  // RFC 7208 section 4.5: the version term is case-insensitive and must lead.
  if (tokens[0]?.toLowerCase() !== 'v=spf1') {
    return err('missing v=spf1 version term');
  }

  let lookupCount = 0;
  let hasRedirect = false;
  let allQualifier: SpfQualifier | undefined;
  const includes: string[] = [];

  for (const token of tokens.slice(1)) {
    // A modifier is `name=value`. A leading qualifier means it is a mechanism,
    // not a modifier: `+exists=x` is not a modifier despite containing `=`.
    const eq = token.indexOf('=');
    if (eq > 0 && !isQualified(token) && MODIFIER_NAME.test(token.slice(0, eq))) {
      if (token.slice(0, eq).toLowerCase() === 'redirect') {
        hasRedirect = true;
        lookupCount += 1;
      }
      // `exp` and every unknown modifier deliberately cost nothing — RFC 7208
      // section 4.6.4 counts only `redirect` among the modifiers.
      continue;
    }

    const qualifier = isQualified(token) ? (token[0] as SpfQualifier) : undefined;
    const body = qualifier === undefined ? token : token.slice(1);

    // The mechanism name runs up to the first `:` or `/`.
    const sep = body.search(/[:/]/);
    const name = (sep === -1 ? body : body.slice(0, sep)).toLowerCase();
    const tail = sep === -1 ? '' : body.slice(sep);

    if (!MECHANISM_NAME.test(name)) continue;
    if (!MECHANISM_NAMES.includes(name)) continue;

    if (name === 'all') {
      // The LAST `all` wins: records with two `all` terms are broken anyway,
      // and taking the final one matches how the record reads as a statement
      // of intent.
      // RFC 7208 section 4.6.2: an absent qualifier means `+`.
      allQualifier = qualifier ?? '+';
      continue;
    }

    if (LOOKUP_MECHANISMS.includes(name)) {
      lookupCount += 1;
      if (name === 'include' && tail.startsWith(':')) {
        const domain = tail.slice(1).toLowerCase();
        if (domain !== '') includes.push(domain);
      }
    }
  }

  const result: ParsedSpf = {
    lookupCount,
    exceedsLookupLimit: lookupCount > SPF_MAX_DNS_LOOKUPS,
    hasRedirect,
    includes,
  };
  if (allQualifier !== undefined) result.allQualifier = allQualifier;
  return ok(result);
}

function isQualified(token: string): boolean {
  const head = token[0];
  return head !== undefined && QUALIFIERS.includes(head);
}
