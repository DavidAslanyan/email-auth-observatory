import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { paths, resetRootCache } from '../src/paths.js';
import { loadSnapshotMap, readSnapshot, writeSnapshot } from '../src/snapshot.js';
import { snapshot } from './helpers.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'observatory-snap-'));
  process.env.MAILSCAPE_ROOT = dir;
  resetRootCache();
});

afterEach(async () => {
  delete process.env.MAILSCAPE_ROOT;
  resetRootCache();
  await rm(dir, { recursive: true, force: true });
});

describe('writeSnapshot', () => {
  it('sorts by domain, which is what makes git delta compression work', async () => {
    // An unsorted file produces a whole-file diff on every run and the
    // repository balloons.
    await writeSnapshot('tier1', [
      snapshot({ domain: 'zulu.example' }),
      snapshot({ domain: 'alpha.example' }),
      snapshot({ domain: 'mike.example' }),
    ]);

    const written = await readFile(paths.snapshot('tier1'), 'utf8');
    const domains = written
      .trim()
      .split('\n')
      .map((l) => (JSON.parse(l) as { domain: string }).domain);
    expect(domains).toEqual(['alpha.example', 'mike.example', 'zulu.example']);
  });

  it('returns how many records it wrote', async () => {
    const count = await writeSnapshot('tier1', [
      snapshot({ domain: 'a.example' }),
      snapshot({ domain: 'b.example' }),
    ]);
    expect(count).toBe(2);
  });

  it('does not mutate the caller’s array while sorting', async () => {
    const input = [snapshot({ domain: 'z.example' }), snapshot({ domain: 'a.example' })];
    await writeSnapshot('tier1', input);
    expect(input[0]?.domain).toBe('z.example');
  });

  it('writes an empty shard without failing', async () => {
    expect(await writeSnapshot('tier2-shard-0', [])).toBe(0);
  });

  it('replaces a previous shard rather than appending to it', async () => {
    await writeSnapshot('tier1', [snapshot({ domain: 'old.example' })]);
    await writeSnapshot('tier1', [snapshot({ domain: 'new.example' })]);
    const map = await loadSnapshotMap('tier1');
    expect([...map.keys()]).toEqual(['new.example']);
  });
});

describe('readSnapshot', () => {
  it('round-trips a written shard', async () => {
    await writeSnapshot('tier1', [
      snapshot({ domain: 'a.example', dmarc: { present: true, p: 'reject' } }),
    ]);

    const read = [];
    for await (const s of readSnapshot('tier1')) read.push(s);

    expect(read).toHaveLength(1);
    expect(read[0]?.domain).toBe('a.example');
    expect(read[0]?.dmarc.p).toBe('reject');
  });

  it('yields nothing for a shard that was never written', async () => {
    const read = [];
    for await (const s of readSnapshot('tier2-shard-4')) read.push(s);
    expect(read).toEqual([]);
  });

  it('skips a line that does not match the schema and keeps the rest', async () => {
    const { writeJsonl } = await import('../src/jsonl.js');
    await writeJsonl(paths.snapshot('tier1'), [
      snapshot({ domain: 'good.example' }),
      { domain: 'broken.example', rank: 'not a number' },
    ]);

    const invalid: string[] = [];
    const read = [];
    for await (const s of readSnapshot('tier1', { onInvalid: (l) => invalid.push(l) })) {
      read.push(s);
    }

    expect(read.map((s) => s.domain)).toEqual(['good.example']);
    expect(invalid).toHaveLength(1);
  });
});

describe('loadSnapshotMap', () => {
  it('keys a shard by domain for diffing', async () => {
    await writeSnapshot('tier1', [
      snapshot({ domain: 'a.example' }),
      snapshot({ domain: 'b.example' }),
    ]);
    const map = await loadSnapshotMap('tier1');
    expect(map.size).toBe(2);
    expect(map.get('a.example')?.domain).toBe('a.example');
  });

  it('returns an empty map when the shard does not exist', async () => {
    expect((await loadSnapshotMap('tier2-shard-6')).size).toBe(0);
  });
});

