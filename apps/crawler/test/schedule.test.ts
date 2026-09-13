import { describe, expect, it } from 'vitest';
import {
  expectedCommits,
  isRestDay,
  isoWeek,
  planFor,
  restDaysOfWeek,
  shouldRun,
  tier2ShardFor,
  TIER2_SLOTS,
} from '../../../scripts/schedule.mjs';

const day = (y: number, m: number, d: number): Date => new Date(Date.UTC(y, m - 1, d));
const range = (start: Date, n: number): Date[] =>
  Array.from({ length: n }, (_, i) => new Date(start.getTime() + i * 86_400_000));

describe('isoWeek', () => {
  it('numbers weeks the ISO way', () => {
    expect(isoWeek(day(2026, 1, 1))).toEqual({ isoYear: 2026, week: 1 });
  });

  it('gives every day of one week the same number', () => {
    const weeks = new Set(
      range(day(2026, 1, 5), 7).map((d) => `${isoWeek(d).isoYear}-${isoWeek(d).week}`),
    );
    expect(weeks.size).toBe(1);
  });
});

describe('rest days', () => {
  it('stands down between one and three days every week', () => {
    for (const d of range(day(2026, 1, 5), 365)) {
      const count = restDaysOfWeek(d).length;
      expect(count).toBeGreaterThanOrEqual(1);
      expect(count).toBeLessThanOrEqual(3);
    }
  });

  it('never rests every day of a week', () => {
    for (const d of range(day(2026, 1, 5), 365)) {
      expect(restDaysOfWeek(d).length).toBeLessThan(7);
    }
  });

  it('agrees with the week it belongs to', () => {
    for (const d of range(day(2026, 3, 1), 90)) {
      expect(isRestDay(d)).toBe(restDaysOfWeek(d).includes(d.getUTCDay()));
    }
  });

  it('moves the rest days around rather than fixing them to one weekday', () => {
    const weekdays = new Set(
      range(day(2026, 1, 5), 365)
        .filter(isRestDay)
        .map((d) => d.getUTCDay()),
    );
    expect(weekdays.size).toBe(7);
  });

  it('plans no work at all on a rest day', () => {
    const rest = range(day(2026, 1, 5), 365).filter(isRestDay);
    expect(rest.length).toBeGreaterThan(40);
    for (const d of rest) {
      const plan = planFor(d);
      expect(plan.tier1).toEqual([]);
      expect(plan.tier2).toEqual([]);
      expect(plan.report).toBe(false);
      expect(expectedCommits(d)).toBe(0);
    }
  });
});

describe('daily intensity', () => {
  it('is deterministic — the same date always plans the same day', () => {
    const a = planFor(day(2026, 6, 15));
    const b = planFor(new Date(Date.UTC(2026, 5, 15, 23, 59)));
    expect(a).toEqual(b);
  });

  it('produces a wide spread of daily commit counts, not one number', () => {
    const counts = new Set(range(day(2026, 1, 5), 365).map(expectedCommits));
    // The failure this replaces: 13 of 16 days produced exactly 9 commits.
    expect(counts.size).toBeGreaterThanOrEqual(8);
  });

  it('includes genuinely quiet and genuinely busy days', () => {
    const counts = range(day(2026, 1, 5), 365).map(expectedCommits);
    expect(Math.min(...counts)).toBe(0);
    expect(Math.max(...counts)).toBeGreaterThanOrEqual(20);
    expect(counts.some((c) => c > 0 && c <= 2)).toBe(true);
  });

  it('never plans more slots than exist', () => {
    for (const d of range(day(2026, 1, 5), 365)) {
      const plan = planFor(d);
      expect(plan.tier1.length).toBeLessThanOrEqual(3);
      expect(plan.tier2.length).toBeLessThanOrEqual(TIER2_SLOTS);
      expect(new Set(plan.tier2).size).toBe(plan.tier2.length);
      expect(new Set(plan.tier1).size).toBe(plan.tier1.length);
    }
  });

  it('keeps every planned slot inside its range', () => {
    for (const d of range(day(2026, 1, 5), 120)) {
      for (const s of planFor(d).tier1) expect(s).toBeGreaterThanOrEqual(0);
      for (const s of planFor(d).tier2) {
        expect(s).toBeGreaterThanOrEqual(0);
        expect(s).toBeLessThan(TIER2_SLOTS);
      }
    }
  });
});

describe('shouldRun', () => {
  it('agrees with the plan for every slot', () => {
    for (const d of range(day(2026, 4, 1), 60)) {
      const plan = planFor(d);
      for (let slot = 0; slot < TIER2_SLOTS; slot++) {
        expect(shouldRun(d, 'tier2', slot)).toBe(plan.tier2.includes(slot));
      }
      expect(shouldRun(d, 'report', 0)).toBe(plan.report);
    }
  });

  it('runs nothing on a rest day', () => {
    const rest = range(day(2026, 1, 5), 120).find(isRestDay);
    expect(rest).toBeDefined();
    if (!rest) return;
    for (let slot = 0; slot < TIER2_SLOTS; slot++) {
      expect(shouldRun(rest, 'tier2', slot)).toBe(false);
    }
    expect(shouldRun(rest, 'report', 0)).toBe(false);
  });
});

describe('tier2ShardFor', () => {
  it('reaches every shard despite the varying intensity', () => {
    const seen = new Set<number>();
    for (const d of range(day(2026, 9, 14), 120)) {
      for (const slot of planFor(d).tier2) seen.add(tier2ShardFor(d, slot));
    }
    expect(seen.size).toBe(28);
  });

  it('advances round-robin rather than repeating a shard within a day', () => {
    const busy = range(day(2026, 9, 14), 200).find((d) => planFor(d).tier2.length >= 4);
    expect(busy).toBeDefined();
    if (!busy) return;
    const shards = planFor(busy).tier2.map((slot) => tier2ShardFor(busy, slot));
    expect(new Set(shards).size).toBe(shards.length);
  });

  it('spreads crawls evenly across shards over time', () => {
    const counts = new Map<number, number>();
    for (const d of range(day(2026, 9, 14), 180)) {
      for (const slot of planFor(d).tier2) {
        const shard = tier2ShardFor(d, slot);
        counts.set(shard, (counts.get(shard) ?? 0) + 1);
      }
    }
    const values = [...counts.values()];
    // Strict round-robin, so no shard may lag another by more than one turn.
    expect(Math.max(...values) - Math.min(...values)).toBeLessThanOrEqual(1);
  });

  it('is deterministic', () => {
    const d = day(2026, 10, 8);
    const slot = planFor(d).tier2[0];
    if (slot === undefined) return;
    expect(tier2ShardFor(d, slot)).toBe(tier2ShardFor(new Date(d), slot));
  });
});

describe('long-tail coverage still holds', () => {
  it('completes a full rotation within about three weeks', () => {
    const seen = new Set<number>();
    let days = 0;
    for (const d of range(day(2026, 9, 14), 60)) {
      days += 1;
      for (const slot of planFor(d).tier2) seen.add(tier2ShardFor(d, slot));
      if (seen.size === 28) break;
    }
    expect(seen.size).toBe(28);
    expect(days).toBeLessThanOrEqual(25);
  });
});
