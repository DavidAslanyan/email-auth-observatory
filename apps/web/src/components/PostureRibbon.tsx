import type { Strength } from '../lib/format.js';
import { STRENGTH_INK, STRENGTH_VAR, num, share } from '../lib/format.js';

export interface RibbonSegment {
  key: string;
  label: string;
  count: number;
  strength: Strength;
}

interface Props {
  segments: RibbonSegment[];
  total: number;
  /** Caption for the table view that carries the same numbers. */
  tableCaption: string;
}

/**
 * The signature element. One continuous band showing the whole population's
 * enforcement distribution, ordered strongest to weakest, with absence as a
 * neutral tail.
 *
 * The identical numbers are also emitted as a real table, visually hidden, so
 * the encoding is never colour-alone and a screen reader gets the data rather
 * than a decorative div.
 */
export function PostureRibbon({ segments, total, tableCaption }: Props): React.JSX.Element {
  const shown = segments.filter((s) => s.count > 0);

  return (
    <figure style={{ margin: 0 }}>
      <div className="ribbon" role="presentation">
        {shown.map((segment) => {
          const percent = (segment.count / total) * 100;
          // Below about 9% the label cannot fit; the legend and the table carry
          // it instead of letting text spill out of the segment.
          const roomy = percent >= 9;
          return (
            <div
              key={segment.key}
              className={`ribbon-segment ${STRENGTH_INK[segment.strength]}`}
              style={{ flexGrow: segment.count, background: STRENGTH_VAR[segment.strength] }}
              title={`${segment.label}: ${num(segment.count)} of ${num(total)} (${percent.toFixed(1)}%)`}
            >
              {roomy && (
                <>
                  <span className="seg-value">{percent.toFixed(1)}%</span>
                  <span className="seg-label">{segment.label}</span>
                </>
              )}
            </div>
          );
        })}
      </div>

      <ul className="ribbon-legend">
        {shown.map((segment) => (
          <li key={segment.key}>
            <span className="swatch" style={{ background: STRENGTH_VAR[segment.strength] }} />
            {segment.label} · {num(segment.count)}
          </li>
        ))}
      </ul>

      <table className="visually-hidden">
        <caption>{tableCaption}</caption>
        <thead>
          <tr>
            <th scope="col">Policy</th>
            <th scope="col">Domains</th>
            <th scope="col">Share</th>
          </tr>
        </thead>
        <tbody>
          {shown.map((segment) => (
            <tr key={segment.key}>
              <th scope="row">{segment.label}</th>
              <td>{num(segment.count)}</td>
              <td>{share(segment.count, total)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}

/** The same grammar at 8px, for a table row. */
export function MiniRibbon({
  segments,
  total,
  label,
}: {
  segments: RibbonSegment[];
  total: number;
  label: string;
}): React.JSX.Element {
  return (
    <span className="ribbon-mini" role="img" aria-label={label}>
      {segments
        .filter((s) => s.count > 0)
        .map((segment) => (
          <span
            key={segment.key}
            style={{ flexGrow: segment.count, background: STRENGTH_VAR[segment.strength] }}
          />
        ))}
      {total === 0 && <span style={{ flexGrow: 1, background: 'var(--absent)' }} />}
    </span>
  );
}
