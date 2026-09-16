// SPDX-License-Identifier: GPL-3.0-or-later
import {
  runGit,
  runGitAllowingExitCodes,
  withEndOfOptions,
  withFsmonitorNeutralized,
} from "./gitProcess";
import { GitCommandError, InvalidArgumentError, OperationAlreadyInProgressError } from "./errors";
import { HEX_SHA_RE } from "./changedFiles";
import { detectInProgressOperation, resolveRepositoryPaths } from "./repository";

/**
 * Implements specs/reset-to-here.md's git-core surface (FR-359 through FR-365): move the current
 * branch/HEAD directly to an arbitrary target commit via `git reset`, plus the one read-only
 * helper the confirmation dialog needs to preview the reset's impact before the user commits to
 * it (`countCommitsExclusiveToHead`). The other read the spec calls for
 * (`computeCommitPairRelationship`, FR-365) is reused unmodified from `commitPairs.ts` — no new
 * ancestry logic is added here. Mirrors this package's established split (a mutating "do it"
 * function here, generic detection/state infrastructure reused unmodified elsewhere) already used
 * by `merge.ts`/`rebase.ts`/`cherryPick.ts`.
 */

/**
 * The only three sanctioned values for `resetCurrentBranch()`'s `mode` — a runtime allow-list,
 * not just a compile-time union. Security review (2026-09-17): `mode` becomes a literal `--<mode>`
 * CLI flag token (see `resetCurrentBranch()` below), and the `"soft" | "mixed" | "hard"` TYPE does
 * not survive the IPC boundary — `contextBridge` makes `window.gitHydra` reachable by any JS in
 * the renderer, so an already-compiled desktop build offers no compile-time guarantee about what
 * string actually arrives here at runtime. Without this check, a caller-supplied value like
 * `"pathspec-from-file=/some/path"` would reach git as `git reset
 * --pathspec-from-file=/some/path <targetSha>` — a real flag combination well outside the three
 * sanctioned reset modes, even though `shell: false` still stops it from escalating past that one
 * argv token. Checked first, before `targetSha`'s own `HEX_SHA_RE` gate below — same "validate
 * every argument that becomes a literal flag/value before it ever reaches argv" principle, applied
 * to both parameters this function accepts.
 */
export const RESET_MODES = ["soft", "mixed", "hard"] as const;

export type ResetMode = (typeof RESET_MODES)[number];

/**
 * Refuses (making no `git` call at all) when a merge/rebase/cherry-pick/revert/am/bisect is
 * already in progress. Mirrors `merge.ts`'s/`rebase.ts`'s identically-shaped private helper —
 * starting a reset on top of an unresolved operation would leave the repository in a confusing,
 * hard-to-recover state, the same reasoning that already guards every other mutating entry point
 * in this package.
 */
async function assertNoOperationInProgress(cwd: string): Promise<void> {
  const { gitDir } = await resolveRepositoryPaths(cwd);
  const operation = await detectInProgressOperation(gitDir);
  if (operation !== null) {
    throw new OperationAlreadyInProgressError(operation, "reset");
  }
}

/**
 * FR-359: move current `HEAD` (attached branch or detached) directly to `targetSha`, running
 * exactly one of `git reset --soft <targetSha>`, `git reset --mixed <targetSha>`, or
 * `git reset --hard <targetSha>` — `mode` is always passed as an explicit flag, never a bare
 * `git reset <targetSha>` left to git's own default-mode inference. Takes no target-branch
 * parameter and never checks out a different branch/commit first: this always acts on whatever
 * `HEAD` already is, matching `mergeCommit()`/`rebaseCommitOnto()`'s identical "always current
 * HEAD, no picker" precedent (FR-299 in specs/drag-commit-menu.md).
 *
 * Refuses up front (`OperationAlreadyInProgressError`, no git call made) when
 * `detectInProgressOperation()` is already non-null (FR-360), and rejects a `mode` outside
 * `RESET_MODES` or a malformed `targetSha` (both `InvalidArgumentError`, before any git call) —
 * `targetSha` uses the same `HEX_SHA_RE` convention `commitPairs.ts`'s
 * `computeCommitPairRelationship()` already established; see `RESET_MODES`'s own doc comment for
 * why `mode` needs a runtime check too, not just its compile-time union type.
 *
 * FR-362: `withFsmonitorNeutralized()` is applied for `mixed`/`hard` (both refresh the index
 * and/or working tree, the same class of call `git status`/`git add`/`git switch` already guard)
 * but deliberately NOT for `soft` (touches neither) — mirroring FR-43's existing
 * touches-the-working-tree-or-not distinction between `git switch` and a plain ref-only
 * `git branch` create/delete. Argv array only (`shell: false` is `gitProcess.ts`'s own
 * unconditional default).
 *
 * **`targetSha` is NOT passed through `withEndOfOptions()`** — unlike almost every other
 * revision-taking command in this package. Verified empirically (2026-09-16, same investigation
 * class as `blame.ts`'s documented `git blame` deviation): `git reset --soft --end-of-options
 * <sha>` exits 128 with `fatal: option '--end-of-options' must come before non-option
 * arguments`, and the natural-seeming workaround of a literal `--` separator instead
 * (`git reset --soft -- <sha>`) is actively wrong for this command specifically — git parses
 * anything after `--` as a PATHSPEC for `reset`, not a revision, so `--soft` (or any mode) with a
 * `--`-prefixed argument list fails outright (`fatal: Cannot do soft reset with paths.`) even
 * though the given "path" was meant as the target commit. This is safe only because `targetSha`
 * is validated against `HEX_SHA_RE` (strict hex-only) immediately above, before it ever reaches
 * `buildArgs` — a valid hex string can never begin with `-`, so it cannot be misparsed as a flag
 * even without `--end-of-options`. Worth a specific look if this function's `targetSha` is ever
 * loosened to accept a non-hex-only revision (a branch/tag name, "HEAD", "HEAD~3", etc.) the way
 * e.g. `getFileHistory()`'s `revision` does — that would need a materially different safeguard.
 *
 * FR-363: no network call anywhere in this function — identical local behavior regardless of any
 * configured remote.
 *
 * Deliberately adds no bare-repository or unborn-HEAD check of its own — per spec, that gating is
 * the UI layer's job (FR-366), not this function's. `mixed`/`hard` still naturally fail with a
 * plain `GitCommandError` if ever called against a bare repository (both require a working tree;
 * git itself refuses), while `soft` (index/ref-only) succeeds even there — this function does not
 * special-case either outcome, it just runs the git command it was asked to run.
 */
