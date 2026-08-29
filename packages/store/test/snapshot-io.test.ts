import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { paths, resetRootCache } from '../src/paths.js';
import { loadSnapshotMap, readSnapshot, writeSnapshot } from '../src/snapshot.js';
import { snapshot } from './helpers.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mailscape-snap-'));
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
