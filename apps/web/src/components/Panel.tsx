interface Props {
  title: string;
  lede?: string;
  children: React.ReactNode;
  id?: string;
}

export function Panel({ title, lede, children, id }: Props): React.JSX.Element {
  return (
    <section className="panel" aria-labelledby={id ? `${id}-heading` : undefined} id={id}>
      <h2 id={id ? `${id}-heading` : undefined}>{title}</h2>
      {lede !== undefined && <p className="lede">{lede}</p>}
      {children}
    </section>
  );
}

export function EmptyState({
  headline,
  children,
}: {
  headline: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="empty">
      <strong>{headline}</strong>
      {children}
    </div>
  );
}
