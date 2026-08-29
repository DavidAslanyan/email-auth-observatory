import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { DomainSnapshot } from '@observatory/core';
import { fetchPolicies } from '../src/mta-sts-pass.js';

/**
 * These fetches go to arbitrary third-party web servers, so the limits matter:
 * an uncapped redirect chain is an open redirect to follow, and an uncapped
 * body read lets one hostile host exhaust the runner. Each case runs against a
 * real local server so the limit is actually exercised.
 */
let server: Server | undefined;

afterEach(async () => {
  await new Promise<void>((resolve) => {
    if (!server) {
      resolve();
      return;
    }
    server.close(() => {
      resolve();
    });
  });
  server = undefined;
});

function snapshot(): DomainSnapshot {
  const meta = { status: 'ok' as const, rcode: 'NOERROR', resolver: 'local' as const, ad: false };
  return {
    domain: 'example.test',
    rank: 1,
    listId: 'TEST',
    crawledAt: '2026-08-29T00:00:00.000Z',
    dnssec: 'unsigned',
    spf: {
      ...meta,
      present: false,
      multipleRecords: false,
      recordCount: 0,
      hasRedirect: false,
      includes: [],
    },
    dmarc: {
      ...meta,
      present: false,
      multipleRecords: false,
      ruaCount: 0,
      rufCount: 0,
      ruaHosts: [],
    },
    bimi: { ...meta, present: false, hasLogo: false, hasVmc: false, declined: false },
    mtaSts: { ...meta, present: true, policyFetched: false },
    tlsRpt: { ...meta, present: false, ruaCount: 0, ruaHosts: [] },
    mx: { ...meta, present: false, hosts: [], isNullMx: false },
    dkim: { status: 'ok', selectorsFound: [], selectorsProbed: [], probeStrategy: 'skipped' },
  };
}

async function against(handler: Parameters<typeof createServer>[1]): Promise<DomainSnapshot> {
  server = createServer(handler);
  await new Promise<void>((resolve) => {
    server?.listen(0, '127.0.0.1', resolve);
  });
  const port = (server.address() as AddressInfo).port;

  const snap = snapshot();
  await fetchPolicies([snap], {
    timeoutMs: 4000,
    concurrency: 1,
    userAgent: 'observatory-test',
    policyUrl: () => `http://127.0.0.1:${port}/.well-known/mta-sts.txt`,
  });
  return snap;
}

const VALID = 'version: STSv1\nmode: enforce\nmx: mail.example.test\nmax_age: 604800\n';

describe('MTA-STS policy fetch', () => {
  it('parses a well-formed policy', async () => {
    const r = await against((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end(VALID);
    });
    expect(r.mtaSts.policyFetched).toBe(true);
    expect(r.mtaSts.mode).toBe('enforce');
    expect(r.mtaSts.maxAge).toBe(604800);
  });

  it('follows a redirect within the limit', async () => {
    let hits = 0;
    const r = await against((req, res) => {
      hits += 1;
      if (hits <= 2) {
        res.writeHead(302, { location: `/hop${hits}` });
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end(VALID);
      void req;
    });
    expect(r.mtaSts.policyFetched).toBe(true);
  });

  it('gives up on a redirect loop instead of following it forever', async () => {
    let hits = 0;
    const r = await against((_req, res) => {
      hits += 1;
      res.writeHead(302, { location: `/again${hits}` });
      res.end();
    });
    expect(r.mtaSts.policyFetched).toBe(false);
    expect(r.mtaSts.policyError).toMatch(/redirect/);
    // Capped at 3, so it stops well short of the runtime default of 20.
    expect(hits).toBeLessThanOrEqual(4);
  });

  it('records an error for a redirect with no location header', async () => {
    const r = await against((_req, res) => {
      res.writeHead(302);
      res.end();
    });
    expect(r.mtaSts.policyError).toMatch(/no location/);
  });

  it('refuses a body larger than the cap using the declared length', async () => {
    const huge = 'x'.repeat(200_000);
    const r = await against((_req, res) => {
      res.writeHead(200, { 'content-length': String(huge.length) });
      res.end(huge);
    });
    expect(r.mtaSts.policyFetched).toBe(false);
    expect(r.mtaSts.policyError).toMatch(/size limit/);
  });

  it('refuses an oversized body that declares no length', async () => {
    // The dangerous case: without a content-length, reading the whole body
    // before checking its size is what exhausts memory.
    const r = await against((_req, res) => {
      res.writeHead(200, { 'transfer-encoding': 'chunked' });
      for (let i = 0; i < 100; i++) res.write('y'.repeat(4096));
      res.end();
    });
    expect(r.mtaSts.policyFetched).toBe(false);
    expect(r.mtaSts.policyError).toMatch(/size limit/);
  });

  it('records the status for a non-2xx response', async () => {
    const r = await against((_req, res) => {
      res.writeHead(404);
      res.end('nope');
    });
    expect(r.mtaSts.policyError).toBe('HTTP 404');
  });

  it('records a parse error for a policy that is not one', async () => {
    const r = await against((_req, res) => {
      res.writeHead(200);
      res.end('<!doctype html><html><body>404</body></html>');
    });
    expect(r.mtaSts.policyFetched).toBe(false);
    expect(r.mtaSts.policyError).toBeDefined();
  });

  it('only contacts domains that published the TXT record', async () => {
    const withRecord = snapshot();
    const without = snapshot();
    without.mtaSts.present = false;

    const targets = await fetchPolicies([withRecord, without], {
      timeoutMs: 2000,
      concurrency: 2,
      userAgent: 'observatory-test',
      policyUrl: () => 'http://127.0.0.1:1/.well-known/mta-sts.txt',
    });

    // The ~98% of domains with no record are never contacted at all.
    expect(targets).toBe(1);
    expect(without.mtaSts.policyError).toBeUndefined();
  });

  it('records a policy error rather than throwing when the host is unreachable', async () => {
    const snap = snapshot();
    await fetchPolicies([snap], {
      timeoutMs: 2000,
      concurrency: 1,
      userAgent: 'observatory-test',
      policyUrl: () => 'http://127.0.0.1:1/.well-known/mta-sts.txt',
    });
    expect(snap.mtaSts.policyFetched).toBe(false);
    expect(snap.mtaSts.policyError).toBeDefined();
  });
});
