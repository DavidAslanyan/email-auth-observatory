import Bottleneck from 'bottleneck';
import {
  TIER1_MAX_RANK,
  TIER2_MAX_RANK,
  TIER2_SHARDS,
  type ChangeEvent,
  type DomainSnapshot,
  type RunSummary,
} from '@observatory/core';
import { Resolver } from '@observatory/dns';
import {
  appendJsonl,
  confirmDisappearances,
  diffSnapshots,
  loadSnapshotMap,
  paths,
  shardFor,
  shardForDayOfYear,
  shardName,
  writeSnapshot,
} from '@observatory/store';
import { loadConfig } from '../config.js';
import { logger } from '../logger.js';
import { probeDomain } from '../probe.js';
import { fetchPolicies } from '../mta-sts-pass.js';
import { checkpointFrom, clearCheckpoint, readCheckpoint, writeCheckpoint } from '../checkpoint.js';
import { readList, readPinnedListId } from '../tranco.js';
import { utcDate } from '../run-summary.js';

export interface CrawlOptions {
  tier: 1 | 2;
  shard?: number | undefined;
  auto?: boolean | undefined;
  /** Which of the day's tier-2 runs this is, when using --auto. */
  slot?: number | undefined;
  slotsPerDay?: number | undefined;
  limit?: number | undefined;
  dryRun?: boolean | undefined;
}

export class NoListError extends Error {
  readonly code = 'NO_PINNED_LIST';
  constructor() {
    super('no Tranco list pinned — run `observatory fetch-list` first');
    this.name = 'NoListError';
  }
}

