import { type ParseResult, err, ok } from '@mailscape/core';
import { parseTagValue, reportingUriHost, splitUriList, uniqueSorted } from './tag-value.js';

export interface ParsedTlsRpt {
  ruaCount: number;
  /** Domain parts only — plan section 4.1.1 applies here exactly as to DMARC. */
  ruaHosts: string[];
}

export function parseTlsRpt(raw: string): ParseResult<ParsedTlsRpt> {
  const input = raw.trim();
  if (input === '') return err('empty record');

  const { tags, order } = parseTagValue(input);

  const version = tags.get('v');
  if (version === undefined) return err('missing v tag');
  // RFC 8460 section 3: the version value is TLSRPTv1.
  if (version !== 'TLSRPTv1') return err(`invalid version: ${version}`);
  if (order[0] !== 'v') return err('v tag is not first');

  const rua = tags.get('rua');
  if (rua === undefined) return err('missing required rua tag');

  const uris = splitUriList(rua);
  if (uris.length === 0) return err('rua tag has no destinations');

  return ok({
    ruaCount: uris.length,
    ruaHosts: uniqueSorted(
      uris.map(reportingUriHost).filter((host): host is string => host !== undefined),
    ),
  });
}
