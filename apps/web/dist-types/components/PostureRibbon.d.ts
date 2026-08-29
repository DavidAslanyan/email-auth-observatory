import type { Strength } from '../lib/format.js';
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
export declare function PostureRibbon({ segments, total, tableCaption }: Props): React.JSX.Element;
/** The same grammar at 8px, for a table row. */
export declare function MiniRibbon({
  segments,
  total,
  label,
}: {
  segments: RibbonSegment[];
  total: number;
  label: string;
}): React.JSX.Element;
export {};
