import type { Aggregate, ChangeEvent, HistoryEntry, IndexedDomain, Manifest } from './types.js';
export declare class DataError extends Error {
  readonly what: string;
  readonly remedy: string;
  constructor(what: string, remedy: string);
}
export declare const loadManifest: () => Promise<Manifest>;
export declare const loadAggregate: () => Promise<Aggregate>;
export declare const loadHistory: () => Promise<HistoryEntry[]>;
export declare const loadIndex: () => Promise<IndexedDomain[]>;
export declare const loadChanges: (date: string) => Promise<ChangeEvent[]>;
export declare function loadReport(date: string): Promise<string>;
