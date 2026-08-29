import type { Aggregate } from '../lib/types.js';
import { num, providerLabel, share } from '../lib/format.js';
import { PostureRibbon, type RibbonSegment } from './PostureRibbon.js';
import { EmptyState, Panel } from './Panel.js';

function dmarcSegments(a: Aggregate): RibbonSegment[] {
  const p = a.totals.dmarc.p;
  return [
    { key: 'reject', label: 'Reject', count: p.reject ?? 0, strength: 'strong' },
    { key: 'quarantine', label: 'Quarantine', count: p.quarantine ?? 0, strength: 'mid' },
    { key: 'none', label: 'Monitor only', count: p.none ?? 0, strength: 'weak' },
    {
      key: 'absent',
      label: 'No DMARC',
      count: a.domainsObserved - a.totals.dmarc.present,
      strength: 'absent',
    },
  ];
}

function spfSegments(a: Aggregate): RibbonSegment[] {
  const q = a.totals.spf.allQualifier;
  return [
    { key: '-all', label: 'Hard fail', count: q['-all'] ?? 0, strength: 'strong' },
    { key: '~all', label: 'Soft fail', count: q['~all'] ?? 0, strength: 'mid' },
    {
      key: 'weak',
      label: 'Neutral or pass-all',
      count: (q['?all'] ?? 0) + (q['+all'] ?? 0),
      strength: 'weak',
    },
    {
      key: 'absent',
      label: 'No SPF',
      count: a.domainsObserved - a.totals.spf.present,
      strength: 'absent',
    },
  ];
}

interface ProviderRow {
  provider: string;
  domains: number;
  rejectRate: number;
  rejects: number;
}

function providerRows(a: Aggregate): ProviderRow[] {
  return Object.entries(a.byMxProvider)
    .filter(([provider, slice]) => slice.domainsObserved >= 10 && provider !== 'none')
    .map(([provider, slice]) => {
      const rejects = slice.totals.dmarc.p.reject ?? 0;
      return {
        provider,
        domains: slice.domainsObserved,
        rejects,
        rejectRate: rejects / slice.domainsObserved,
      };
    })
    .sort((x, y) => y.rejectRate - x.rejectRate);
}

export function Overview({ aggregate }: { aggregate: Aggregate }): React.JSX.Element {
  const a = aggregate;
  const providers = providerRows(a);

  return (
    <>
      <Panel
        title="DMARC enforcement across the ranking"
        lede={`Where the ${num(a.domainsObserved)} domains observed on ${a.date} sit on the DMARC policy scale, strongest first.`}
        id="posture"
      >
        <PostureRibbon
          segments={dmarcSegments(a)}
          total={a.domainsObserved}
          tableCaption="DMARC policy distribution"
        />
      </Panel>

      <Panel
        title="SPF enforcement"
        lede="The qualifier on the final all mechanism, which decides what a receiver does with mail that fails SPF."
      >
        <PostureRibbon
          segments={spfSegments(a)}
          total={a.domainsObserved}
          tableCaption="SPF enforcement distribution"
        />
      </Panel>

      <Panel title="Adoption" lede="Share of observed domains publishing each mechanism.">
        <dl className="tiles">
          <Tile
            label="SPF"
            value={share(a.totals.spf.present, a.domainsObserved)}
            sub={`${num(a.totals.spf.present)} domains`}
          />
          <Tile
            label="DMARC"
            value={share(a.totals.dmarc.present, a.domainsObserved)}
            sub={`${num(a.totals.dmarc.present)} domains`}
          />
          <Tile
            label="MTA-STS"
            value={share(a.totals.mtaSts.present, a.domainsObserved)}
            sub={`${num(a.totals.mtaSts.mode.enforce ?? 0)} enforcing, ${num(a.totals.mtaSts.mode.testing ?? 0)} testing`}
          />
          <Tile
            label="TLS reporting"
            value={share(a.totals.tlsRpt.present, a.domainsObserved)}
            sub={`${num(a.totals.tlsRpt.present)} domains`}
          />
          <Tile
            label="BIMI"
            value={share(a.totals.bimi.present, a.domainsObserved)}
            sub={`${num(a.totals.bimi.hasVmc)} with a verified mark`}
          />
          <Tile
            label="DNSSEC"
            value={share(a.totals.dnssec.signed ?? 0, a.domainsObserved)}
            sub={`${num(a.totals.dnssec.signed ?? 0)} signed zones`}
          />
        </dl>
        <p className="footnote" style={{ marginTop: '1rem' }}>
          DKIM is deliberately absent from this list. Selectors cannot be enumerated from DNS, so
          any DKIM adoption figure would be a guess dressed as a measurement. See{' '}
          <a href="https://github.com/DavidAslanyan/email-auth-observatory/blob/main/docs/METHODOLOGY.md">
            the methodology
          </a>
          .
        </p>
      </Panel>

      <Panel
        title="Enforcement by mail provider"
        lede="Share of each provider's domains publishing DMARC at reject. Providers with fewer than ten domains observed are omitted."
      >
        {providers.length === 0 ? (
          <EmptyState headline="No provider has enough domains yet.">
            <p style={{ margin: 0 }}>
              Provider breakdowns appear once at least ten domains share a mail provider. Crawl more
              of the ranking with <code>observatory crawl --tier 2 --auto</code>.
            </p>
          </EmptyState>
        ) : (
          <div className="table-scroll">
            <table>
              <caption>Domains at DMARC reject, by mail provider, on {a.date}</caption>
              <thead>
                <tr>
                  <th scope="col">Provider</th>
                  <th scope="col">At reject</th>
                  <th scope="col" className="num">
                    Rate
                  </th>
                  <th scope="col" className="num">
                    Domains
                  </th>
                </tr>
              </thead>
              <tbody>
                {providers.map((row) => (
                  <tr key={row.provider}>
                    <th scope="row" style={{ fontWeight: 500 }}>
                      {providerLabel(row.provider)}
                    </th>
                    <td>
                      <div className="bar-track" aria-hidden="true">
                        <div
                          className="bar-fill"
                          style={{ width: `${Math.max(row.rejectRate * 100, 1)}%` }}
                        />
                      </div>
                    </td>
                    <td className="num">{(row.rejectRate * 100).toFixed(0)}%</td>
                    <td className="num">{num(row.domains)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </>
  );
}

function Tile({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub: string;
}): React.JSX.Element {
  return (
    <div className="tile">
      <dt>{label}</dt>
      <dd>
        {value}
        <span className="tile-sub">{sub}</span>
      </dd>
    </div>
  );
}
