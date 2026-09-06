// SPDX-License-Identifier: GPL-3.0-or-later
import { runGit } from "./gitProcess";
import { OperationCancelledError } from "./errors";

/**
 * Resolve the current branch's configured upstream (`branch.<name>.remote` +
 * `branch.<name>.merge`, i.e. what `@{u}` resolves to), e.g. "origin/main" — FR-15's "current
 * branch's upstream" default heuristic.
 *
 * No upstream configured, a detached HEAD, and an unborn branch all make `@{u}` fail to
 * resolve — these are normal, expected outcomes (not every branch tracks a remote), so a
 * non-zero exit here resolves to `null` rather than throwing. Only genuinely unexpected
 * failures (e.g. `cwd` not actually being a repository) would still be a bug, but those are
 * already guarded upstream by `Repository.open()`/`getState()` before this is ever called.
 *
 * specs/repo-open-feedback-fixes.md FR-197: `signal` — when supplied — is threaded through to
 * `runGit`. A caller cancellation must still surface as `OperationCancelledError`, never get
 * silently folded into this function's own "no upstream configured" `null` fallback (matching
 * `isShallowRepository`/`readHeadState`'s existing convention in `repository.ts`).
 */
export async function getUpstreamBranch(cwd: string, signal?: AbortSignal): Promise<string | null> {
  try {
    const { stdout } = await runGit(
      ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
      { cwd, signal },
    );
    const trimmed = stdout.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch (err) {
    if (err instanceof OperationCancelledError) throw err;
    return null;
  }
}
