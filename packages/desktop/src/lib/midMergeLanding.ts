// SPDX-License-Identifier: GPL-3.0-or-later
import type { RepositoryState } from "@githydra/git-core";

/**
 * specs/mid-merge-landing.md FR-580: identity of one in-progress operation — kind plus the merge head / rebase step / picked
 * commit — so "once per operation" survives a refresh but a new operation (or the next rebase step) lands again.
 */
export function operationKey(state: Pick<RepositoryState, "inProgressOperation" | "inProgressOperationDetail">): string | null {
  const op = state.inProgressOperation;
  if (!op) return null;
  const d = state.inProgressOperationDetail;
  if (!d) return op;
  switch (d.kind) {
    case "merge":
      return `${op}:${d.mergeHeadSha ?? ""}`;
    case "rebase":
      return `${op}:${d.currentStep ?? ""}/${d.totalSteps ?? ""}:${d.ontoSha ?? ""}`;
    case "cherry-pick":
    case "revert":
      return `${op}:${d.targetSha ?? ""}`;
    default:
      return op;
  }
}

export interface LandingInput {
  handled: ReadonlySet<string> | undefined;
  key: string | null;
  conflicted: number;
  changesOpen: boolean;
  editorDirty: boolean;
}

export interface LandingDecision {
  /** Record `key` as spent for this tab, whether or not the drawer was opened. */
  markHandled: boolean;
  open: boolean;
}

/** FR-580: auto-open at most once per tab per operation, never over unsaved edits, never again after the user closed it. */
export function decideLanding(i: LandingInput): LandingDecision {
  if (!i.key || i.conflicted <= 0) return { markHandled: false, open: false };
  if (i.handled?.has(i.key)) return { markHandled: false, open: false };
  return { markHandled: true, open: !i.changesOpen && !i.editorDirty };
}

/** FR-582: the window title while mid-operation with conflicts; null means "use the normal title". */
export function mergingWindowTitle(repoLabel: string, operation: RepositoryState["inProgressOperation"], conflicted: number): string | null {
  if (!operation || conflicted <= 0) return null;
  const word =
    operation === "merge" ? "Merging" : operation === "rebase" ? "Rebasing" : operation === "cherry-pick" ? "Cherry-picking" : "Resolving";
  return `${repoLabel} — ${word} (${conflicted} conflict${conflicted === 1 ? "" : "s"})`;
}
