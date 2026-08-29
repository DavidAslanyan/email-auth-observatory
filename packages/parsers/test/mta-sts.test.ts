import { describe, expect, it } from 'vitest';
import { parseMtaStsPolicy, parseMtaStsTxt } from '../src/mta-sts.js';

function txtValue(raw: string) {
  const r = parseMtaStsTxt(raw);
  if (!r.ok) throw new Error(`expected parse to succeed, got: ${r.error}`);
  return r.value;
}

function txtError(raw: string) {
  const r = parseMtaStsTxt(raw);
  if (r.ok) throw new Error('expected parse to fail');
  return r.error;
}

function policyValue(raw: string) {
  const r = parseMtaStsPolicy(raw);
  if (!r.ok) throw new Error(`expected parse to succeed, got: ${r.error}`);
  return r.value;
}

function policyError(raw: string) {
  const r = parseMtaStsPolicy(raw);
  if (r.ok) throw new Error('expected parse to fail');
  return r.error;
}

describe('parseMtaStsTxt', () => {
  it('extracts the policy id', () => {
    expect(txtValue('v=STSv1; id=20240101T000000Z').policyId).toBe('20240101T000000Z');
  });

  it('rejects a record with no id tag', () => {
    expect(txtError('v=STSv1')).toMatch(/missing required id/);
  });

  it('rejects an empty id tag', () => {
    expect(txtError('v=STSv1; id=')).toMatch(/missing required id/);
  });

  it('rejects an id longer than 32 characters', () => {
    expect(txtError(`v=STSv1; id=${'a'.repeat(33)}`)).toMatch(/invalid id/);
  });

  it('accepts an id of exactly 32 characters', () => {
    expect(txtValue(`v=STSv1; id=${'a'.repeat(32)}`).policyId).toHaveLength(32);
  });

  it('rejects a wrong version value', () => {
    expect(txtError('v=STSv2; id=abc')).toMatch(/invalid version/);
  });

  it('rejects a lowercase version value, which is case-sensitive', () => {
    expect(txtError('v=stsv1; id=abc')).toMatch(/invalid version/);
  });

  it('rejects a record with no v tag', () => {
    expect(txtError('id=abc')).toMatch(/missing v tag/);
  });

  it('rejects a record where v is not first', () => {
    expect(txtError('id=abc; v=STSv1')).toMatch(/not first/);
  });

  it('rejects an empty string without throwing', () => {
    expect(txtError('')).toBe('empty record');
  });

  it('rejects a whitespace-only string without throwing', () => {
    expect(txtError('  \t ')).toBe('empty record');
  });

  it('tolerates whitespace chaos and a trailing semicolon', () => {
    expect(txtValue('v=STSv1 ;  id = abc123 ;').policyId).toBe('abc123');
  });
});

describe('parseMtaStsPolicy', () => {
  const enforcePolicy = [
    'version: STSv1',
    'mode: enforce',
    'mx: mail.example.com',
    'mx: *.example.net',
    'max_age: 604800',
  ].join('\n');

  it('parses an enforce policy with multiple mx patterns', () => {
    const v = policyValue(enforcePolicy);
    expect(v.mode).toBe('enforce');
    expect(v.maxAge).toBe(604800);
    expect(v.mxPatterns).toEqual(['mail.example.com', '*.example.net']);
  });

  it('parses a testing policy, the state that precedes enforcement', () => {
    const v = policyValue('version: STSv1\nmode: testing\nmx: a.example\nmax_age: 86400');
    expect(v.mode).toBe('testing');
  });

  it('parses a none policy without requiring mx patterns', () => {
    const v = policyValue('version: STSv1\nmode: none\nmax_age: 1');
    expect(v.mode).toBe('none');
    expect(v.mxPatterns).toEqual([]);
  });

  it('accepts CRLF line endings, which RFC 8461 specifies', () => {
    const v = policyValue(enforcePolicy.replace(/\n/g, '\r\n'));
    expect(v.mode).toBe('enforce');
    expect(v.mxPatterns).toHaveLength(2);
  });

  it('lowercases mx patterns so the diff is not case-noisy', () => {
    const v = policyValue('version: STSv1\nmode: enforce\nmx: Mail.Example.COM\nmax_age: 1');
    expect(v.mxPatterns).toEqual(['mail.example.com']);
  });

  it('is case-insensitive about field names and mode values', () => {
    const v = policyValue('Version: STSv1\nMODE: Enforce\nMx: a.example\nMax_Age: 1');
    expect(v.mode).toBe('enforce');
  });

  it('tolerates blank lines and surrounding whitespace', () => {
    const v = policyValue(
      '\n  version: STSv1  \n\n  mode: enforce \n mx: a.example \n max_age: 1\n',
    );
    expect(v.mode).toBe('enforce');
  });

  it('ignores unknown fields', () => {
    const v = policyValue('version: STSv1\nmode: enforce\nmx: a.example\nmax_age: 1\nfoo: bar');
    expect(v.mode).toBe('enforce');
  });

  it('ignores a line with no colon', () => {
    const v = policyValue('version: STSv1\ngarbage\nmode: enforce\nmx: a.example\nmax_age: 1');
    expect(v.mode).toBe('enforce');
  });

  it('takes the first value when a single-valued field repeats', () => {
    const v = policyValue('version: STSv1\nmode: enforce\nmode: none\nmx: a.example\nmax_age: 1');
    expect(v.mode).toBe('enforce');
  });

  it('rejects a policy with no version field', () => {
    expect(policyError('mode: enforce\nmx: a.example\nmax_age: 1')).toMatch(/missing version/);
  });

  it('rejects a wrong version value', () => {
    expect(policyError('version: STSv2\nmode: enforce\nmx: a.example\nmax_age: 1')).toMatch(
      /invalid version/,
    );
  });

  it('rejects a policy with no mode field', () => {
    expect(policyError('version: STSv1\nmx: a.example\nmax_age: 1')).toMatch(/mode/);
  });

  it('rejects an unrecognised mode rather than guessing', () => {
    expect(policyError('version: STSv1\nmode: strict\nmx: a.example\nmax_age: 1')).toMatch(/mode/);
  });

  it('rejects a policy with no max_age field', () => {
    expect(policyError('version: STSv1\nmode: enforce\nmx: a.example')).toMatch(/max_age/);
  });

  it('rejects a non-numeric max_age', () => {
    expect(policyError('version: STSv1\nmode: enforce\nmx: a.example\nmax_age: forever')).toMatch(
      /max_age/,
    );
  });

  it('rejects an enforcing policy that declares no mx patterns', () => {
    expect(policyError('version: STSv1\nmode: enforce\nmax_age: 1')).toMatch(/no mx patterns/);
  });

  it('ignores an empty mx value', () => {
    expect(policyError('version: STSv1\nmode: enforce\nmx: \nmax_age: 1')).toMatch(/no mx/);
  });

  it('rejects an empty policy without throwing', () => {
    expect(policyError('')).toBe('empty policy');
  });

  it('rejects a whitespace-only policy without throwing', () => {
    expect(policyError('  \n \t ')).toBe('empty policy');
  });

  it('rejects an HTML error page served in place of a policy', () => {
    expect(policyError('<!doctype html>\n<html><body>404</body></html>')).toMatch(/version/);
  });
});
