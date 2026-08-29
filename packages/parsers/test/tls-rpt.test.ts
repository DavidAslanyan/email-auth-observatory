import { describe, expect, it } from 'vitest';
import { parseTlsRpt } from '../src/tls-rpt.js';

function value(raw: string) {
  const r = parseTlsRpt(raw);
  if (!r.ok) throw new Error(`expected parse to succeed, got: ${r.error}`);
  return r.value;
}

function error(raw: string) {
  const r = parseTlsRpt(raw);
  if (r.ok) throw new Error('expected parse to fail');
  return r.error;
}

describe('parseTlsRpt', () => {
  it('counts a single mailto destination', () => {
    const v = value('v=TLSRPTv1; rua=mailto:tlsrpt@example.com');
    expect(v.ruaCount).toBe(1);
    expect(v.ruaHosts).toEqual(['example.com']);
  });

  it('stores only the domain part, never the mailbox', () => {
    const v = value('v=TLSRPTv1; rua=mailto:jane.doe@reports.example');
    expect(JSON.stringify(v)).not.toContain('jane.doe');
  });

  it('counts multiple destinations', () => {
    const v = value('v=TLSRPTv1; rua=mailto:a@x.example,https://y.example/report');
    expect(v.ruaCount).toBe(2);
    expect(v.ruaHosts).toEqual(['x.example', 'y.example']);
  });

  it('deduplicates hosts while still counting every destination', () => {
    const v = value('v=TLSRPTv1; rua=mailto:a@r.example,mailto:b@r.example');
    expect(v.ruaCount).toBe(2);
    expect(v.ruaHosts).toEqual(['r.example']);
  });

  it('rejects a record with no rua tag, which RFC 8460 requires', () => {
    expect(error('v=TLSRPTv1')).toMatch(/missing required rua/);
  });

  it('rejects an rua tag with no destinations', () => {
    expect(error('v=TLSRPTv1; rua=')).toMatch(/no destinations/);
  });

  it('rejects a wrong version value', () => {
    expect(error('v=TLSRPTv2; rua=mailto:a@x.example')).toMatch(/invalid version/);
  });

  it('rejects a lowercase version value, which is case-sensitive', () => {
    expect(error('v=tlsrptv1; rua=mailto:a@x.example')).toMatch(/invalid version/);
  });

  it('rejects a record with no v tag', () => {
    expect(error('rua=mailto:a@x.example')).toMatch(/missing v tag/);
  });

  it('rejects a record where v is not first', () => {
    expect(error('rua=mailto:a@x.example; v=TLSRPTv1')).toMatch(/not first/);
  });

  it('rejects an empty string without throwing', () => {
    expect(error('')).toBe('empty record');
  });

  it('rejects a whitespace-only string without throwing', () => {
    expect(error('   ')).toBe('empty record');
  });

  it('tolerates whitespace chaos and a trailing semicolon', () => {
    const v = value('v=TLSRPTv1 ; rua = mailto:a@x.example ;');
    expect(v.ruaCount).toBe(1);
  });
});
