import { runGit, withFsmonitorNeutralized } from "./gitProcess";
import { getWorkingDirectoryChanges } from "./workingDirStatus";
import { assertPathWithinWorkdir } from "./pathSafety";
import type { WorkingDirectoryFileChange } from "./types";

/** FR-23: stage a single file (`git add --`). Path is always passed after a literal `--`. */
export async function stageFile(workdir: string, filePath: string): Promise<void> {
  assertPathWithinWorkdir(workdir, filePath);
  await runGit(withFsmonitorNeutralized(["add", "--", filePath]), { cwd: workdir });
}

/**
 * A staged rename/copy is recorded internally as an old-path delete + new-path add — restoring
 * only the new path leaves the old path's delete still staged (a real bug, found in QA: after
 * unstaging what looks like a single renamed row, `original.txt` was left behind as a brand
 * new, never-requested staged deletion, and a later commit would silently delete it from
 * history with no trace of the rename). So the `git restore --staged --` pathspec for a
 * renamed/copied entry must include BOTH the old and new path — same pairing approach
 * `diff.ts`'s commit-mode source already uses for a historical rename's diff.
 */
function restorePathsFor(entry: Pick<WorkingDirectoryFileChange, "path" | "oldPath" | "status">): string[] {
  if (entry.oldPath && (entry.status === "renamed" || entry.status === "copied")) {
    return [entry.oldPath, entry.path];
  }
  return [entry.path];
}

/**
 * FR-23: unstage a single file (`git restore --staged --`). Only the index changes — the
 * working-tree file is left exactly as it was. Distinct from `discardTrackedFileChanges`
 * (FR-24), which is the destructive worktree-losing operation.
 *
 * Looks up the current staged entry for `filePath` first (via `getWorkingDirectoryChanges()`)
 * so a renamed/copied entry is unstaged as its full old+new path pair — see `restorePathsFor()`.
 * If `filePath` doesn't currently have a staged entry at all, falls back to restoring just the
 * given path (git's own "did not match any files" error surfaces as before).
 */
export async function unstageFile(workdir: string, filePath: string): Promise<void> {
  assertPathWithinWorkdir(workdir, filePath);
  const changes = await getWorkingDirectoryChanges(workdir);
  const entry = changes.staged.find((f) => f.path === filePath);
  const paths = entry ? restorePathsFor(entry) : [filePath];
  for (const p of paths) assertPathWithinWorkdir(workdir, p);
  await runGit(withFsmonitorNeutralized(["restore", "--staged", "--", ...paths]), { cwd: workdir });
}

/**
 * FR-23: stage every eligible (non-conflicted) unstaged/untracked file in one action.
 * Deliberately enumerates paths via `getWorkingDirectoryChanges()` and stages them by name,
 * rather than a blanket `git add -A`: during an unresolved merge/rebase, `-A` would also
 * silently stage (and thereby mark "resolved") any conflicted path it finds on disk, which
 * would violate FR-27 ("conflicted paths ... not offered a plain stage/unstage control").
 * Conflicted paths never appear in `unstaged`/`untracked` — only in their own `conflicted`
 * category — so enumerating first means they're never touched here. Paths themselves come
 * from git's own status output (trusted), but are still run through the same containment
 * check as every other path-taking function here, on the off chance that ever changes.
 */
export async function stageAllFiles(workdir: string): Promise<void> {
  const changes = await getWorkingDirectoryChanges(workdir);
  const paths = Array.from(new Set([...changes.unstaged, ...changes.untracked].map((f) => f.path)));
  if (paths.length === 0) return;
  for (const p of paths) assertPathWithinWorkdir(workdir, p);
  await runGit(withFsmonitorNeutralized(["add", "--", ...paths]), { cwd: workdir });
}

/**
 * FR-23: unstage every currently-staged (non-conflicted) file in one action. See
 * `stageAllFiles`'s doc comment for why this enumerates paths rather than using a blanket
 * `git restore --staged :/`. Each renamed/copied entry contributes both its old and new path
 * (see `restorePathsFor()`'s doc comment) so a staged rename is fully reverted, not left as a
 * phantom staged deletion of the old path.
 */
export async function unstageAllFiles(workdir: string): Promise<void> {
  const changes = await getWorkingDirectoryChanges(workdir);
  const paths = Array.from(new Set(changes.staged.flatMap((f) => restorePathsFor(f))));
  if (paths.length === 0) return;
  for (const p of paths) assertPathWithinWorkdir(workdir, p);
  await runGit(withFsmonitorNeutralized(["restore", "--staged", "--", ...paths]), { cwd: workdir });
}

/**
 * FR-24: discard a tracked file's *working-tree* changes (worktree -> index), i.e.
 * `git restore --`. This does not touch the index — if the file also has staged changes,
 * those remain staged untouched. Destructive and unrecoverable via git for the discarded
 * worktree edit. Deliberately named and exported separately from `unstageFile` so a caller
 * cannot reach this destructive path through the same code path as a plain, non-destructive
 * unstage.
 */
export async function discardTrackedFileChanges(workdir: string, filePath: string): Promise<void> {
  assertPathWithinWorkdir(workdir, filePath);
  await runGit(withFsmonitorNeutralized(["restore", "--", filePath]), { cwd: workdir });
}

/**
 * FR-24: remove a single untracked file from disk (`git clean -f --`), scoped to exactly that
 * one path — never a bare `git clean -fd` sweep of the whole tree. Destructive and
 * unrecoverable. `git clean` only ever removes untracked files by design, so this is a no-op
 * (not an error) if `filePath` turns out to already be tracked.
 */
export async function discardUntrackedFile(workdir: string, filePath: string): Promise<void> {
  assertPathWithinWorkdir(workdir, filePath);
  await runGit(withFsmonitorNeutralized(["clean", "-f", "--", filePath]), { cwd: workdir });
}
