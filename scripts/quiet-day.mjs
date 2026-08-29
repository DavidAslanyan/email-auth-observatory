#!/usr/bin/env node
/**
 * Decides whether today is a scheduled rest day for the data pipeline.
 *
 * The crawls do not need to run 365 days a year. The long tail is on a
 * fortnightly rotation and the top 1,000 move slowly, so standing down roughly
 * one day a week costs no meaningful coverage and takes another slice off the
 * query volume we send to a free public resolver.
 *
 * The choice is deterministic — derived from the ISO week, not from a random
 * number — so any run can be reproduced and explained after the fact. Roughly
 * one week in four has no rest day at all, and when there is one it moves
 * around the week rather than always falling on the same day.
 *
 * Prints "quiet" or "active" and exits 0 either way; callers read stdout.
 * MAILSCAPE_NO_QUIET_DAYS=1 disables it entirely.
 */

/** FNV-1a, so the schedule is stable and reproducible from the date alone. */
function hash(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

/** ISO-8601 week number, so the schedule aligns to calendar weeks. */
export function isoWeek(date) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  // Thursday determines the ISO year a week belongs to.
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
  return { isoYear: d.getUTCFullYear(), week };
}

export function isQuietDay(date) {
  const { isoYear, week } = isoWeek(date);
  const h = hash(`observatory:${isoYear}:${week}`);

  // One week in four runs straight through with no rest day.
  if (h % 4 === 0) return false;

  // Otherwise one weekday stands down, and which one moves week to week.
  const restDay = h % 7; // 0 = Sunday, matching getUTCDay()
  return date.getUTCDay() === restDay;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const disabled = process.env.MAILSCAPE_NO_QUIET_DAYS === '1';
  const when = process.argv[2] ? new Date(process.argv[2]) : new Date();
  process.stdout.write(!disabled && isQuietDay(when) ? 'quiet' : 'active');
}
