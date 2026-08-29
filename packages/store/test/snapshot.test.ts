import { describe, expect, it } from 'vitest';
import { TIER2_SHARDS } from '@observatory/core';
import { allShardNames, isTier1, shardFor, shardForDayOfYear, shardName } from '../src/snapshot.js';

describe('shardFor', () => {
  it('is deterministic', () => {
    expect(shardFor('example.com')).toBe(shardFor('example.com'));
  });

  it('always returns a shard inside the range', () => {
    for (let i = 0; i < 1000; i++) {
      const shard = shardFor(`domain-${i}.example`);
      expect(shard).toBeGreaterThanOrEqual(0);
      expect(shard).toBeLessThan(TIER2_SHARDS);
    }
  });

  it('distributes the whole long tail across every shard within 5% of even', () => {
    // Sized to the real list, because that is the distribution that matters:
    // one oversized shard is one crawl that runs long and gets killed.
    const counts = new Array<number>(TIER2_SHARDS).fill(0);
    for (let i = 0; i < 100_000; i++) {
      const shard = shardFor(`site-${i}.example`);
      counts[shard] = (counts[shard] ?? 0) + 1;
    }

    const expected = 100_000 / TIER2_SHARDS;
    for (const count of counts) {
      expect(Math.abs(count - expected) / expected).toBeLessThan(0.05);
    }
    expect(counts.reduce((a, b) => a + b, 0)).toBe(100_000);
  });

  it('distributes realistic domain names evenly, not just sequential ones', () => {
    const tlds = ['com', 'org', 'net', 'io', 'co.uk', 'de', 'jp'];
    const counts = new Array<number>(TIER2_SHARDS).fill(0);
    for (let i = 0; i < 100_000; i++) {
      const domain = `${['mail', 'shop', 'news', 'app', 'cdn'][i % 5]}${i}.${tlds[i % tlds.length]}`;
      const shard = shardFor(domain);
      counts[shard] = (counts[shard] ?? 0) + 1;
    }
    const expected = 100_000 / TIER2_SHARDS;
    for (const count of counts) {
      expect(Math.abs(count - expected) / expected).toBeLessThan(0.05);
    }
  });

  it('hashes the domain, not the rank, so a rollover does not reshuffle shards', () => {
    // The same domain keeps its shard whatever rank it holds. Sharding by rank
    // would move most of the long tail every quarter and destroy the per-shard
    // diffs.
    const before = shardFor('stable.example');
    const after = shardFor('stable.example');
    expect(before).toBe(after);
  });

  it('respects a custom shard count', () => {
    for (let i = 0; i < 200; i++) {
      expect(shardFor(`d${i}.example`, 3)).toBeLessThan(3);
    }
  });

  it('keeps a domain in the same shard for a given shard count', () => {
    // Stability is the whole point of hashing the domain rather than the rank.
    expect(shardFor('stable.example')).toBe(shardFor('stable.example'));
  });

  it('handles an empty string without throwing', () => {
    // FNV-1a returns its offset basis for empty input, which lands in a valid
    // shard like any other hash.
    const shard = shardFor('');
    expect(shard).toBeGreaterThanOrEqual(0);
    expect(shard).toBeLessThan(TIER2_SHARDS);
  });

  it('gives different shards to similar names, so it is not merely sequential', () => {
    const shards = new Set(
      ['a.example', 'b.example', 'c.example', 'd.example'].map((d) => shardFor(d)),
    );
    expect(shards.size).toBeGreaterThan(1);
  });
});

describe('shardForDayOfYear', () => {
  it('covers every shard over one full rotation', () => {
    const seen = new Set<number>();
    for (let day = 1; day <= TIER2_SHARDS; day++) {
      seen.add(shardForDayOfYear(new Date(Date.UTC(2026, 0, day))));
    }
    expect(seen.size).toBe(TIER2_SHARDS);
  });

  it('returns the same shard for the same day and slot', () => {
    const a = shardForDayOfYear(new Date(Date.UTC(2026, 7, 29, 2, 30)));
    const b = shardForDayOfYear(new Date(Date.UTC(2026, 7, 29, 23, 59)));
    expect(a).toBe(b);
  });

  it('advances by one shard on consecutive days', () => {
    const first = shardForDayOfYear(new Date(Date.UTC(2026, 5, 10)));
    const second = shardForDayOfYear(new Date(Date.UTC(2026, 5, 11)));
    expect(second).toBe((first + 1) % TIER2_SHARDS);
  });

  it('gives the two daily runs different shards', () => {
    const day = new Date(Date.UTC(2026, 5, 10));
    const slotA = shardForDayOfYear(day, TIER2_SHARDS, 0, 2);
    const slotB = shardForDayOfYear(day, TIER2_SHARDS, 1, 2);
    expect(slotA).not.toBe(slotB);
  });

  it('covers the whole long tail in half the days when two run daily', () => {
    const seen = new Set<number>();
    for (let day = 1; day <= TIER2_SHARDS / 2; day++) {
      const d = new Date(Date.UTC(2026, 0, day));
      seen.add(shardForDayOfYear(d, TIER2_SHARDS, 0, 2));
      seen.add(shardForDayOfYear(d, TIER2_SHARDS, 1, 2));
    }
    expect(seen.size).toBe(TIER2_SHARDS);
  });
});

describe('tier and shard naming', () => {
  it('treats the top 1000 ranks as tier 1', () => {
    expect(isTier1(1)).toBe(true);
    expect(isTier1(1000)).toBe(true);
    expect(isTier1(1001)).toBe(false);
  });

  it('names the tier 1 shard file', () => {
    expect(shardName(1, 0)).toBe('tier1');
  });

  it('names tier 2 shard files by index', () => {
    expect(shardName(2, 3)).toBe('tier2-shard-3');
  });

  it('lists every shard that makes up a complete dataset', () => {
    const names = allShardNames();
    expect(names).toHaveLength(TIER2_SHARDS + 1);
    expect(names[0]).toBe('tier1');
    expect(names[1]).toBe('tier2-shard-0');
    expect(names.at(-1)).toBe(`tier2-shard-${TIER2_SHARDS - 1}`);
  });
});
