import Bottleneck from 'bottleneck';
import type { DomainSnapshot } from '@mailscape/core';
import { parseMtaStsPolicy } from '@mailscape/parsers';

export interface PolicyPassOptions {
  timeoutMs: number;
  concurrency: number;
  userAgent: string;
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

async function applyPolicy(snapshot: DomainSnapshot, options: PolicyPassOptions): Promise<void> {
  const url = `https://mta-sts.${snapshot.domain}/.well-known/mta-sts.txt`;

  try {
    const response = await fetch(url, {
      headers: { 'user-agent': options.userAgent },
      signal: AbortSignal.timeout(options.timeoutMs),
      redirect: 'follow',
    });

    if (!response.ok) {
      snapshot.mtaSts.policyError = `HTTP ${response.status}`;
      return;
    }

    // A misconfigured server can serve a 200MB file here; the policy is at most
    // a few hundred bytes, so read a bounded prefix rather than the whole body.
    const body = (await response.text()).slice(0, 64 * 1024);
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
