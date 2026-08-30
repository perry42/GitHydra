import type { ConflictedFileInfo, ConflictSideLabels } from "@githydra/git-core";

/**
 * FR-63/76-80: which resolution UI a conflicted file's classification + stage presence should
 * render. Driven by which of `base`/`ours`/`theirs` are actually present (the ground truth from
 * git's index) rather than `stageCombination` alone, so this stays correct even for the rarer
 * `both-added`/`both-deleted` combinations `stageCombination` documents but doesn't need its own
 * render mode beyond "does a base exist" / "does each side exist".
 */
export type ConflictRenderMode =
  | "submodule"
  | "binary"
  | "delete-modify"
  | "add-only"
  | "both-added"
  | "text";

export interface ConflictRenderInfo {
  mode: ConflictRenderMode;
  /** For "delete-modify": which side ("ours" | "theirs") has no content. Null otherwise. */
  deletedSide: "ours" | "theirs" | null;
}

export function classifyConflictRender(file: ConflictedFileInfo): ConflictRenderInfo {
  if (file.isSubmodule) return { mode: "submodule", deletedSide: null };
  if (file.isBinary) return { mode: "binary", deletedSide: null };

  const hasBase = file.base !== null;
  const hasOurs = file.ours !== null;
  const hasTheirs = file.theirs !== null;

  if (hasBase && hasOurs !== hasTheirs) {
    // FR-78: exactly one side deleted it while the other modified it.
    return { mode: "delete-modify", deletedSide: hasOurs ? "theirs" : "ours" };
  }
  if (!hasBase && hasOurs !== hasTheirs) {
    // Only one side has ever had this path (no common ancestor, no counterpart) — nothing
    // meaningful to diff against.
    return { mode: "add-only", deletedSide: null };
  }
  if (!hasBase && hasOurs && hasTheirs) {
    // Both sides independently added this path with different content (add/add).
    return { mode: "both-added", deletedSide: null };
  }
  // both-modified (the common case), or the rare both-deleted-with-a-base combination — both
  // render as "text" (both-deleted falls back to the ConflictFileDiff hook's null diffs, which
  // the view below already renders as "nothing to compare").
  return { mode: "text", deletedSide: null };
}

/** FR-61/FR-78: "Accept <label>" — with an explicit "(delete file)" qualifier when that side has
 * no content, since accepting it stages a deletion (git-core's `acceptConflictSide` behavior)
 * rather than the more common "replace with this side's text" outcome. */
export function acceptActionLabel(
  side: "ours" | "theirs",
  hasContent: boolean,
  sideLabels: ConflictSideLabels | null,
): string {
  const label = sideLabels ? sideLabels[side].label : side === "ours" ? "our side" : "their side";
  return hasContent ? `Accept ${label}` : `Accept ${label} (delete file)`;
}
