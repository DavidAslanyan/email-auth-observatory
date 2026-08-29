import { useMemo, useState } from 'react';
import type { ChangeEvent } from '../lib/types.js';
import {
  DIRECTION_GLYPH,
  directionOf,
  fieldLabel,
  num,
  providerLabel,
  strengthOf,
  valueLabel,
  type Direction,
} from '../lib/format.js';
import { EmptyState, Panel } from './Panel.js';

interface Props {
  events: ChangeEvent[];
  dates: string[];
  date: string;
  onDateChange: (date: string) => void;
}

const MAX_ROWS = 300;

export function Changes({ events, dates, date, onDateChange }: Props): React.JSX.Element {
  const [field, setField] = useState('all');
  const [provider, setProvider] = useState('all');
  const [direction, setDirection] = useState<'all' | Direction>('all');
  // Hide first sightings only when there is something else to look at.
  // On the first day of a dataset every event is a first sighting, and
  // defaulting to "hidden" would greet a new visitor with an empty table.
  const [hideFirstSeen, setHideFirstSeen] = useState(() =>
    events.some((e) => e.kind !== 'first_seen'),
  );

  const fields = useMemo(() => [...new Set(events.map((e) => e.field))].sort(), [events]);
  const providers = useMemo(
    () =>
      [
        ...new Set(events.map((e) => e.mxProvider).filter((p): p is string => p !== undefined)),
      ].sort(),
    [events],
  );

  const filtered = useMemo(
    () =>
      events.filter((e) => {
        if (hideFirstSeen && e.kind === 'first_seen') return false;
        if (field !== 'all' && e.field !== field) return false;
        if (provider !== 'all' && e.mxProvider !== provider) return false;
        if (direction !== 'all' && directionOf(e) !== direction) return false;
        return true;
      }),
    [events, field, provider, direction, hideFirstSeen],
  );

  const firstSeenCount = events.filter((e) => e.kind === 'first_seen').length;

  return (
    <Panel
      title="Recent changes"
      lede="Every observed change, as recorded. A change is dated when it was observed, not when it happened."
    >
      <div className="controls">
        <div className="field">
          <label htmlFor="ch-date">Date</label>
          <select
            id="ch-date"
            value={date}
            onChange={(e) => {
              onDateChange(e.target.value);
            }}
          >
            {dates.map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>
        </div>

        <div className="field">
          <label htmlFor="ch-field">Field</label>
          <select
            id="ch-field"
            value={field}
            onChange={(e) => {
              setField(e.target.value);
            }}
          >
            <option value="all">All fields</option>
            {fields.map((f) => (
              <option key={f} value={f}>
                {fieldLabel(f)}
              </option>
            ))}
          </select>
        </div>

        <div className="field">
          <label htmlFor="ch-provider">Provider</label>
          <select
            id="ch-provider"
            value={provider}
            onChange={(e) => {
              setProvider(e.target.value);
            }}
          >
            <option value="all">All providers</option>
            {providers.map((p) => (
              <option key={p} value={p}>
                {providerLabel(p)}
              </option>
            ))}
          </select>
        </div>

        <div className="field">
          <label htmlFor="ch-direction">Direction</label>
          <select
            id="ch-direction"
            value={direction}
            onChange={(e) => {
              setDirection(e.target.value as 'all' | Direction);
            }}
          >
            <option value="all">Any direction</option>
            <option value="strengthening">Strengthening</option>
            <option value="weakening">Weakening</option>
            <option value="neutral">Neutral</option>
          </select>
        </div>

        <button
          type="button"
          className="toggle"
          aria-pressed={hideFirstSeen}
          onClick={() => {
            setHideFirstSeen((v) => !v);
          }}
        >
          {hideFirstSeen ? 'Hiding' : 'Showing'} first sightings ({num(firstSeenCount)})
        </button>
      </div>

      {filtered.length === 0 ? (
        <EmptyState headline="Nothing matches these filters.">
          <p style={{ margin: 0 }}>
            {events.length === 0
              ? 'No changes were recorded on this date. A quiet day is recorded as a quiet day.'
              : 'Widen a filter, or turn first sightings back on to see domains entering the dataset.'}
          </p>
        </EmptyState>
      ) : (
        <>
          <div className="table-scroll">
            <table>
              <caption>
                {num(filtered.length)} of {num(events.length)} changes on {date}
              </caption>
              <thead>
                <tr>
                  <th scope="col" className="num">
                    Rank
                  </th>
                  <th scope="col">Domain</th>
                  <th scope="col">What changed</th>
                  <th scope="col">From</th>
                  <th scope="col">To</th>
                  <th scope="col">Direction</th>
                  <th scope="col">Provider</th>
                </tr>
              </thead>
              <tbody>
                {filtered.slice(0, MAX_ROWS).map((e, i) => {
                  const dir = directionOf(e);
                  return (
                    <tr key={`${e.domain}-${e.field}-${i}`}>
                      <td className="num">{num(e.rank)}</td>
                      <th scope="row" className="domain" style={{ fontWeight: 500 }}>
                        {e.domain}
                      </th>
                      <td>{fieldLabel(e.field)}</td>
                      <td>
                        <span className="chip" data-strength={strengthOf(String(e.from))}>
                          {valueLabel(e.from)}
                        </span>
                      </td>
                      <td>
                        <span className="chip" data-strength={strengthOf(String(e.to))}>
                          {valueLabel(e.to)}
                        </span>
                      </td>
                      <td>
                        {/* Never colour alone: glyph and word always present. */}
                        <span className="dir" data-dir={dir}>
                          <span className="glyph" aria-hidden="true">
                            {DIRECTION_GLYPH[dir]}
                          </span>
                          {dir}
                        </span>
                      </td>
                      <td>{e.mxProvider === undefined ? '—' : providerLabel(e.mxProvider)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {filtered.length > MAX_ROWS && (
            <p className="footnote" style={{ marginTop: '0.75rem' }}>
              Showing the first {num(MAX_ROWS)} of {num(filtered.length)} matches. Narrow a filter
              to see the rest, or read the full file at{' '}
              <code className="record">data/changes/{date}.jsonl</code>.
            </p>
          )}
        </>
      )}
    </Panel>
  );
}
