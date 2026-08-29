import { TIMEOUTS, UNKNOWN_RATE_DEGRADED_THRESHOLD } from '@mailscape/core';

/**
 * Every tunable in the project, in one place, each overridable by environment
 * variable. No magic numbers scattered through the code — when a crawl needs
 * to be slowed down at 3am, it is one env var, not a code change.
 */
export interface Config {
  resolverHost: string;
  resolverPort: number;
  localAttempts: number;
  localTimeoutMs: number;
  dohTimeoutMs: number;
  useDoh: boolean;
  localConcurrency: number;
  dohConcurrency: number;
  dohMinTimeMs: number;
  /** Domains probed concurrently. Each domain costs 6-9 DNS lookups. */
  domainConcurrency: number;
  policyFetchTimeoutMs: number;
  policyFetchConcurrency: number;
  checkpointEvery: number;
  unknownRateDegradedThreshold: number;
  trancoApiBase: string;
  userAgent: string;
  logLevel: string;
}

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function str(name: string, fallback: string): string {
  const raw = process.env[name];
  return raw === undefined || raw === '' ? fallback : raw;
}

function bool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return raw === '1' || raw.toLowerCase() === 'true';
}

export function loadConfig(): Config {
  return {
    // Defaults to the local unbound the workflows start. Point it elsewhere for
    // local development, where running a recursive resolver on port 53 needs
    // root.
    resolverHost: str('MAILSCAPE_RESOLVER_HOST', '127.0.0.1'),
    resolverPort: num('MAILSCAPE_RESOLVER_PORT', 53),
    localAttempts: num('MAILSCAPE_LOCAL_ATTEMPTS', 2),
    localTimeoutMs: num('MAILSCAPE_LOCAL_TIMEOUT_MS', TIMEOUTS.localMs),
    dohTimeoutMs: num('MAILSCAPE_DOH_TIMEOUT_MS', TIMEOUTS.dohMs),
    useDoh: bool('MAILSCAPE_USE_DOH', true),
    localConcurrency: num('MAILSCAPE_LOCAL_CONCURRENCY', 100),
    // DoH is one endpoint and should see 1-3% of traffic. Raising this to paper
    // over local resolver problems hides the cause instead of fixing it.
    dohConcurrency: num('MAILSCAPE_DOH_CONCURRENCY', 10),
    dohMinTimeMs: num('MAILSCAPE_DOH_MIN_TIME_MS', 20),
    domainConcurrency: num('MAILSCAPE_DOMAIN_CONCURRENCY', 20),
    policyFetchTimeoutMs: num('MAILSCAPE_POLICY_TIMEOUT_MS', TIMEOUTS.policyFetchMs),
    policyFetchConcurrency: num('MAILSCAPE_POLICY_CONCURRENCY', 8),
    checkpointEvery: num('MAILSCAPE_CHECKPOINT_EVERY', 500),
    unknownRateDegradedThreshold: num(
      'MAILSCAPE_UNKNOWN_THRESHOLD',
      UNKNOWN_RATE_DEGRADED_THRESHOLD,
    ),
    trancoApiBase: str('MAILSCAPE_TRANCO_BASE', 'https://tranco-list.eu'),
    userAgent: str(
      'MAILSCAPE_USER_AGENT',
      'mailscape/1.0 (+https://github.com/mailscape/mailscape)',
    ),
    logLevel: str('MAILSCAPE_LOG_LEVEL', 'info'),
  };
}
