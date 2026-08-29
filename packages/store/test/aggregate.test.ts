import { describe, expect, it } from 'vitest';
import { aggregate, accumulate, rankBucketOf, tldOf, toHistoryEntry } from '../src/aggregate.js';
import { snapshot } from './helpers.js';

const input = { date: '2026-08-29', listId: 'N2Q8W', unknownRate: 0.001, degraded: false };

describe('tldOf', () => {
  it('returns the last label', () => {
    expect(tldOf('example.com')).toBe('com');
  });

  it('returns the last label of a multi-part suffix', () => {
    // A registrable suffix needs a public suffix list; the last label is enough
    // to separate .com from .de, which is what the breakdown is for.
    expect(tldOf('bbc.co.uk')).toBe('uk');
  });

  it('lowercases the result', () => {
    expect(tldOf('EXAMPLE.COM')).toBe('com');
  });

  it('handles a domain with no dot', () => {
    expect(tldOf('localhost')).toBe('localhost');
  });
});

describe('rankBucketOf', () => {
  it('buckets the top thousand', () => {
    expect(rankBucketOf(1)).toBe('1-1000');
    expect(rankBucketOf(1000)).toBe('1-1000');
  });

  it('buckets the middle band', () => {
    expect(rankBucketOf(1001)).toBe('1001-10000');
    expect(rankBucketOf(10_000)).toBe('1001-10000');
  });

  it('buckets the long tail', () => {
    expect(rankBucketOf(10_001)).toBe('10001-100000');
    expect(rankBucketOf(100_000)).toBe('10001-100000');
  });

  it('reports a rank outside every bucket as other', () => {
    expect(rankBucketOf(500_000)).toBe('other');
  });
});

describe('accumulate', () => {
  it('counts an SPF qualifier under its mechanism spelling', () => {
    const totals = aggregate(
      [snapshot({ spf: { present: true, allQualifier: '-' } })],
      input,
    ).totals;
    expect(totals.spf.allQualifier['-all']).toBe(1);
  });

  it('does not count a qualifier for a domain with no SPF', () => {
    const totals = aggregate([snapshot()], input).totals;
    expect(totals.spf.present).toBe(0);
    expect(totals.spf.allQualifier).toEqual({});
  });

  it('counts DMARC policies', () => {
    const totals = aggregate(
      [
        snapshot({ domain: 'a.example', dmarc: { present: true, p: 'reject' } }),
        snapshot({ domain: 'b.example', dmarc: { present: true, p: 'reject' } }),
        snapshot({ domain: 'c.example', dmarc: { present: true, p: 'none' } }),
      ],
      input,
    ).totals;
    expect(totals.dmarc.p).toEqual({ reject: 2, none: 1 });
  });

  it('treats an absent pct as the RFC default of 100, not as below 100', () => {
    // pct is stored as published; absent means the default applies.
    const totals = aggregate([snapshot({ dmarc: { present: true, p: 'reject' } })], input).totals;
    expect(totals.dmarc.pctBelow100).toBe(0);
  });

  it('counts an explicitly reduced pct', () => {
    const totals = aggregate(
      [snapshot({ dmarc: { present: true, p: 'reject', pct: 20 } })],
      input,
    ).totals;
    expect(totals.dmarc.pctBelow100).toBe(1);
  });

  it('does not count pct=100 as below 100', () => {
    const totals = aggregate(
      [snapshot({ dmarc: { present: true, p: 'reject', pct: 100 } })],
      input,
    ).totals;
    expect(totals.dmarc.pctBelow100).toBe(0);
  });

  it('counts a BIMI decline separately from a BIMI logo', () => {
    const totals = aggregate(
      [snapshot({ bimi: { present: true, declined: true, hasLogo: false } })],
      input,
    ).totals;
    expect(totals.bimi.present).toBe(1);
    expect(totals.bimi.declined).toBe(1);
    expect(totals.bimi.hasVmc).toBe(0);
  });

  it('counts MTA-STS modes', () => {
    const totals = aggregate(
      [
        snapshot({ domain: 'a.example', mtaSts: { present: true, mode: 'enforce' } }),
        snapshot({ domain: 'b.example', mtaSts: { present: true, mode: 'testing' } }),
      ],
      input,
    ).totals;
    expect(totals.mtaSts.mode).toEqual({ enforce: 1, testing: 1 });
  });

  it('counts an MTA-STS record whose policy could not be fetched as present with no mode', () => {
    const totals = aggregate(
      [snapshot({ mtaSts: { present: true, policyFetched: false, policyError: 'timeout' } })],
      input,
    ).totals;
    expect(totals.mtaSts.present).toBe(1);
    expect(totals.mtaSts.mode).toEqual({});
  });

  it('counts a null MX separately from a present MX', () => {
    // RFC 7505: a null MX is a deliberate configuration, not a missing one.
    const totals = aggregate([snapshot({ mx: { present: true, isNullMx: true } })], input).totals;
    expect(totals.mx.isNullMx).toBe(1);
  });

  it('counts every DNSSEC state including unknown', () => {
    const totals = aggregate(
      [
        snapshot({ domain: 'a.example', dnssec: 'signed' }),
        snapshot({ domain: 'b.example', dnssec: 'unsigned' }),
        snapshot({ domain: 'c.example', dnssec: 'unknown' }),
      ],
      input,
    ).totals;
    expect(totals.dnssec).toEqual({ signed: 1, unsigned: 1, unknown: 1 });
  });

  it('accumulates into an existing totals object', () => {
    const totals = aggregate([], input).totals;
    accumulate(totals, snapshot({ dmarc: { present: true, p: 'reject' } }));
    accumulate(totals, snapshot({ dmarc: { present: true, p: 'reject' } }));
    expect(totals.dmarc.present).toBe(2);
  });
});

