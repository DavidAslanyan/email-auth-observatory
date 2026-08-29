import { appendFile } from 'node:fs/promises';
import type { RunSummary } from '@mailscape/core';

/**
 * Emits the run summary as structured JSON on stdout, and as a markdown table
 * into the Actions job summary when running in CI. Seeing per-run stats in the
 * Actions UI is worth the few lines it costs.
 */
export async function emitRunSummary(summary: RunSummary): Promise<void> {
  process.stdout.write(`${JSON.stringify(summary)}\n`);

  const target = process.env.GITHUB_STEP_SUMMARY;
  if (target === undefined || target === '') return;

  const rows: [string, string][] = [
    ['Command', summary.command],
    ['List', summary.listId],
    ['Domains', `${summary.domainsCompleted} / ${summary.domainsAttempted}`],
    ['Lookups', String(summary.lookupsTotal)],
    ['Unknown rate', `${(summary.unknownRate * 100).toFixed(2)}%`],
    ['Degraded', summary.degraded ? '**yes**' : 'no'],
    ['Changes', String(summary.changesEmitted)],
    ['Disappearances retracted', String(summary.disappearancesRetracted ?? 0)],
    ['Elapsed', `${(summary.elapsedMs / 1000).toFixed(1)}s`],
    [
      'Lookup latency',
      summary.latencyMs === undefined
        ? 'n/a'
        : `${summary.latencyMs.median}ms median, ${summary.latencyMs.p95}ms p95`,
    ],
    ['Resolver: local', String(summary.byResolver.local)],
    ['Resolver: Cloudflare DoH', String(summary.byResolver['doh-cloudflare'])],
    ['Resolver: Google DoH', String(summary.byResolver['doh-google'])],
  ];

  const markdown = [
    `### mailscape ${summary.command}`,
    '',
    '| Metric | Value |',
    '| --- | --- |',
    ...rows.map(([k, v]) => `| ${k} | ${v} |`),
    '',
  ].join('\n');

  await appendFile(target, markdown, 'utf8');
}

export function utcDate(at: Date = new Date()): string {
  return at.toISOString().slice(0, 10);
}
