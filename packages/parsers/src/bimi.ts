import { type ParseResult, err, ok } from '@observatory/core';
import { parseTagValue } from './tag-value.js';

export interface ParsedBimi {
  /** l= present and non-empty. */
  hasLogo: boolean;
  /** a= present and non-empty: a Verified Mark Certificate is published. */
  hasVmc: boolean;
  /**
   * l= present but empty. This is an explicit opt-out — the domain is telling
   * receivers "do not display an indicator for me" — and is a different fact
   * from having no BIMI record at all.
   */
  declined: boolean;
}

export function parseBimi(raw: string): ParseResult<ParsedBimi> {
  const input = raw.trim();
  if (input === '') return err('empty record');

  const { tags, order } = parseTagValue(input);

  const version = tags.get('v');
  if (version === undefined) return err('missing v tag');
  if (version.toUpperCase() !== 'BIMI1') return err(`invalid version: ${version}`);
  if (order[0] !== 'v') return err('v tag is not first');

  const l = tags.get('l');
  const a = tags.get('a');

  return ok({
    hasLogo: l !== undefined && l !== '',
    // An `a=` with no value carries no certificate, so it is not a VMC however
    // the tag is written.
    hasVmc: a !== undefined && a !== '',
    declined: l !== undefined && l === '',
  });
}
