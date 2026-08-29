import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { appendJsonl, readJson, readJsonlArray, writeJson, writeJsonl } from '../src/jsonl.js';

const schema = z.object({ domain: z.string(), rank: z.number().int() });

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'observatory-jsonl-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('writeJsonl / readJsonlArray', () => {
  it('round-trips records', async () => {
    const path = join(dir, 'out.jsonl');
    await writeJsonl(path, [
      { domain: 'a.example', rank: 1 },
      { domain: 'b.example', rank: 2 },
    ]);
    expect(await readJsonlArray(path, schema)).toEqual([
      { domain: 'a.example', rank: 1 },
      { domain: 'b.example', rank: 2 },
    ]);
  });

  it('writes one JSON object per line and ends with a newline', async () => {
    const path = join(dir, 'out.jsonl');
    await writeJsonl(path, [{ domain: 'a.example', rank: 1 }]);
    const raw = await readFile(path, 'utf8');
    expect(raw).toBe('{"domain":"a.example","rank":1}\n');
  });

  it('writes an empty file for no records rather than failing', async () => {
    const path = join(dir, 'empty.jsonl');
    expect(await writeJsonl(path, [])).toBe(0);
    expect(await readFile(path, 'utf8')).toBe('');
  });

  it('creates missing parent directories', async () => {
    const path = join(dir, 'deep', 'nested', 'out.jsonl');
    await writeJsonl(path, [{ domain: 'a.example', rank: 1 }]);
    expect(await readJsonlArray(path, schema)).toHaveLength(1);
  });

  it('leaves no temp file behind after a successful write', async () => {
    const path = join(dir, 'out.jsonl');
    await writeJsonl(path, [{ domain: 'a.example', rank: 1 }]);
    const { readdir } = await import('node:fs/promises');
    expect((await readdir(dir)).filter((f) => f.includes('.tmp-'))).toEqual([]);
  });

  it('replaces the previous file atomically', async () => {
    // A killed run must leave either the old snapshot or the new one, never a
    // half-written file the next run diffs against.
    const path = join(dir, 'out.jsonl');
    await writeJsonl(path, [{ domain: 'old.example', rank: 1 }]);
    await writeJsonl(path, [{ domain: 'new.example', rank: 2 }]);
    expect(await readJsonlArray(path, schema)).toEqual([{ domain: 'new.example', rank: 2 }]);
  });

  it('returns an empty array for a file that does not exist', async () => {
    expect(await readJsonlArray(join(dir, 'missing.jsonl'), schema)).toEqual([]);
  });
});

describe('readJsonlArray — malformed input', () => {
  it('skips a malformed JSON line and keeps the rest of the file', async () => {
    // One corrupt line in a 14,000-line shard should cost one domain, not the
    // whole run.
    const path = join(dir, 'partial.jsonl');
    await writeFile(
      path,
      [
        '{"domain":"a.example","rank":1}',
        'not json at all',
        '{"domain":"c.example","rank":3}',
      ].join('\n'),
      'utf8',
    );

    const invalid: string[] = [];
    const result = await readJsonlArray(path, schema, {
      onInvalid: (line) => invalid.push(line),
    });

    expect(result).toHaveLength(2);
    expect(invalid).toEqual(['not json at all']);
  });

  it('skips a line that parses but fails the schema', async () => {
    const path = join(dir, 'wrong-shape.jsonl');
    await writeFile(
      path,
      '{"domain":"a.example","rank":"first"}\n{"domain":"b.example","rank":2}\n',
    );

    const reasons: string[] = [];
    const result = await readJsonlArray(path, schema, {
      onInvalid: (_line, _index, error) => reasons.push(error),
    });

    expect(result).toEqual([{ domain: 'b.example', rank: 2 }]);
    expect(reasons).toHaveLength(1);
  });

  it('reports the line number of an invalid line', async () => {
    const path = join(dir, 'numbered.jsonl');
    await writeFile(path, '{"domain":"a.example","rank":1}\nbroken\n');
    const indexes: number[] = [];
    await readJsonlArray(path, schema, { onInvalid: (_l, index) => indexes.push(index) });
    expect(indexes).toEqual([2]);
  });

  it('ignores blank lines', async () => {
    const path = join(dir, 'blanks.jsonl');
    await writeFile(path, '\n{"domain":"a.example","rank":1}\n\n\n');
    expect(await readJsonlArray(path, schema)).toHaveLength(1);
  });

  it('handles CRLF line endings', async () => {
    const path = join(dir, 'crlf.jsonl');
    await writeFile(path, '{"domain":"a.example","rank":1}\r\n{"domain":"b.example","rank":2}\r\n');
    expect(await readJsonlArray(path, schema)).toHaveLength(2);
  });
});

describe('appendJsonl', () => {
  it('appends without rewriting existing lines', async () => {
    const path = join(dir, 'history.jsonl');
    await appendJsonl(path, { domain: 'a.example', rank: 1 });
    await appendJsonl(path, { domain: 'b.example', rank: 2 });
    expect(await readJsonlArray(path, schema)).toHaveLength(2);
  });

  it('creates the file and its directory when absent', async () => {
    const path = join(dir, 'new', 'history.jsonl');
    await appendJsonl(path, { domain: 'a.example', rank: 1 });
    expect(await readJsonlArray(path, schema)).toHaveLength(1);
  });
});

describe('writeJson / readJson', () => {
  it('round-trips an object', async () => {
    const path = join(dir, 'latest.json');
    await writeJson(path, { domain: 'a.example', rank: 1 });
    expect(await readJson(path, schema)).toEqual({ domain: 'a.example', rank: 1 });
  });

  it('writes indented JSON so the committed file diffs readably', async () => {
    const path = join(dir, 'latest.json');
    await writeJson(path, { domain: 'a.example', rank: 1 });
    expect(await readFile(path, 'utf8')).toContain('\n  "domain"');
  });

  it('returns undefined for a missing file', async () => {
    expect(await readJson(join(dir, 'nope.json'), schema)).toBeUndefined();
  });

  it('returns undefined when the file does not match the schema', async () => {
    const path = join(dir, 'bad.json');
    await writeFile(path, '{"domain":123}');
    expect(await readJson(path, schema)).toBeUndefined();
  });
});