export async function crawl(options: CrawlOptions): Promise<RunSummary> {
  const config = loadConfig();
  const startedAt = new Date();

  const listId = await readPinnedListId();
  if (listId === undefined) throw new NoListError();

  const shard = resolveShard(options, startedAt);
  const name = shardName(options.tier, shard);
  const date = utcDate(startedAt);

  // One timestamp for every domain in the run — see ProbeInput.crawledAt.
  const crawledAt = startedAt.toISOString();
  const targets = await selectTargets(options, shard);
  logger.info({ shard: name, listId, domains: targets.length }, 'starting crawl');

  const resolver = new Resolver({
    local: { host: config.resolverHost, port: config.resolverPort },
    localAttempts: config.localAttempts,
    localTimeoutMs: config.localTimeoutMs,
    dohTimeoutMs: config.dohTimeoutMs,
    useDoh: config.useDoh,
    skipLocal: config.skipLocalResolver,
    localConcurrency: config.localConcurrency,
    dohConcurrency: config.dohConcurrency,
    dohMinTimeMs: config.dohMinTimeMs,
  });

  // Loaded before probing, not after: the DKIM cadence needs to know what was
  // found last time, and the diff needs the same map afterwards.
  const previous = await loadSnapshotMap(name, {
    onInvalid: (_line, index, error) => {
      logger.warn({ shard: name, line: index, error }, 'skipping invalid snapshot line');
    },
  });

  // Resume a crawl the runner killed. GitHub runners have a hard six-hour
  // limit and are pre-empted; losing four hours of work is not acceptable.
  const resumed = await readCheckpoint(name, listId, date);
  const snapshots: DomainSnapshot[] = resumed ? [...resumed.snapshots] : [];
  const done = new Set(snapshots.map((s) => s.domain));
  if (resumed) {
    logger.info({ shard: name, resumed: snapshots.length }, 'resuming from checkpoint');
  }

  const pending = targets.filter((t) => !done.has(t.domain));
  const limiter = new Bottleneck({ maxConcurrent: config.domainConcurrency });
  let sinceCheckpoint = 0;

  await Promise.all(
    pending.map((target) =>
      limiter.schedule(async () => {
        try {
          const snapshot = await probeDomain(resolver, {
            ...target,
            listId,
            crawledAt,
            previous: previous.get(target.domain),
            dkimRefreshDays: config.dkimRefreshDays,
          });
          snapshots.push(snapshot);
        } catch (error) {
          // A probe should never throw — but if it does, one domain must not
          // take the crawl with it.
          logger.error(
            { domain: target.domain, err: error instanceof Error ? error.message : String(error) },
            'probe failed',
          );
          return;
        }

        sinceCheckpoint += 1;
        if (sinceCheckpoint >= config.checkpointEvery && !options.dryRun) {
          sinceCheckpoint = 0;
          await writeCheckpoint(checkpointFrom(name, listId, date, snapshots));
          logger.info(
            { shard: name, done: snapshots.length, total: targets.length },
            'checkpoint written',
          );
        }
      }),
    ),
  );

  await limiter.stop();

  // Second pass: HTTPS policy fetches, never inside the DNS pipeline.
  const policyTargets = await fetchPolicies(snapshots, {
    timeoutMs: config.policyFetchTimeoutMs,
    concurrency: config.policyFetchConcurrency,
    userAgent: config.userAgent,
  });
  logger.info({ policyTargets }, 'MTA-STS policy pass complete');

  const stats = resolver.getStats();
  const degraded = stats.unknownRate > config.unknownRateDegradedThreshold;

  let events: ChangeEvent[] = [];
  let retracted = 0;
  if (options.dryRun) {
    logger.info({ shard: name }, 'dry run: no files written');
  } else {
    const previous = await loadSnapshotMap(name, {
      onInvalid: (_line, index, error) => {
        logger.warn({ shard: name, line: index, error }, 'skipping invalid snapshot line');
      },
    });
    const diff = diffSnapshots(previous, snapshots);
    // A resolver that answers NOERROR with an incomplete answer set looks
    // exactly like a domain that withdrew a record. Confirm before recording:
    // disappearances are a tiny fraction of a crawl, and a false weakening
    // event is the most damaging kind of wrong entry this dataset can hold.
    const confirmLimiter = new Bottleneck({ maxConcurrent: config.domainConcurrency });
    const confirmed = await confirmDisappearances(previous, diff, (snapshot) =>
      confirmLimiter.schedule(async () => {
        try {
          return await probeDomain(resolver, {
            domain: snapshot.domain,
            rank: snapshot.rank,
            listId,
            crawledAt,
            previous: previous.get(snapshot.domain),
            dkimRefreshDays: config.dkimRefreshDays,
          });
        } catch {
          // A failed confirmation is not evidence; keep the original result.
          return undefined;
        }
      }),
    );
    await confirmLimiter.stop();

    if (confirmed.contradicted.length > 0) {
      logger.warn(
        { domains: confirmed.contradicted, retracted: confirmed.retracted },
        'second lookup contradicted a claimed disappearance; the first answer was incomplete',
      );
    }
    events = confirmed.events;
    retracted = confirmed.retracted;

    await writeSnapshot(name, confirmed.snapshots, crawledAt);
    for (const event of events) await appendJsonl(paths.changes(date), event);
    await clearCheckpoint(name);
  }

  if (degraded) {
    logger.warn(
      { unknownRate: stats.unknownRate, threshold: config.unknownRateDegradedThreshold },
      'run is DEGRADED: elevated unknown rate, results carried forward',
    );
  }

  const finishedAt = new Date();
  return {
    command: `crawl --tier ${options.tier}${options.tier === 2 ? ` --shard ${shard}` : ''}`,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    elapsedMs: finishedAt.getTime() - startedAt.getTime(),
    listId,
    domainsAttempted: targets.length,
    domainsCompleted: snapshots.length,
    lookupsTotal: stats.total,
    unknownLookups: stats.byStatus.unknown,
    unknownRate: stats.unknownRate,
    degraded,
    byResolver: stats.byResolver,
    latencyMs: stats.latencyMs,
    changesEmitted: events.length,
    disappearancesRetracted: retracted,
  };
}

function resolveShard(options: CrawlOptions, at: Date): number {
  if (options.tier === 1) return 0;
  if (options.auto === true) {
    return shardForDayOfYear(at, TIER2_SHARDS, options.slot ?? 0, options.slotsPerDay ?? 1);
  }
  return options.shard ?? 0;
}

async function selectTargets(
  options: CrawlOptions,
  shard: number,
): Promise<{ domain: string; rank: number }[]> {
  const targets: { domain: string; rank: number }[] = [];

  if (options.tier === 1) {
    for await (const entry of readList({ maxRank: TIER1_MAX_RANK, limit: options.limit })) {
      targets.push(entry);
    }
    return targets;
  }

  const limit = options.limit ?? Number.POSITIVE_INFINITY;
  for await (const entry of readList({ minRank: TIER1_MAX_RANK + 1, maxRank: TIER2_MAX_RANK })) {
    if (shardFor(entry.domain, TIER2_SHARDS) !== shard) continue;
    targets.push(entry);
    if (targets.length >= limit) break;
  }
  return targets;
}
