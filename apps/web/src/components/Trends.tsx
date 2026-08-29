import {
  Area,
  AreaChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { HistoryEntry } from '../lib/types.js';
import { num } from '../lib/format.js';
import { EmptyState, Panel } from './Panel.js';

interface Row {
  date: string;
  reject: number;
  quarantine: number;
  none: number;
  enforce: number;
  testing: number;
}

function toRows(history: HistoryEntry[]): Row[] {
  return history.map((h) => ({
    date: h.date,
    reject: h.totals.dmarc.p.reject ?? 0,
    quarantine: h.totals.dmarc.p.quarantine ?? 0,
    none: h.totals.dmarc.p.none ?? 0,
    enforce: h.totals.mtaSts.mode.enforce ?? 0,
    testing: h.totals.mtaSts.mode.testing ?? 0,
  }));
}

const AXIS = { fill: 'var(--ink-muted)', fontSize: 11 };

export function Trends({ history }: { history: HistoryEntry[] }): React.JSX.Element {
  const rows = toRows(history);

  // A stacked area needs at least two observations to show a trend. Saying so
  // is more useful than drawing a chart with one point in it.
  if (rows.length < 2) {
    return (
      <Panel title="Trends" lede="How enforcement moves over time.">
        <EmptyState headline="Trends need at least two days of history.">
          <p style={{ margin: '0 0 0.5rem' }}>
            There {rows.length === 1 ? 'is 1 day' : 'are no days'} of history so far. The charts
            here fill in as the scheduled crawls accumulate daily aggregates.
          </p>
          <p style={{ margin: 0 }}>
            Add a day locally with <code>observatory crawl --tier 1</code> followed by{' '}
            <code>observatory aggregate</code>.
          </p>
        </EmptyState>
        <HistoryTable rows={rows} />
      </Panel>
    );
  }

  return (
    <>
      <Panel
        title="DMARC policy over time"
        lede="Domains at each policy level. A rising reject band is the headline number for the industry."
      >
        <div style={{ width: '100%', height: 320 }}>
          <ResponsiveContainer>
            <AreaChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
              <CartesianGrid stroke="var(--rule)" vertical={false} />
              <XAxis dataKey="date" tick={AXIS} stroke="var(--rule)" tickMargin={8} />
              <YAxis tick={AXIS} stroke="var(--rule)" width={52} />
              <Tooltip
                contentStyle={{
                  background: 'var(--surface)',
                  border: '1px solid var(--ring)',
                  borderRadius: 8,
                  fontSize: 12,
                  color: 'var(--ink)',
                }}
                formatter={(value: number, name: string) => [num(value), name]}
              />
              <Legend wrapperStyle={{ fontSize: 12, color: 'var(--ink-secondary)' }} />
              <Area
                type="monotone"
                dataKey="reject"
                name="Reject"
                stackId="p"
                stroke="var(--enforce-strong)"
                fill="var(--enforce-strong)"
                strokeWidth={2}
              />
              <Area
                type="monotone"
                dataKey="quarantine"
                name="Quarantine"
                stackId="p"
                stroke="var(--enforce-mid)"
                fill="var(--enforce-mid)"
                strokeWidth={2}
              />
              <Area
                type="monotone"
                dataKey="none"
                name="Monitor only"
                stackId="p"
                stroke="var(--enforce-weak)"
                fill="var(--enforce-weak)"
                strokeWidth={2}
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
        <HistoryTable rows={rows} />
      </Panel>

      <Panel
        title="MTA-STS mode over time"
        lede="Testing means the policy is published but not enforced. The move from testing to enforce is the one worth watching."
      >
        <div style={{ width: '100%', height: 280 }}>
          <ResponsiveContainer>
            <AreaChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
              <CartesianGrid stroke="var(--rule)" vertical={false} />
              <XAxis dataKey="date" tick={AXIS} stroke="var(--rule)" tickMargin={8} />
              <YAxis tick={AXIS} stroke="var(--rule)" width={52} />
              <Tooltip
                contentStyle={{
                  background: 'var(--surface)',
                  border: '1px solid var(--ring)',
                  borderRadius: 8,
                  fontSize: 12,
                  color: 'var(--ink)',
                }}
                formatter={(value: number, name: string) => [num(value), name]}
              />
              <Legend wrapperStyle={{ fontSize: 12, color: 'var(--ink-secondary)' }} />
              <Area
                type="monotone"
                dataKey="enforce"
                name="Enforce"
                stackId="m"
                stroke="var(--enforce-strong)"
                fill="var(--enforce-strong)"
                strokeWidth={2}
              />
              <Area
                type="monotone"
                dataKey="testing"
                name="Testing"
                stackId="m"
                stroke="var(--enforce-mid)"
                fill="var(--enforce-mid)"
                strokeWidth={2}
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </Panel>
    </>
  );
}

/** The chart's data as a table, so the encoding is never visual-only. */
function HistoryTable({ rows }: { rows: Row[] }): React.JSX.Element | null {
  if (rows.length === 0) return null;
  return (
    <details style={{ marginTop: '1rem' }}>
      <summary style={{ cursor: 'pointer', fontSize: '0.82rem', color: 'var(--ink-secondary)' }}>
        View as table
      </summary>
      <div className="table-scroll" style={{ marginTop: '0.75rem' }}>
        <table>
          <caption>Domains at each DMARC policy, by day</caption>
          <thead>
            <tr>
              <th scope="col">Date</th>
              <th scope="col" className="num">
                Reject
              </th>
              <th scope="col" className="num">
                Quarantine
              </th>
              <th scope="col" className="num">
                Monitor only
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.date}>
                <th scope="row" className="record" style={{ fontWeight: 500 }}>
                  {r.date}
                </th>
                <td className="num">{num(r.reject)}</td>
                <td className="num">{num(r.quarantine)}</td>
                <td className="num">{num(r.none)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}
