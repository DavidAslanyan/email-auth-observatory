import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
import type { DomainSnapshot } from '@observatory/core';
import { domainSnapshotSchema } from '@observatory/core';
import { paths } from '@observatory/store';

const checkpointSchema = z.object({
  shard: z.string(),
  listId: z.string(),
  /** UTC date the run started, so yesterday's checkpoint is never resumed. */
  date: z.string(),
  completed: z.array(z.string()),
  snapshots: z.array(domainSnapshotSchema),
});

export type Checkpoint = z.infer<typeof checkpointSchema>;

/**
 * Crawl progress, written every N domains.
 *
 * GitHub runners get killed. A five-hour crawl that loses everything at hour
 * four is unacceptable, so progress survives in data/tmp — gitignored, because
 * checkpoints are ephemeral and must never be committed.
 */
export async function writeCheckpoint(checkpoint: Checkpoint): Promise<void> {
  const path = paths.checkpoint(checkpoint.shard);
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.tmp-${process.pid}`;
  try {
    await writeFile(temp, JSON.stringify(checkpoint), 'utf8');
    await rename(temp, path);
  } catch (error) {
    await unlink(temp).catch(() => undefined);
    throw error;
  }
}

/**
 * Loads a checkpoint, but only if it belongs to today's run of this shard and
 * the same pinned list. A stale checkpoint would resume a crawl against a list
 * that has since rolled over, mixing two populations in one snapshot.
 */
export async function readCheckpoint(
  shard: string,
  listId: string,
  date: string,
): Promise<Checkpoint | undefined> {
  const path = paths.checkpoint(shard);
  if (!existsSync(path)) return undefined;

  try {
    const parsed = checkpointSchema.safeParse(JSON.parse(await readFile(path, 'utf8')));
    if (!parsed.success) return undefined;
    if (parsed.data.shard !== shard) return undefined;
    if (parsed.data.listId !== listId) return undefined;
    if (parsed.data.date !== date) return undefined;
    return parsed.data;
  } catch {
    // A truncated checkpoint means the run died mid-write. Starting over is
    // correct; refusing to run is not.
    return undefined;
  }
}

export async function clearCheckpoint(shard: string): Promise<void> {
  await unlink(paths.checkpoint(shard)).catch(() => undefined);
}

export function emptyCheckpoint(shard: string, listId: string, date: string): Checkpoint {
  return { shard, listId, date, completed: [], snapshots: [] };
}

export function checkpointFrom(
  shard: string,
  listId: string,
  date: string,
  snapshots: readonly DomainSnapshot[],
): Checkpoint {
  return {
    shard,
    listId,
    date,
    completed: snapshots.map((s) => s.domain),
    snapshots: [...snapshots],
  };
}
