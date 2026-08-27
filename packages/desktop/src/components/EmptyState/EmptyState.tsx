import "./EmptyState.css";

export interface EmptyStateProps {
  title: string;
  description: string;
}

/** AC7: a freshly-initialized (zero-commit) repo must show an explicit empty state, not a blank
 * or errored canvas. Reused for any other "nothing to draw" state that isn't itself an error. */
export function EmptyState({ title, description }: EmptyStateProps) {
  return (
    <div className="gh-empty-state" role="status">
      <p className="gh-empty-state__title">{title}</p>
      <p className="gh-empty-state__description">{description}</p>
    </div>
  );
}
