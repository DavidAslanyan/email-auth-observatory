import { type MtaStsMode, type ParseResult, err, ok } from '@observatory/core';
import { parseTagValue } from './tag-value.js';

export interface ParsedMtaStsTxt {
  policyId: string;
}

export interface ParsedMtaStsPolicy {
  mode: MtaStsMode;
  maxAge: number;
  mxPatterns: string[];
}

/** Stage one: the TXT record at `_mta-sts.<domain>`. */
export function parseMtaStsTxt(raw: string): ParseResult<ParsedMtaStsTxt> {
  const input = raw.trim();
  if (input === '') return err('empty record');

  const { tags, order } = parseTagValue(input);

  const version = tags.get('v');
  if (version === undefined) return err('missing v tag');
  // RFC 8461 section 3.1: the version value is STSv1.
  if (version !== 'STSv1') return err(`invalid version: ${version}`);
  if (order[0] !== 'v') return err('v tag is not first');

  const id = tags.get('id');
  if (id === undefined || id === '') return err('missing required id tag');
  // RFC 8461 section 3.1: id is 1-32 printable ASCII, no whitespace or ';'.
  if (!/^[\x21-\x3A\x3C\x3E-\x7E]{1,32}$/.test(id)) return err(`invalid id value: ${id}`);

  return ok({ policyId: id });
}

const MODES: readonly string[] = ['enforce', 'testing', 'none'];

/**
 * Stage two: the policy file at `https://mta-sts.<domain>/.well-known/mta-sts.txt`.
 *
 * Note this is NOT tag-value syntax. RFC 8461 section 3.2 defines a
 * line-oriented `key: value` format where `mx` may repeat, so the shared
 * tokenizer deliberately does not apply.
 */
export function parseMtaStsPolicy(raw: string): ParseResult<ParsedMtaStsPolicy> {
  const input = raw.trim();
  if (input === '') return err('empty policy');

  let version: string | undefined;
  let mode: MtaStsMode | undefined;
  let maxAge: number | undefined;
  const mxPatterns: string[] = [];

  // RFC 8461 section 3.2 specifies CRLF; LF-only files are common in practice.
  for (const line of input.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '') continue;

    const colon = trimmed.indexOf(':');
    if (colon === -1) continue;

    const key = trimmed.slice(0, colon).trim().toLowerCase();
    const value = trimmed.slice(colon + 1).trim();

    switch (key) {
      case 'version':
        version ??= value;
        break;
      case 'mode':
        mode ??= MODES.includes(value.toLowerCase()) ? (value.toLowerCase() as MtaStsMode) : mode;
        break;
      case 'max_age': {
        if (maxAge === undefined && /^\d+$/.test(value)) {
          const parsed = Number.parseInt(value, 10);
          if (Number.isSafeInteger(parsed)) maxAge = parsed;
        }
        break;
      }
      case 'mx':
        if (value !== '') mxPatterns.push(value.toLowerCase());
        break;
      default:
        break;
    }
  }

  if (version === undefined) return err('missing version field');
  if (version !== 'STSv1') return err(`invalid version: ${version}`);
  if (mode === undefined) return err('missing or invalid mode field');
  if (maxAge === undefined) return err('missing or invalid max_age field');
  // RFC 8461 section 3.2: mx is required unless mode is none.
  if (mode !== 'none' && mxPatterns.length === 0) return err('policy declares no mx patterns');

  return ok({ mode, maxAge, mxPatterns });
}
