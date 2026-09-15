// SPDX-License-Identifier: GPL-3.0-or-later
import {
  runGit,
  runGitAllowingExitCodes,
  withEndOfOptions,
} from "./gitProcess";
import { GitCommandError, InvalidArgumentError } from "./errors";
import { HEX_SHA_RE } from "./changedFiles";

/**
 * specs/drag-commit-menu.md FR-295: the drag-drop menu's ancestry classification for an
 * arbitrary pair of commits (A = dragged, B = dropped-on). Drives FR-307's Merge/Rebase
 * enabled/disabled table — this module computes the relationship only; labeling/enabling is the
 * UI layer's job.
 */
export type CommitPairRelationship =
  | "a-ancestor-of-b"
  | "b-ancestor-of-a"
  | "no-common-ancestor"
  | "diverged";

/**
 * FR-295: `git merge-base --is-ancestor <maybeAncestor> <maybeDescendant>` — exit 0 means true,
 * exit 1 means false (both are normal, expected outcomes, never thrown). Per FR-295's explicit
 * product decision, ANY other exit code — most concretely a shallow-clone boundary where git
 * cannot determine ancestry at all — also resolves to `false` for this direction rather than
 * throwing, since the caller has nothing more specific to do with a third state (see this
 * package's "no dedicated unknown-ancestry UI case" non-goal). A `GitCommandTimeoutError` or
 * `OperationCancelledError` is a process-level failure, not an ancestry answer, and is never
 * folded into that same "false" fallback — it propagates as-is.
 */
async function isAncestor(
  repoPath: string,
  maybeAncestor: string,
  maybeDescendant: string,
): Promise<boolean> {
  try {
    const { exitCode } = await runGitAllowingExitCodes(
      ["merge-base", "--is-ancestor", ...withEndOfOptions([maybeAncestor, maybeDescendant])],
      { cwd: repoPath },
      [0, 1],
    );
    return exitCode === 0;
  } catch (err) {
    if (err instanceof GitCommandError) {
      return false;
    }
    throw err;
  }
}

/**
 * FR-295: plain `git merge-base <shaA> <shaB>` — returns the merge-base SHA, or `null` (⇒
 * `"no-common-ancestor"`) on "empty/error output", exactly per FR-295's own wording. Two distinct
 * real-git outcomes both land here, verified directly: two truly disconnected histories (e.g. two
 * orphan branches) exit 1 with empty stdout AND empty stderr; a shallow-clone boundary where one
 * endpoint's ancestry can't be resolved at all (an object outside the shallow fetch) instead exits
 * 128 with a real `fatal: Not a valid commit name ...` stderr message — a DIFFERENT failure shape
 * than the plain "no common ancestor" case, but FR-295 deliberately does not ask this function to
 * distinguish them (no dedicated unknown-ancestry UI state — see the spec's Non-goals), so any
 * `GitCommandError` here folds into the same `null` result. A `GitCommandTimeoutError` or
 * `OperationCancelledError` is a process-level failure, not an ancestry answer, and is never
 * folded into that same fallback — it propagates as-is, same as `isAncestor()` above.
 */
async function tryMergeBase(repoPath: string, shaA: string, shaB: string): Promise<string | null> {
  try {
    const { stdout } = await runGit(
      ["merge-base", ...withEndOfOptions([shaA, shaB])],
      { cwd: repoPath },
    );
    const trimmed = stdout.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch (err) {
    if (err instanceof GitCommandError) {
      return null;
    }
    throw err;
  }
}

/**
 * specs/drag-commit-menu.md FR-295/296: classify the ancestry relationship between two distinct
 * commits, as exactly three parallel git reads in one round trip (two `--is-ancestor` directions
 * plus a plain `merge-base`) — never during a drag itself, only once at drop time (see the
 * spec's own performance rationale; this function has no opinion on when its caller invokes it).
 *
 * FR-296: both `shaA`/`shaB` are validated against `HEX_SHA_RE` before any git call
 * (`InvalidArgumentError` on failure, matching `changedFiles.ts`'s `getChangedFilesBetween()`
 * precedent for a two-commit entry point). `shaA === shaB` is also rejected here defensively —
 * the UI layer never calls this for a self-drop (FR-302), but this layer does not trust that.
 *
 * Result is `"diverged"` only when NEITHER `--is-ancestor` direction is true AND a real
 * merge-base was found; `"no-common-ancestor"` when no merge-base exists at all (genuinely
 * disconnected histories, e.g. two orphan branches).
 */
export async function computeCommitPairRelationship(
  repoPath: string,
  shaA: string,
  shaB: string,
): Promise<CommitPairRelationship> {
  if (!HEX_SHA_RE.test(shaA)) {
    throw new InvalidArgumentError(`Not a valid hex SHA: ${JSON.stringify(shaA)}`);
  }
  if (!HEX_SHA_RE.test(shaB)) {
    throw new InvalidArgumentError(`Not a valid hex SHA: ${JSON.stringify(shaB)}`);
  }
  if (shaA === shaB) {
    throw new InvalidArgumentError(
      "computeCommitPairRelationship() requires two distinct commits.",
    );
  }

  const [aAncestorOfB, bAncestorOfA, mergeBase] = await Promise.all([
    isAncestor(repoPath, shaA, shaB),
    isAncestor(repoPath, shaB, shaA),
    tryMergeBase(repoPath, shaA, shaB),
  ]);

  if (aAncestorOfB) return "a-ancestor-of-b";
  if (bAncestorOfA) return "b-ancestor-of-a";
  if (mergeBase === null) return "no-common-ancestor";
  return "diverged";
}
