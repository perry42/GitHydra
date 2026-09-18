// SPDX-License-Identifier: GPL-3.0-or-later
import { IconClone, IconOpenRepo } from "../Icon/Icon";
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
  /**
   * specs/repo-open-feedback-fixes.md FR-204/FR-205: resolved-path -> originally-picked-path, for
   * whichever `recentRepos` entries genuinely diverge (the subfolder-of-a-larger-repo case) — a
   * path-keyed side-channel exactly like `notFoundPath`/`busyPath` below, not a reshaped
   * `recentRepos` array, so the common non-divergent case needs no new plumbing. Omitted (or
   * missing a given entry's key) renders that entry exactly as it does today.
   */
  divergentPickedPaths?: Record<string, string>;
  notFoundPath?: string | null;
  busyPath?: string | null;
  onOpenRecent?: (path: string) => void;
  onRemoveRecent?: (path: string) => void;
  /**
   * specs/repo-list.md Must-have 2/3/AC10 (revised IA): launches the native OS folder dialog —
   * this screen is now the single surface for opening a repo (there is no more separate
   * "Open repository…" toolbar action). Only passed by `App.tsx`'s "No repository open" usage
   * (same reasoning as `recentRepos` above); omitted for the other two callers, which also omit
   * the whole actions row below (there's nothing to open from "No commits yet"/"No matching
   * commits" — a repo is already open in both).
   */
  onBrowse?: () => void;
  /**
   * specs/online-sync-clone.md FR-351: activates the slot this component used to render
   * permanently disabled (see the button below's own comment) — opens `CloneDialog`. Only passed
   * alongside `onBrowse` (same caller, same gating reasoning as that prop's own doc comment); when
   * omitted, the Clone action is not rendered at all (matches `onBrowse`'s own omitted behavior)
   * rather than rendering a dead button.
   */
  onClone?: () => void;
  /**
   * specs/repo-list.md Must-have 4: true while a browse/recent-open attempt is in flight anywhere
   * on this screen (`useRepoTabs`'s `switching`) — disables "Open a repository" and every recent
   * row so a second overlapping attempt can't be queued, mirroring `TabBar`'s identical
   * `switching`-driven disabling elsewhere in the app.
   */
  disabled?: boolean;
}

/** AC7: a freshly-initialized (zero-commit) repo must show an explicit empty state, not a blank
 * or errored canvas. Reused for any other "nothing to draw" state that isn't itself an error. */
export function EmptyState({
  title,
  description,
  recentRepos = [],
  divergentPickedPaths,
  notFoundPath = null,
  busyPath = null,
  onOpenRecent,
  onRemoveRecent,
  onBrowse,
  onClone,
  disabled = false,
}: EmptyStateProps) {
  return (
    <div className="gh-empty-state" role="status">
      <p className="gh-empty-state__title">{title}</p>
      <p className="gh-empty-state__description">{description}</p>
      {onBrowse && (
        <div className="gh-empty-state__actions">
          <button
            type="button"
            className="gh-empty-state__action gh-empty-state__action--primary"
            onClick={onBrowse}
            disabled={disabled}
          >
            <IconOpenRepo />
            Open a repository
          </button>
          {/* specs/online-sync-clone.md FR-351: the slot specs/repo-list.md Must-have 2/AC11
           * reserved (and deliberately left permanently disabled, no `onClick`) is now live — opens
           * `CloneDialog`. Disabled only while another switch/open is already in flight, same gate
           * "Open a repository" uses immediately above. */}
          {onClone && (
            <button
              type="button"
              className="gh-empty-state__action"
              onClick={onClone}
              disabled={disabled}
            >
              <IconClone />
              Clone a repository
            </button>
          )}
        </div>
      )}
      {recentRepos.length > 0 && (
        <div className="gh-empty-state__recent">
          <p className="gh-empty-state__recent-heading">Recent repositories</p>
          <ul className="gh-empty-state__recent-list">
            {recentRepos.map((path) => (
              <li key={path}>
                <RecentRepoRow
                  path={path}
                  pickedPath={divergentPickedPaths?.[path]}
                  busy={busyPath === path || disabled}
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
