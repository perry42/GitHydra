// SPDX-License-Identifier: GPL-3.0-or-later
import { runGit } from "./gitProcess";

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
 */
export async function getUpstreamBranch(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await runGit(
      ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
      { cwd },
    );
    const trimmed = stdout.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}
