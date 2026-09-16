// SPDX-License-Identifier: GPL-3.0-or-later
import type { RepositoryState, ResetMode } from "@githydra/git-core";

/**
 * specs/reset-to-here.md FR-366: the commit-graph context menu's "Reset {branch} to here…" entry's
 * disabled+reason state — the UI-layer gate git-core deliberately leaves to this package (bare-repo
 * and unborn-HEAD are explicitly the UI's job, per the spec's own git-core section; an unborn HEAD
 * has no commit rows to right-click on in the first place, so it needs no check of its own here).
 * Checked client-side, mirroring `computeCherryPickDisabledReason`'s established convention, so the
 * menu item's disabled state can never disagree with `resetCurrentBranch()`'s own server-side
 * `OperationAlreadyInProgressError` refusal (FR-360).
 *
 * Deliberately never disables based on ancestry, or on the right-clicked commit already being the
 * current `HEAD` commit (FR-366's explicit carve-outs) — those are FR-370's job, evaluated per-mode
 * once the dialog is already open, not here.
 */
export function computeResetDisabledReason(repoState: RepositoryState | null, busy: boolean): string | null {
  if (busy) {
    return "A reset is already running.";
  }
  if (!repoState) {
    return "Repository state is still loading.";
  }
  if (repoState.isBare) {
    return "No working tree — reset isn't available in a bare repository.";
  }
  if (repoState.inProgressOperation) {
    return `Resolve or abort the ${repoState.inProgressOperation} in progress before resetting.`;
  }
  return null;
}

/**
 * specs/reset-to-here.md FR-370: Soft/Mixed are genuine no-ops (and therefore disabled) when the
 * dialog's target commit is exactly the current `HEAD` commit — both modes only ever move the
 * branch ref plus, for Mixed, the index, neither of which has anything to do at `HEAD` itself. Hard
 * stays enabled there: it's the standard "discard all uncommitted changes" affordance (equivalent
 * to a bare `git reset --hard`), independent of whether `HEAD` itself moves.
 */
export function computeResetModeDisabledReason(mode: ResetMode, isAtHead: boolean): string | null {
  if (mode !== "hard" && isAtHead) {
    return "Already at this commit — nothing to reset.";
  }
  return null;
}
