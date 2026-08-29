import type { ResolverTier } from '@observatory/core';
import { SYNTHETIC_RCODES, rcodeName, toLookupStatus } from './rcode.js';
import { joinTxtChunks } from './txt.js';
import type { DnsAnswer, MxAnswer, QueryOptions, RecordType } from './types.js';

export interface DohEndpoint {
  tier: ResolverTier;
  url: string;
}

export const CLOUDFLARE_DOH: DohEndpoint = {
  tier: 'doh-cloudflare',
  url: 'https://cloudflare-dns.com/dns-query',
};

export const GOOGLE_DOH: DohEndpoint = {
  tier: 'doh-google',
  url: 'https://dns.google/resolve',
};

/**
 * The shape both Cloudflare and Google return for `application/dns-json`.
 * Their wire formats differ from each other in small ways (Cloudflare omits
 * `Authority` when empty, Google always includes `Comment` on errors), so both
 * are normalised to DnsAnswer here and nothing downstream can tell them apart.
 */
interface DohResponse {
  Status?: number;
  TC?: boolean;
  AD?: boolean;
  Answer?: { name: string; type: number; TTL?: number; data: string }[];
  Authority?: { name: string; type: number; data: string }[];
}

const TYPE_NUMBERS: Record<RecordType, number> = {
  A: 1,
  NS: 2,
  CNAME: 5,
  SOA: 6,
  MX: 15,
  TXT: 16,
  AAAA: 28,
};

export async function queryDoh(
  endpoint: DohEndpoint,
  name: string,
  type: RecordType,
  options: QueryOptions,
): Promise<DnsAnswer> {
  const startedAt = performance.now();
  const url = `${endpoint.url}?name=${encodeURIComponent(name)}&type=${type}&do=${
    options.dnssecOk === false ? '0' : '1'
  }`;

  try {
    const response = await fetch(url, {
      headers: { accept: 'application/dns-json' },
      signal: AbortSignal.timeout(options.timeoutMs),
    });

    if (!response.ok) {
      // An HTTP-level failure tells us nothing about the domain, so it is our
      // failure, not an absence.
      return failure(endpoint.tier, `HTTP_${response.status}`, startedAt);
    }

    const body = (await response.json()) as DohResponse;
    return normalise(endpoint.tier, body, type, startedAt);
  } catch (error) {
    const isTimeout = error instanceof Error && error.name === 'TimeoutError';
    return failure(
      endpoint.tier,
      isTimeout ? SYNTHETIC_RCODES.timeout : SYNTHETIC_RCODES.networkError,
      startedAt,
    );
  }
}

function normalise(
  tier: ResolverTier,
  body: DohResponse,
  type: RecordType,
  startedAt: number,
): DnsAnswer {
  const rcode = rcodeName(body.Status ?? 2);
  const wanted = TYPE_NUMBERS[type];
  // Filter to the requested type: a CNAME chain puts intermediate records in
  // Answer, and counting those would turn a NODATA into a false `ok`.
  const answers = (body.Answer ?? []).filter((a) => a.type === wanted);

  const txt: string[] = [];
  const mx: MxAnswer[] = [];

  for (const answer of answers) {
    if (type === 'TXT') {
      txt.push(unquoteJsonTxt(answer.data));
    } else if (type === 'MX') {
      const parsed = parseJsonMx(answer.data);
      if (parsed) mx.push(parsed);
    }
  }

  return {
    status: toLookupStatus(rcode, answers.length),
    rcode,
    resolver: tier,
    elapsedMs: Math.round(performance.now() - startedAt),
    ad: body.AD === true,
    txt,
    mx,
    authority: (body.Authority ?? []).map((a) => a.name),
  };
}

function failure(tier: ResolverTier, rcode: string, startedAt: number): DnsAnswer {
  return {
    status: 'unknown',
    rcode,
    resolver: tier,
    elapsedMs: Math.round(performance.now() - startedAt),
    ad: false,
    txt: [],
    mx: [],
    authority: [],
  };
}

/**
 * The JSON APIs render a chunked TXT record as adjacent quoted strings, e.g.
 * `"chunk one" "chunk two"`. They must be unquoted and joined with NO
 * separator, exactly as the wire-format path does — see plan section 1.2.
 */
export function unquoteJsonTxt(data: string): string {
  const matches = [...data.matchAll(/"((?:[^"\\]|\\.)*)"/g)];
  if (matches.length === 0) return data;
  return joinTxtChunks(
    matches.map((m) => (m[1] ?? '').replace(/\\"/g, '"').replace(/\\\\/g, '\\')),
  );
}

/** The JSON APIs render MX data as `"<preference> <exchange>"`. */
export function parseJsonMx(data: string): MxAnswer | undefined {
  const match = /^\s*(\d+)\s+(\S+)\s*$/.exec(data);
  if (!match) return undefined;
  const preference = Number.parseInt(match[1] ?? '', 10);
  const exchange = match[2];
  if (!Number.isFinite(preference) || exchange === undefined) return undefined;
  return { preference, exchange };
}
