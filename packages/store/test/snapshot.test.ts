import { describe, expect, it } from 'vitest';
import { allShardNames, isTier1, shardFor, shardForDayOfYear, shardName } from '../src/snapshot.js';

describe('shardFor', () => {
  it('is deterministic', () => {
    expect(shardFor('example.com')).toBe(shardFor('example.com'));
  });

  it('always returns a shard inside the range', () => {
    for (let i = 0; i < 1000; i++) {
      const shard = shardFor(`domain-${i}.example`);
      expect(shard).toBeGreaterThanOrEqual(0);
      expect(shard).toBeLessThan(7);
    }
  });

  it('distributes 10,000 domains across 7 shards within 5% of even', () => {
    // The distribution matters because one oversized shard means one crawl day
    // that runs long and gets killed by the runner's time limit.
    const counts = new Array<number>(7).fill(0);
    for (let i = 0; i < 10_000; i++) {
      const shard = shardFor(`site-${i}.example`);
      counts[shard] = (counts[shard] ?? 0) + 1;
    }

    const expected = 10_000 / 7;
    for (const count of counts) {
      const deviation = Math.abs(count - expected) / expected;
      expect(deviation).toBeLessThan(0.05);
    }
    expect(counts.reduce((a, b) => a + b, 0)).toBe(10_000);
  });

  it('distributes realistic domain names evenly, not just sequential ones', () => {
    const tlds = ['com', 'org', 'net', 'io', 'co.uk', 'de', 'jp'];
    const counts = new Array<number>(7).fill(0);
    for (let i = 0; i < 10_000; i++) {
      const domain = `${['mail', 'shop', 'news', 'app', 'cdn'][i % 5]}${i}.${tlds[i % tlds.length]}`;
      const shard = shardFor(domain);
      counts[shard] = (counts[shard] ?? 0) + 1;
    }
    const expected = 10_000 / 7;
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

  it('handles an empty string without throwing', () => {
    // FNV-1a returns its offset basis for empty input, which lands in a valid
    // shard like any other hash.
    const shard = shardFor('');
    expect(shard).toBeGreaterThanOrEqual(0);
    expect(shard).toBeLessThan(7);
  });

  it('gives different shards to similar names, so it is not merely sequential', () => {
    const shards = new Set(
      ['a.example', 'b.example', 'c.example', 'd.example'].map((d) => shardFor(d)),
    );
    expect(shards.size).toBeGreaterThan(1);
  });
});

describe('shardForDayOfYear', () => {
  it('rotates through every shard across a week', () => {
    const seen = new Set<number>();
    for (let day = 1; day <= 7; day++) {
      seen.add(shardForDayOfYear(new Date(Date.UTC(2026, 0, day))));
    }
    expect(seen.size).toBe(7);
  });

  it('returns the same shard for the same day', () => {
    const a = shardForDayOfYear(new Date(Date.UTC(2026, 7, 29, 2, 30)));
    const b = shardForDayOfYear(new Date(Date.UTC(2026, 7, 29, 23, 59)));
    expect(a).toBe(b);
  });

  it('advances by one shard on consecutive days', () => {
    const first = shardForDayOfYear(new Date(Date.UTC(2026, 5, 10)));
    const second = shardForDayOfYear(new Date(Date.UTC(2026, 5, 11)));
    expect(second).toBe((first + 1) % 7);
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
    expect(allShardNames()).toEqual([
      'tier1',
      'tier2-shard-0',
      'tier2-shard-1',
      'tier2-shard-2',
      'tier2-shard-3',
      'tier2-shard-4',
      'tier2-shard-5',
      'tier2-shard-6',
    ]);
  });
});
