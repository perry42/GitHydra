// SPDX-License-Identifier: GPL-3.0-or-later
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
 * specs/repo-list.md Must-have 2/AC6: one row of the "Recent repositories" list — the label
 * derivation (Must-have 2's "consistent with existing tab-label derivation" — `repoTabLabel`, the
 * exact function `TabBar` already uses) and the "not found" + "Try again"/"Remove" treatment live
 * in exactly one place, `EmptyState`'s only caller.
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
        <div className="gh-recent-repo__not-found-actions">
          {/* specs/repo-list.md Must-have 5/AC6 (revised): re-attempts the same open — covers a
           * transient case (a reconnected drive, a network share back online). A second
           * consecutive failure simply leaves this same not-found state showing — no error
           * dialog, no retry-count limit, per the spec. */}
          <button
            type="button"
            className="gh-recent-repo__retry"
            disabled={busy}
            onClick={() => onOpen(path)}
          >
            Try again
          </button>
          <button
            type="button"
            className="gh-recent-repo__remove"
            onClick={() => onRemove(path)}
          >
            Remove from list
          </button>
        </div>
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
