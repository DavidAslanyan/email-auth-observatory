/**
 * Network-dependent verification of the four-state rule (plan section 1.1,
 * phase 2 acceptance step 7).
 *
 * These are excluded from the default `pnpm test` run so CI never fails on
 * somebody else's outage. Run them deliberately:
 *
 *   pnpm vitest run --project dns-network
 *
 * MAILSCAPE_TEST_RESOLVER selects the recursive resolver (default 1.1.1.1);
 * in CI and on a crawl host this is the local unbound at 127.0.0.1.
 */
import { describe, expect, it } from 'vitest';
import { Resolver } from '../src/resolver.js';

const RESOLVER_HOST = process.env.MAILSCAPE_TEST_RESOLVER ?? '1.1.1.1';

function resolver(overrides = {}): Resolver {
  return new Resolver({
    local: { host: RESOLVER_HOST, port: 53 },
    // DoH is disabled so each assertion tests the local path in isolation;
    // the fallback gets its own test below.
    useDoh: false,
    localAttempts: 2,
    ...overrides,
  });
}

describe('four-state rule, verified against the live internet', () => {
  it('records a domain that publishes DMARC as ok', async () => {
    const answer = await resolver().query('_dmarc.google.com', 'TXT');
    expect(answer.status).toBe('ok');
    expect(answer.rcode).toBe('NOERROR');
    expect(answer.txt.some((r) => r.toUpperCase().startsWith('V=DMARC1'))).toBe(true);
  });

  it('records a name that exists without the record type as nodata, not nxdomain', async () => {
    // example.com exists and answers, but publishes no MTA-STS TXT record.
    const answer = await resolver().query('_mta-sts.example.com', 'TXT');
    expect(answer.status).toBe('nodata');
    expect(answer.rcode).toBe('NOERROR');
    expect(answer.txt).toEqual([]);
  });

  it('records a name that does not exist as nxdomain, not nodata', async () => {
    const answer = await resolver().query('_dmarc.thisdoesnotexist-observatory.invalid', 'TXT');
    expect(answer.status).toBe('nxdomain');
    expect(answer.rcode).toBe('NXDOMAIN');
  });

  it('records an unreachable resolver as unknown, NEVER as nodata', async () => {
    // The single most damaging possible bug: if this ever returns nodata, a
    // resolver outage is published as thousands of domains dropping DMARC.
    const unreachable = resolver({
      // 192.0.2.0/24 is TEST-NET-1 (RFC 5737) and is guaranteed unroutable.
      local: { host: '192.0.2.1', port: 53 },
      localTimeoutMs: 1500,
      localAttempts: 1,
    });
    const answer = await unreachable.query('_dmarc.google.com', 'TXT');
    expect(answer.status).toBe('unknown');
    expect(answer.status).not.toBe('nodata');
    expect(answer.status).not.toBe('nxdomain');
    expect(['TIMEOUT', 'NETWORK_ERROR']).toContain(answer.rcode);
  });

  it('records a refused resolver as unknown, not absent', async () => {
    // Port 1 has nothing listening; the OS answers with ICMP unreachable.
    const refused = resolver({
      local: { host: '127.0.0.1', port: 1 },
      localTimeoutMs: 1500,
      localAttempts: 1,
    });
    const answer = await refused.query('_dmarc.google.com', 'TXT');
    expect(answer.status).toBe('unknown');
  });
});

describe('resolver behaviour against the live internet', () => {
  it('resolves MX records with preference and exchange', async () => {
    const answer = await resolver().query('google.com', 'MX');
    expect(answer.status).toBe('ok');
    expect(answer.mx.length).toBeGreaterThan(0);
    expect(answer.mx[0]?.exchange).toMatch(/google/i);
  });

  it('reassembles a TXT record longer than one 255-byte chunk', async () => {
    const answer = await resolver().query('akamai.com', 'TXT');
    const spf = answer.txt.find((r) => r.toLowerCase().startsWith('v=spf1'));
    expect(spf).toBeDefined();
    expect((spf ?? '').length).toBeGreaterThan(255);
    // A truncated join would leave the record without its terminating `all`.
    expect(spf).toMatch(/all\s*$/);
  });

  it('reports the DNSSEC AD flag for a signed zone', async () => {
    const answer = await resolver().query('cloudflare.com', 'TXT');
    expect(answer.status).toBe('ok');
    expect(answer.ad).toBe(true);
  });

  it('reports no AD flag for an unsigned zone', async () => {
    const answer = await resolver().query('google.com', 'TXT');
    expect(answer.status).toBe('ok');
    expect(answer.ad).toBe(false);
  });

  it('falls back to DoH when the local resolver is unreachable', async () => {
    const withDoh = new Resolver({
      local: { host: '192.0.2.1', port: 53 },
      localTimeoutMs: 1500,
      localAttempts: 1,
      useDoh: true,
    });
    const answer = await withDoh.query('_dmarc.google.com', 'TXT');
    expect(answer.status).toBe('ok');
    expect(answer.resolver).toBe('doh-cloudflare');
    expect(answer.txt.some((r) => r.toUpperCase().startsWith('V=DMARC1'))).toBe(true);
  });

  it('counts statuses and resolver tiers for the run summary', async () => {
    const r = resolver();
    await r.query('_dmarc.google.com', 'TXT');
    await r.query('_mta-sts.example.com', 'TXT');
    const stats = r.getStats();
    expect(stats.total).toBe(2);
    expect(stats.byStatus.ok).toBe(1);
    expect(stats.byStatus.nodata).toBe(1);
    expect(stats.byResolver.local).toBe(2);
    expect(stats.unknownRate).toBe(0);
  });

  it('reports a nonzero unknown rate when every tier fails', async () => {
    const r = resolver({
      local: { host: '192.0.2.1', port: 53 },
      localTimeoutMs: 1200,
      localAttempts: 1,
    });
    await r.query('_dmarc.google.com', 'TXT');
    expect(r.getStats().unknownRate).toBe(1);
  });
});
