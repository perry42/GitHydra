import { runGit } from "./gitProcess";
import type { WorkingDirectoryStatus } from "./types";

/**
 * `git status` is unlike every other command this module runs (`rev-parse`, `log`, `diff`,
 * `for-each-ref`): it consults the repository's *local* `.git/config` for `core.fsmonitor`,
 * and — per `git help config` — if that key is set to anything other than a recognized
 * boolean, git treats it as the path/command of an external "fsmonitor hook" and executes it
 * (via the OS's normal child-process/shell invocation for hook scripts) every time `status`
 * needs working-tree state. No confirmation, no opt-in beyond the value already being present
 * in `.git/config`.
 *
 * That matters here specifically because a repo can arrive as a pre-existing checkout, zip/
 * tarball extraction, bare repo, or linked worktree — all explicitly-supported ways to open a
 * repo in GitHydra per CLAUDE.md, not just a fresh `git clone` (which never copies this local
 * config; it lives in `.git/config`, not anything transferred by the clone protocol). Such a
 * repo can ship `[core]\n    fsmonitor = <malicious command>` and have that command run the
 * moment `getWorkingDirectoryStatus()` is called — e.g. right after the user opens it via
 * GitHydra's "Open a git repository" dialog.
 *
 * Fix: pass `-c core.fsmonitor=false` ahead of `status` in argv. A `-c` override always wins
 * over anything read from `.git/config` for that single invocation, so this can't be bypassed
 * by repo-local config no matter what it contains. `false` (git's own canonical "disabled"
 * boolean spelling) is used rather than an empty value — both were verified empirically to
 * block the hook, but `false` is unambiguous across git versions, whereas an empty config
 * value's treatment as a boolean is less clearly specified.
 *
 * `core.hooksPath` does NOT need the same treatment for this specific command: verified
 * empirically (git 2.31, 2026-08-27, via `GIT_TRACE=1`) that plain `git status` invokes no
 * hook at all, so there is no hook-based execution surface here to neutralize. (Other
 * git-core commands that DO run hooks, if any are ever added, must be reassessed on their
 * own merits — this reasoning is specific to `status`.)
 */
const NEUTRALIZE_LOCAL_HOOK_CONFIG = ["-c", "core.fsmonitor=false"];

/**
 * Working-tree status counts (FR-18's uncommitted-changes pseudo-node). Caller is responsible
 * for only calling this against a non-bare repo with a working directory — see
 * `Repository.getWorkingDirectoryStatus()`, which guards that.
 */
export async function getWorkingDirectoryStatus(workdir: string): Promise<WorkingDirectoryStatus> {
  const { stdout } = await runGit(
    [...NEUTRALIZE_LOCAL_HOOK_CONFIG, "status", "--porcelain=v1", "--untracked-files=all"],
    { cwd: workdir },
  );
  return parsePorcelainStatus(stdout);
}

/** Parse `git status --porcelain=v1 --untracked-files=all` output into summary counts. */
export function parsePorcelainStatus(porcelainOutput: string): WorkingDirectoryStatus {
  let staged = 0;
  let unstaged = 0;
  let untracked = 0;
  let conflicted = 0;

  for (const line of porcelainOutput.split("\n")) {
    if (!line) continue;
    const x = line[0];
    const y = line[1];
    if (x === "?" && y === "?") {
      untracked++;
      continue;
    }
    // Unmerged (conflict) combinations per `git status --porcelain` docs.
    const isConflict =
      x === "U" || y === "U" || (x === "A" && y === "A") || (x === "D" && y === "D");
    if (isConflict) {
      conflicted++;
      continue;
    }
    if (x && x !== " ") staged++;
    if (y && y !== " ") unstaged++;
  }

  return {
    hasChanges: staged + unstaged + untracked + conflicted > 0,
    staged,
    unstaged,
    untracked,
    conflicted,
  };
}