describe('aggregate breakdowns', () => {
  const snapshots = [
    snapshot({
      domain: 'a.com',
      rank: 5,
      mx: { present: true, provider: 'google' },
      dmarc: { present: true, p: 'reject' },
    }),
    snapshot({
      domain: 'b.com',
      rank: 2000,
      mx: { present: true, provider: 'google' },
      dmarc: { present: true, p: 'none' },
    }),
    snapshot({ domain: 'c.de', rank: 50_000, mx: { present: true, provider: 'microsoft' } }),
    snapshot({ domain: 'd.com', rank: 60_000, mx: { present: true, isNullMx: true } }),
  ];

  it('breaks down by TLD', () => {
    const result = aggregate(snapshots, input);
    expect(result.byTld.com?.domainsObserved).toBe(3);
    expect(result.byTld.de?.domainsObserved).toBe(1);
  });

  it('breaks down by MX provider', () => {
    const result = aggregate(snapshots, input);
    expect(result.byMxProvider.google?.domainsObserved).toBe(2);
    expect(result.byMxProvider.microsoft?.domainsObserved).toBe(1);
  });

  it('files a null MX under its own provider key rather than as absent', () => {
    expect(aggregate(snapshots, input).byMxProvider['null-mx']?.domainsObserved).toBe(1);
  });

  it('breaks down by rank bucket', () => {
    const result = aggregate(snapshots, input);
    expect(result.byRankBucket['1-1000']?.domainsObserved).toBe(1);
    expect(result.byRankBucket['1001-10000']?.domainsObserved).toBe(1);
    expect(result.byRankBucket['10001-100000']?.domainsObserved).toBe(2);
  });

  it('keeps per-slice totals independent of the global totals', () => {
    const result = aggregate(snapshots, input);
    expect(result.totals.dmarc.present).toBe(2);
    expect(result.byRankBucket['1-1000']?.totals.dmarc.present).toBe(1);
  });

  it('carries the date, list id and degraded flag through', () => {
    const result = aggregate(snapshots, { ...input, degraded: true, unknownRate: 0.07 });
    expect(result.date).toBe('2026-08-29');
    expect(result.listId).toBe('N2Q8W');
    expect(result.degraded).toBe(true);
    expect(result.unknownRate).toBe(0.07);
  });

  it('handles an empty dataset', () => {
    const result = aggregate([], input);
    expect(result.domainsObserved).toBe(0);
    expect(result.totals.dmarc.present).toBe(0);
  });
});

describe('toHistoryEntry', () => {
  it('drops the wide breakdowns so the history file stays a single small fetch', () => {
    const entry = toHistoryEntry(aggregate([snapshot()], input));
    expect(entry).not.toHaveProperty('byTld');
    expect(entry).not.toHaveProperty('byMxProvider');
  });

  it('keeps the rank buckets, which the trend charts use', () => {
    expect(toHistoryEntry(aggregate([snapshot()], input))).toHaveProperty('byRankBucket');
  });

  it('keeps the headline totals', () => {
    const entry = toHistoryEntry(
      aggregate([snapshot({ dmarc: { present: true, p: 'reject' } })], input),
    );
    expect(entry.totals.dmarc.present).toBe(1);
    expect(entry.date).toBe('2026-08-29');
  });
});
