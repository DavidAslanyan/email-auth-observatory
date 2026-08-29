import type { ChangeEvent } from '../lib/types.js';
interface Props {
  events: ChangeEvent[];
  dates: string[];
  date: string;
  onDateChange: (date: string) => void;
}
export declare function Changes({ events, dates, date, onDateChange }: Props): React.JSX.Element;
export {};
