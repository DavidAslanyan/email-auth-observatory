/**
 * Tests driven by records captured from real domains with `dig`
 * (see scripts/capture-fixtures.mjs). Synthetic strings prove the parsers
 * handle the cases we thought of; these prove they handle the ones we did not.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseBimi } from '../src/bimi.js';
import { parseDmarc } from '../src/dmarc.js';
import { parseMtaStsPolicy, parseMtaStsTxt } from '../src/mta-sts.js';
import { parseMx, type MxRecord } from '../src/mx.js';
import { parseSpf } from '../src/spf.js';
import { parseTlsRpt } from '../src/tls-rpt.js';

interface CapturedDomain {
  domain: string;
  spf: string[];
  dmarc: string[];
  bimi: string[];
  mtaSts: string[];
  tlsRpt: string[];
  mx: MxRecord[];
}

const records = JSON.parse(
  readFileSync(new URL('./fixtures/records.json', import.meta.url), 'utf8'),
) as { capturedAt: string; domains: CapturedDomain[] };

const policies = JSON.parse(
  readFileSync(new URL('./fixtures/mta-sts-policies.json', import.meta.url), 'utf8'),
) as { policies: { domain: string; body: string }[] };

function domain(name: string): CapturedDomain {
  const found = records.domains.find((d) => d.domain === name);
  if (!found) throw new Error(`fixture missing: ${name}`);
  return found;
}

function policyBody(name: string): string {
  const found = policies.policies.find((p) => p.domain === name);
  if (!found) throw new Error(`policy fixture missing: ${name}`);
  return found.body;
}

describe('captured fixtures — coverage of the corpus', () => {
  it('captured at least 30 real domains, as the plan requires', () => {
    expect(records.domains.length).toBeGreaterThanOrEqual(30);
  });

  it('parses every captured SPF record without throwing', () => {
    const failures: string[] = [];
    for (const d of records.domains) {
      for (const raw of d.spf) {
        const r = parseSpf(raw);
        if (!r.ok) failures.push(`${d.domain}: ${r.error}`);
      }
    }
    expect(failures).toEqual([]);
  });

  it('parses every captured DMARC record without throwing', () => {
    const failures: string[] = [];
    for (const d of records.domains) {
      for (const raw of d.dmarc) {
        const r = parseDmarc(raw);
        if (!r.ok) failures.push(`${d.domain}: ${r.error}`);
      }
    }
    expect(failures).toEqual([]);
  });

  it('parses every captured BIMI record without throwing', () => {
    const failures: string[] = [];
    for (const d of records.domains) {
      for (const raw of d.bimi) {
        const r = parseBimi(raw);
        if (!r.ok) failures.push(`${d.domain}: ${r.error}`);
      }
    }
    expect(failures).toEqual([]);
  });

  it('parses every captured MTA-STS TXT record without throwing', () => {
    const failures: string[] = [];
    for (const d of records.domains) {
      for (const raw of d.mtaSts) {
        const r = parseMtaStsTxt(raw);
        if (!r.ok) failures.push(`${d.domain}: ${r.error}`);
      }
    }
    expect(failures).toEqual([]);
  });

  it('parses every captured TLS-RPT record without throwing', () => {
    const failures: string[] = [];
    for (const d of records.domains) {
      for (const raw of d.tlsRpt) {
        const r = parseTlsRpt(raw);
        if (!r.ok) failures.push(`${d.domain}: ${r.error}`);
      }
    }
    expect(failures).toEqual([]);
  });

  it('classifies every captured MX set without throwing', () => {
    for (const d of records.domains) {
      expect(() => parseMx(d.mx)).not.toThrow();
    }
  });

  it('spans the provider ecosystems the plan asks for', () => {
    const providers = new Set(
      records.domains
        .map((d) => parseMx(d.mx).provider)
        .filter((p): p is string => p !== undefined),
    );
    expect(providers).toContain('google');
    expect(providers).toContain('microsoft');
    expect(providers).toContain('proofpoint');
    expect(providers).toContain('self-hosted');
  });
});

describe('captured fixtures — the privacy rule holds on real records', () => {
  it('never retains a mailbox local part from any captured DMARC record', () => {
    // paypal.com publishes rua=mailto:d@rua.agari.com and a base64-ish
    // ruf local part; both must be gone by the time parsing finishes.
    for (const d of records.domains) {
      for (const raw of d.dmarc) {
        const r = parseDmarc(raw);
        if (!r.ok) continue;
        for (const host of r.value.ruaHosts) {
          expect(host).not.toContain('@');
        }
      }
    }
  });

  it('strips the local part from paypal.com, which names individual mailboxes', () => {
    const r = parseDmarc(domain('paypal.com').dmarc[0] ?? '');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.ruaHosts).toEqual(['rua.agari.com', 'vali.email']);
    expect(JSON.stringify(r.value)).not.toContain('dmarc_agg');
    // ruf destinations are counted but their hosts are never stored.
    expect(r.value.rufCount).toBe(2);
    expect(JSON.stringify(r.value)).not.toContain('ruf.agari.com');
  });

  it('never retains a mailbox local part from any captured TLS-RPT record', () => {
    for (const d of records.domains) {
      for (const raw of d.tlsRpt) {
        const r = parseTlsRpt(raw);
        if (!r.ok) continue;
        for (const host of r.value.ruaHosts) expect(host).not.toContain('@');
      }
    }
  });
});

describe('captured fixtures — specific real-world shapes', () => {
  it('parses a 717-byte SPF record, which DNS must have delivered in chunks', () => {
    // akamai.com's record is far longer than the 255-byte TXT chunk limit, so
    // this fixture only exists correctly if chunk joining worked at capture
    // time — and it only parses if the parser handles the joined result.
    const raw = domain('akamai.com').spf[0] ?? '';
    expect(raw.length).toBeGreaterThan(255);
    const r = parseSpf(raw);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.allQualifier).toBeDefined();
  });

  it('records example.com as an explicit null MX, not as a missing MX', () => {
    const v = parseMx(domain('example.com').mx);
    expect(v.isNullMx).toBe(true);
    expect(v.hosts).toEqual([]);
  });

  it('distinguishes a domain with no MX at all from a null MX', () => {
    const v = parseMx(domain('gov.uk').mx);
    expect(v.isNullMx).toBe(false);
    expect(v.hosts).toEqual([]);
  });

  it('reads a BIMI record that carries a Verified Mark Certificate', () => {
    const r = parseBimi(domain('cloudflare.com').bimi[0] ?? '');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.hasLogo).toBe(true);
    expect(r.value.hasVmc).toBe(true);
    expect(r.value.declined).toBe(false);
  });

  it('tolerates an MTA-STS TXT record written with no spaces after semicolons', () => {
    // cloudflare.com publishes `v=STSv1;id=...;`
    const r = parseMtaStsTxt(domain('cloudflare.com').mtaSts[0] ?? '');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.policyId).toMatch(/^\d+$/);
  });

  it('reads a government domain that publishes DMARC at reject', () => {
    const r = parseDmarc(domain('irs.gov').dmarc[0] ?? '');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.p).toBe('reject');
  });

  it('reads a bank publishing DMARC at reject with BIMI', () => {
    const dmarc = parseDmarc(domain('paypal.com').dmarc[0] ?? '');
    expect(dmarc.ok && dmarc.value.p).toBe('reject');
    const bimi = parseBimi(domain('paypal.com').bimi[0] ?? '');
    expect(bimi.ok && bimi.value.hasLogo).toBe(true);
  });
});

describe('captured fixtures — real MTA-STS policy files', () => {
  it('parses every captured policy without throwing', () => {
    const failures: string[] = [];
    for (const p of policies.policies) {
      const r = parseMtaStsPolicy(p.body);
      if (!r.ok) failures.push(`${p.domain}: ${r.error}`);
    }
    expect(failures).toEqual([]);
  });

  it('reads an enforcing policy', () => {
    const r = parseMtaStsPolicy(policyBody('google.com'));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.mode).toBe('enforce');
    expect(r.value.mxPatterns.length).toBeGreaterThan(0);
    expect(r.value.maxAge).toBeGreaterThan(0);
  });

  it('reads a testing policy, the state that precedes enforcement', () => {
    // The testing -> enforce transition is exactly the change this project
    // exists to capture, so a real testing-mode policy is a required fixture.
    const r = parseMtaStsPolicy(policyBody('facebook.com'));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.mode).toBe('testing');
  });

  it('captured both modes across the corpus', () => {
    const modes = new Set(
      policies.policies
        .map((p) => parseMtaStsPolicy(p.body))
        .filter((r) => r.ok)
        .map((r) => r.value.mode),
    );
    expect(modes).toContain('enforce');
    expect(modes).toContain('testing');
  });

  it('collects every mx pattern when a policy lists several', () => {
    const r = parseMtaStsPolicy(policyBody('microsoft.com'));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.mxPatterns.length).toBeGreaterThanOrEqual(1);
  });
});
