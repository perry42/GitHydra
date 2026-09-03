import { RecentRepoRow } from "../RecentRepos/RecentRepoRow";
import "./EmptyState.css";

export interface EmptyStateProps {
  title: string;
  description: string;
  /**
   * specs/repo-list.md Must-have 2/AC9: the "No repository open" empty state's "Recent
   * repositories" list — only ever passed by `App.tsx`'s idle-state usage of `EmptyState`, never
   * by its other two ("No commits yet" / "No matching commits") usages, which aren't "no
   * repository open" at all. Omitted (or empty) renders no Recent repositories section — never an
   * empty-but-visible one (AC9's fresh-profile requirement).
   *
   * AC6's busy/not-found bookkeeping is deliberately owned by `App.tsx` (via `useRecentOpenRow`),
   * not local state in this component: clicking a recent entry here drives `graph.status` through
   * `"opening"` and (on failure) briefly `"error"` before settling back to `"idle"` — `MainArea`
   * unmounts this whole component for those transitional renders (it only renders `EmptyState`
   * while `status === "idle"`), so any state owned *inside* `EmptyState` itself would be lost by
   * the time the failure is actually known. `App`-level state survives that unmount/remount.
   */
  recentRepos?: string[];
  notFoundPath?: string | null;
  busyPath?: string | null;
  onOpenRecent?: (path: string) => void;
  onRemoveRecent?: (path: string) => void;
}

/** AC7: a freshly-initialized (zero-commit) repo must show an explicit empty state, not a blank
 * or errored canvas. Reused for any other "nothing to draw" state that isn't itself an error. */
export function EmptyState({
  title,
  description,
  recentRepos = [],
  notFoundPath = null,
  busyPath = null,
  onOpenRecent,
  onRemoveRecent,
}: EmptyStateProps) {
  return (
    <div className="gh-empty-state" role="status">
      <p className="gh-empty-state__title">{title}</p>
      <p className="gh-empty-state__description">{description}</p>
      {recentRepos.length > 0 && (
        <div className="gh-empty-state__recent">
          <p className="gh-empty-state__recent-heading">Recent repositories</p>
          <ul className="gh-empty-state__recent-list">
            {recentRepos.map((path) => (
              <li key={path}>
                <RecentRepoRow
                  path={path}
                  busy={busyPath === path}
                  notFound={notFoundPath === path}
                  onOpen={(p) => onOpenRecent?.(p)}
                  onRemove={(p) => onRemoveRecent?.(p)}
                />
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
