import Bottleneck from 'bottleneck';
import type { DomainSnapshot } from '@observatory/core';
import { parseMtaStsPolicy } from '@observatory/parsers';

export interface PolicyPassOptions {
  timeoutMs: number;
  concurrency: number;
  userAgent: string;
  /**
   * Where the policy lives. Defaults to the well-known location; overridden in
   * tests so the redirect and size limits can be exercised against a real
   * server rather than asserted by inspection.
   */
  policyUrl?: ((domain: string) => string) | undefined;
}

/**
 * Second pass: fetch the MTA-STS policy file for the ~2% of domains that
 * publish the TXT record.
 *
 * Deliberately separate from the DNS pass. These are HTTPS requests to
 * arbitrary web servers, and letting one that hangs for ten seconds sit inside
 * the DNS pipeline would stall the whole crawl. Any failure is recorded as
 * policyError with policyFetched false — never as an absent policy.
 */
export async function fetchPolicies(
  snapshots: DomainSnapshot[],
  options: PolicyPassOptions,
): Promise<number> {
  const limiter = new Bottleneck({ maxConcurrent: options.concurrency });
  const targets = snapshots.filter((s) => s.mtaSts.present);

  await Promise.all(
    targets.map((snapshot) =>
      limiter.schedule(async () => {
        await applyPolicy(snapshot, options);
      }),
    ),
  );

  await limiter.stop();
  return targets.length;
}

/** RFC 8461 policies are a few hundred bytes; this is generous. */
const MAX_POLICY_BYTES = 64 * 1024;
/** Plan section 4.3: follow at most three redirects. */
const MAX_REDIRECTS = 3;

async function applyPolicy(snapshot: DomainSnapshot, options: PolicyPassOptions): Promise<void> {
  const buildUrl =
    options.policyUrl ?? ((domain: string) => `https://mta-sts.${domain}/.well-known/mta-sts.txt`);
  let url = buildUrl(snapshot.domain);
  const allowInsecure = options.policyUrl !== undefined;

  try {
    let response: Response | undefined;

    // Redirects are followed by hand so the count is capped and every hop is
    // checked. These are arbitrary third-party web servers, and the default
    // limit of twenty hops is both a slow loop and an open redirect to follow.
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const hopResponse = await fetch(url, {
        headers: { 'user-agent': options.userAgent },
        signal: AbortSignal.timeout(options.timeoutMs),
        redirect: 'manual',
      });

      if (hopResponse.status < 300 || hopResponse.status > 399) {
        response = hopResponse;
        break;
      }

      const location = hopResponse.headers.get('location');
      if (location === null) {
        snapshot.mtaSts.policyError = `HTTP ${hopResponse.status} with no location`;
        return;
      }

      const next = new URL(location, url);
      // Never downgrade: a policy fetched over plaintext proves nothing.
      if (!allowInsecure && next.protocol !== 'https:') {
        snapshot.mtaSts.policyError = 'redirected to a non-HTTPS location';
        return;
      }
      url = next.toString();

      if (hop === MAX_REDIRECTS) {
        snapshot.mtaSts.policyError = `more than ${MAX_REDIRECTS} redirects`;
        return;
      }
    }

    if (response === undefined) {
      snapshot.mtaSts.policyError = 'no response';
      return;
    }

    if (!response.ok) {
      snapshot.mtaSts.policyError = `HTTP ${response.status}`;
      return;
    }

    const body = await readCapped(response, MAX_POLICY_BYTES);
    if (body === undefined) {
      snapshot.mtaSts.policyError = 'policy exceeded the size limit';
      return;
    }

    const parsed = parseMtaStsPolicy(body);
    if (!parsed.ok) {
      snapshot.mtaSts.policyError = parsed.error;
      return;
    }

    snapshot.mtaSts.policyFetched = true;
    snapshot.mtaSts.mode = parsed.value.mode;
    snapshot.mtaSts.maxAge = parsed.value.maxAge;
    snapshot.mtaSts.mxPatternCount = parsed.value.mxPatterns.length;
    delete snapshot.mtaSts.policyError;
  } catch (error) {
    snapshot.mtaSts.policyError =
      error instanceof Error && error.name === 'TimeoutError' ? 'timeout' : 'fetch failed';
  }
}

/**
 * Reads at most `limit` bytes, stopping as soon as the limit is passed.
 *
 * `response.text()` would buffer the whole body first and only then let us
 * truncate it, so a server returning a multi-gigabyte file would exhaust the
 * runner's memory before we ever looked at the size. Streaming means a hostile
 * or misconfigured host costs us 64KB, not the job.
 */
async function readCapped(response: Response, limit: number): Promise<string | undefined> {
  const declared = Number(response.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > limit) return undefined;

  // The runtime types for response.body widen to any here, so the element type
  // is pinned explicitly rather than propagating that through the read loop.
  const body = response.body as ReadableStream<Uint8Array> | null;
  if (body === null) return '';

  const reader: ReadableStreamDefaultReader<Uint8Array> = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) return undefined;
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }

  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8');
}
