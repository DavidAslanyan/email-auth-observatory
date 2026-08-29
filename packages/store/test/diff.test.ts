/**
 * The change engine. Plan section 4.4 calls this the second-most-important
 * file in the project after rcode.ts, for the same reason: a bug here does not
 * crash, it publishes a plausible lie.
 */
import { describe, expect, it } from 'vitest';
import type { ChangeEvent } from '@observatory/core';
import { classifyDirection, diffDomain, diffSnapshots } from '../src/diff.js';
import { ALL_STATUSES, snapshot } from './helpers.js';

function fields(events: ChangeEvent[]): string[] {
  return events.map((e) => e.field).sort();
}

describe('diffDomain — the unknown rule', () => {
  it('emits no event for any combination where either side is unknown', () => {
    // The exhaustive matrix the plan requires: every {prev} x {new} pair.
    const offenders: string[] = [];

    for (const prevStatus of ALL_STATUSES) {
      for (const nextStatus of ALL_STATUSES) {
        const previous = snapshot({
          dmarc: { status: prevStatus, present: true, p: 'reject' },
        });
        const next = snapshot({
          dmarc: { status: nextStatus, present: false },
          crawledAt: '2026-08-30T00:00:00.000Z',
        });

        const { events } = diffDomain(previous, next);
        const dmarcEvents = events.filter((e) => e.field.startsWith('dmarc.'));
        const involvesUnknown = prevStatus === 'unknown' || nextStatus === 'unknown';

        if (involvesUnknown && dmarcEvents.length > 0) {
          offenders.push(`${prevStatus} -> ${nextStatus} emitted ${dmarcEvents.length} events`);
        }
        if (!involvesUnknown && dmarcEvents.length === 0) {
          offenders.push(`${prevStatus} -> ${nextStatus} emitted nothing but should have`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it('emits nothing when the new lookup failed, however different the values look', () => {
    const previous = snapshot({ dmarc: { status: 'ok', present: true, p: 'reject' } });
    const next = snapshot({ dmarc: { status: 'unknown', present: false } });
    expect(diffDomain(previous, next).events).toEqual([]);
  });

  it('emits nothing when the previous lookup had failed', () => {
    const previous = snapshot({ dmarc: { status: 'unknown', present: false } });
    const next = snapshot({ dmarc: { status: 'ok', present: true, p: 'reject' } });
    expect(diffDomain(previous, next).events).toEqual([]);
  });

  it('carries the previous value forward when the new lookup failed', () => {
    const previous = snapshot({
      dmarc: { status: 'ok', present: true, p: 'reject' },
      crawledAt: '2026-08-28T00:00:00.000Z',
    });
    const next = snapshot({
      dmarc: { status: 'unknown', present: false },
      crawledAt: '2026-08-29T00:00:00.000Z',
    });

    const { snapshot: result } = diffDomain(previous, next);
    expect(result.dmarc.p).toBe('reject');
    expect(result.dmarc.present).toBe(true);
    expect(result.dmarc.stale).toBe(true);
    expect(result.dmarc.lastSeenAt).toBe('2026-08-28T00:00:00.000Z');
  });

  it('keeps the original lastSeenAt across consecutive failures', () => {
    // Two bad mornings in a row must not make the data look one day old.
    const first = snapshot({
      dmarc: { status: 'ok', present: true, p: 'reject' },
      crawledAt: '2026-08-20T00:00:00.000Z',
    });
    const secondAttempt = diffDomain(
      first,
      snapshot({ dmarc: { status: 'unknown' }, crawledAt: '2026-08-21T00:00:00.000Z' }),
    ).snapshot;
    const thirdAttempt = diffDomain(
      secondAttempt,
      snapshot({ dmarc: { status: 'unknown' }, crawledAt: '2026-08-22T00:00:00.000Z' }),
    ).snapshot;

    expect(thirdAttempt.dmarc.stale).toBe(true);
    expect(thirdAttempt.dmarc.lastSeenAt).toBe('2026-08-20T00:00:00.000Z');
  });

  it('clears the stale marker once a lookup succeeds again', () => {
    const stale = snapshot({
      dmarc: {
        status: 'ok',
        present: true,
        p: 'reject',
        stale: true,
        lastSeenAt: '2026-08-01T00:00:00.000Z',
      },
    });
    const fresh = snapshot({ dmarc: { status: 'ok', present: true, p: 'reject' } });
    const { snapshot: result } = diffDomain(stale, fresh);
    expect(result.dmarc.stale).toBeUndefined();
    expect(result.dmarc.lastSeenAt).toBeUndefined();
  });

  it('carries a failed DKIM probe forward so an outage is not a removal', () => {
    const previous = snapshot({ dkim: { status: 'ok', selectorsFound: ['google'] } });
    const next = snapshot({ dkim: { status: 'unknown', selectorsFound: [] } });
    expect(diffDomain(previous, next).snapshot.dkim.selectorsFound).toEqual(['google']);
  });

  it('carries dnssec forward when it could not be determined', () => {
    const previous = snapshot({ dnssec: 'signed' });
    const next = snapshot({ dnssec: 'unknown' });
    const { events, snapshot: result } = diffDomain(previous, next);
    expect(result.dnssec).toBe('signed');
    expect(events.filter((e) => e.field === 'dnssec')).toEqual([]);
  });
});

describe('diffDomain — first sighting', () => {
  it('emits exactly one first_seen event for a domain never seen before', () => {
    const next = snapshot({ dmarc: { present: true, p: 'reject' }, spf: { present: true } });
    const { events } = diffDomain(undefined, next);
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe('first_seen');
  });

  it('does not emit per-field added events on first sighting', () => {
    // Otherwise every Tranco rollover floods the changes file with thousands of
    // fabricated adoptions.
    const next = snapshot({
      dmarc: { present: true, p: 'reject' },
      spf: { present: true, allQualifier: '-' },
      mtaSts: { present: true, mode: 'enforce' },
    });
    const { events } = diffDomain(undefined, next);
    expect(events.filter((e) => e.kind === 'added')).toEqual([]);
  });

  it('stores the new snapshot unchanged on first sighting', () => {
    const next = snapshot({ dmarc: { present: true, p: 'none' } });
    expect(diffDomain(undefined, next).snapshot).toEqual(next);
  });
});

describe('diffDomain — change kinds', () => {
  it('reports a newly published tag as added', () => {
    const previous = snapshot({ dmarc: { present: true, p: 'reject' } });
    const next = snapshot({ dmarc: { present: true, p: 'reject', sp: 'none' } });
    const events = diffDomain(previous, next).events;
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ field: 'dmarc.sp', kind: 'added', from: null, to: 'none' });
  });

  it('reports a withdrawn tag as removed', () => {
    const previous = snapshot({ dmarc: { present: true, p: 'reject', sp: 'none' } });
    const next = snapshot({ dmarc: { present: true, p: 'reject' } });
    expect(diffDomain(previous, next).events[0]).toMatchObject({
      field: 'dmarc.sp',
      kind: 'removed',
      from: 'none',
      to: null,
    });
  });

  it('reports a changed value as modified', () => {
    const previous = snapshot({ dmarc: { present: true, p: 'none' } });
    const next = snapshot({ dmarc: { present: true, p: 'reject' } });
    expect(diffDomain(previous, next).events[0]).toMatchObject({
      field: 'dmarc.p',
      kind: 'modified',
      from: 'none',
      to: 'reject',
    });
  });

  it('emits nothing at all when nothing changed', () => {
    const previous = snapshot({ dmarc: { present: true, p: 'reject' } });
    const next = snapshot({
      dmarc: { present: true, p: 'reject' },
      crawledAt: '2026-09-01T00:00:00.000Z',
    });
    expect(diffDomain(previous, next).events).toEqual([]);
  });

  it('carries the rank and timestamp of the new observation onto every event', () => {
    const previous = snapshot({ rank: 7, dmarc: { present: true, p: 'none' } });
    const next = snapshot({
      rank: 7,
      dmarc: { present: true, p: 'reject' },
      crawledAt: '2026-09-02T03:04:05.000Z',
    });
    expect(diffDomain(previous, next).events[0]).toMatchObject({
      domain: 'example.com',
      rank: 7,
      ts: '2026-09-02T03:04:05.000Z',
    });
  });
});

describe('diffDomain — tracked and untracked fields', () => {
  it('tracks exactly the fields the plan lists', () => {
    const previous = snapshot();
    const next = snapshot({
      dnssec: 'signed',
      spf: { present: true, allQualifier: '-', exceedsLookupLimit: true },
      dmarc: { present: true, p: 'reject', sp: 'none', pct: 50, adkim: 's', aspf: 's' },
      bimi: { present: true, hasLogo: true, hasVmc: true },
      mtaSts: { present: true, mode: 'enforce' },
      tlsRpt: { present: true },
      mx: { present: true, provider: 'google', isNullMx: true },
    });
    expect(fields(diffDomain(previous, next).events)).toEqual([
      'bimi.hasLogo',
      'bimi.hasVmc',
      'bimi.present',
      'dmarc.adkim',
      'dmarc.aspf',
      'dmarc.p',
      'dmarc.pct',
      'dmarc.present',
      'dmarc.sp',
      'dnssec',
      'mtaSts.mode',
      'mtaSts.present',
      'mx.isNullMx',
      'mx.provider',
      'spf.allQualifier',
      'spf.exceedsLookupLimit',
      'spf.present',
      'tlsRpt.present',
    ]);
  });

  it('does not emit events for deliberately untracked noisy fields', () => {
    const previous = snapshot({
      spf: { present: true, raw: 'v=spf1 -all' },
      dmarc: { present: true, p: 'reject', ruaHosts: ['a.example'], ruaCount: 1 },
      mx: { present: true, hosts: ['a.example'], provider: 'self-hosted' },
      mtaSts: { present: true, mode: 'enforce', policyId: 'old' },
      dkim: { status: 'ok', selectorsFound: ['s1'] },
    });
    const next = snapshot({
      spf: { present: true, raw: 'v=spf1 ip4:1.2.3.4 -all' },
      dmarc: { present: true, p: 'reject', ruaHosts: ['b.example'], ruaCount: 2 },
      mx: { present: true, hosts: ['b.example'], provider: 'self-hosted' },
      mtaSts: { present: true, mode: 'enforce', policyId: 'new' },
      dkim: { status: 'ok', selectorsFound: ['s2'] },
    });
    expect(diffDomain(previous, next).events).toEqual([]);
  });
});

describe('diffSnapshots', () => {
  it('diffs a whole shard and returns one snapshot per domain', () => {
    const previous = new Map([
      ['a.example', snapshot({ domain: 'a.example', dmarc: { present: true, p: 'none' } })],
      ['b.example', snapshot({ domain: 'b.example', dmarc: { present: true, p: 'reject' } })],
    ]);
    const next = [
      snapshot({ domain: 'a.example', dmarc: { present: true, p: 'reject' } }),
      snapshot({ domain: 'b.example', dmarc: { present: true, p: 'reject' } }),
      snapshot({ domain: 'c.example', dmarc: { present: true, p: 'none' } }),
    ];

    const result = diffSnapshots(previous, next);
    expect(result.snapshots).toHaveLength(3);
    expect(result.events.filter((e) => e.kind === 'modified')).toHaveLength(1);
    expect(result.events.filter((e) => e.kind === 'first_seen')).toHaveLength(1);
  });

  it('produces no events when a shard is re-crawled unchanged', () => {
    // Phase 3 acceptance: two crawls minutes apart must produce a near-empty
    // changes file.
    const domains = ['a.example', 'b.example', 'c.example'];
    const first = domains.map((domain) =>
      snapshot({ domain, dmarc: { present: true, p: 'reject' } }),
    );
    const previous = new Map(first.map((s) => [s.domain, s]));
    const second = domains.map((domain) =>
      snapshot({
        domain,
        dmarc: { present: true, p: 'reject' },
        crawledAt: '2026-08-29T06:00:00.000Z',
      }),
    );
    expect(diffSnapshots(previous, second).events).toEqual([]);
  });

  it('emits nothing for a whole shard that failed to resolve', () => {
    const unknownEverywhere = (domain: string, crawledAt: string) =>
      snapshot({
        domain,
        crawledAt,
        dnssec: 'unknown',
        spf: { status: 'unknown' },
        dmarc: { status: 'unknown' },
        bimi: { status: 'unknown' },
        mtaSts: { status: 'unknown' },
        tlsRpt: { status: 'unknown' },
        mx: { status: 'unknown' },
        dkim: { status: 'unknown', selectorsFound: [] },
      });

    const previous = new Map(
      ['a.example', 'b.example'].map((d) => [
        d,
        snapshot({ domain: d, dmarc: { present: true, p: 'reject' } }),
      ]),
    );
    const next = ['a.example', 'b.example'].map((d) =>
      unknownEverywhere(d, '2026-08-30T00:00:00.000Z'),
    );

    const result = diffSnapshots(previous, next);
    expect(result.events).toEqual([]);
    // and the known values survive
    expect(result.snapshots[0]?.dmarc.p).toBe('reject');
    expect(result.snapshots[0]?.dmarc.stale).toBe(true);
  });
});

describe('classifyDirection', () => {
  const event = (field: string, from: ChangeEvent['from'], to: ChangeEvent['to']): ChangeEvent => ({
    domain: 'x.example',
    rank: 1,
    field,
    kind: 'modified',
    from,
    to,
    ts: '2026-08-29T00:00:00.000Z',
  });

  it('reads a DMARC policy climb as strengthening', () => {
    expect(classifyDirection(event('dmarc.p', 'none', 'quarantine'))).toBe('strengthening');
    expect(classifyDirection(event('dmarc.p', 'quarantine', 'reject'))).toBe('strengthening');
  });

  it('reads a DMARC policy retreat as weakening', () => {
    expect(classifyDirection(event('dmarc.p', 'reject', 'quarantine'))).toBe('weakening');
    expect(classifyDirection(event('dmarc.p', 'reject', 'none'))).toBe('weakening');
    expect(classifyDirection(event('dmarc.p', 'quarantine', 'none'))).toBe('weakening');
  });

  it('reads an SPF qualifier softening as weakening', () => {
    expect(classifyDirection(event('spf.allQualifier', '-', '~'))).toBe('weakening');
    expect(classifyDirection(event('spf.allQualifier', '~', '?'))).toBe('weakening');
    expect(classifyDirection(event('spf.allQualifier', '?', '+'))).toBe('weakening');
  });

  it('reads an SPF qualifier tightening as strengthening', () => {
    expect(classifyDirection(event('spf.allQualifier', '~', '-'))).toBe('strengthening');
  });

  it('reads enforce to testing as weakening', () => {
    expect(classifyDirection(event('mtaSts.mode', 'enforce', 'testing'))).toBe('weakening');
  });

  it('reads testing to enforce as strengthening', () => {
    expect(classifyDirection(event('mtaSts.mode', 'testing', 'enforce'))).toBe('strengthening');
  });

  it('reads publishing a mechanism as strengthening', () => {
    expect(classifyDirection(event('dmarc.present', false, true))).toBe('strengthening');
    expect(classifyDirection(event('mtaSts.present', false, true))).toBe('strengthening');
  });

  it('reads withdrawing a mechanism as weakening', () => {
    expect(classifyDirection(event('dmarc.present', true, false))).toBe('weakening');
  });

  it('reads adding a policy where none existed as strengthening', () => {
    expect(classifyDirection(event('dmarc.p', null, 'reject'))).toBe('strengthening');
  });

  it('reads removing a policy entirely as weakening', () => {
    expect(classifyDirection(event('dmarc.p', 'reject', null))).toBe('weakening');
  });

  it('reads a pct increase as strengthening and a decrease as weakening', () => {
    expect(classifyDirection(event('dmarc.pct', 50, 100))).toBe('strengthening');
    expect(classifyDirection(event('dmarc.pct', 100, 10))).toBe('weakening');
  });

  it('reads breaking the SPF lookup limit as weakening', () => {
    expect(classifyDirection(event('spf.exceedsLookupLimit', false, true))).toBe('weakening');
    expect(classifyDirection(event('spf.exceedsLookupLimit', true, false))).toBe('strengthening');
  });

  it('reads an alignment or provider change as neutral', () => {
    expect(classifyDirection(event('mx.provider', 'google', 'microsoft'))).toBe('neutral');
    expect(classifyDirection(event('dmarc.adkim', 'r', 's'))).toBe('neutral');
  });

  it('reads an unchanged policy value as neutral', () => {
    expect(classifyDirection(event('dmarc.p', 'reject', 'reject'))).toBe('neutral');
  });

  it('reads a null-to-null policy transition as neutral', () => {
    expect(classifyDirection(event('dmarc.p', null, null))).toBe('neutral');
  });
});
