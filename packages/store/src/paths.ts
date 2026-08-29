import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/**
 * Every path in the project is constructed here. No other file concatenates
 * path strings — when the layout changes, it changes in one place, and a typo
 * in a data path cannot silently write a snapshot somewhere nobody reads it.
 */

const ROOT_MARKER = 'pnpm-workspace.yaml';

let cachedRoot: string | undefined;

/**
 * The repository root, so the CLI works from any working directory.
 * MAILSCAPE_ROOT overrides it, which is what the tests use to write into a
 * temporary directory instead of the real dataset.
 */
export function root(): string {
  const override = process.env.MAILSCAPE_ROOT;
  if (override !== undefined && override !== '') return resolve(override);
  if (cachedRoot !== undefined) return cachedRoot;

  let dir = process.cwd();
  for (;;) {
    if (existsSync(join(dir, ROOT_MARKER))) {
      cachedRoot = dir;
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      // No marker anywhere above: fall back to the working directory rather
      // than throwing, so `mailscape` still runs in a bare checkout.
      cachedRoot = process.cwd();
      return cachedRoot;
    }
    dir = parent;
  }
}

/** Clears the memoised root. Only tests need this. */
export function resetRootCache(): void {
  cachedRoot = undefined;
}

const rel = (...parts: string[]): string => join(root(), ...parts);

export const paths = {
  root,

  trancoDir: (): string => rel('data', 'tranco'),
  trancoListId: (): string => rel('data', 'tranco', 'list-id.txt'),
  trancoDomains: (): string => rel('data', 'tranco', 'domains.csv.gz'),
  trancoRollovers: (): string => rel('data', 'tranco', 'rollovers.jsonl'),

  snapshotDir: (): string => rel('data', 'snapshots', 'latest'),
  snapshot: (shard: string): string => rel('data', 'snapshots', 'latest', `${shard}.jsonl`),
  /** Holds the run timestamp for a shard, so records need not repeat it. */
  snapshotMeta: (shard: string): string => rel('data', 'snapshots', 'latest', `${shard}.meta.json`),

  changesDir: (): string => rel('data', 'changes'),
  changes: (date: string): string => rel('data', 'changes', `${date}.jsonl`),

  aggregateDir: (): string => rel('data', 'aggregates'),
  aggregateLatest: (): string => rel('data', 'aggregates', 'latest.json'),
  aggregateHistory: (): string => rel('data', 'aggregates', 'history.jsonl'),

  reportsDir: (): string => rel('reports'),
  report: (date: string): string => rel('reports', `${date}.md`),

  /** Gitignored: checkpoints are ephemeral and must never be committed. */
  tmpDir: (): string => rel('data', 'tmp'),
  checkpoint: (shard: string): string => rel('data', 'tmp', `checkpoint-${shard}.json`),
};

/** Shard names, used for both snapshot filenames and checkpoint filenames. */
export const SHARD_NAMES = {
  tier1: 'tier1',
  tier2: (shard: number): string => `tier2-shard-${shard}`,
} as const;
