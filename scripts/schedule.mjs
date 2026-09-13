#!/usr/bin/env node
/**
 * The pipeline's daily plan.
 *
 * The crawls do not need to run at a constant rate. The long tail is a
 * round-robin over 28 shards, so covering six shards one day and none the next
 * reaches every domain just as surely as two a day does — it only changes how
 * the work is spread. Varying it deliberately keeps the load on a free public
 * resolver lumpy rather than constant, gives the rotation room to catch up
 * after a quiet stretch, and means the repository's activity reflects the work
 * actually done rather than a fixed heartbeat.
 *
 * Every decision here is derived from the date, not from a random number, so
 * any past or future day can be replayed and explained exactly.
 *
 * Run it directly to inspect a day:
 *   node scripts/schedule.mjs 2026-09-20
 *   node scripts/schedule.mjs --calendar 2026-09-01 56   (preview N days)
 */

/** FNV-1a. Stable across platforms and Node versions. */
function hash(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

const utcDay = (date) => Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());

const isoDate = (date) => new Date(utcDay(date)).toISOString().slice(0, 10);

/** ISO-8601 week, so rest days are chosen per calendar week. */
export function isoWeek(date) {
  const d = new Date(utcDay(date));
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return { isoYear: d.getUTCFullYear(), week: Math.ceil(((d - yearStart) / 86400000 + 1) / 7) };
}

/**
 * Which weekdays this ISO week stands down. One to three, varying by week.
 * Picked per week rather than per day so a week never accidentally rests on
 * every day, and so the gaps land in different places from week to week.
 */
export function restDaysOfWeek(date) {
  const { isoYear, week } = isoWeek(date);
  const seed = hash(`rest:${isoYear}:${week}`);
  const count = 1 + (seed % 3); // 1, 2 or 3

  const days = [];
  for (let i = 0; i < count; i++) {
    // Re-hash per slot so the chosen days are independent of each other.
    let day = hash(`rest:${isoYear}:${week}:${i}`) % 7;
    while (days.includes(day)) day = (day + 1) % 7;
    days.push(day);
  }
  return days.sort((a, b) => a - b);
}

export const isRestDay = (date) => restDaysOfWeek(date).includes(date.getUTCDay());

/**
 * How much work an active day does.
 *
 * Weighted so most days are ordinary, a few are very light, and a few are
 * genuinely busy — the shape real project activity has, rather than a flat line.
 * `tier1` and `tier2` are counts of crawl slots; each crawl that finds a change
 * also produces an aggregate.
 */
const INTENSITIES = [
  { name: 'minimal', tier1: 0, tier2: 0, report: true, weight: 3 },
  { name: 'trickle', tier1: 1, tier2: 0, report: false, weight: 3 },
  { name: 'light', tier1: 0, tier2: 1, report: true, weight: 4 },
  { name: 'easy', tier1: 1, tier2: 1, report: false, weight: 4 },
  { name: 'steady', tier1: 1, tier2: 2, report: true, weight: 5 },
  { name: 'normal', tier1: 2, tier2: 2, report: true, weight: 5 },
  { name: 'brisk', tier1: 2, tier2: 4, report: true, weight: 4 },
  { name: 'busy', tier1: 2, tier2: 5, report: true, weight: 3 },
  { name: 'heavy', tier1: 3, tier2: 7, report: true, weight: 2 },
  { name: 'peak', tier1: 3, tier2: 8, report: true, weight: 1 },
];

const TOTAL_WEIGHT = INTENSITIES.reduce((sum, i) => sum + i.weight, 0);

export function planFor(date) {
  if (isRestDay(date)) {
    return { date: isoDate(date), intensity: 'rest', tier1: [], tier2: [], report: false };
  }

  let pick = hash(`intensity:${isoDate(date)}`) % TOTAL_WEIGHT;
  let chosen = INTENSITIES[INTENSITIES.length - 1];
  for (const candidate of INTENSITIES) {
    if (pick < candidate.weight) {
      chosen = candidate;
      break;
    }
    pick -= candidate.weight;
  }

  return {
    date: isoDate(date),
    intensity: chosen.name,
    tier1: spread(date, 'tier1', chosen.tier1, TIER1_SLOTS),
    tier2: spread(date, 'tier2', chosen.tier2, TIER2_SLOTS),
    report: chosen.report,
  };
}

export const TIER1_SLOTS = 3;
export const TIER2_SLOTS = 8;

/** Chooses `count` distinct slots out of `total`, spread across the day. */
function spread(date, kind, count, total) {
  if (count <= 0) return [];
  if (count >= total) return Array.from({ length: total }, (_, i) => i);

  const chosen = [];
  for (let i = 0; i < count; i++) {
    let slot = hash(`${kind}:${isoDate(date)}:${i}`) % total;
    while (chosen.includes(slot)) slot = (slot + 1) % total;
    chosen.push(slot);
  }
  return chosen.sort((a, b) => a - b);
}

/**
 * The day this schedule began. Shard selection counts crawls forward from here,
 * so the long-tail rotation stays strict round-robin no matter how the daily
 * intensity varies — a busy day simply advances the cursor further.
 */
const EPOCH = Date.UTC(2026, 8, 14);

/**
 * Which long-tail shard a given tier-2 slot crawls.
 *
 * Derived by replaying the plan rather than from the calendar, because the
 * number of crawls per day is no longer fixed: keying off the date would make
 * shards that happen to land on light days wait weeks for another turn.
 */
export function tier2ShardFor(date, slot, shards = 28) {
  let cursor = 0;
  for (let t = EPOCH; t < utcDay(date); t += 86400000) {
    cursor += planFor(new Date(t)).tier2.length;
  }
  cursor += planFor(date).tier2.filter((s) => s < slot).length;
  return cursor % shards;
}

export const shouldRun = (date, kind, slot) => {
  const plan = planFor(date);
  if (kind === 'report') return plan.report;
  return (kind === 'tier1' ? plan.tier1 : plan.tier2).includes(slot);
};

/**
 * Commits a day is expected to produce: each crawl that finds a change also
 * produces an aggregate, and the report is one more. Used only for previewing
 * the schedule.
 */
export const expectedCommits = (date) => {
  const p = planFor(date);
  return (p.tier1.length + p.tier2.length) * 2 + (p.report ? 1 : 0);
};

if (import.meta.url === `file://${process.argv[1]}`) {
  const [command, ...rest] = process.argv.slice(2);

  // A tiny CLI so the workflow can ask a question without inline node -e, which
  // is fragile about flag order and quoting inside YAML.
  if (command === '--should-run') {
    const [kind, slot = '0'] = rest;
    process.stdout.write(shouldRun(new Date(), kind, Number(slot)) ? 'true' : 'false');
  } else if (command === '--shard') {
    process.stdout.write(String(tier2ShardFor(new Date(), Number(rest[0] ?? 0))));
  } else if (command === '--calendar') {
    const start = new Date(`${rest[0] ?? isoDate(new Date())}T00:00:00Z`);
    const days = Number(rest[1] ?? 56);
    for (let i = 0; i < days; i++) {
      const d = new Date(start.getTime() + i * 86400000);
      const plan = planFor(d);
      const n = expectedCommits(d);
      process.stdout.write(
        `${plan.date}  ${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getUTCDay()]}  ` +
          `${String(n).padStart(2)}  ${'█'.repeat(n) || '·'}  ${plan.intensity}\n`,
      );
    }
  } else {
    const when = command ? new Date(`${command}T00:00:00Z`) : new Date();
    process.stdout.write(`${JSON.stringify(planFor(when))}\n`);
  }
}
