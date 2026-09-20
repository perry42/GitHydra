// SPDX-License-Identifier: GPL-3.0-or-later
import { useEffect, useId, useRef, useState } from "react";
import type { CommitPairRelationship, ResetMode } from "@githydra/git-core";
import type { GitHydraApi, WorkingDirectoryStatus } from "../../../shared/ipcContract";
import { unwrap } from "../../hooks/gitHydraClient";
import { useDialogChrome } from "../../hooks/useDialogChrome";
import { computeResetModeDisabledReason } from "../../lib/resetEligibility";
import { describeResetHardDangerCounts, describeResetImpact, type ResetImpact } from "../../lib/resetImpact";
import "./ResetBranchDialog.css";

export interface ResetBranchDialogTarget {
  sha: string;
  abbrevSha: string;
  subject: string;
}

export interface ResetBranchDialogProps {
  api: GitHydraApi;
  target: ResetBranchDialogTarget;
  /** The current branch's name, or the literal string "HEAD" when detached — substituted for
   * "{branch}" throughout this dialog's copy (specs/reset-to-here.md Edge cases). */
  branchLabel: string;
  headSha: string | null;
  /** FR-369: the live danger-callout preview — this is deliberately the caller's already-loaded
   * (possibly slightly stale) value, used only to decide whether to SHOW the callout while the user
   * is choosing a mode. The real gating decision for whether a second confirmation is required
   * happens against a fresh read once the user actually clicks Reset (`useResetActions.requestReset`
   * — see its own doc comment for why that distinction matters). */
  workingDirStatus: WorkingDirectoryStatus | null;
  /** True while a reset (or its own fresh dirty-check) triggered by this dialog's own primary
   * action is in flight. */
  busy: boolean;
  onConfirm: (mode: ResetMode) => void;
  onClose: () => void;
}

const MODE_OPTIONS: ReadonlyArray<{ mode: ResetMode; label: string; describe: (branchLabel: string) => string }> = [
  {
    mode: "soft",
    label: "Soft",
    describe: (b) => `Move ${b} here. Keep all changes from the undone commits staged, ready to re-commit.`,
  },
  {
    mode: "mixed",
    label: "Mixed",
    describe: (b) => `Move ${b} here. Keep all changes from the undone commits, but unstaged.`,
  },
  {
    mode: "hard",
    label: "Hard",
    describe: (b) =>
      `Move ${b} here. Permanently discard all changes from the undone commits, and any uncommitted changes to tracked files. Untracked files are not touched.`,
  },
];

/**
 * specs/reset-to-here.md FR-367/FR-368/FR-369/FR-370: the mode-selection dialog opened from the
 * commit graph's "Reset {branch} to here…" context-menu item. All three modes are always rendered
 * simultaneously (never a single "reset" action that silently picks one, and Hard is never
 * pre-selected or hidden behind a secondary disclosure) — Soft is the pre-selected default, per the
 * roadmap's "default to a non-destructive form" instruction.
 */
export function ResetBranchDialog({
  api,
  target,
  branchLabel,
  headSha,
  workingDirStatus,
  busy,
  onConfirm,
  onClose,
}: ResetBranchDialogProps) {
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const isAtHead = target.sha === headSha;
  // FR-367's "Soft is the pre-selected default" assumes a selectable Soft — at AC9's "already at
  // this commit" target, Soft/Mixed start disabled (FR-370), so defaulting to them would open the
  // dialog with its own primary action already disabled for no reason visible except a tooltip.
  // Hard (always enabled) is the only sensible default there instead.
  const [mode, setMode] = useState<ResetMode>(() => (isAtHead ? "hard" : "soft"));
  const [impact, setImpact] = useState<ResetImpact | null>(null);

  const { onOverlayMouseDown } = useDialogChrome({
    onEscape: onClose,
    escapeDeps: [onClose],
    refocusWithEscapeEffect: true,
    getFocusTarget: () => dialogRef.current?.querySelector<HTMLElement>("input,button") ?? null,
    onBackdropClick: onClose,
  });

  // FR-368: computed once, when the dialog opens — `target`/`headSha`/`branchLabel` are all fixed
  // for this dialog's lifetime (it closes and reopens fresh for a different target/repo state).
  useEffect(() => {
    if (isAtHead) {
      setImpact(describeResetImpact("same", null, branchLabel));
      return;
    }
    if (!headSha) return; // Unreachable in practice — no commit rows exist to open this dialog from.
    let cancelled = false;
    void (async () => {
      let relationship: CommitPairRelationship | null = null;
      try {
        relationship = unwrap(await api.computeCommitPairRelationship(target.sha, headSha));
      } catch {
        relationship = null;
      }
      if (cancelled || relationship === null) return;
      let count: number | null = null;
      try {
        count = unwrap(await api.countCommitsExclusiveToHead(target.sha, headSha));
      } catch {
        count = null;
      }
      if (cancelled) return;
      setImpact(describeResetImpact(relationship, count, branchLabel));
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `api` is a stable bridge instance for the lifetime of an open repo.
  }, [target.sha, headSha, branchLabel, isAtHead]);

  const dangerText =
    mode === "hard"
      ? describeResetHardDangerCounts(
          workingDirStatus?.staged ?? 0,
          workingDirStatus?.unstaged ?? 0,
          workingDirStatus?.conflicted ?? 0,
        )
      : null;

  const modeDisabledReason = computeResetModeDisabledReason(mode, isAtHead);

  return (
    <div className="gh-reset-dialog__overlay" onMouseDown={onOverlayMouseDown}>
      <div ref={dialogRef} className="gh-reset-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <h2 id={titleId} className="gh-reset-dialog__title">
          Reset {branchLabel} to here…
        </h2>
        <p className="gh-reset-dialog__target">
          <span className="gh-mono">{target.abbrevSha}</span> {target.subject}
        </p>

        <fieldset className="gh-reset-dialog__modes">
          <legend className="gh-reset-dialog__legend">Reset mode</legend>
          {MODE_OPTIONS.map((opt) => {
            const reason = computeResetModeDisabledReason(opt.mode, isAtHead);
            return (
              <label
                key={opt.mode}
                className="gh-reset-dialog__mode"
                title={reason ?? undefined}
              >
                <input
                  type="radio"
                  name="gh-reset-mode"
                  value={opt.mode}
                  checked={mode === opt.mode}
                  disabled={reason !== null}
                  onChange={() => setMode(opt.mode)}
                />
                <span className="gh-reset-dialog__mode-body">
                  <span className="gh-reset-dialog__mode-label">{opt.label}</span>
                  <span className="gh-reset-dialog__mode-desc">{opt.describe(branchLabel)}</span>
                </span>
              </label>
            );
          })}
        </fieldset>

        {impact && (
          <p
            className={`gh-reset-dialog__impact${impact.critical ? " gh-reset-dialog__impact--critical" : ""}`}
            role={impact.critical ? "alert" : undefined}
          >
            {impact.text}
          </p>
        )}

        {dangerText && (
          <div className="gh-reset-dialog__danger" role="alert">
            <p className="gh-reset-dialog__danger-counts">{dangerText}</p>
            <p className="gh-reset-dialog__danger-untracked">Untracked files are not affected.</p>
          </div>
        )}

        <div className="gh-reset-dialog__actions">
          <button type="button" className="gh-reset-dialog__cancel" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="gh-reset-dialog__confirm"
            disabled={busy || modeDisabledReason !== null}
            title={modeDisabledReason ?? undefined}
            onClick={() => onConfirm(mode)}
          >
            {busy ? "Resetting…" : "Reset"}
          </button>
        </div>
      </div>
    </div>
  );
}
