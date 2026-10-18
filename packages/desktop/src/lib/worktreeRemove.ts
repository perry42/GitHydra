// SPDX-License-Identifier: GPL-3.0-or-later
import type { BranchMergeState, RemoveWorktreeResult, WorktreeEntry, WorktreeRemovalState } from "@githydra/git-core";
import { DISCARD_TYPE_TO_CONFIRM_ABOVE, plural } from "./fileSelection";
import { lockedRemoveReason, visibleText } from "./worktrees";

/** Everything the remove confirm shows, derived from git-core's read-only answers (specs/worktrees.md FR-615). */
export interface RemovalPlan {
  title: string;
  message: string;
  confirmLabel: string;
  /** Delete the branch after removing the worktree (merged branch only). */
  deleteBranch: boolean;
  /** Extra line under the message: the kept-branch explanation. */
  keptBranchLine: string | null;
  /** The branch exists but has unmerged commits, so a requested delete was downgraded to a plain removal. */
  keptUnmerged: boolean;
  count: number;
  submodules: string[];
  dirtySubmodules: string[];
  /** git could not check submodules for changes (a linked submodule folder): every populated one may be dirty. */
  submoduleCheckIncomplete: boolean;
  /** FR-603: git needs the explicit force for a dirty worktree or one with populated submodules. */
  force: boolean;
  /** FR-615: more than 20 files means the count must be typed (same shared threshold as the bulk discard). */
  needsTyping: boolean;
  tabLine: string | null;
}

export const TYPE_CONFIRM_ABOVE = DISCARD_TYPE_TO_CONFIRM_ABOVE;

/** FR-615: "Branch X has N commits that are not merged into <current branch> or its upstream, so it will be kept." */
export function keptBranchLine(branch: string, unmergedCommits: number | null, currentBranch: string): string {
  const what = unmergedCommits === null ? "some commits that are" : `${plural(unmergedCommits, "commit")} that ${unmergedCommits === 1 ? "is" : "are"}`;
  return `Branch ${visibleText(branch)} has ${what} not merged into ${visibleText(currentBranch)} or its upstream, so it will be kept.`;
}

export function planRemoval(input: {
  entry: WorktreeEntry;
  state: Extract<WorktreeRemovalState, { ok: true }>;
  /** null: the branch state could not be read, treated as unmerged (nothing is deleted on a guess). */
  merge: BranchMergeState | null;
  wantsDeleteBranch: boolean;
  openAsTab: boolean;
  currentBranch: string;
}): RemovalPlan {
  const { entry, state, merge, wantsDeleteBranch, openAsTab, currentBranch } = input;
  const path = visibleText(entry.path);
  const branch = entry.branch;
  const merged = Boolean(merge?.exists && merge.merged);
  const deleteBranch = wantsDeleteBranch && branch !== null && merged;
  let keptLine: string | null = null;
  if (wantsDeleteBranch && branch !== null && !merged) {
    keptLine = merge && !merge.exists ? `Branch ${visibleText(branch)} was not found, so there is nothing to delete.` : keptBranchLine(branch, merge?.unmergedCommits ?? null, currentBranch);
  }
  const dirty = state.count > 0;
  const message = dirty
    ? `${path} has ${plural(state.count, "uncommitted file")}. Removing it permanently deletes them, along with ignored files such as node_modules and build output.`
    : `This also deletes ignored files such as node_modules and build output in ${path}.`;
  return {
    title: deleteBranch ? "Remove worktree and delete branch?" : "Remove worktree?",
    message,
    confirmLabel: deleteBranch ? "Remove and delete branch" : "Remove worktree",
    deleteBranch,
    keptBranchLine: keptLine,
    keptUnmerged: wantsDeleteBranch && branch !== null && !merged && !(merge && !merge.exists),
    count: state.count,
    submodules: state.submodules,
    dirtySubmodules: state.dirtySubmodules,
    submoduleCheckIncomplete: state.submoduleCheckIncomplete === true,
    force: dirty || state.submodules.length > 0,
    needsTyping: state.count > TYPE_CONFIRM_ABOVE,
    tabLine: openAsTab ? "Its open tab will be closed first." : null,
  };
}

/** FR-603: a refusal after confirming, in plain words. `dirty` and `hasSubmodules` are handled by re-reading the state instead. */
export function removalRefusalMessage(r: Extract<RemoveWorktreeResult, { ok: false }>): string {
  switch (r.reason) {
    case "locked":
      return lockedRemoveReason(r.lockReason);
    case "inUse":
      return "Close programs using this folder and try again.";
    case "unsafeTarget":
      return "This folder cannot be removed safely, so nothing was removed.";
    case "walkFailed":
      return "The worktree folder could not be read completely, so nothing was removed.";
    case "unsupported":
      return "This worktree entry cannot be trusted, so it cannot be removed.";
    case "main":
      return "The main worktree cannot be removed.";
    case "symlinkTarget":
      return "The worktree folder is a link, so it was not removed.";
    case "notAWorktree":
      return "Not a worktree of this repository.";
    case "missing":
      return `The worktree's folder is missing. Use "Forget missing worktree" instead.`;
    case "notFound":
      return "That worktree no longer exists.";
    case "pathChanged":
      return "The worktree changed since you opened this. Close the dialog and try again.";
    case "expectationRequired":
      return "Something went wrong, so nothing was removed. Close this and try again.";
    case "dirty":
      return "The worktree has uncommitted changes.";
    case "hasSubmodules":
      return "The worktree contains submodules.";
  }
}

export function distrustMessage(reason: string): string {
  if (reason === "missing") return `The worktree's folder is missing. Use "Forget missing worktree" instead.`;
  if (reason === "tracked-in-main") return "This folder is part of the main working tree, so it cannot be removed as a worktree.";
  return "Not a worktree of this repository.";
}
