import type { WorkingDirectoryChanges, WorkingDirectoryFileChange } from "@githydra/git-core";

/**
 * FR-30: pure helpers computing an optimistic next `WorkingDirectoryChanges` for a stage/unstage
 * action, so the Changes panel can update instantly instead of waiting on the round trip. These
 * are best-effort approximations, not a full re-derivation of git's status logic — `useChangesPanel`
 * always follows up with a real `getWorkingDirectoryChanges()` refetch after a successful call to
 * silently correct anything guessed here, and reverts to the pre-action snapshot entirely on a
 * failed git call (see its doc comment). Kept as pure, independently unit-tested functions rather
 * than inlined in the hook.
 */

function without(entries: WorkingDirectoryFileChange[], path: string): WorkingDirectoryFileChange[] {
  return entries.filter((e) => e.path !== path);
}

/** Move a single file from Unstaged or Untracked into Staged. */
export function optimisticStage(
  changes: WorkingDirectoryChanges,
  path: string,
  from: "unstaged" | "untracked",
): WorkingDirectoryChanges {
  const entry = changes[from].find((e) => e.path === path);
  if (!entry) return changes;
  const stagedEntry: WorkingDirectoryFileChange = { ...entry, category: "staged" };
  return {
    ...changes,
    [from]: without(changes[from], path),
    staged: [...without(changes.staged, path), stagedEntry],
  };
}

/**
 * Move a single file out of Staged, back to Unstaged or Untracked. A staged "added" file returns
 * to Untracked (matching git's real behavior for a brand-new file: unstaging an add just removes
 * it from the index, and it was never tracked before). Every other status returns to Unstaged
 * with the same status. A renamed/copied entry has an ambiguous destination (git actually splits
 * it into a delete + add) — it's dropped from Staged and left for the caller's background
 * refetch to place correctly, rather than guessing wrong.
 */
export function optimisticUnstage(changes: WorkingDirectoryChanges, path: string): WorkingDirectoryChanges {
  const entry = changes.staged.find((e) => e.path === path);
  if (!entry) return changes;
  const staged = without(changes.staged, path);
  if (entry.status === "renamed" || entry.status === "copied") {
    return { ...changes, staged };
  }
  const targetCategory: "untracked" | "unstaged" = entry.status === "added" ? "untracked" : "unstaged";
  const targetEntry: WorkingDirectoryFileChange = {
    ...entry,
    category: targetCategory,
    oldPath: undefined,
  };
  return {
    ...changes,
    staged,
    [targetCategory]: [...without(changes[targetCategory], path), targetEntry],
  };
}

/** Move every eligible (non-conflicted) Unstaged/Untracked file into Staged. */
export function optimisticStageAll(changes: WorkingDirectoryChanges): WorkingDirectoryChanges {
  const toStage = [...changes.unstaged, ...changes.untracked];
  if (toStage.length === 0) return changes;
  const stagedByPath = new Map(changes.staged.map((e) => [e.path, e]));
  for (const entry of toStage) stagedByPath.set(entry.path, { ...entry, category: "staged" });
  return { ...changes, unstaged: [], untracked: [], staged: Array.from(stagedByPath.values()) };
}

/** Move every currently-staged file back to Unstaged/Untracked (see `optimisticUnstage` for the
 * per-status destination rule; renames/copies are dropped, not guessed). */
export function optimisticUnstageAll(changes: WorkingDirectoryChanges): WorkingDirectoryChanges {
  if (changes.staged.length === 0) return changes;
  const unstaged = [...changes.unstaged];
  const untracked = [...changes.untracked];
  for (const entry of changes.staged) {
    if (entry.status === "renamed" || entry.status === "copied") continue;
    if (entry.status === "added") untracked.push({ ...entry, category: "untracked", oldPath: undefined });
    else unstaged.push({ ...entry, category: "unstaged" });
  }
  return { ...changes, staged: [], unstaged, untracked };
}

/** Total pending-change count across all four categories — mirrors `WorkingDirectoryStatus`'s
 * shape without a round trip, for an instant Toolbar badge update alongside the optimistic
 * mutations above. */
export function totalChangeCount(changes: WorkingDirectoryChanges): number {
  return (
    changes.staged.length + changes.unstaged.length + changes.untracked.length + changes.conflicted.length
  );
}
