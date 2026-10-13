// SPDX-License-Identifier: GPL-3.0-or-later
import * as path from "node:path";
import { runGit, runGitAllowingExitCodes, type RunOptions, type RunResult } from "../src/gitProcess";
import type { WorktreeRunner } from "../src/worktreeRunner";

/** Shared fixtures for the worktree test files (specs/worktrees.md AC1-11). */

export interface RecordedCall {
  args: string[];
  opts: RunOptions;
}

/** Delegates to the real runner while recording every argv; `rewrite` may change the args or the result (version stubs). */
export function recordingRunner(
  rewrite?: (args: readonly string[]) => { args?: readonly string[]; stdout?: (real: string) => string } | undefined,
): { runner: WorktreeRunner; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const apply = async <T extends RunResult>(args: readonly string[], opts: RunOptions, go: (a: readonly string[]) => Promise<T>): Promise<T> => {
    calls.push({ args: [...args], opts });
    const change = rewrite?.(args);
    const result = await go(change?.args ?? args);
    return change?.stdout ? { ...result, stdout: change.stdout(result.stdout) } : result;
  };
  return {
    calls,
    runner: {
      run: (args, opts) => apply(args, opts, (a) => runGit(a, opts)),
      runAllowing: (args, opts, allowed) => apply(args, opts, (a) => runGitAllowingExitCodes(a, opts, allowed)),
    },
  };
}

/** Newline porcelain to the `-z` shape of git >= 2.36: NUL after every field, an extra NUL after every block. */
export function porcelainToNul(stdout: string): string {
  return stdout
    .split("\n")
    .slice(0, -1)
    .map((line) => `${line}\0`)
    .join("");
}

/** Same filesystem location, ignoring separator style and (on Windows) case. */
export function samePath(a: string, b: string): boolean {
  const norm = (p: string) => (process.platform === "win32" ? path.resolve(p).toLowerCase() : path.resolve(p));
  return norm(a) === norm(b);
}
