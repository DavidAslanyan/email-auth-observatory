interface Props {
  title: string;
  lede?: string;
  children: React.ReactNode;
  id?: string;
}
export declare function Panel({ title, lede, children, id }: Props): React.JSX.Element;
export declare function EmptyState({
  headline,
  children,
}: {
  headline: string;
  children: React.ReactNode;
}): React.JSX.Element;
export {};
