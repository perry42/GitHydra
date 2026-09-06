// SPDX-License-Identifier: GPL-3.0-or-later
import "../StatusBanner/StatusBanner.css";

export interface CherryPickEmptyResultNoticeProps {
  /** Full SHA of the paused commit — only the short (7-char) prefix is ever displayed. */
  targetSha: string;
  targetSubject: string | null;
  /** FR-106: `git cherry-pick --skip` — advance past this step with no commit created for it. */
  onSkip: () => void;
  /** FR-106: `git commit --allow-empty`, reusing this commit's original message verbatim. */
  onCommitEmpty: () => void;
  /** True while a Skip/Commit-empty call is in flight — disables both actions without a global
   * spinner, matching every other row-level busy-state convention in this codebase. */
  busy: boolean;
}

/**
 * specs/cherry-pick.md FR-118: the FR-105 empty-result pause's distinct, non-conflict notice — a
 * commit whose changes are already fully present on this branch produces no conflict
 * (`WorkingDirectoryChanges.conflicted` is empty), so this is deliberately NOT
 * `ConflictResolutionView` (there is nothing to resolve). Named the specific paused commit (short
 * SHA + subject, both text — FR-122) and offers two explicit, equally-valid actions; neither is
 * auto-applied, the choice is the user's. Reuses `StatusBanner`'s exact banner/action-button
 * tokens (same visual family as the persistent operation banner this notice always accompanies)
 * rather than inventing new chrome for what is, structurally, one more status banner.
 */
export function CherryPickEmptyResultNotice({
  targetSha,
  targetSubject,
  onSkip,
  onCommitEmpty,
  busy,
}: CherryPickEmptyResultNoticeProps) {
  const shortSha = targetSha.slice(0, 7);
  return (
    <div className="gh-status-banner-stack">
      <div
        className="gh-status-banner gh-status-banner--neutral gh-status-banner--operation"
        role="status"
        aria-live="polite"
      >
        <span className="gh-status-banner__operation-text">
          <span className="gh-mono">{shortSha}</span>
          {targetSubject ? ` "${targetSubject}"` : ""} has no effect here — its changes are already
          present on this branch.
        </span>
        <span className="gh-status-banner__op-actions">
          <button type="button" className="gh-status-banner__action" onClick={onSkip} disabled={busy}>
            {busy ? "Working…" : "Skip this commit"}
          </button>
          <button type="button" className="gh-status-banner__action" onClick={onCommitEmpty} disabled={busy}>
            {busy ? "Working…" : "Commit anyway (empty)"}
          </button>
        </span>
      </div>
    </div>
  );
}
