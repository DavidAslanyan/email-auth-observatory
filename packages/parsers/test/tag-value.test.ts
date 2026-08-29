import { describe, expect, it } from 'vitest';
import { parseTagValue, reportingUriHost, splitUriList, uniqueSorted } from '../src/tag-value.js';

describe('parseTagValue', () => {
  it('splits a simple record into keys and values', () => {
    const { tags } = parseTagValue('v=DMARC1; p=reject');
    expect(tags.get('v')).toBe('DMARC1');
    expect(tags.get('p')).toBe('reject');
  });

  it('preserves tag order so callers can require v first', () => {
    const { order } = parseTagValue('v=DMARC1; p=none; rua=mailto:a@b.example');
    expect(order).toEqual(['v', 'p', 'rua']);
  });

  it('splits each pair on the first equals sign only', () => {
    const { tags } = parseTagValue('v=DMARC1; rua=mailto:d@e.example?subject=a=b');
    expect(tags.get('rua')).toBe('mailto:d@e.example?subject=a=b');
  });

  it('ignores a trailing semicolon', () => {
    const { tags, malformed } = parseTagValue('v=DMARC1; p=none;');
    expect(tags.size).toBe(2);
    expect(malformed).toEqual([]);
  });

  it('ignores repeated and leading semicolons', () => {
    const { tags, malformed } = parseTagValue(';;v=DMARC1;;p=none;;');
    expect(tags.size).toBe(2);
    expect(malformed).toEqual([]);
  });

  it('trims whitespace around both keys and values', () => {
    const { tags } = parseTagValue('v=DMARC1 ;  p = reject ;pct=100');
    expect(tags.get('v')).toBe('DMARC1');
    expect(tags.get('p')).toBe('reject');
    expect(tags.get('pct')).toBe('100');
  });

  it('lowercases keys because tag names are case-insensitive', () => {
    const { tags } = parseTagValue('V=DMARC1; P=reject; ADKIM=s');
    expect(tags.get('v')).toBe('DMARC1');
    expect(tags.get('p')).toBe('reject');
    expect(tags.get('adkim')).toBe('s');
  });

  it('preserves value case because v=DMARC1 is case-sensitive', () => {
    const { tags } = parseTagValue('v=dmarc1; p=none');
    expect(tags.get('v')).toBe('dmarc1');
  });

  it('keeps the first of a duplicated tag and reports the duplication', () => {
    const { tags, duplicates } = parseTagValue('v=DMARC1; p=none; p=reject');
    expect(tags.get('p')).toBe('none');
    expect(duplicates).toEqual(['p']);
  });

  it('reports a duplicated tag only once however often it repeats', () => {
    const { duplicates } = parseTagValue('v=DMARC1; p=none; p=reject; p=quarantine');
    expect(duplicates).toEqual(['p']);
  });

  it('records a segment with no equals sign as malformed rather than dropping it', () => {
    const { tags, malformed } = parseTagValue('v=DMARC1; p; pct=100');
    expect(malformed).toEqual(['p']);
    expect(tags.has('p')).toBe(false);
  });

  it('records a segment with an empty key as malformed', () => {
    const { malformed } = parseTagValue('v=DMARC1; =orphan');
    expect(malformed).toEqual(['=orphan']);
  });

  it('accepts an empty value', () => {
    const { tags } = parseTagValue('v=BIMI1; l=; a=');
    expect(tags.get('l')).toBe('');
    expect(tags.get('a')).toBe('');
  });

  it('returns an empty record for an empty string', () => {
    const r = parseTagValue('');
    expect(r.tags.size).toBe(0);
    expect(r.order).toEqual([]);
  });

  it('returns an empty record for whitespace only', () => {
    const r = parseTagValue('   \t \n ');
    expect(r.tags.size).toBe(0);
    expect(r.malformed).toEqual([]);
  });
});

describe('splitUriList', () => {
  it('splits on commas and trims each entry', () => {
    expect(splitUriList('mailto:a@x.example , mailto:b@y.example')).toEqual([
      'mailto:a@x.example',
      'mailto:b@y.example',
    ]);
  });

  it('drops empty entries from a trailing comma', () => {
    expect(splitUriList('mailto:a@x.example,')).toEqual(['mailto:a@x.example']);
  });

  it('returns an empty array for an empty string', () => {
    expect(splitUriList('')).toEqual([]);
  });
});

describe('reportingUriHost', () => {
  it('returns only the domain part of a mailto, never the mailbox', () => {
    expect(reportingUriHost('mailto:john.doe@reports.example')).toBe('reports.example');
  });

  it('lowercases the host', () => {
    expect(reportingUriHost('mailto:Ops@Reports.Example')).toBe('reports.example');
  });

  it('strips the RFC 7489 size limit suffix', () => {
    expect(reportingUriHost('mailto:a@reports.example!10m')).toBe('reports.example');
  });

  it('uses the last at-sign so a quoted local part cannot leak a fake host', () => {
    expect(reportingUriHost('mailto:a@b@reports.example')).toBe('reports.example');
  });

  it('drops query strings appended to a mailto', () => {
    expect(reportingUriHost('mailto:a@reports.example?subject=dmarc')).toBe('reports.example');
  });

  it('returns the host of an https destination', () => {
    expect(reportingUriHost('https://tls.example/report')).toBe('tls.example');
  });

  it('drops the port from an https destination', () => {
    expect(reportingUriHost('https://tls.example:8443/report')).toBe('tls.example');
  });

  it('drops userinfo from an https destination', () => {
    expect(reportingUriHost('https://user:pw@tls.example/report')).toBe('tls.example');
  });

  it('returns undefined for a mailto with no at-sign', () => {
    expect(reportingUriHost('mailto:notanaddress')).toBeUndefined();
  });

  it('returns undefined for an unsupported scheme', () => {
    expect(reportingUriHost('ftp://x.example')).toBeUndefined();
  });

  it('returns undefined when there is no scheme', () => {
    expect(reportingUriHost('reports.example')).toBeUndefined();
  });

  it('returns undefined for an empty string', () => {
    expect(reportingUriHost('')).toBeUndefined();
  });

  it('returns undefined when the size limit suffix leaves nothing', () => {
    expect(reportingUriHost('!10m')).toBeUndefined();
  });

  it('returns undefined when a mailto has an empty host', () => {
    expect(reportingUriHost('mailto:a@')).toBeUndefined();
  });

  it('returns undefined when an https uri has an empty host', () => {
    expect(reportingUriHost('https://')).toBeUndefined();
  });
});

describe('uniqueSorted', () => {
  it('deduplicates and sorts for stable diffs', () => {
    expect(uniqueSorted(['b.example', 'a.example', 'b.example'])).toEqual([
      'a.example',
      'b.example',
    ]);
  });

  it('returns an empty array unchanged', () => {
    expect(uniqueSorted([])).toEqual([]);
  });
});
