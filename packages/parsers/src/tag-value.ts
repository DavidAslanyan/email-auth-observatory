/**
 * The `key=value; key=value` grammar shared by DMARC (RFC 7489), BIMI,
 * MTA-STS TXT (RFC 8461) and TLS-RPT (RFC 8460). One tokenizer, four callers —
 * the alternative is four subtly different splitters and four different bugs.
 */
export interface TagValueRecord {
  /** First occurrence wins, per RFC 7489 section 6.6.3. Keys are lowercased. */
  tags: Map<string, string>;
  /** Every key in the order it appeared, duplicates included. */
  order: string[];
  /** Keys that appeared more than once. */
  duplicates: string[];
  /** Non-empty segments containing no `=` at all. */
  malformed: string[];
}

export function parseTagValue(input: string): TagValueRecord {
  const tags = new Map<string, string>();
  const order: string[] = [];
  const duplicates: string[] = [];
  const malformed: string[] = [];

  for (const segment of input.split(';')) {
    const trimmed = segment.trim();
    // A trailing `;` is legal and extremely common; it yields an empty segment.
    if (trimmed === '') continue;

    const eq = trimmed.indexOf('=');
    if (eq === -1) {
      malformed.push(trimmed);
      continue;
    }

    // Split on the FIRST `=` only: values routinely contain more of them, in
    // URIs (`rua=mailto:a@b?x=y`) and base64 DKIM keys.
    const key = trimmed.slice(0, eq).trim().toLowerCase();
    const value = trimmed.slice(eq + 1).trim();

    if (key === '') {
      malformed.push(trimmed);
      continue;
    }

    order.push(key);
    if (tags.has(key)) {
      if (!duplicates.includes(key)) duplicates.push(key);
      continue;
    }
    tags.set(key, value);
  }

  return { tags, order, duplicates, malformed };
}

/**
 * Splits a comma-separated URI list (`rua`, `ruf`) into trimmed, non-empty
 * entries. RFC 7489 allows whitespace around the commas.
 */
export function splitUriList(value: string): string[] {
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
}

/**
 * Extracts the domain part of a reporting URI, discarding the local part.
 *
 * Plan section 4.1.1: `rua=` tags routinely name individual mailboxes. This is
 * a public dataset, so the local part is dropped at the parser — it never
 * reaches a snapshot, a diff or a report. The domain alone answers the
 * question that matters ("which DMARC vendors are gaining share?") without
 * publishing a harvestable address list.
 */
export function reportingUriHost(uri: string): string | undefined {
  // Strip the RFC 7489 size limit suffix, e.g. `mailto:a@b.example!10m`.
  const bang = uri.indexOf('!');
  const withoutLimit = (bang === -1 ? uri : uri.slice(0, bang)).trim();
  if (withoutLimit === '') return undefined;

  const schemeSplit = withoutLimit.indexOf(':');
  if (schemeSplit === -1) return undefined;

  const scheme = withoutLimit.slice(0, schemeSplit).toLowerCase();
  const rest = withoutLimit.slice(schemeSplit + 1);

  if (scheme === 'mailto') {
    const at = rest.lastIndexOf('@');
    if (at === -1) return undefined;
    const host = stripUriTail(rest.slice(at + 1)).toLowerCase();
    return host === '' ? undefined : host;
  }

  if (scheme === 'https' || scheme === 'http') {
    const host = stripUriTail(rest.replace(/^\/\//, '')).toLowerCase();
    // Drop any userinfo and port.
    const noUser = host.includes('@') ? host.slice(host.lastIndexOf('@') + 1) : host;
    const colon = noUser.indexOf(':');
    const noPort = colon === -1 ? noUser : noUser.slice(0, colon);
    return noPort === '' ? undefined : noPort;
  }

  return undefined;
}

function stripUriTail(value: string): string {
  const cut = value.search(/[/?#]/);
  return (cut === -1 ? value : value.slice(0, cut)).trim();
}

/** Deduplicates while preserving first-seen order, then sorts for stable diffs. */
export function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}
