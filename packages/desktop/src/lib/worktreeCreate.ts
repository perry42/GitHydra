// SPDX-License-Identifier: GPL-3.0-or-later
import type { AddWorktreeResult, AddWorktreeSource, DestinationCheck } from "@githydra/git-core";
import { visibleText } from "./worktrees";

/** What the Create dialog is asked to make a worktree from (specs/worktrees.md FR-607/FR-608). */
export type WorktreeCreateRequest =
  /** A local branch that is not checked out anywhere. */
  | { kind: "branch"; branch: string }
  /** A remote-only branch: git makes a local tracking branch named after it, no network (FR-602). */
  | { kind: "remote"; remote: string; branch: string }
  /** A commit: needs a new branch name, or a detached HEAD under Advanced. */
  | { kind: "commit"; sha: string; label: string }
  /** The palette's "create new branch in a new worktree": starts from the current HEAD. */
  | { kind: "newFromHead"; headLabel: string };

export interface CreateWorktreeValues {
  destination: string;
  source: AddWorktreeSource;
  openAfter: boolean;
}

export interface CreateFailure {
  field: "folder" | "branch" | "general";
  message: string;
  /** "Open" / "Open that worktree" for an existing worktree that is in the way. */
  link?: { label: string; path: string };
}

export const CREATE_INTRO = "A second folder with another branch checked out, sharing this repo's history. No second clone.";
export const DETACHED_WARNING = "Commits made on a detached HEAD can be lost unless you save them on a branch.";

const WINDOWS_ABSOLUTE = /^[A-Za-z]:[\\/]/;

export function isAbsolutePathLike(p: string): boolean {
  return WINDOWS_ABSOLUTE.test(p) || p.startsWith("/") || p.startsWith("\\\\");
}

/**
 * FR-608: a relative folder is resolved against the repo's parent (the main worktree's parent), keeping that path's own
 * separator style. `..` and `.` segments are folded so the preview shows what git-core will validate.
 */
export function resolveWorktreeFolder(input: string, mainPath: string): string {
  const typed = input.trim();
  if (typed === "" || isAbsolutePathLike(typed)) return typed;
  const sep = mainPath.includes("\\") && !mainPath.includes("/") ? "\\" : "/";
  const trimmedMain = mainPath.replace(/[\\/]+$/, "");
  const cut = Math.max(trimmedMain.lastIndexOf("/"), trimmedMain.lastIndexOf("\\"));
  const parent = cut > 0 ? trimmedMain.slice(0, cut) : trimmedMain;
  const stack = parent.split(/[\\/]/);
  for (const seg of typed.split(/[\\/]+/)) {
    if (seg === "" || seg === ".") continue;
    if (seg === ".." && stack.length > 1) stack.pop();
    else if (seg !== "..") stack.push(seg);
  }
  return stack.join(sep);
}

export function joinFolder(parent: string, leaf: string): string {
  const sep = parent.includes("\\") && !parent.includes("/") ? "\\" : "/";
  return `${parent.replace(/[\\/]+$/, "")}${sep}${leaf}`;
}

/** FR-608: the in-field message for a destination refusal (git-core's own text is the fallback). */
export function destinationFailure(check: Extract<DestinationCheck, { ok: false }>): CreateFailure {
  switch (check.reason) {
    case "notEmpty":
      return { field: "folder", message: "That folder is not empty. Choose an empty or new folder." };
    case "insideRepo":
    case "insideGitDir":
    case "insideWorktree":
      return { field: "folder", message: "That folder is inside the repository or another worktree. Choose a folder outside it." };
    case "ancestorOfRepo":
    case "ancestorOfWorktree":
      return { field: "folder", message: "That folder contains the repository or another worktree. Choose a different folder." };
    case "alreadyWorktree": {
      const on = check.branch ? ` with branch ${visibleText(check.branch)} checked out` : "";
      return {
        field: "folder",
        message: `A worktree already exists in that folder${on}.`,
        ...(check.worktreePath ? { link: { label: "Open", path: check.worktreePath } } : {}),
      };
    }
    default:
      return { field: "folder", message: check.message };
  }
}

/** FR-602/FR-608: typed add refusals become in-field messages; none reaches the user as raw git text. */
export function addRefusalFailure(result: Extract<AddWorktreeResult, { ok: false }>): CreateFailure {
  if (result.reason === "destination") {
    return destinationFailure({
      ok: false,
      reason: result.destinationReason ?? "invalidPath",
      message: result.message,
      branch: result.branch,
      worktreePath: result.worktreePath,
    });
  }
  switch (result.reason) {
    case "branchCheckedOut":
      return {
        field: "branch",
        message: `That branch is already checked out${result.worktreePath ? ` at ${visibleText(result.worktreePath)}` : " in another worktree"}.`,
        ...(result.worktreePath ? { link: { label: "Open that worktree", path: result.worktreePath } } : {}),
      };
    case "invalidBranchName":
      return { field: "branch", message: "That is not a valid branch name." };
    case "branchExists":
      return { field: "branch", message: "A branch with that name already exists." };
    case "branchNotFound":
    case "startPointNotFound":
    case "remoteNotFound":
    case "remoteBranchNotFound":
      return { field: "general", message: "The branch or commit to start from was not found. Refresh the branch list and try again." };
    case "emptyRepository":
      return { field: "general", message: "This repository has no commits yet, so there is nothing to check out in a second folder." };
    case "listUntrusted":
      return { field: "general", message: "Git's worktree list and this repository's records disagree, so a worktree cannot be created safely." };
    default:
      return { field: "general", message: result.message };
  }
}
