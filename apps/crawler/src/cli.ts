#!/usr/bin/env node
import { flagBoolean, flagNumber, flagString, parseArgs } from './args.js';
import { crawl } from './commands/crawl.js';
import { fetchList } from './commands/fetch-list.js';
import { logger } from './logger.js';
import { emitRunSummary } from './run-summary.js';

const USAGE = `mailscape — email authentication posture crawler

Usage:
  mailscape fetch-list [--list-id <id>] [--force]
      Pin a Tranco list and download it. Without --list-id, resolves the latest
      list once and pins it; an already-pinned list is left alone.

  mailscape crawl --tier 1 [--limit <n>] [--dry-run]
      Crawl the top 1000 domains.

  mailscape crawl --tier 2 --shard <0-6> [--limit <n>] [--dry-run]
  mailscape crawl --tier 2 --auto [--slot <n> --slots-per-day <n>]
      Crawl one long-tail shard. --auto selects it from the day of year;
      --slot distinguishes the day's several runs so they advance together.

  mailscape aggregate
      Roll every shard up into data/aggregates/.

  mailscape report [--date YYYY-MM-DD]
      Write the daily human-readable report.

Exit codes:
  0  success, including a degraded run (flagged in the data, not a crash)
  1  hard failure: no list available, no writable data directory
`;

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));

  if (args.command === undefined || args.command === 'help' || flagBoolean(args, 'help')) {
    process.stdout.write(USAGE);
    return 0;
  }

  switch (args.command) {
    case 'fetch-list': {
      await fetchList({ listId: flagString(args, 'list-id'), force: flagBoolean(args, 'force') });
      return 0;
    }

    case 'crawl': {
      const tier = flagNumber(args, 'tier') ?? 1;
      if (tier !== 1 && tier !== 2) {
        logger.error({ tier }, 'tier must be 1 or 2');
        return 1;
      }
      const summary = await crawl({
        tier,
        shard: flagNumber(args, 'shard'),
        auto: flagBoolean(args, 'auto'),
        slot: flagNumber(args, 'slot'),
        slotsPerDay: flagNumber(args, 'slots-per-day'),
        limit: flagNumber(args, 'limit'),
        dryRun: flagBoolean(args, 'dry-run'),
      });
      await emitRunSummary(summary);
      // A degraded run still exits zero: the data is published with the flag
      // set, which is the point. Only hard failures are non-zero.
      return 0;
    }

    case 'aggregate': {
      const { aggregateCommand } = await import('./commands/aggregate.js');
      await emitRunSummary(await aggregateCommand());
      return 0;
    }

    case 'report': {
      const { reportCommand } = await import('./commands/report.js');
      await emitRunSummary(await reportCommand({ date: flagString(args, 'date') }));
      return 0;
    }

    default: {
      logger.error({ command: args.command }, 'unknown command');
      process.stdout.write(USAGE);
      return 1;
    }
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    logger.error({ err: error instanceof Error ? error.message : String(error) }, 'command failed');
    process.exitCode = 1;
  });
