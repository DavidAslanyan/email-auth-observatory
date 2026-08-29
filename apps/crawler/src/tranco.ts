import { createGunzip, gzip } from 'node:zlib';
import { createReadStream, existsSync } from 'node:fs';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';
import { paths } from '@observatory/store';

const gzipAsync = promisify(gzip);

export interface TrancoEntry {
  rank: number;
  domain: string;
}

/**
 * Reads the pinned list id.
 *
 * Tranco publishes a new list daily and 1-2% of membership churns. Re-fetching
 * "today's list" every morning would make domains entering and leaving the
 * ranking appear in the diff as changes, contaminating every delta the project
 * publishes with pure list churn. So one id is pinned per quarter and rolled
 * over deliberately, as its own commit.
 */
export async function readPinnedListId(): Promise<string | undefined> {
  const path = paths.trancoListId();
  if (!existsSync(path)) return undefined;
  const raw = (await readFile(path, 'utf8')).trim();
  return raw === '' ? undefined : raw;
}

export async function writePinnedListId(listId: string): Promise<void> {
  await mkdir(paths.trancoDir(), { recursive: true });
  await writeFile(paths.trancoListId(), `${listId}\n`, 'utf8');
}

/** Resolves the id of the most recent daily list, so it can be pinned. */
export async function resolveLatestListId(base: string, userAgent: string): Promise<string> {
  const response = await fetch(`${base}/api/lists/date/latest`, {
    headers: { 'user-agent': userAgent, accept: 'application/json' },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    throw new TrancoError(`could not resolve latest list id: HTTP ${response.status}`);
  }
  const body = (await response.json()) as { list_id?: string; available?: boolean };
  if (typeof body.list_id !== 'string' || body.list_id === '') {
    throw new TrancoError('latest list response contained no list_id');
  }
  return body.list_id;
}

export class TrancoError extends Error {
  readonly code = 'TRANCO_UNAVAILABLE';
  constructor(message: string) {
    super(message);
    this.name = 'TrancoError';
  }
}

/**
 * Downloads a specific list by id and stores it gzipped, truncated to the
 * ranks this project actually crawls.
 *
 * Tranco's full list is 4.3 million domains and 43MB gzipped. The crawler never
 * looks past rank 100,000, so storing the rest would put tens of megabytes of
 * dead weight into the repository on every quarterly rollover. Truncated and
 * gzipped it is roughly 1MB, and .gitattributes marks it binary so git never
 * tries to diff it.
 */
export async function downloadList(
  base: string,
  listId: string,
  userAgent: string,
  maxRank = 100_000,
): Promise<number> {
  const response = await fetch(`${base}/download/${listId}/full`, {
    headers: { 'user-agent': userAgent },
    signal: AbortSignal.timeout(300_000),
  });
  if (!response.ok) {
    throw new TrancoError(`could not download list ${listId}: HTTP ${response.status}`);
  }

  const csv = Buffer.from(await response.arrayBuffer());
  if (csv.length === 0) throw new TrancoError(`list ${listId} downloaded empty`);

  const truncated = truncateToRank(csv.toString('utf8'), maxRank);
  if (truncated.count === 0) throw new TrancoError(`list ${listId} contained no usable rows`);

  const compressed = await gzipAsync(Buffer.from(truncated.csv, 'utf8'), { level: 9 });
  await mkdir(paths.trancoDir(), { recursive: true });

  const target = paths.trancoDomains();
  const temp = `${target}.tmp-${process.pid}`;
  try {
    await writeFile(temp, compressed);
    await rename(temp, target);
  } catch (error) {
    await unlink(temp).catch(() => undefined);
    throw error;
  }

  return truncated.count;
}

/** Keeps rows up to maxRank. The list is rank-ordered, so this is a prefix. */
export function truncateToRank(csv: string, maxRank: number): { csv: string; count: number } {
  const kept: string[] = [];
  for (const line of csv.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    const comma = trimmed.indexOf(',');
    if (comma === -1) continue;
    const rank = Number.parseInt(trimmed.slice(0, comma), 10);
    if (!Number.isInteger(rank)) continue;
    if (rank > maxRank) break;
    kept.push(trimmed);
  }
  return { csv: kept.length === 0 ? '' : `${kept.join('\n')}\n`, count: kept.length };
}

/**
 * Streams the pinned list. The full list is a million lines, so it is never
 * loaded into memory whole — callers take the slice of ranks they need.
 */
export interface ReadListOptions {
  minRank?: number | undefined;
  maxRank?: number | undefined;
  limit?: number | undefined;
}

export async function* readList(options: ReadListOptions = {}): AsyncGenerator<TrancoEntry> {
  const path = paths.trancoDomains();
  if (!existsSync(path)) return;

  const minRank = options.minRank ?? 1;
  const maxRank = options.maxRank ?? Number.POSITIVE_INFINITY;
  const limit = options.limit ?? Number.POSITIVE_INFINITY;

  const stream = createReadStream(path).pipe(createGunzip());
  const lines = createInterface({ input: stream, crlfDelay: Infinity });

  let yielded = 0;
  try {
    for await (const line of lines) {
      const trimmed = line.trim();
      if (trimmed === '') continue;

      const comma = trimmed.indexOf(',');
      if (comma === -1) continue;

      const rank = Number.parseInt(trimmed.slice(0, comma), 10);
      const domain = trimmed
        .slice(comma + 1)
        .trim()
        .toLowerCase();
      if (!Number.isInteger(rank) || domain === '') continue;

      if (rank < minRank) continue;
      // The list is rank-ordered, so passing maxRank means we are done reading.
      if (rank > maxRank) break;

      yield { rank, domain };
      yielded += 1;
      if (yielded >= limit) break;
    }
  } finally {
    lines.close();
    stream.destroy();
  }
}

export async function readListDomains(options: ReadListOptions = {}): Promise<TrancoEntry[]> {
  const out: TrancoEntry[] = [];
  for await (const entry of readList(options)) out.push(entry);
  return out;
}
