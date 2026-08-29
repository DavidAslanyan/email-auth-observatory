import { appendJsonl, paths } from '@observatory/store';
import type { RolloverEntry } from '@observatory/core';
import { loadConfig } from '../config.js';
import { logger } from '../logger.js';
import {
  downloadList,
  readListDomains,
  readPinnedListId,
  resolveLatestListId,
  writePinnedListId,
} from '../tranco.js';

export interface FetchListOptions {
  listId?: string | undefined;
  force?: boolean | undefined;
}

/**
 * Pins a Tranco list and downloads it.
 *
 * With no --list-id and nothing pinned, the latest list is resolved once and
 * then PINNED. It is never silently re-resolved on a later run: a list that
 * changes underneath the crawler contaminates every delta with membership
 * churn (plan section 1.5).
 */
export async function fetchList(options: FetchListOptions = {}): Promise<number> {
  const config = loadConfig();
  const pinned = await readPinnedListId();

  if (options.listId === undefined && pinned !== undefined && options.force !== true) {
    logger.info({ listId: pinned }, 'list already pinned; nothing to do');
    return 0;
  }

  const previousDomains =
    pinned === undefined ? [] : (await readListDomains({ maxRank: 100_000 })).map((e) => e.domain);

  const target =
    options.listId ?? (await resolveLatestListId(config.trancoApiBase, config.userAgent));

  if (pinned !== undefined && pinned !== target) {
    logger.info({ from: pinned, to: target }, 'rolling over to a new Tranco list');
  }

  const lines = await downloadList(config.trancoApiBase, target, config.userAgent);
  await writePinnedListId(target);

  // A rollover boundary must be recorded so anyone analysing the history can
  // exclude it: on that day, membership churn is indistinguishable from real
  // change unless the entering and leaving domains are known.
  if (pinned !== target) {
    const nextDomains = (await readListDomains({ maxRank: 100_000 })).map((e) => e.domain);
    const before = new Set(previousDomains);
    const after = new Set(nextDomains);
    const entered = nextDomains.filter((d) => !before.has(d));
    const left = previousDomains.filter((d) => !after.has(d));

    const entry: RolloverEntry = {
      ts: new Date().toISOString(),
      fromListId: pinned ?? null,
      toListId: target,
      // On the very first pin there is no previous list, so naming all 100,000
      // domains as "entering" is noise, not a boundary anyone needs to exclude.
      // The list file itself is that record.
      entered: pinned === undefined ? [] : entered,
      left,
      enteredCount: entered.length,
      leftCount: left.length,
    };
    await appendJsonl(paths.trancoRollovers(), entry);
    logger.info(
      { listId: target, entered: entered.length, left: left.length },
      'recorded list rollover',
    );
  }

  logger.info({ listId: target, lines }, 'pinned Tranco list');
  return lines;
}
