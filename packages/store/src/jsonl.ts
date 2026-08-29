import { createReadStream, existsSync } from 'node:fs';
import { mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createInterface } from 'node:readline';
import type { z } from 'zod';

export interface ReadOptions {
  /** Called for each line that fails validation, instead of aborting the run. */
  onInvalid?: (line: string, index: number, error: string) => void;
}

/**
 * Streams a JSONL file line by line, validating each line against a schema.
 *
 * Never `JSON.parse(readFileSync(...))` on a snapshot: tier2 shards are ~14k
 * lines today and the full snapshot set grows monotonically. Streaming keeps
 * memory flat regardless of how large the dataset becomes.
 *
 * An invalid line is logged and skipped rather than aborting: one corrupt line
 * in a 14,000-line shard should cost one domain, not the whole run.
 */
export async function* readJsonl<T>(
  path: string,
  schema: z.ZodType<T>,
  options: ReadOptions = {},
): AsyncGenerator<T> {
  if (!existsSync(path)) return;

  const stream = createReadStream(path, { encoding: 'utf8' });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });

  let index = 0;
  try {
    for await (const line of lines) {
      index += 1;
      const trimmed = line.trim();
      if (trimmed === '') continue;

      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        options.onInvalid?.(trimmed, index, 'malformed JSON');
        continue;
      }

      const result = schema.safeParse(parsed);
      if (!result.success) {
        options.onInvalid?.(trimmed, index, result.error.issues[0]?.message ?? 'schema mismatch');
        continue;
      }
      yield result.data;
    }
  } finally {
    lines.close();
    stream.close();
  }
}

/** Reads a whole JSONL file into memory. Only for files known to be small. */
export async function readJsonlArray<T>(
  path: string,
  schema: z.ZodType<T>,
  options: ReadOptions = {},
): Promise<T[]> {
  const out: T[] = [];
  for await (const item of readJsonl(path, schema, options)) out.push(item);
  return out;
}

/**
 * Writes a JSONL file atomically: temp file, then rename.
 *
 * rename(2) is atomic within a filesystem, so a run killed mid-write leaves
 * either the old file or the new one — never a half-written snapshot that the
 * next run reads as truth and diffs against.
 */
export async function writeJsonl<T>(path: string, items: Iterable<T>): Promise<number> {
  await mkdir(dirname(path), { recursive: true });

  const lines: string[] = [];
  let count = 0;
  for (const item of items) {
    lines.push(JSON.stringify(item));
    count += 1;
  }

  const temp = `${path}.tmp-${process.pid}`;
  try {
    await writeFile(temp, lines.length === 0 ? '' : `${lines.join('\n')}\n`, 'utf8');
    await rename(temp, path);
  } catch (error) {
    await unlink(temp).catch(() => undefined);
    throw error;
  }
  return count;
}

/** Appends one line. Used for history and rollovers, which only ever grow. */
export async function appendJsonl(path: string, item: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const { appendFile } = await import('node:fs/promises');
  await appendFile(path, `${JSON.stringify(item)}\n`, 'utf8');
}

/** Writes formatted JSON atomically, for the single-object aggregate file. */
export async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.tmp-${process.pid}`;
  try {
    await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await rename(temp, path);
  } catch (error) {
    await unlink(temp).catch(() => undefined);
    throw error;
  }
}

export async function readJson<T>(path: string, schema: z.ZodType<T>): Promise<T | undefined> {
  if (!existsSync(path)) return undefined;
  const { readFile } = await import('node:fs/promises');
  const raw = await readFile(path, 'utf8');
  const result = schema.safeParse(JSON.parse(raw));
  return result.success ? result.data : undefined;
}
