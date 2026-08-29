import { describe, expect, it } from 'vitest';
import { joinTxtChunks, joinTxtRecords, selectByPrefix } from '../src/txt.js';

describe('joinTxtChunks', () => {
  it('joins chunks with no separator', () => {
    expect(joinTxtChunks([Buffer.from('v=spf1 '), Buffer.from('-all')])).toBe('v=spf1 -all');
  });

  it('reassembles a record longer than the 255-byte chunk limit', () => {
    // A 600-byte SPF record arrives as three chunks. Reading only the first
    // would yield a string that still parses, hiding the truncation.
    const full = `v=spf1 ${'include:a-very-long-domain-name.example '.repeat(15)}-all`;
    expect(full.length).toBeGreaterThan(255);
    const chunks: Buffer[] = [];
    for (let i = 0; i < full.length; i += 255) {
      chunks.push(Buffer.from(full.slice(i, i + 255), 'utf8'));
    }
    expect(chunks.length).toBeGreaterThan(1);
    expect(joinTxtChunks(chunks)).toBe(full);
  });

  it('does not insert a space between chunks that split mid-token', () => {
    // The classic corruption: joining with ' ' turns include:example.com into
    // two broken terms.
    expect(joinTxtChunks([Buffer.from('include:exa'), Buffer.from('mple.com')])).toBe(
      'include:example.com',
    );
  });

  it('reassembles a base64 DKIM key split across chunks', () => {
    const key = `v=DKIM1; k=rsa; p=${'A'.repeat(392)}`;
    const chunks = [Buffer.from(key.slice(0, 255)), Buffer.from(key.slice(255))];
    expect(joinTxtChunks(chunks)).toBe(key);
  });

  it('accepts a single buffer', () => {
    expect(joinTxtChunks(Buffer.from('v=spf1 -all'))).toBe('v=spf1 -all');
  });

  it('accepts a plain string', () => {
    expect(joinTxtChunks('v=spf1 -all')).toBe('v=spf1 -all');
  });

  it('accepts an array of strings, as the DoH JSON APIs return', () => {
    expect(joinTxtChunks(['v=spf1 ', '-all'])).toBe('v=spf1 -all');
  });

  it('returns an empty string for an empty chunk array', () => {
    expect(joinTxtChunks([])).toBe('');
  });

  it('preserves UTF-8 multi-byte characters split across a chunk boundary', () => {
    const text = 'v=spf1 exists:café.example -all';
    const buf = Buffer.from(text, 'utf8');
    // Split at a byte offset, not a character offset, exactly as DNS does.
    const joined = joinTxtChunks([buf.subarray(0, 20), buf.subarray(20)]);
    expect(joined).toBe(text);
  });
});

describe('joinTxtRecords', () => {
  it('keeps records separate while joining each record’s chunks', () => {
    const result = joinTxtRecords([
      [Buffer.from('v=spf1 '), Buffer.from('-all')],
      [Buffer.from('google-site-verification=abc')],
    ]);
    expect(result).toEqual(['v=spf1 -all', 'google-site-verification=abc']);
  });

  it('returns an empty array for no records', () => {
    expect(joinTxtRecords([])).toEqual([]);
  });
});

describe('selectByPrefix', () => {
  it('selects only the records with the requested version prefix', () => {
    const records = ['v=spf1 -all', 'google-site-verification=abc', 'MS=ms12345'];
    expect(selectByPrefix(records, 'v=spf1')).toEqual(['v=spf1 -all']);
  });

  it('matches case-insensitively', () => {
    expect(selectByPrefix(['V=SPF1 -all'], 'v=spf1')).toEqual(['V=SPF1 -all']);
  });

  it('tolerates leading whitespace', () => {
    expect(selectByPrefix(['  v=spf1 -all'], 'v=spf1')).toHaveLength(1);
  });

  it('returns every match so a duplicate publication is visible, not hidden', () => {
    const records = ['v=spf1 -all', 'v=spf1 ~all'];
    expect(selectByPrefix(records, 'v=spf1')).toHaveLength(2);
  });

  it('returns an empty array when nothing matches', () => {
    expect(selectByPrefix(['MS=ms12345'], 'v=spf1')).toEqual([]);
  });
});
