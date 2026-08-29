/**
 * Parsers return this instead of throwing. A malformed DNS record is expected
 * input for this project, not an exceptional condition — roughly one domain in
 * fifty publishes something that does not parse, and a thrown exception in a
 * 100k-domain loop is a crash, not a data point.
 */
export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

export function ok<T>(value: T): ParseResult<T> {
  return { ok: true, value };
}

export function err<T = never>(error: string): ParseResult<T> {
  return { ok: false, error };
}
