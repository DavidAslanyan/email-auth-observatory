import type { IndexedDomain } from '../lib/types.js';
/**
 * Client-side only, against a pre-built index of the tier 1 domains. The long
 * tail is deliberately not shipped: 100,000 snapshots would be a multi-megabyte
 * download for a feature most visitors never open, so a domain outside tier 1
 * gets an honest "not in this index" instead of a broken search.
 */
export declare function Lookup({ index }: { index: IndexedDomain[] }): React.JSX.Element;
