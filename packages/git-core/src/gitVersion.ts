// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Pure git-version parsing (load-safe: no Node globals, no I/O). Feature gates such as
 * `worktree list -z` (git 2.36, specs/worktrees.md FR-601) compare against this; vendor suffixes
 * (".windows.1", "(Apple Git-154)", "-rc1") are ignored so they never change a decision.
 */

export interface GitVersion {
  major: number;
  minor: number;
  patch: number;
}

/** Accepts "git version 2.31.1.windows.1", "2.39.5 (Apple Git-154)", "2.45", "v2.44.0-rc1". Null when no X.Y is found. */
export function parseGitVersionString(raw: string): GitVersion | null {
  const m = /(?:^|[^0-9.])(\d+)\.(\d+)(?:\.(\d+))?/.exec(raw.replace(/^git version\s+/i, " "));
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: m[3] === undefined ? 0 : Number(m[3]) };
}

export function compareGitVersion(a: GitVersion, b: GitVersion): number {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}

/** An unparseable version is treated as "too old" so every gate falls back to the conservative path. */
export function gitVersionAtLeast(v: GitVersion | null, min: GitVersion): boolean {
  return v !== null && compareGitVersion(v, min) >= 0;
}

/** `git worktree list -z` exists from this version; older gits reject the switch. */
export const WORKTREE_LIST_Z_MIN_VERSION: GitVersion = { major: 2, minor: 36, patch: 0 };

/** `worktree list --porcelain` prints `prunable` from this version. */
export const WORKTREE_PORCELAIN_PRUNABLE_MIN_VERSION: GitVersion = { major: 2, minor: 31, patch: 0 };
