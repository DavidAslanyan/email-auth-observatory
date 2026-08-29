#!/usr/bin/env node
/**
 * Fetches real MTA-STS policy files into
 * packages/parsers/test/fixtures/mta-sts-policies.json.
 *
 * Policies are fetched separately from the DNS fixtures because they are HTTPS
 * resources, not DNS records — the same separation the crawler enforces at
 * runtime so a slow web server can never stall the DNS pass.
 */
import { writeFile } from 'node:fs/promises';

const CANDIDATES = process.argv.slice(2).length
  ? process.argv.slice(2)
  : [
      'cloudflare.com',
      'microsoft.com',
      'google.com',
      'facebook.com',
      'protonmail.com',
      'fastmail.com',
      'linkedin.com',
      'github.com',
      'gitlab.com',
      'wikipedia.org',
      'mozilla.org',
      'apple.com',
      'amazon.com',
      'yahoo.com',
      'aol.com',
      'comcast.net',
      'gmx.net',
      'web.de',
      'mail.ru',
      'seznam.cz',
      'bbc.co.uk',
      'ft.com',
      'economist.com',
      'nih.gov',
      'cisa.gov',
      'ncsc.gov.uk',
      'digitalocean.com',
      'hetzner.com',
      'ovh.com',
      'posteo.de',
      'mailbox.org',
      'tutanota.com',
      'zoho.com',
      'sendgrid.com',
      'mailgun.com',
      'stackoverflow.com',
      'discord.com',
      'spotify.com',
      'booking.com',
      'adobe.com',
    ];

async function fetchPolicy(domain) {
  const url = `https://mta-sts.${domain}/.well-known/mta-sts.txt`;
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(10_000),
      redirect: 'follow',
      headers: { 'user-agent': 'email-auth-observatory-fixture-capture/1.0' },
    });
    if (!res.ok) return { domain, error: `HTTP ${res.status}` };
    const body = await res.text();
    return { domain, url, body };
  } catch (e) {
    return { domain, error: e instanceof Error ? e.message : String(e) };
  }
}

const results = await Promise.all(CANDIDATES.map(fetchPolicy));
const fetched = results.filter((r) => 'body' in r);

for (const r of results) {
  const mode = 'body' in r ? (/^\s*mode\s*:\s*(\S+)/im.exec(r.body)?.[1] ?? '?') : `— ${r.error}`;
  process.stderr.write(`${r.domain.padEnd(24)} ${mode}\n`);
}

const out = new URL('../packages/parsers/test/fixtures/mta-sts-policies.json', import.meta.url);
await writeFile(
  out,
  `${JSON.stringify({ capturedAt: new Date().toISOString(), policies: fetched }, null, 2)}\n`,
);
process.stderr.write(`\nwrote ${fetched.length} policies\n`);
