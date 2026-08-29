import { describe, expect, it } from 'vitest';
import type { Aggregate, ChangeEvent } from '@observatory/core';
import {
  annotateWithProvider,
  findClusters,
  findFirstTimeAdopters,
  findHighRankMovers,
  findWeakening,
  renderReport,
} from '../src/report.js';

function change(over: Partial<ChangeEvent> = {}): ChangeEvent {
  return {
    domain: 'example.com',
    rank: 500,
    field: 'dmarc.p',
    kind: 'modified',
    from: 'none',
    to: 'reject',
    ts: '2026-08-29T00:00:00.000Z',
    ...over,
  };
}

function aggregate(over: Partial<Aggregate> = {}): Aggregate {
  return {
    date: '2026-08-29',
    listId: 'N2Q8W',
    domainsObserved: 1000,
    unknownRate: 0.001,
    degraded: false,
    totals: {
      spf: { present: 764, allQualifier: { '-all': 436 }, exceedsLookupLimit: 0 },
      dmarc: { present: 724, p: { reject: 439 }, pctBelow100: 10 },
      bimi: { present: 163, hasVmc: 123, declined: 2 },
      mtaSts: { present: 32, mode: { enforce: 19 } },
      tlsRpt: { present: 42 },
      dnssec: { signed: 106 },
      mx: { present: 700, isNullMx: 9 },
    },
    byTld: {},
    byMxProvider: {},
    byRankBucket: {},
    ...over,
  };
}

describe('findClusters', () => {
  it('finds five domains on one provider making the same change', () => {
    const events = ['a', 'b', 'c', 'd', 'e'].map((d) =>
      change({ domain: `${d}.example`, mxProvider: 'google' }),
    );
    const clusters = findClusters(events);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]?.provider).toBe('google');
    expect(clusters[0]?.domains).toHaveLength(5);
  });

  it('does not report four domains as a cluster', () => {
    const events = ['a', 'b', 'c', 'd'].map((d) =>
      change({ domain: `${d}.example`, mxProvider: 'google' }),
    );
    expect(findClusters(events)).toEqual([]);
  });

  it('does not group domains making different changes', () => {
    const events = [
      ...['a', 'b', 'c'].map((d) => change({ domain: `${d}.example`, mxProvider: 'google' })),
      ...['e', 'f', 'g'].map((d) =>
        change({ domain: `${d}.example`, mxProvider: 'google', to: 'quarantine' }),
      ),
    ];
    expect(findClusters(events)).toEqual([]);
  });

  it('does not group domains on different providers', () => {
    const events = [
      ...['a', 'b', 'c'].map((d) => change({ domain: `${d}.example`, mxProvider: 'google' })),
      ...['e', 'f', 'g'].map((d) => change({ domain: `${d}.example`, mxProvider: 'microsoft' })),
    ];
    expect(findClusters(events)).toEqual([]);
  });

  it('ignores self-hosted domains, which have no common operator', () => {
    const events = ['a', 'b', 'c', 'd', 'e', 'f'].map((d) =>
      change({ domain: `${d}.example`, mxProvider: 'self-hosted' }),
    );
    expect(findClusters(events)).toEqual([]);
  });

  it('ignores events with no provider', () => {
    const events = ['a', 'b', 'c', 'd', 'e'].map((d) => change({ domain: `${d}.example` }));
    expect(findClusters(events)).toEqual([]);
  });

  it('ignores first_seen events, which are list churn rather than change', () => {
    const events = ['a', 'b', 'c', 'd', 'e', 'f'].map((d) =>
      change({ domain: `${d}.example`, mxProvider: 'google', kind: 'first_seen' }),
    );
    expect(findClusters(events)).toEqual([]);
  });

  it('sorts the largest cluster first', () => {
    const events = [
      ...Array.from({ length: 5 }, (_, i) =>
        change({ domain: `g${i}.example`, mxProvider: 'google' }),
      ),
      ...Array.from({ length: 9 }, (_, i) =>
        change({ domain: `m${i}.example`, mxProvider: 'microsoft' }),
      ),
    ];
    expect(findClusters(events)[0]?.provider).toBe('microsoft');
  });
});

