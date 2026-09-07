// SPDX-License-Identifier: GPL-3.0-or-later
import { RecentRepoRow } from "../RecentRepos/RecentRepoRow";
import "../EmptyState/EmptyState.css";

export interface TabNotFoundStateProps {
  /** The restored (or otherwise gone-stale) tab's repo path. */
  path: string;
  /** True while a retry attempt for this exact tab is in flight — disables the row, mirroring
   * `RecentRepoRow`'s own `busy` treatment for a recent-list entry mid-retry. */
  busy: boolean;
  onRetry: () => void;
  onRemove: () => void;
}

/**
 * specs/restore-tabs-on-relaunch.md FR-212/AC5: shown in place of the commit graph when the
 * currently-active tab's `repoPath` failed to resolve to a valid repo (most realistically, a
 * restored tab from a previous session whose repo was moved/deleted since) — reuses
 * `RecentRepoRow`'s own "not found" + "Try again"/"Remove from list" treatment verbatim
 * (`specs/repo-list.md`'s already-shipped stale-recent-entry pattern), inside the same
 * `EmptyState`-shaped wrapper every other "nothing to draw here" state in this app already uses,
 * so this reads as "the same kind of thing" rather than a new, one-off error surface.
 */
export function TabNotFoundState({ path, busy, onRetry, onRemove }: TabNotFoundStateProps) {
  return (
    <div className="gh-empty-state" role="status">
      <p className="gh-empty-state__title">Repository not found</p>
      <p className="gh-empty-state__description">
        This repository could not be located. It may have been moved, deleted, or is on a drive
        that isn&apos;t currently connected.
      </p>
      <div className="gh-empty-state__recent">
        <ul className="gh-empty-state__recent-list">
          <li>
            <RecentRepoRow path={path} notFound busy={busy} onOpen={onRetry} onRemove={onRemove} />
          </li>
        </ul>
      </div>
    </div>
  );
}
