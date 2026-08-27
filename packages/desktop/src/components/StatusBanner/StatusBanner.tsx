import type { ReactNode } from "react";
import type { InProgressOperation, RepositoryState } from "@githydra/git-core";
import "./StatusBanner.css";

export interface StatusBannerProps {
  repoState: RepositoryState;
  hasExternalChanges: boolean;
  onRefresh: () => void;
}

const OPERATION_LABEL: Record<Exclude<InProgressOperation, null>, string> = {
  merge: "Merge in progress",
  rebase: "Rebase in progress",
  am: "Applying patches (am) in progress",
  "cherry-pick": "Cherry-pick in progress",
  revert: "Revert in progress",
  bisect: "Bisect in progress",
};

/** FR-5: the graph must label an in-progress operation rather than silently rendering HEAD as if
 * nothing were happening. Also surfaces detached HEAD / bare / shallow context (edge cases) and
 * the FR-6 "history changed externally" manual-refresh prompt. */
export function StatusBanner({ repoState, hasExternalChanges, onRefresh }: StatusBannerProps) {
  const banners: ReactNode[] = [];

  if (repoState.inProgressOperation) {
    banners.push(
      <div key="op" className="gh-status-banner gh-status-banner--serious" role="status">
        {OPERATION_LABEL[repoState.inProgressOperation]}
      </div>,
    );
  }
  if (repoState.isDetachedHead) {
    banners.push(
      <div key="detached" className="gh-status-banner gh-status-banner--serious" role="status">
        Detached HEAD — not on a branch tip
      </div>,
    );
  }
  if (repoState.isBare) {
    banners.push(
      <div key="bare" className="gh-status-banner gh-status-banner--neutral" role="status">
        Bare repository — no working directory
      </div>,
    );
  }
  if (repoState.isShallow) {
    banners.push(
      <div key="shallow" className="gh-status-banner gh-status-banner--neutral" role="status">
        Shallow clone — history is truncated (see boundary markers below)
      </div>,
    );
  }
  if (hasExternalChanges) {
    banners.push(
      <div key="external" className="gh-status-banner gh-status-banner--warning" role="alert">
        <span>History changed outside GitHydra.</span>
        <button type="button" onClick={onRefresh} className="gh-status-banner__action">
          Refresh
        </button>
      </div>,
    );
  }

  if (banners.length === 0) return null;
  return <div className="gh-status-banner-stack">{banners}</div>;
}
