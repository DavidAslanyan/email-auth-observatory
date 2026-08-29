import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DomainSnapshot } from '@observatory/core';
import { paths, resetRootCache } from '@observatory/store';
import {
  checkpointFrom,
  clearCheckpoint,
  emptyCheckpoint,
  readCheckpoint,
  writeCheckpoint,
} from '../src/checkpoint.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'observatory-ckpt-'));
  process.env.MAILSCAPE_ROOT = dir;
  resetRootCache();
});

afterEach(async () => {
  delete process.env.MAILSCAPE_ROOT;
  resetRootCache();
  await rm(dir, { recursive: true, force: true });
});

function snapshot(domain: string): DomainSnapshot {
  const meta = {
    status: 'ok' as const,
    rcode: 'NOERROR',
    resolver: 'local' as const,
    ad: false,
  };
  return {
    domain,
    rank: 1,
    listId: 'LIST1',
    crawledAt: '2026-08-29T00:00:00.000Z',
    dnssec: 'unsigned',
    spf: {
      ...meta,
      present: false,
      multipleRecords: false,
      recordCount: 0,
      hasRedirect: false,
      includes: [],
    },
    dmarc: {
      ...meta,
      present: false,
      multipleRecords: false,
      ruaCount: 0,
      rufCount: 0,
      ruaHosts: [],
    },
    bimi: { ...meta, present: false, hasLogo: false, hasVmc: false, declined: false },
    mtaSts: { ...meta, present: false, policyFetched: false },
    tlsRpt: { ...meta, present: false, ruaCount: 0, ruaHosts: [] },
    mx: { ...meta, present: false, hosts: [], isNullMx: false },
    dkim: { status: 'ok', selectorsFound: [], selectorsProbed: [], probeStrategy: 'skipped' },
  };
}

describe('checkpointing', () => {
  it('round-trips a checkpoint so a killed crawl can resume', () => {
    // GitHub runners get killed; losing four hours of a five-hour crawl is not
    // acceptable.
    return (async () => {
      const cp = checkpointFrom('tier1', 'LIST1', '2026-08-29', [snapshot('a.example')]);
      await writeCheckpoint(cp);
      const loaded = await readCheckpoint('tier1', 'LIST1', '2026-08-29');
      expect(loaded?.snapshots).toHaveLength(1);
      expect(loaded?.completed).toEqual(['a.example']);
    })();
  });

  it('returns undefined when no checkpoint exists', async () => {
    expect(await readCheckpoint('tier1', 'LIST1', '2026-08-29')).toBeUndefined();
  });

  it('refuses a checkpoint from a different day', async () => {
    await writeCheckpoint(checkpointFrom('tier1', 'LIST1', '2026-08-28', [snapshot('a.example')]));
    expect(await readCheckpoint('tier1', 'LIST1', '2026-08-29')).toBeUndefined();
  });

  it('refuses a checkpoint from a different Tranco list', async () => {
    // Resuming across a rollover would mix two populations into one snapshot.
    await writeCheckpoint(
      checkpointFrom('tier1', 'OLDLIST', '2026-08-29', [snapshot('a.example')]),
    );
    expect(await readCheckpoint('tier1', 'LIST1', '2026-08-29')).toBeUndefined();
  });

  it('refuses a checkpoint belonging to another shard', async () => {
    await writeCheckpoint(checkpointFrom('tier2-shard-3', 'LIST1', '2026-08-29', []));
    expect(await readCheckpoint('tier1', 'LIST1', '2026-08-29')).toBeUndefined();
  });

  it('starts over rather than failing when the checkpoint is truncated', async () => {
    // A run killed mid-write leaves half a JSON document.
    await writeCheckpoint(emptyCheckpoint('tier1', 'LIST1', '2026-08-29'));
    await writeFile(paths.checkpoint('tier1'), '{"shard":"tier1","listId":', 'utf8');
    expect(await readCheckpoint('tier1', 'LIST1', '2026-08-29')).toBeUndefined();
  });

  it('starts over when the checkpoint does not match the schema', async () => {
    await writeCheckpoint(emptyCheckpoint('tier1', 'LIST1', '2026-08-29'));
    await writeFile(paths.checkpoint('tier1'), '{"shard":"tier1","snapshots":"nope"}', 'utf8');
    expect(await readCheckpoint('tier1', 'LIST1', '2026-08-29')).toBeUndefined();
  });

  it('clears the checkpoint after a completed run', async () => {
    await writeCheckpoint(emptyCheckpoint('tier1', 'LIST1', '2026-08-29'));
    expect(existsSync(paths.checkpoint('tier1'))).toBe(true);
    await clearCheckpoint('tier1');
    expect(existsSync(paths.checkpoint('tier1'))).toBe(false);
  });

  it('clearing a checkpoint that does not exist is not an error', async () => {
    await expect(clearCheckpoint('tier1')).resolves.toBeUndefined();
  });

  it('writes checkpoints under data/tmp, which is gitignored', () => {
    expect(paths.checkpoint('tier1')).toContain(join('data', 'tmp'));
  });
});
