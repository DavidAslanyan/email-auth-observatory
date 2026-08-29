import { describe, expect, it } from 'vitest';
import type { ChangeEvent } from '@observatory/core';
import { diffSnapshots } from '../src/diff.js';
import {
  confirmDisappearances,
  domainsClaimingDisappearance,
  isDisappearance,
} from '../src/verify.js';
import { snapshot } from './helpers.js';

function change(over: Partial<ChangeEvent> = {}): ChangeEvent {
  return {
    domain: 'example.com',
    rank: 1,
    field: 'dmarc.p',
    kind: 'modified',
    from: 'reject',
    to: 'none',
    ts: '2026-08-29T00:00:00.000Z',
    ...over,
  };
}

describe('isDisappearance', () => {
  it('flags a removed tag', () => {
    expect(isDisappearance(change({ kind: 'removed', from: '-', to: null }))).toBe(true);
  });

  it('flags a mechanism going from published to absent', () => {
    expect(isDisappearance(change({ field: 'spf.present', from: true, to: false }))).toBe(true);
  });

  it('does not flag a mechanism being published', () => {
    expect(isDisappearance(change({ field: 'spf.present', from: false, to: true }))).toBe(false);
  });

  it('does not flag a policy weakening that still publishes a value', () => {
    // reject -> none is a real weakening, but nothing disappeared, so a second
    // lookup would tell us nothing new.
    expect(isDisappearance(change({ from: 'reject', to: 'none' }))).toBe(false);
  });

  it('does not flag an added tag', () => {
    expect(isDisappearance(change({ kind: 'added', from: null, to: 'reject' }))).toBe(false);
  });

  it('does not flag a first sighting', () => {
    expect(isDisappearance(change({ kind: 'first_seen', from: null, to: 'x' }))).toBe(false);
  });
});

describe('domainsClaimingDisappearance', () => {
  it('collects the affected domains without duplicates', () => {
    const events = [
      change({ domain: 'a.example', field: 'spf.present', from: true, to: false }),
      change({
        domain: 'a.example',
        kind: 'removed',
        field: 'spf.allQualifier',
        from: '-',
        to: null,
      }),
      change({ domain: 'b.example', from: 'reject', to: 'none' }),
    ];
    expect(domainsClaimingDisappearance(events)).toEqual(['a.example']);
  });

  it('returns nothing when no record disappeared', () => {
    expect(domainsClaimingDisappearance([change()])).toEqual([]);
  });

  it('returns nothing for an empty change set', () => {
    expect(domainsClaimingDisappearance([])).toEqual([]);
  });
});

describe('confirmDisappearances', () => {
  const had = snapshot({
    domain: 'a.example',
    spf: { present: true, allQualifier: '-', recordCount: 1 },
  });
  const lost = snapshot({
    domain: 'a.example',
    crawledAt: '2026-08-30T00:00:00.000Z',
    spf: { present: false, recordCount: 0 },
  });

  it('retracts a disappearance the second lookup contradicts', async () => {
    // The exact failure seen in production: a resolver answered NOERROR with an
    // incomplete answer set, making an untouched SPF record look withdrawn.
    const previous = new Map([['a.example', had]]);
    const diff = diffSnapshots(previous, [lost]);
    expect(diff.events.length).toBeGreaterThan(0);

    const result = await confirmDisappearances(previous, diff, async () =>
      Promise.resolve(
        snapshot({
          domain: 'a.example',
          crawledAt: '2026-08-30T00:00:00.000Z',
          spf: { present: true, allQualifier: '-', recordCount: 1 },
        }),
      ),
    );

    expect(result.events).toEqual([]);
    expect(result.retracted).toBe(diff.events.length);
    expect(result.contradicted).toEqual(['a.example']);
    // The confirmed value is what gets stored, not the incomplete one.
    expect(result.snapshots[0]?.spf.present).toBe(true);
  });

  it('keeps a disappearance the second lookup confirms', async () => {
    const previous = new Map([['a.example', had]]);
    const diff = diffSnapshots(previous, [lost]);

    const result = await confirmDisappearances(previous, diff, async () => Promise.resolve(lost));

    expect(result.events.length).toBe(diff.events.length);
    expect(result.retracted).toBe(0);
    expect(result.contradicted).toEqual([]);
    expect(result.snapshots[0]?.spf.present).toBe(false);
  });

  it('keeps the original result when the confirming lookup itself fails', async () => {
    // A failed confirmation is not evidence. Inventing a second opinion from a
    // failure would be the same mistake in the opposite direction.
    const previous = new Map([['a.example', had]]);
    const diff = diffSnapshots(previous, [lost]);

    const result = await confirmDisappearances(previous, diff, async () =>
      Promise.resolve(undefined),
    );

    expect(result.events.length).toBe(diff.events.length);
    expect(result.retracted).toBe(0);
  });

  it('does not re-probe anything when no record disappeared', async () => {
    const previous = new Map([['a.example', had]]);
    const stronger = snapshot({
      domain: 'a.example',
      crawledAt: '2026-08-30T00:00:00.000Z',
      spf: { present: true, allQualifier: '~', recordCount: 1 },
    });
    const diff = diffSnapshots(previous, [stronger]);

    let probes = 0;
    const result = await confirmDisappearances(previous, diff, async () => {
      probes += 1;
      return Promise.resolve(undefined);
    });

    expect(probes).toBe(0);
    expect(result.events).toEqual(diff.events);
    expect(result.retracted).toBe(0);
  });

  it('leaves other domains in the shard untouched', async () => {
    const other = snapshot({ domain: 'b.example', dmarc: { present: true, p: 'reject' } });
    const previous = new Map([
      ['a.example', had],
      ['b.example', other],
    ]);
    const diff = diffSnapshots(previous, [lost, other]);

    const result = await confirmDisappearances(previous, diff, async () =>
      Promise.resolve(undefined),
    );

    expect(result.snapshots.map((s) => s.domain).sort()).toEqual(['a.example', 'b.example']);
  });
});