describe('findHighRankMovers', () => {
  it('names a top-1000 domain changing policy', () => {
    expect(findHighRankMovers([change({ rank: 12 })])).toHaveLength(1);
  });

  it('ignores a domain outside the top 1000', () => {
    expect(findHighRankMovers([change({ rank: 5000 })])).toEqual([]);
  });

  it('ignores fields that are not policy, enforcement or MTA-STS mode', () => {
    expect(findHighRankMovers([change({ rank: 12, field: 'dmarc.adkim' })])).toEqual([]);
  });

  it('orders by rank so the most prominent domain reads first', () => {
    const movers = findHighRankMovers([
      change({ rank: 900 }),
      change({ rank: 3, domain: 'b.example' }),
    ]);
    expect(movers[0]?.rank).toBe(3);
  });
});

describe('findWeakening', () => {
  it('finds a policy retreat at any rank', () => {
    const events = [change({ rank: 90_000, from: 'reject', to: 'none' })];
    expect(findWeakening(events)).toHaveLength(1);
  });

  it('does not report a policy climb as weakening', () => {
    expect(findWeakening([change({ from: 'none', to: 'reject' })])).toEqual([]);
  });

  it('finds an MTA-STS retreat from enforce to testing', () => {
    const events = [change({ field: 'mtaSts.mode', from: 'enforce', to: 'testing' })];
    expect(findWeakening(events)).toHaveLength(1);
  });

  it('ignores first_seen events', () => {
    expect(findWeakening([change({ kind: 'first_seen', from: null, to: 'x' })])).toEqual([]);
  });
});

describe('findFirstTimeAdopters', () => {
  it('counts domains publishing DMARC for the first time, by provider', () => {
    const events = [
      change({
        domain: 'a.example',
        field: 'dmarc.present',
        from: false,
        to: true,
        kind: 'added',
        mxProvider: 'google',
      }),
      change({
        domain: 'b.example',
        field: 'dmarc.present',
        from: false,
        to: true,
        kind: 'added',
        mxProvider: 'google',
      }),
      change({
        domain: 'c.example',
        field: 'dmarc.present',
        from: false,
        to: true,
        kind: 'added',
        mxProvider: 'microsoft',
      }),
    ];
    const result = findFirstTimeAdopters(events);
    expect(result.total).toBe(3);
    expect(result.byProvider[0]).toEqual(['google', 2]);
  });

  it('does not count a domain withdrawing DMARC', () => {
    expect(
      findFirstTimeAdopters([change({ field: 'dmarc.present', from: true, to: false })]).total,
    ).toBe(0);
  });

  it('does not count a first sighting as an adoption', () => {
    expect(
      findFirstTimeAdopters([
        change({ field: 'dmarc.present', kind: 'first_seen', from: null, to: true }),
      ]).total,
    ).toBe(0);
  });
});

