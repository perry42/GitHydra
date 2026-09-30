// SPDX-License-Identifier: GPL-3.0-or-later
import type { LeftBehindInfo } from "../../lib/guardedCheckout";
import "../StatusBanner/StatusBanner.css";

export interface LeftBehindBannerProps {
  info: LeftBehindInfo;
  onCreateBranch: () => void;
  onDismiss: () => void;
}

/** "Left 3 commits behind at abc1234" (count omitted when the guard could not determine it). */
export function leftBehindMessage(info: LeftBehindInfo): string {
  if (info.unknown) return `Left possibly unsaved commits behind at ${info.shortSha}`;
  const n = info.totalIsCapped ? `${info.total}+ commits` : info.total === 1 ? "1 commit" : `${info.total} commits`;
  return `Left ${n} behind at ${info.shortSha}`;
}

/**
 * specs/branch-panel-drag-merge.md FR-430: shown after a confirmed "Leave commits behind" checkout.
 * Same chrome as `CherryPickEmptyResultNotice`/StatusBanner. Session-only (never persisted).
 */
export function LeftBehindBanner({ info, onCreateBranch, onDismiss }: LeftBehindBannerProps) {
  return (
    <div className="gh-status-banner-stack">
      <div
        className="gh-status-banner gh-status-banner--warning gh-status-banner--operation"
        role="status"
        aria-live="polite"
      >
        <span className="gh-status-banner__operation-text">{leftBehindMessage(info)}</span>
        <span className="gh-status-banner__op-actions">
          <button type="button" className="gh-status-banner__action" onClick={onCreateBranch}>
            Create branch at {info.shortSha}
          </button>
          <button type="button" className="gh-status-banner__action" onClick={onDismiss}>
            Dismiss
          </button>
        </span>
      </div>
    </div>
  );
}
