// SPDX-License-Identifier: GPL-3.0-or-later

export type Platform = "win32" | "darwin" | "linux";

/**
 * specs/external-programs.md AC3: every detector is a pure function of this injected environment, so the same tests run on any
 * OS from canned `reg query` / `mdfind` output and a temp-dir PATH. The optional members default to "no extra information"
 * (realpath is the identity, nothing is a repository, nothing is world-writable).
 */
export interface DetectEnv {
  platform: Platform;
  env: Record<string, string | undefined>;
  homedir?: string;
  /** argv only, never a shell string. A rejection or timeout means "no output". */
  runCommand(command: string, args: readonly string[]): Promise<string>;
  /** A regular file that can be run (an executable file on POSIX, any regular file on Windows). */
  exists(path: string): Promise<boolean>;
  /** A directory (macOS `.app` bundles). */
  isDirectory?(path: string): Promise<boolean>;
  realpath?(path: string): Promise<string>;
  readdir?(dir: string): Promise<string[]>;
  /** True when an ancestor of `path` holds a `.git` entry (the path is inside a repository or a worktree). */
  hasGitAncestor?(path: string): Promise<boolean>;
  isWorldWritableDir?(dir: string): Promise<boolean>;
}

export interface DetectedProgram {
  id: string;
  name: string;
  /** Absolute: the executable, or the `.app` bundle on macOS. */
  exe: string;
  /** The realpath that passed the location checks. */
  resolved: string;
  kind: "exe" | "app";
  editorId: string;
}
