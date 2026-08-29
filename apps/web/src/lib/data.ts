import type { Aggregate, ChangeEvent, HistoryEntry, IndexedDomain, Manifest } from './types.js';

/**
 * Everything is loaded from files staged into public/data at build time by
 * scripts/stage-web-data.mjs. There is no runtime fetch of the raw repository:
 * no CORS, no rate limits, and the deployed site is a versioned artifact rather
 * than a view onto a moving target.
 */
/**
 * BASE_URL is '/' in dev but '/<repo>' on Pages, and GitHub's
 * configure-pages emits base_path WITHOUT a trailing slash — so naive
 * concatenation produced '/<repo>data/latest.json'. Normalise once here
 * rather than depending on how the deploy formats it.
 */
const BASE = `${import.meta.env.BASE_URL.replace(/\/+$/, '')}/data`;

export class DataError extends Error {
  constructor(
    readonly what: string,
    readonly remedy: string,
  ) {
    super(`${what} ${remedy}`);
    this.name = 'DataError';
  }
}

async function getJson<T>(path: string, what: string): Promise<T> {
  const response = await fetch(`${BASE}/${path}`);
  if (!response.ok) {
    throw new DataError(
      `${what} could not be loaded (HTTP ${response.status}).`,
      'Reload the page; if it persists the last deploy did not include it.',
    );
  }
  return (await response.json()) as T;
}

async function getJsonl<T>(path: string, what: string): Promise<T[]> {
  const response = await fetch(`${BASE}/${path}`);
  if (!response.ok) {
    throw new DataError(
      `${what} could not be loaded (HTTP ${response.status}).`,
      'Reload the page; if it persists the last deploy did not include it.',
    );
  }
  const text = await response.text();
  const out: T[] = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    try {
      out.push(JSON.parse(line) as T);
    } catch {
      // One malformed line costs one row, not the whole page.
    }
  }
  return out;
}

export const loadManifest = (): Promise<Manifest> =>
  getJson<Manifest>('manifest.json', 'The data manifest');
export const loadAggregate = (): Promise<Aggregate> =>
  getJson<Aggregate>('latest.json', 'The latest aggregate');
export const loadHistory = (): Promise<HistoryEntry[]> =>
  getJsonl<HistoryEntry>('history.jsonl', 'The trend history');
export const loadIndex = (): Promise<IndexedDomain[]> =>
  getJson<IndexedDomain[]>('tier1-index.json', 'The domain index');

export const loadChanges = (date: string): Promise<ChangeEvent[]> =>
  getJsonl<ChangeEvent>(`changes/${date}.jsonl`, `Changes for ${date}`);

export async function loadReport(date: string): Promise<string> {
  const response = await fetch(`${BASE}/reports/${date}.md`);
  if (!response.ok) {
    throw new DataError(
      `The report for ${date} could not be loaded (HTTP ${response.status}).`,
      'Pick another date from the list.',
    );
  }
  return response.text();
}
