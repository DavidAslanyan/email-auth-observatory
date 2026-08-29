import { useMemo, useState } from 'react';
import type { IndexedDomain } from '../lib/types.js';
import { num, providerLabel, qualifierMeaning, qualifierToken, strengthOf } from '../lib/format.js';
import { EmptyState, Panel } from './Panel.js';

/**
 * Client-side only, against a pre-built index of the tier 1 domains. The long
 * tail is deliberately not shipped: 100,000 snapshots would be a multi-megabyte
 * download for a feature most visitors never open, so a domain outside tier 1
 * gets an honest "not in this index" instead of a broken search.
 */
export function Lookup({ index }: { index: IndexedDomain[] }): React.JSX.Element {
  const [query, setQuery] = useState('');
  const needle = query.trim().toLowerCase();

  const matches = useMemo(() => {
    if (needle.length < 2) return [];
    // Rank order, so the domain someone actually meant leads the results.
    return index
      .filter((d) => d.domain.includes(needle))
      .sort((a, b) => a.rank - b.rank)
      .slice(0, 12);
  }, [index, needle]);

  return (
    <Panel
      title="Look up a domain"
      lede={`Current state for any of the ${num(index.length)} domains in the top-1000 index.`}
    >
      <div className="controls">
        <div className="field">
          <label htmlFor="lookup">Domain</label>
          <input
            id="lookup"
            type="search"
            placeholder="cloudflare.com"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
            }}
            autoComplete="off"
            spellCheck={false}
          />
        </div>
      </div>

      {needle.length < 2 && (
        <EmptyState headline="Type at least two characters.">
          <p style={{ margin: 0 }}>
            Try <code>github</code>, <code>.gov</code> or <code>proton</code>.
          </p>
        </EmptyState>
      )}

      {needle.length >= 2 && matches.length === 0 && (
        <EmptyState headline={`No domain matching “${query.trim()}” is in this index.`}>
          <p style={{ margin: 0 }}>
            The index covers the top 1,000 domains only. Longer-tail domains are crawled weekly and
            live in the shard files under <code className="record">data/snapshots/latest/</code>.
          </p>
        </EmptyState>
      )}

      {matches.map((d) => (
        <DomainCard key={d.domain} domain={d} />
      ))}
    </Panel>
  );
}

function DomainCard({ domain: d }: { domain: IndexedDomain }): React.JSX.Element {
  return (
    <article
      style={{
        border: '1px solid var(--rule)',
        borderRadius: 'var(--radius-sm)',
        padding: '0.9rem 1rem',
        marginBottom: '0.75rem',
      }}
    >
      <header style={{ display: 'flex', alignItems: 'baseline', gap: '0.75rem', flexWrap: 'wrap' }}>
        <h3 className="domain" style={{ margin: 0, fontSize: '1rem' }}>
          {d.domain}
        </h3>
        <span style={{ fontSize: '0.78rem', color: 'var(--ink-muted)' }}>rank {num(d.rank)}</span>
        <span
          style={{ marginLeft: 'auto', fontSize: '0.75rem', color: 'var(--ink-muted)' }}
          className="record"
        >
          observed {d.crawledAt.slice(0, 10)}
        </span>
      </header>

      <div className="table-scroll" style={{ marginTop: '0.6rem' }}>
        <table>
          <caption className="visually-hidden">Email authentication records for {d.domain}</caption>
          <tbody>
            <Row
              name="DMARC"
              chip={d.dmarc.p ?? (d.dmarc.present ? 'published' : null)}
              detail={
                d.dmarc.present
                  ? `${d.dmarc.sp === null ? 'no explicit subdomain policy' : `subdomain policy ${d.dmarc.sp}`}${
                      d.dmarc.pct === null ? '' : `, sampling ${d.dmarc.pct}%`
                    }`
                  : 'no record'
              }
              stale={d.dmarc.stale}
            />
            <Row
              name="SPF"
              chip={qualifierToken(d.spf.allQualifier) ?? (d.spf.present ? 'published' : null)}
              detail={
                d.spf.present
                  ? qualifierMeaning(qualifierToken(d.spf.allQualifier) ?? '')
                  : 'no record'
              }
              stale={d.spf.stale}
            />
            <Row
              name="MTA-STS"
              chip={d.mtaSts.mode ?? (d.mtaSts.present ? 'published' : null)}
              detail={
                d.mtaSts.present
                  ? d.mtaSts.mode === null
                    ? 'record published, policy file unreadable'
                    : `policy ${d.mtaSts.mode}`
                  : 'no record'
              }
            />
            <Row
              name="BIMI"
              chip={d.bimi.declined ? 'declined' : d.bimi.present ? 'published' : null}
              detail={
                d.bimi.declined
                  ? 'explicit opt-out'
                  : d.bimi.present
                    ? d.bimi.hasVmc
                      ? 'with a verified mark certificate'
                      : 'logo only, no verified mark'
                    : 'no record'
              }
            />
            <Row
              name="TLS reporting"
              chip={d.tlsRpt.present ? 'published' : null}
              detail={d.tlsRpt.present ? 'accepts TLS-RPT reports' : 'no record'}
            />
            <Row name="DNSSEC" chip={d.dnssec === 'signed' ? 'signed' : null} detail={d.dnssec} />
            <Row
              name="Mail provider"
              chip={null}
              detail={
                d.mx.isNullMx
                  ? 'null MX — this domain deliberately receives no mail'
                  : d.mx.provider === null
                    ? 'no MX records'
                    : `${providerLabel(d.mx.provider)}${d.mx.hosts.length > 0 ? ` · ${d.mx.hosts[0] ?? ''}` : ''}`
              }
            />
            <Row
              name="DKIM selectors"
              chip={null}
              detail={
                d.dkim.selectorsFound.length > 0
                  ? `${d.dkim.selectorsFound.join(', ')} — a lower bound, not a complete list`
                  : d.dkim.probeStrategy === 'skipped'
                    ? 'not probed: this provider generates selectors that cannot be guessed'
                    : 'none of the probed selectors answered, which does not mean there are none'
              }
            />
          </tbody>
        </table>
      </div>
    </article>
  );
}

function Row({
  name,
  chip,
  detail,
  stale,
}: {
  name: string;
  chip: string | null;
  detail: string;
  stale?: boolean;
}): React.JSX.Element {
  return (
    <tr>
      <th scope="row" style={{ textTransform: 'none', fontSize: '0.8rem', width: '9.5rem' }}>
        {name}
      </th>
      <td style={{ width: '7.5rem' }}>
        {chip === null ? (
          <span className="chip" data-strength="absent">
            —
          </span>
        ) : (
          <span className="chip" data-strength={strengthOf(chip)}>
            {chip}
          </span>
        )}
      </td>
      <td style={{ color: 'var(--ink-secondary)' }}>
        {detail}
        {stale === true && (
          <em className="stale-flag" title="Carried forward from an earlier crawl">
            {' '}
            · carried forward
          </em>
        )}
      </td>
    </tr>
  );
}
