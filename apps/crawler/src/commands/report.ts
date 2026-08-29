import {
  aggregateSchema,
  changeEventSchema,
  type ChangeEvent,
  type RunSummary,
} from '@observatory/core';
import {
  allShardNames,
  annotateWithProvider,
  paths,
  readJson,
  readJsonlArray,
  readSnapshot,
  renderReport,
} from '@observatory/store';
import { mkdir, writeFile } from 'node:fs/promises';
import { logger } from '../logger.js';
import { readPinnedListId } from '../tranco.js';
import { utcDate } from '../run-summary.js';

export interface ReportOptions {
  date?: string | undefined;
}

export async function reportCommand(options: ReportOptions = {}): Promise<RunSummary> {
  const startedAt = new Date();
  const date = options.date ?? utcDate(startedAt);
  const listId = (await readPinnedListId()) ?? 'unknown';

  const events: ChangeEvent[] = await readJsonlArray(paths.changes(date), changeEventSchema, {
    onInvalid: (_line, index, error) => {
      logger.warn({ date, line: index, error }, 'skipping invalid change event');
    },
  });

  // Provider comes from the snapshot, not the change event: the differ has no
  // business knowing about MX providers, and the report needs them to cluster.
  const providers = new Map<string, string>();
  for (const shard of allShardNames()) {
    for await (const snapshot of readSnapshot(shard)) {
      const provider = snapshot.mx.isNullMx ? 'null-mx' : snapshot.mx.provider;
      if (provider !== undefined) providers.set(snapshot.domain, provider);
    }
  }

  const annotated = annotateWithProvider(events, (domain) => providers.get(domain));
  const aggregate = await readJson(paths.aggregateLatest(), aggregateSchema);

  const markdown = renderReport({ date, events: annotated, aggregate });
  await mkdir(paths.reportsDir(), { recursive: true });
  await writeFile(paths.report(date), markdown, 'utf8');

  logger.info({ date, events: events.length, bytes: markdown.length }, 'report written');

  const finishedAt = new Date();
  return {
    command: `report --date ${date}`,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    elapsedMs: finishedAt.getTime() - startedAt.getTime(),
    listId,
    domainsAttempted: providers.size,
    domainsCompleted: providers.size,
    lookupsTotal: 0,
    unknownLookups: 0,
    unknownRate: aggregate?.unknownRate ?? 0,
    degraded: aggregate?.degraded ?? false,
    byResolver: { local: 0, 'doh-cloudflare': 0, 'doh-google': 0 },
    changesEmitted: events.length,
  };
}
