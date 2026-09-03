import { repoTabLabel } from "../../lib/repoLabel";
import "./RecentRepoRow.css";

export interface RecentRepoRowProps {
  path: string;
  /** True while this specific entry's open attempt is in flight — disables the row so a fast
   * double-click can't queue up a second overlapping attempt for the same path. */
  busy?: boolean;
  /** specs/repo-list.md AC6: true once this entry's own click attempt resolved "not found". */
  notFound: boolean;
  onOpen: (path: string) => void;
  onRemove: (path: string) => void;
}

/**
 * specs/repo-list.md Must-have 2/AC6: one row of the "Recent repositories" list — shared between
 * `EmptyState`'s inline list and `OpenRepoMenu`'s popover so the label derivation (Must-have 2's
 * "consistent with existing tab-label derivation" — `repoTabLabel`, the exact function `TabBar`
 * already uses) and the "not found" + "remove from list" treatment can never drift between the
 * two surfaces.
 */
export function RecentRepoRow({ path, busy = false, notFound, onOpen, onRemove }: RecentRepoRowProps) {
  const label = repoTabLabel(path);

  if (notFound) {
    return (
      <div className="gh-recent-repo gh-recent-repo--not-found">
        <div className="gh-recent-repo__info">
          <span className="gh-recent-repo__label">{label}</span>
          <span className="gh-recent-repo__path gh-mono">{path}</span>
        </div>
        <p className="gh-recent-repo__not-found-message" role="alert">
          Not found — this repository may have been moved or deleted.
        </p>
        <button
          type="button"
          className="gh-recent-repo__remove"
          onClick={() => onRemove(path)}
        >
          Remove from list
        </button>
      </div>
    );
  }

  return (
    <button
      type="button"
      className="gh-recent-repo"
      disabled={busy}
      title={path}
      onClick={() => onOpen(path)}
    >
      <span className="gh-recent-repo__label">{label}</span>
      <span className="gh-recent-repo__path gh-mono">{path}</span>
    </button>
  );
}
