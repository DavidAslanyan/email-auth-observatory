import {
  UNKNOWN_RATE_DEGRADED_THRESHOLD,
  type Aggregate,
  type DomainSnapshot,
  type RunSummary,
} from '@observatory/core';
import {
  aggregate,
  allShardNames,
  appendJsonl,
  paths,
  readSnapshot,
  toHistoryEntry,
  writeJson,
} from '@observatory/store';
import { logger } from '../logger.js';
import { readPinnedListId } from '../tranco.js';
import { utcDate } from '../run-summary.js';
import { NoListError } from './crawl.js';

/**
 * Rolls every shard up into data/aggregates/.
 *
 * Reads all eight shard files, not only the one crawled today: a long-tail
 * domain is observed weekly and its last known state is what `latest/` holds.
 * Counting only today's shard would make every total swing by a factor of seven
 * from one day to the next.
 */
export async function aggregateCommand(): Promise<RunSummary> {
  const startedAt = new Date();
  const listId = await readPinnedListId();
  if (listId === undefined) throw new NoListError();

  const date = utcDate(startedAt);
  const snapshots: DomainSnapshot[] = [];
  let stale = 0;

  for (const shard of allShardNames()) {
    let shardCount = 0;
    for await (const snapshot of readSnapshot(shard, {
      onInvalid: (_line, index, error) => {
        logger.warn({ shard, line: index, error }, 'skipping invalid snapshot line');
      },
    })) {
      snapshots.push(snapshot);
      shardCount += 1;
      if (isStale(snapshot)) stale += 1;
    }
    if (shardCount > 0) logger.info({ shard, domains: shardCount }, 'read shard');
  }

  // The unknown rate for an aggregate is the share of the CURRENT dataset that
  // is carried-forward rather than freshly observed. It is not the crawl's own
  // rate: the aggregate spans eight shards crawled on eight different days.
  const unknownRate = snapshots.length === 0 ? 0 : stale / snapshots.length;
  const degraded = unknownRate > UNKNOWN_RATE_DEGRADED_THRESHOLD;

  const result = aggregate(snapshots, { date, listId, unknownRate, degraded });
  await writeJson(paths.aggregateLatest(), result);

  // history.jsonl is append-only, but re-running aggregate on the same day
  // must not add a second line for that day.
  await appendHistory(result.date, result);

  logger.info(
    { domains: result.domainsObserved, stale, unknownRate, degraded },
    'aggregate written',
  );

  const finishedAt = new Date();
  return {
    command: 'aggregate',
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    elapsedMs: finishedAt.getTime() - startedAt.getTime(),
    listId,
    domainsAttempted: snapshots.length,
    domainsCompleted: snapshots.length,
    lookupsTotal: 0,
    unknownLookups: stale,
    unknownRate,
    degraded,
    byResolver: { local: 0, 'doh-cloudflare': 0, 'doh-google': 0 },
    changesEmitted: 0,
  };
}

function isStale(snapshot: DomainSnapshot): boolean {
  return (
    snapshot.spf.stale === true ||
    snapshot.dmarc.stale === true ||
    snapshot.bimi.stale === true ||
    snapshot.mtaSts.stale === true ||
    snapshot.tlsRpt.stale === true ||
    snapshot.mx.stale === true
  );
}

async function appendHistory(date: string, result: Aggregate): Promise<void> {
  const { existsSync } = await import('node:fs');
  const { readFile, writeFile } = await import('node:fs/promises');
  const path = paths.aggregateHistory();
  const entry = toHistoryEntry(result);

  if (!existsSync(path)) {
    await appendJsonl(path, entry);
    return;
  }

  // Rewriting is cheap: one line per day means a decade of history is 3,650
  // lines, and it keeps the file idempotent when aggregate runs twice.
  const kept = (await readFile(path, 'utf8'))
    .split('\n')
    .filter((line) => line.trim() !== '')
    .filter((line) => {
      try {
        return (JSON.parse(line) as { date?: string }).date !== date;
      } catch {
        return false;
      }
    });
  kept.push(JSON.stringify(entry));
  await writeFile(path, `${kept.join('\n')}\n`, 'utf8');
}