describe('renderReport', () => {
  it('writes a short report when nothing changed, without padding it', () => {
    const md = renderReport({ date: '2026-08-29', events: [], aggregate: aggregate() });
    expect(md).toContain('# 2026-08-29');
    expect(md).toContain('No changes observed.');
    expect(md).not.toContain('## Enforcement moves');
    expect(md.split('\n').length).toBeLessThan(10);
  });

  it('leads with the cluster, which is the highest-value finding', () => {
    const events = Array.from({ length: 12 }, (_, i) =>
      change({ domain: `site${i}.example`, mxProvider: 'godaddy', from: 'reject', to: 'none' }),
    );
    const md = renderReport({ date: '2026-08-29', events, aggregate: aggregate() });
    expect(md).toContain('**12 godaddy-hosted domains**');
    expect(md).toContain('provider-side default change');
    expect(md.indexOf('## Enforcement moves')).toBeLessThan(md.indexOf('## Weakening'));
  });

  it('names a high-rank individual mover', () => {
    const events = [change({ domain: 'bigsite.example', rank: 4, from: 'none', to: 'reject' })];
    const md = renderReport({ date: '2026-08-29', events, aggregate: aggregate() });
    expect(md).toContain('**bigsite.example** (#4)');
    expect(md).toContain('DMARC policy');
  });

  it('always lists a weakening move, even a single one', () => {
    const events = [change({ domain: 'weak.example', rank: 88_000, from: 'reject', to: 'none' })];
    const md = renderReport({ date: '2026-08-29', events, aggregate: aggregate() });
    expect(md).toContain('## Weakening');
    expect(md).toContain('weak.example');
  });

  it('uses names people recognise rather than field paths', () => {
    const md = renderReport({
      date: '2026-08-29',
      events: [change({ rank: 5 })],
      aggregate: aggregate(),
    });
    expect(md).toContain('DMARC policy');
    expect(md).not.toContain('dmarc.p');
  });

  it('warns at the top when the run was degraded', () => {
    const md = renderReport({
      date: '2026-08-29',
      events: [change({ rank: 5 })],
      aggregate: aggregate({ degraded: true, unknownRate: 0.071 }),
    });
    expect(md).toContain('Elevated unknown rate (7.10%)');
    expect(md).toContain('## Anomalies');
    expect(md).toContain('carried forward');
  });

  it('attributes a nameserver outage rather than implying the domains changed', () => {
    const md = renderReport({
      date: '2026-08-29',
      events: [change({ rank: 5 })],
      aggregate: aggregate(),
      unknownClusters: [{ nameserver: 'ns1.badhost.example', count: 412 }],
    });
    expect(md).toContain('ns1.badhost.example');
    expect(md).toContain('412 unresolved lookups');
    expect(md).toContain('outage at that nameserver');
  });

  it('reports first sightings separately from changes', () => {
    const events = [
      change({
        domain: 'new.example',
        kind: 'first_seen',
        field: 'domain',
        from: null,
        to: 'new.example',
      }),
    ];
    const md = renderReport({ date: '2026-08-29', events, aggregate: aggregate() });
    expect(md).toContain('1 domains entered the dataset for the first time.');
    expect(md).not.toContain('## Enforcement moves');
  });

  it('does not repeat itself when there are changes but none are notable', () => {
    const events = [change({ rank: 50_000, field: 'dmarc.adkim', from: 'r', to: 's' })];
    const md = renderReport({ date: '2026-08-29', events, aggregate: aggregate() });
    expect(md).toContain('**1 change** across 1 domain.');
    expect(md).toContain('No change met the notability rules today.');
  });

  it('cites the Tranco list it was generated from', () => {
    const md = renderReport({ date: '2026-08-29', events: [], aggregate: aggregate() });
    expect(md).toContain('Tranco list `N2Q8W`');
  });

  it('survives having no aggregate at all', () => {
    const md = renderReport({ date: '2026-08-29', events: [change()], aggregate: undefined });
    expect(md).toContain('# 2026-08-29');
  });

  it('does not list a clustered domain again as an individual mover', () => {
    const events = Array.from({ length: 6 }, (_, i) =>
      change({ domain: `top${i}.example`, rank: i + 1, mxProvider: 'zoho' }),
    );
    const md = renderReport({ date: '2026-08-29', events, aggregate: aggregate() });
    const mentions = md.split('top0.example').length - 1;
    expect(mentions).toBe(1);
  });
});

describe('annotateWithProvider', () => {
  it('attaches the provider from the snapshot', () => {
    const annotated = annotateWithProvider([change({ domain: 'a.example' })], () => 'google');
    expect(annotated[0]?.mxProvider).toBe('google');
  });

  it('leaves the event untouched when the provider is unknown', () => {
    const annotated = annotateWithProvider([change()], () => undefined);
    expect(annotated[0]?.mxProvider).toBeUndefined();
  });
});
