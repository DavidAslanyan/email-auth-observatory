import { describe, expect, it } from 'vitest';
import { parseBimi } from '../src/bimi.js';

function value(raw: string) {
  const r = parseBimi(raw);
  if (!r.ok) throw new Error(`expected parse to succeed, got: ${r.error}`);
  return r.value;
}

function error(raw: string) {
  const r = parseBimi(raw);
  if (r.ok) throw new Error('expected parse to fail');
  return r.error;
}

describe('parseBimi', () => {
  it('reports a logo when l is present and non-empty', () => {
    const v = value('v=BIMI1; l=https://example.com/logo.svg');
    expect(v.hasLogo).toBe(true);
    expect(v.declined).toBe(false);
  });

  it('reports an explicit decline when l is present but empty', () => {
    // An empty l= is an opt-out, which is a different fact from having no
    // BIMI record at all.
    const v = value('v=BIMI1; l=');
    expect(v.declined).toBe(true);
    expect(v.hasLogo).toBe(false);
  });

  it('does not report a decline when l is absent entirely', () => {
    expect(value('v=BIMI1; a=https://example.com/vmc.pem').declined).toBe(false);
  });

  it('reports a VMC when a is present and non-empty', () => {
    expect(value('v=BIMI1; l=https://e.example/l.svg; a=https://e.example/v.pem').hasVmc).toBe(
      true,
    );
  });

  it('does not report a VMC for an empty a tag, which carries no certificate', () => {
    expect(value('v=BIMI1; l=https://e.example/l.svg; a=').hasVmc).toBe(false);
  });

  it('does not report a VMC when a is absent', () => {
    expect(value('v=BIMI1; l=https://e.example/l.svg').hasVmc).toBe(false);
  });

  it('accepts a lowercase version value', () => {
    expect(value('v=bimi1; l=https://e.example/l.svg').hasLogo).toBe(true);
  });

  it('rejects a wrong version value', () => {
    expect(error('v=BIMI2; l=https://e.example/l.svg')).toMatch(/invalid version/);
  });

  it('rejects a record with no v tag', () => {
    expect(error('l=https://e.example/l.svg')).toMatch(/missing v tag/);
  });

  it('rejects a record where v is not first', () => {
    expect(error('l=https://e.example/l.svg; v=BIMI1')).toMatch(/not first/);
  });

  it('rejects an empty string without throwing', () => {
    expect(error('')).toBe('empty record');
  });

  it('rejects a whitespace-only string without throwing', () => {
    expect(error('  \t ')).toBe('empty record');
  });

  it('tolerates a trailing semicolon and whitespace chaos', () => {
    const v = value('v=BIMI1 ;  l = https://e.example/l.svg ;');
    expect(v.hasLogo).toBe(true);
  });

  it('takes the first of a duplicated l tag', () => {
    expect(value('v=BIMI1; l=; l=https://e.example/l.svg').declined).toBe(true);
  });
});