describe('snapshot encoding: the run timestamp lives in a sidecar', () => {
  it('produces a byte-identical file when nothing changed', async () => {
    // The property the whole encoding exists for. With a per-record timestamp
    // this diff was 100% of lines on every crawl.
    const domains = ['a.example', 'b.example', 'c.example'];
    const first = domains.map((domain) =>
      snapshot({ domain, crawledAt: '2026-08-29T06:00:00.000Z' }),
    );
    await writeSnapshot('tier1', first, '2026-08-29T06:00:00.000Z');
    const afterFirst = await readFile(paths.snapshot('tier1'), 'utf8');

    // Same data, a later crawl.
    const second = domains.map((domain) =>
      snapshot({ domain, crawledAt: '2026-08-29T12:00:00.000Z' }),
    );
    await writeSnapshot('tier1', second, '2026-08-29T12:00:00.000Z');
    const afterSecond = await readFile(paths.snapshot('tier1'), 'utf8');

    expect(afterSecond).toBe(afterFirst);
  });

  it('changes only the line whose data actually changed', async () => {
    const base = ['a.example', 'b.example', 'c.example'].map((domain) => snapshot({ domain }));
    await writeSnapshot('tier1', base, '2026-08-29T06:00:00.000Z');
    const before = (await readFile(paths.snapshot('tier1'), 'utf8')).trim().split('\n');

    const changed = base.map((s) =>
      s.domain === 'b.example'
        ? snapshot({ domain: 'b.example', dmarc: { present: true, p: 'reject' } })
        : s,
    );
    await writeSnapshot('tier1', changed, '2026-08-29T12:00:00.000Z');
    const after = (await readFile(paths.snapshot('tier1'), 'utf8')).trim().split('\n');

    const differing = after.filter((line, i) => line !== before[i]);
    expect(differing).toHaveLength(1);
  });

  it('omits crawledAt from the stored line', async () => {
    await writeSnapshot('tier1', [snapshot({ domain: 'a.example' })], '2026-08-29T06:00:00.000Z');
    const line = JSON.parse((await readFile(paths.snapshot('tier1'), 'utf8')).trim()) as Record<
      string,
      unknown
    >;
    expect('crawledAt' in line).toBe(false);
  });

  it('puts crawledAt back on every record when reading', async () => {
    await writeSnapshot('tier1', [snapshot({ domain: 'a.example' })], '2026-08-29T06:00:00.000Z');
    const read = [];
    for await (const s of readSnapshot('tier1')) read.push(s);
    expect(read[0]?.crawledAt).toBe('2026-08-29T06:00:00.000Z');
  });

  it('writes a sidecar naming the shard, timestamp and record count', async () => {
    await writeSnapshot(
      'tier2-shard-3',
      [snapshot({ domain: 'a.example' })],
      '2026-08-29T06:00:00.000Z',
    );
    const meta = JSON.parse(await readFile(paths.snapshotMeta('tier2-shard-3'), 'utf8')) as Record<
      string,
      unknown
    >;
    expect(meta).toMatchObject({
      shard: 'tier2-shard-3',
      crawledAt: '2026-08-29T06:00:00.000Z',
      domains: 1,
    });
    // The run-uniform values hoisted out of every record live here too.
    expect(meta.listId).toBe('TESTLIST');
    expect(meta.resolver).toBe('local');
  });

  it('still reads a shard whose sidecar is missing', async () => {
    // Shards written before this encoding existed carry crawledAt per record.
    const { writeJsonl } = await import('../src/jsonl.js');
    await writeJsonl(paths.snapshot('tier1'), [snapshot({ domain: 'a.example' })]);
    const read = [];
    for await (const s of readSnapshot('tier1')) read.push(s);
    expect(read[0]?.crawledAt).toBe('2026-08-29T00:00:00.000Z');
  });
});

describe('snapshot encoding: run-uniform values are hoisted', () => {
  it('omits listId, resolver, rcode and ad from a healthy record', async () => {
    await writeSnapshot('tier1', [snapshot({ domain: 'a.example' })], '2026-08-29T06:00:00.000Z');
    const line = JSON.parse((await readFile(paths.snapshot('tier1'), 'utf8')).trim()) as {
      listId?: string;
      spf: Record<string, unknown>;
    };
    expect(line.listId).toBeUndefined();
    expect('resolver' in line.spf).toBe(false);
    expect('rcode' in line.spf).toBe(false);
    expect('ad' in line.spf).toBe(false);
  });

  it('restores every hoisted value on read', async () => {
    await writeSnapshot('tier1', [snapshot({ domain: 'a.example' })], '2026-08-29T06:00:00.000Z');
    const read = [];
    for await (const s of readSnapshot('tier1')) read.push(s);
    const got = read[0];
    expect(got?.listId).toBe('TESTLIST');
    expect(got?.spf.resolver).toBe('local');
    expect(got?.spf.rcode).toBe('NOERROR');
    expect(got?.spf.ad).toBe(false);
  });

  it('keeps an rcode that carries information beyond the status', async () => {
    // SERVFAIL is exactly what must survive: it is why the value is unknown.
    await writeSnapshot(
      'tier1',
      [snapshot({ domain: 'a.example', dmarc: { status: 'unknown', rcode: 'SERVFAIL' } })],
      '2026-08-29T06:00:00.000Z',
    );
    const raw = (await readFile(paths.snapshot('tier1'), 'utf8')).trim();
    expect(raw).toContain('SERVFAIL');

    const read = [];
    for await (const s of readSnapshot('tier1')) read.push(s);
    expect(read[0]?.dmarc.rcode).toBe('SERVFAIL');
    expect(read[0]?.dmarc.status).toBe('unknown');
  });

  it('keeps a resolver that differs from the run default', async () => {
    const odd = snapshot({ domain: 'a.example', mx: { resolver: 'doh-google' } });
    const usual = snapshot({ domain: 'b.example' });
    await writeSnapshot('tier1', [odd, usual], '2026-08-29T06:00:00.000Z');

    const map = await loadSnapshotMap('tier1');
    expect(map.get('a.example')?.mx.resolver).toBe('doh-google');
    expect(map.get('b.example')?.mx.resolver).toBe('local');
  });

  it('keeps a true DNSSEC ad flag', async () => {
    await writeSnapshot(
      'tier1',
      [snapshot({ domain: 'a.example', dmarc: { ad: true } })],
      '2026-08-29T06:00:00.000Z',
    );
    const map = await loadSnapshotMap('tier1');
    expect(map.get('a.example')?.dmarc.ad).toBe(true);
  });
});
