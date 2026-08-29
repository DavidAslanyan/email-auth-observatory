import { Suspense, lazy, useEffect, useState } from 'react';
import type { Aggregate, ChangeEvent, HistoryEntry, IndexedDomain, Manifest } from './lib/types.js';
import {
  DataError,
  loadAggregate,
  loadChanges,
  loadHistory,
  loadIndex,
  loadManifest,
} from './lib/data.js';
import { num } from './lib/format.js';
import { Changes } from './components/Changes.js';
import { EmptyState, Panel } from './components/Panel.js';
import { Lookup } from './components/Lookup.js';
import { Overview } from './components/Overview.js';
import { Reports } from './components/Reports.js';

/* recharts is the single largest dependency and only the Trends tab uses it.
   Splitting it out keeps it off the critical path for every other tab. */
const Trends = lazy(async () => ({ default: (await import('./components/Trends.js')).Trends }));

const TABS = ['Overview', 'Trends', 'Changes', 'Reports', 'Lookup'] as const;
type Tab = (typeof TABS)[number];

interface Loaded {
  manifest: Manifest;
  aggregate: Aggregate;
  history: HistoryEntry[];
  index: IndexedDomain[];
}

export function App(): React.JSX.Element {
  const [tab, setTab] = useState<Tab>('Overview');
  const [data, setData] = useState<Loaded | undefined>(undefined);
  const [error, setError] = useState<DataError | undefined>(undefined);

  const [changeDate, setChangeDate] = useState('');
  const [changes, setChanges] = useState<ChangeEvent[]>([]);

  useEffect(() => {
    Promise.all([loadManifest(), loadAggregate(), loadHistory(), loadIndex()])
      .then(([manifest, aggregate, history, index]) => {
        setData({ manifest, aggregate, history, index });
        const latest = manifest.changes.at(-1);
        if (latest !== undefined) setChangeDate(latest);
      })
      .catch((e: unknown) => {
        setError(
          e instanceof DataError
            ? e
            : new DataError('The dashboard data could not be loaded.', 'Reload the page.'),
        );
      });
  }, []);

  useEffect(() => {
    if (changeDate === '') return;
    let cancelled = false;
    loadChanges(changeDate)
      .then((e) => {
        if (!cancelled) setChanges(e);
      })
      .catch(() => {
        if (!cancelled) setChanges([]);
      });
    return () => {
      cancelled = true;
    };
  }, [changeDate]);

  if (error !== undefined) {
    return (
      <div className="shell">
        <Masthead />
        <Panel title="Data unavailable">
          <EmptyState headline={error.what}>
            <p style={{ margin: 0 }}>{error.remedy}</p>
          </EmptyState>
        </Panel>
      </div>
    );
  }

  if (data === undefined) {
    return (
      <div className="shell">
        <Masthead />
        <p className="footnote" aria-live="polite">
          Loading the latest crawl…
        </p>
      </div>
    );
  }

  const { manifest, aggregate, history, index } = data;
  const changeDates = [...manifest.changes].reverse();

  return (
    <>
      <a className="skip-link" href="#tabpanel">
        Skip to content
      </a>
      <div className="shell">
        <Masthead aggregate={aggregate} />

        {/* Full ARIA tabs pattern: a tablist parent, roving tabindex so Tab
            enters the group once, and arrow keys to move within it. */}
        <main id="main">
          <div className="tabs" role="tablist" aria-label="Sections">
            {TABS.map((t) => (
              <button
                key={t}
                type="button"
                role="tab"
                id={`tab-${t}`}
                aria-controls="tabpanel"
                aria-selected={tab === t}
                tabIndex={tab === t ? 0 : -1}
                onClick={() => {
                  setTab(t);
                }}
                onKeyDown={(event) => {
                  const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
                  if (step === 0) {
                    if (event.key === 'Home') setTab(TABS[0]);
                    else if (event.key === 'End') setTab(TABS[TABS.length - 1] ?? TABS[0]);
                    else return;
                  } else {
                    const next = TABS[(TABS.indexOf(t) + step + TABS.length) % TABS.length];
                    if (next !== undefined) setTab(next);
                  }
                  event.preventDefault();
                }}
                ref={(node) => {
                  // Move real focus with the selection, so the arrow keys read
                  // the newly selected tab rather than leaving focus behind.
                  if (node && tab === t && document.activeElement?.getAttribute('role') === 'tab') {
                    node.focus();
                  }
                }}
              >
                {t}
              </button>
            ))}
          </div>

          <div id="tabpanel" role="tabpanel" tabIndex={-1} aria-labelledby={`tab-${tab}`}>
            {aggregate.degraded && (
              <Panel title="This crawl was degraded">
                <EmptyState
                  headline={`Unknown rate ${(aggregate.unknownRate * 100).toFixed(2)}%, above the 2% threshold.`}
                >
                  <p style={{ margin: 0 }}>
                    Affected records were carried forward from their last successful observation and
                    produced no change events. Read the figures below as a lower bound on change,
                    not as a drop in adoption.
                  </p>
                </EmptyState>
              </Panel>
            )}

            {tab === 'Overview' && <Overview aggregate={aggregate} />}
            {tab === 'Trends' && (
              <Suspense
                fallback={
                  <p className="footnote" aria-live="polite">
                    Loading charts…
                  </p>
                }
              >
                <Trends history={history} />
              </Suspense>
            )}
            {tab === 'Changes' && (
              <Changes
                events={changes}
                dates={changeDates}
                date={changeDate}
                onDateChange={setChangeDate}
              />
            )}
            {tab === 'Reports' && <Reports dates={[...manifest.reports].reverse()} />}
            {tab === 'Lookup' && <Lookup index={index} />}
          </div>
        </main>

        <footer className="footnote" style={{ marginTop: '2rem' }}>
          <p>
            Code is MIT. The dataset is CC BY 4.0. Rankings derive from the{' '}
            <a href="https://tranco-list.eu/">Tranco list</a>, list{' '}
            <code className="record">{aggregate.listId}</code>.
          </p>
          <p>
            DKIM findings are a lower bound, SPF lookup counts are not recursive, and the long tail
            is observed weekly rather than daily. The{' '}
            <a href="https://github.com/DavidAslanyan/mailscape/blob/main/docs/METHODOLOGY.md">
              methodology
            </a>{' '}
            explains why.
          </p>
        </footer>
      </div>
    </>
  );
}

function Masthead({ aggregate }: { aggregate?: Aggregate }): React.JSX.Element {
  return (
    <header className="masthead">
      <h1>mailscape</h1>
      <p className="tagline">
        Email authentication posture across the internet&rsquo;s top domains
      </p>
      {aggregate !== undefined && (
        <div className="meta">
          <span>{aggregate.date}</span>
          <span>{num(aggregate.domainsObserved)} domains</span>
          <span>list {aggregate.listId}</span>
        </div>
      )}
    </header>
  );
}
