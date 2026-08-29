import { describe, expect, it } from 'vitest';
// The schedule lives in a plain script so the workflows can run it with no
// build step; it is imported here directly.
import { isQuietDay, isoWeek } from '../../../scripts/quiet-day.mjs';

const day = (y: number, m: number, d: number): Date => new Date(Date.UTC(y, m - 1, d));

describe('isoWeek', () => {
  it('numbers weeks the ISO way', () => {
    // 2026-01-01 is a Thursday, so it belongs to week 1 of 2026.
    expect(isoWeek(day(2026, 1, 1))).toEqual({ isoYear: 2026, week: 1 });
  });

  it('assigns a late-December date to the following ISO year when it belongs there', () => {
    const r = isoWeek(day(2025, 12, 31));
    expect(r.isoYear).toBe(2026);
    expect(r.week).toBe(1);
  });

  it('gives every day of one week the same number', () => {
    const weeks = new Set<string>();
    for (let d = 5; d <= 11; d++) {
      const r = isoWeek(day(2026, 1, d));
      weeks.add(`${r.isoYear}-${r.week}`);
    }
    expect(weeks.size).toBe(1);
  });
});

describe('isQuietDay', () => {
  it('is deterministic — the same date always gives the same answer', () => {
    const d = day(2026, 9, 15);
    expect(isQuietDay(d)).toBe(isQuietDay(new Date(d)));
  });

  it('never stands down more than one day in a week', () => {
    for (let week = 0; week < 60; week++) {
      const start = day(2026, 1, 5).getTime() + week * 7 * 86_400_000;
      let quiet = 0;
      for (let i = 0; i < 7; i++) {
        if (isQuietDay(new Date(start + i * 86_400_000))) quiet += 1;
      }
      expect(quiet).toBeLessThanOrEqual(1);
    }
  });

  it('leaves some weeks with no rest day at all', () => {
    let fullWeeks = 0;
    for (let week = 0; week < 60; week++) {
      const start = day(2026, 1, 5).getTime() + week * 7 * 86_400_000;
      let quiet = 0;
      for (let i = 0; i < 7; i++) {
        if (isQuietDay(new Date(start + i * 86_400_000))) quiet += 1;
      }
      if (quiet === 0) fullWeeks += 1;
    }
    // Roughly a quarter, by construction.
    expect(fullWeeks).toBeGreaterThan(5);
    expect(fullWeeks).toBeLessThan(30);
  });

  it('moves the rest day around rather than fixing it to one weekday', () => {
    const weekdays = new Set<number>();
    for (let i = 0; i < 400; i++) {
      const d = new Date(day(2026, 1, 5).getTime() + i * 86_400_000);
      if (isQuietDay(d)) weekdays.add(d.getUTCDay());
    }
    expect(weekdays.size).toBeGreaterThan(3);
  });

  it('keeps the pipeline running on the large majority of days', () => {
    let active = 0;
    for (let i = 0; i < 365; i++) {
      if (!isQuietDay(new Date(day(2026, 1, 1).getTime() + i * 86_400_000))) active += 1;
    }
    // Around one rest day a week at most, so well over 300 active days.
    expect(active).toBeGreaterThan(300);
  });
});
