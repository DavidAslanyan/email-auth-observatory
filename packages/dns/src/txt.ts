/**
 * DNS TXT records travel as arrays of character-strings, each at most 255
 * bytes (RFC 1035 section 3.3.14). Long SPF records and every DKIM public key
 * are therefore ALWAYS split across chunks.
 *
 * The chunks join with NO separator. Reading `chunks[0]` alone silently
 * truncates roughly 15% of SPF records and 100% of DKIM keys — and the result
 * still parses, so the corruption is invisible without a test like this one.
 */
export type TxtChunks = Buffer | string | readonly (Buffer | string)[];

export function joinTxtChunks(data: TxtChunks): string {
  if (typeof data === 'string') return data;
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  return data.map((chunk) => (typeof chunk === 'string' ? chunk : chunk.toString('utf8'))).join('');
}

/** Joins every record in a TXT answer set, preserving record boundaries. */
export function joinTxtRecords(records: readonly TxtChunks[]): string[] {
  return records.map(joinTxtChunks);
}

/**
 * Selects the records matching a version prefix, case-insensitively.
 *
 * Returns ALL matches rather than the first. A domain publishing two `v=spf1`
 * records is a misconfiguration receivers must treat as permerror (RFC 7208
 * section 4.5) — and recording that is more interesting than hiding it, so the
 * caller gets the count.
 */
export function selectByPrefix(records: readonly string[], prefix: string): string[] {
  const needle = prefix.toLowerCase();
  return records.filter((r) => r.trimStart().toLowerCase().startsWith(needle));
}
