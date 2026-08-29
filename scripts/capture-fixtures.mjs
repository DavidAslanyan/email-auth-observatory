#!/usr/bin/env node
/**
 * Captures real email-auth records with `dig` and writes them to
 * packages/parsers/test/fixtures/records.json.
 *
 * Fixtures are captured, not hand-written, because real records contain
 * whitespace, ordering and length quirks nobody thinks to invent. Re-run this
 * to refresh them; review the diff before committing, since a fixture change
 * means the internet changed, not that the parser did.
 *
 * Usage: node scripts/capture-fixtures.mjs [domain ...]
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile } from 'node:fs/promises';

const run = promisify(execFile);

const DEFAULT_DOMAINS = [
  // Google-hosted
  'cloudflare.com',
  'stripe.com',
  'shopify.com',
  'reddit.com',
  'twitch.tv',
  // Microsoft-hosted
  'microsoft.com',
  'linkedin.com',
  'skype.com',
  'dell.com',
  // Large self-hosted / infrastructure
  'google.com',
  'amazon.com',
  'apple.com',
  'facebook.com',
  'netflix.com',
  'wikipedia.org',
  'mozilla.org',
  'github.com',
  'gitlab.com',
  // Banks and payments
  'paypal.com',
  'jpmorganchase.com',
  'bankofamerica.com',
  'wellsfargo.com',
  'hsbc.com',
  // Government
  'irs.gov',
  'nasa.gov',
  'cisa.gov',
  'gov.uk',
  'europa.eu',
  // Mail providers and senders
  'protonmail.com',
  'fastmail.com',
  'zoho.com',
  'mailchimp.com',
  'sendgrid.com',
  // Known BIMI / MTA-STS publishers
  'cnn.com',
  'ebay.com',
  'bbc.co.uk',
  'nytimes.com',
  // Domains that publish a null MX or no mail at all
  'example.com',
  'gstatic.com',
  'akamai.com',
  // Non-US / other ecosystems
  'yandex.ru',
  'qq.com',
  'alibaba.com',
  'rakuten.co.jp',
];

const RESOLVER = process.env.FIXTURE_RESOLVER ?? '1.1.1.1';

/**
 * `dig +short TXT` prints one record per line, with each <=255-byte chunk as a
 * separate quoted string on that line. Chunks join with NO separator — see
 * plan section 1.2.
 */
function parseDigTxt(stdout) {
  const records = [];
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith(';')) continue;
    const chunks = [...trimmed.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) =>
      m[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\'),
    );
    if (chunks.length > 0) records.push(chunks.join(''));
  }
  return records;
}

function parseDigMx(stdout) {
  const records = [];
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith(';')) continue;
    const m = /^(\d+)\s+(\S+)$/.exec(trimmed);
    if (m) records.push({ preference: Number(m[1]), exchange: m[2] });
  }
  return records;
}

async function dig(name, type) {
  try {
    const { stdout } = await run(
      'dig',
      [`@${RESOLVER}`, '+short', '+time=5', '+tries=2', type, name],
      {
        timeout: 15_000,
      },
    );
    return stdout;
  } catch {
    return '';
  }
}

async function capture(domain) {
  const [apex, dmarc, bimi, mtaSts, tlsRpt, mx] = await Promise.all([
    dig(domain, 'TXT'),
    dig(`_dmarc.${domain}`, 'TXT'),
    dig(`default._bimi.${domain}`, 'TXT'),
    dig(`_mta-sts.${domain}`, 'TXT'),
    dig(`_smtp._tls.${domain}`, 'TXT'),
    dig(domain, 'MX'),
  ]);

  return {
    domain,
    spf: parseDigTxt(apex).filter((r) => r.toLowerCase().startsWith('v=spf1')),
    dmarc: parseDigTxt(dmarc).filter((r) => r.toUpperCase().startsWith('V=DMARC1')),
    bimi: parseDigTxt(bimi).filter((r) => r.toUpperCase().startsWith('V=BIMI1')),
    mtaSts: parseDigTxt(mtaSts).filter((r) => r.toUpperCase().startsWith('V=STSV1')),
    tlsRpt: parseDigTxt(tlsRpt).filter((r) => r.toUpperCase().startsWith('V=TLSRPTV1')),
    mx: parseDigMx(mx),
  };
}

const domains = process.argv.slice(2).length > 0 ? process.argv.slice(2) : DEFAULT_DOMAINS;
const results = [];
for (const domain of domains) {
  const record = await capture(domain);
  results.push(record);
  process.stderr.write(
    `${domain}: spf=${record.spf.length} dmarc=${record.dmarc.length} ` +
      `bimi=${record.bimi.length} sts=${record.mtaSts.length} tlsrpt=${record.tlsRpt.length} ` +
      `mx=${record.mx.length}\n`,
  );
}

const out = new URL('../packages/parsers/test/fixtures/records.json', import.meta.url);
await writeFile(
  out,
  `${JSON.stringify({ capturedAt: new Date().toISOString(), resolver: RESOLVER, domains: results }, null, 2)}\n`,
);
process.stderr.write(`\nwrote ${results.length} domains to ${out.pathname}\n`);