export async function resetCurrentBranch(
  cwd: string,
  targetSha: string,
  mode: ResetMode,
): Promise<void> {
  if (!RESET_MODES.includes(mode)) {
    throw new InvalidArgumentError(`Not a valid reset mode: ${JSON.stringify(mode)}`);
  }
  if (!HEX_SHA_RE.test(targetSha)) {
    throw new InvalidArgumentError(`Not a valid hex SHA: ${JSON.stringify(targetSha)}`);
  }

  await assertNoOperationInProgress(cwd);

  const modeFlag = `--${mode}` as const;
  // See this function's own doc comment for why `targetSha` is NOT run through
  // `withEndOfOptions()` here, unlike everywhere else in this package.
  const args = ["reset", modeFlag, targetSha];

  await runGit(mode === "soft" ? args : withFsmonitorNeutralized(args), {
    cwd,
    mutatesRepository: true,
  });
}

/**
 * FR-364: `git rev-list --count <targetSha>..<headSha>` — a single, pure read used only to
 * preview a prospective reset's impact before the user confirms; makes no mutating call. Both
 * SHAs are validated against `HEX_SHA_RE` first; like every other failure mode here (an
 * unresolvable SHA, a shallow-clone boundary that can't be traversed, a real `git` process
 * failure, a non-numeric/negative parse of stdout, ...), an invalid input degrades to `null`
 * ("count unknown") rather than throwing or blocking the caller — this function never throws for
 * an ordinary git-level failure. A `GitCommandTimeoutError`/`OperationCancelledError` is a
 * process-level failure, not a count answer, and is never folded into that same fallback — it
 * propagates as-is, matching `commitPairs.ts`'s identical "degrade a `GitCommandError`, but never
 * a process-level failure" convention.
 *
 * Correct for all four ancestry shapes with no branching logic of its own: naturally 0 when
 * `targetSha` is a descendant of `headSha` (nothing lost), the exact "commits being undone" count
 * when `targetSha` is an ancestor, the branch-unique count on a diverged pair, and `headSha`'s
 * full commit count on genuinely unrelated histories.
 *
 * The `<targetSha>..<headSha>` range is built as a single composed argv token (never two
 * separate flag/value entries), still passed through `withEndOfOptions()` for the same defensive
 * reason every other revision-like argument in this package is: both halves are pre-validated
 * hex-only strings (so the composed token cannot itself begin with `-`), but this keeps the
 * convention uniform rather than special-casing the one caller that happens to already be safe
 * for a different reason.
 */
export async function countCommitsExclusiveToHead(
  cwd: string,
  targetSha: string,
  headSha: string,
): Promise<number | null> {
  if (!HEX_SHA_RE.test(targetSha) || !HEX_SHA_RE.test(headSha)) {
    return null;
  }
  try {
    const { stdout, exitCode } = await runGitAllowingExitCodes(
      ["rev-list", "--count", ...withEndOfOptions([`${targetSha}..${headSha}`])],
      { cwd },
      [0],
    );
    if (exitCode !== 0) return null;
    const n = Number(stdout.trim());
    return Number.isFinite(n) && Number.isInteger(n) && n >= 0 ? n : null;
  } catch (err) {
    if (err instanceof GitCommandError) {
      return null;
    }
    throw err;
  }
}
