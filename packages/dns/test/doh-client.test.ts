import { describe, expect, it } from 'vitest';
import { parseJsonMx, unquoteJsonTxt } from '../src/doh-client.js';

describe('unquoteJsonTxt', () => {
  it('unquotes a single-chunk record', () => {
    expect(unquoteJsonTxt('"v=spf1 -all"')).toBe('v=spf1 -all');
  });

  it('joins adjacent quoted chunks with no separator', () => {
    // The JSON APIs render a chunked record as adjacent quoted strings; joining
    // them with a space would corrupt any token split across the boundary.
    expect(unquoteJsonTxt('"include:exa" "mple.com"')).toBe('include:example.com');
  });

  it('joins three chunks of a long record', () => {
    expect(unquoteJsonTxt('"a" "b" "c"')).toBe('abc');
  });

  it('unescapes an embedded quote', () => {
    expect(unquoteJsonTxt('"say \\"hi\\""')).toBe('say "hi"');
  });

  it('unescapes an embedded backslash', () => {
    expect(unquoteJsonTxt('"a\\\\b"')).toBe('a\\b');
  });

  it('returns unquoted data unchanged', () => {
    expect(unquoteJsonTxt('v=spf1 -all')).toBe('v=spf1 -all');
  });

  it('handles an empty quoted string', () => {
    expect(unquoteJsonTxt('""')).toBe('');
  });
});

describe('parseJsonMx', () => {
  it('parses preference and exchange', () => {
    expect(parseJsonMx('10 aspmx.l.google.com.')).toEqual({
      preference: 10,
      exchange: 'aspmx.l.google.com.',
    });
  });

  it('parses a null MX', () => {
    expect(parseJsonMx('0 .')).toEqual({ preference: 0, exchange: '.' });
  });

  it('tolerates surrounding whitespace', () => {
    expect(parseJsonMx('  20   mx.example.  ')).toEqual({
      preference: 20,
      exchange: 'mx.example.',
    });
  });

  it('returns undefined for data with no preference', () => {
    expect(parseJsonMx('aspmx.l.google.com.')).toBeUndefined();
  });

  it('returns undefined for empty data', () => {
    expect(parseJsonMx('')).toBeUndefined();
  });

  it('returns undefined for a non-numeric preference', () => {
    expect(parseJsonMx('high mx.example')).toBeUndefined();
  });
});
