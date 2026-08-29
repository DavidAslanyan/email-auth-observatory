import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, sep } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SHARD_NAMES, paths, resetRootCache, root } from '../src/paths.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mailscape-paths-'));
  process.env.MAILSCAPE_ROOT = dir;
  resetRootCache();
});

afterEach(async () => {
  delete process.env.MAILSCAPE_ROOT;
  resetRootCache();
  await rm(dir, { recursive: true, force: true });
});

describe('root', () => {
  it('honours MAILSCAPE_ROOT, which is how tests avoid the real dataset', () => {
    expect(root()).toBe(dir);
  });

  it('falls back to discovery when the override is empty', () => {
    process.env.MAILSCAPE_ROOT = '';
    resetRootCache();
    // The repository root is found by walking up to pnpm-workspace.yaml.
    expect(isAbsolute(root())).toBe(true);
  });
});

describe('paths', () => {
  // Built lazily: MAILSCAPE_ROOT is set per test, so evaluating these at module
  // scope would resolve them against the real repository instead.
  const built = (): [string, string][] => [
    [paths.trancoDir(), join('data', 'tranco')],
    [paths.trancoListId(), join('data', 'tranco', 'list-id.txt')],
    [paths.trancoDomains(), join('data', 'tranco', 'domains.csv.gz')],
    [paths.trancoRollovers(), join('data', 'tranco', 'rollovers.jsonl')],
    [paths.snapshotDir(), join('data', 'snapshots', 'latest')],
    [paths.snapshot('tier1'), join('data', 'snapshots', 'latest', 'tier1.jsonl')],
    [paths.changesDir(), join('data', 'changes')],
    [paths.changes('2026-08-29'), join('data', 'changes', '2026-08-29.jsonl')],
    [paths.aggregateDir(), join('data', 'aggregates')],
    [paths.aggregateLatest(), join('data', 'aggregates', 'latest.json')],
    [paths.aggregateHistory(), join('data', 'aggregates', 'history.jsonl')],
    [paths.reportsDir(), 'reports'],
    [paths.report('2026-08-29'), join('reports', '2026-08-29.md')],
    [paths.tmpDir(), join('data', 'tmp')],
    [paths.checkpoint('tier1'), join('data', 'tmp', 'checkpoint-tier1.json')],
  ];

  it('builds every path with the expected layout', () => {
    for (const [actual, expectedSuffix] of built()) {
      expect(actual.endsWith(expectedSuffix)).toBe(true);
    }
  });

  it('returns absolute paths, so the CLI works from any directory', () => {
    for (const [actual] of built()) expect(isAbsolute(actual)).toBe(true);
  });

  it('keeps every path inside the root', () => {
    for (const [actual] of built()) expect(actual.startsWith(dir + sep)).toBe(true);
  });

  it('exposes root through the paths object too', () => {
    expect(paths.root()).toBe(dir);
  });

  it('puts checkpoints under data/tmp, which is gitignored', () => {
    expect(paths.checkpoint('tier2-shard-3')).toContain(join('data', 'tmp'));
  });
});

describe('SHARD_NAMES', () => {
  it('names the tier 1 shard', () => {
    expect(SHARD_NAMES.tier1).toBe('tier1');
  });

  it('names tier 2 shards by index', () => {
    expect(SHARD_NAMES.tier2(0)).toBe('tier2-shard-0');
    expect(SHARD_NAMES.tier2(6)).toBe('tier2-shard-6');
  });
});
