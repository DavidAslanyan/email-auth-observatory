#!/usr/bin/env node
/**
 * Copies the data the dashboard needs into apps/web/public/data before
 * `vite build`.
 *
 * Build-time copy rather than runtime fetch from raw.githubusercontent.com:
 * no CORS, no rate limits, and the deployed site is a versioned artifact
 * rather than a view onto a moving target. apps/web/public/data is gitignored
 * because it is derived.
 */
import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const OUT = join(ROOT, 'apps/web/public/data');
const KEEP_DAYS = 30;

async function recentFiles(dir, suffix, limit) {
  if (!existsSync(dir)) return [];
  const entries = (await readdir(dir)).filter((f) => f.endsWith(suffix)).sort();
  return entries.slice(-limit);
}

await rm(OUT, { recursive: true, force: true });
await mkdir(join(OUT, 'changes'), { recursive: true });
await mkdir(join(OUT, 'reports'), { recursive: true });

// Aggregates: the whole trend series is a single small fetch.
for (const name of ['latest.json', 'history.jsonl']) {
  const src = join(ROOT, 'data/aggregates', name);
  if (existsSync(src)) await cp(src, join(OUT, name));
}

const changes = await recentFiles(join(ROOT, 'data/changes'), '.jsonl', KEEP_DAYS);
for (const name of changes) {
  await cp(join(ROOT, 'data/changes', name), join(OUT, 'changes', name));
}

const reports = await recentFiles(join(ROOT, 'reports'), '.md', KEEP_DAYS);
for (const name of reports) {
  await cp(join(ROOT, 'reports', name), join(OUT, 'reports', name));
}

// A pre-built index of tier 1 domains, so the lookup page needs no server. The
// long tail is deliberately excluded: shipping 100,000 snapshots to the browser
// would be a multi-megabyte download for a feature few visitors use.
const snapshotPath = join(ROOT, 'data/snapshots/latest/tier1.jsonl');
const index = [];
if (existsSync(snapshotPath)) {
  const raw = await readFile(snapshotPath, 'utf8');
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue;
    const s = JSON.parse(line);
    index.push({
      domain: s.domain,
      rank: s.rank,
      dnssec: s.dnssec,
      crawledAt: s.crawledAt,
      spf: {
        present: s.spf.present,
        allQualifier: s.spf.allQualifier ?? null,
        stale: s.spf.stale ?? false,
      },
      dmarc: {
        present: s.dmarc.present,
        p: s.dmarc.p ?? null,
        sp: s.dmarc.sp ?? null,
        pct: s.dmarc.pct ?? null,
        stale: s.dmarc.stale ?? false,
      },
      bimi: { present: s.bimi.present, hasVmc: s.bimi.hasVmc, declined: s.bimi.declined },
      mtaSts: { present: s.mtaSts.present, mode: s.mtaSts.mode ?? null },
      tlsRpt: { present: s.tlsRpt.present },
      mx: {
        provider: s.mx.isNullMx ? 'null-mx' : (s.mx.provider ?? null),
        isNullMx: s.mx.isNullMx,
        hosts: s.mx.hosts,
      },
      dkim: { selectorsFound: s.dkim.selectorsFound, probeStrategy: s.dkim.probeStrategy },
    });
  }
}
await writeFile(join(OUT, 'tier1-index.json'), JSON.stringify(index));

await writeFile(
  join(OUT, 'manifest.json'),
  JSON.stringify({
    stagedAt: new Date().toISOString(),
    changes: changes.map((f) => f.replace('.jsonl', '')),
    reports: reports.map((f) => f.replace('.md', '')),
    domainsIndexed: index.length,
  }),
);

process.stderr.write(
  `staged ${index.length} domains, ${changes.length} change files, ${reports.length} reports\n`,
);
