// SPDX-License-Identifier: GPL-3.0-or-later
import * as path from "node:path";
import type { SpawnOptions } from "node:child_process";
import type { Platform } from "./types";

/** The only way a program is started. argv array, `shell: false`, never `exec` (specs/external-programs.md FR-622). */
export interface ChildLike {
  unref(): void;
  once?(event: "spawn" | "error", listener: (err?: Error) => void): unknown;
}
export type SpawnFn = (command: string, args: string[], options: SpawnOptions) => ChildLike;

/** `/usr/bin/open` is an absolute system path; `-a` with an absolute `.app` is the only form used (FR-619). */
export const MAC_OPEN = "/usr/bin/open";

const DROP_PREFIXES = ["ELECTRON_", "NODE_", "GIT_", "DYLD_", "PYTHON"];
// Beyond the spec list: other variables that load code or options into a child (security review L3).
const DROP_EXACT = new Set(["LD_PRELOAD", "_JAVA_OPTIONS", "LD_LIBRARY_PATH", "JAVA_TOOL_OPTIONS", "JDK_JAVA_OPTIONS", "BASH_ENV", "ENV", "PERL5OPT", "RUBYOPT"]);

/**
 * FR-622: ELECTRON_RUN_AS_NODE would break Electron-based editors, NODE_OPTIONS, GIT_*, LD_PRELOAD and DYLD_* would let our own
 * environment steer the child. Keys are compared upper-case because Windows variable names are case-insensitive.
 */
export function scrubEnv(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    const upper = key.toUpperCase();
    if (DROP_EXACT.has(upper) || DROP_PREFIXES.some((p) => upper.startsWith(p))) continue;
    out[key] = value;
  }
  return out;
}

export interface LaunchProcessInput {
  /** The program: an executable path, or an absolute `.app` bundle when `kind` is "app". */
  exe: string;
  kind: "exe" | "app";
  /** Already resolved, real, absolute (see folderRules). */
  folder: string;
  platform: Platform;
  /** Never the repository or the worktree: a repo-controlled cwd is how a planted file gets picked up. */
  home: string;
  env: Record<string, string | undefined>;
  spawnFn: SpawnFn;
}

export type LaunchProcessResult = { ok: true } | { ok: false; reason: "rejected-argument" | "spawn-failed" };

const SPAWN_SETTLE_MS = 3000;

/** True for anything a program could read as an option: after resolution an absolute path can never start with '-'. */
const looksLikeOption = (value: string): boolean => value.startsWith("-");

export async function launchProcess(input: LaunchProcessInput): Promise<LaunchProcessResult> {
  const { exe, kind, folder, platform, home, env, spawnFn } = input;
  const absolute = platform === "win32" ? /^[A-Za-z]:[\\/]/.test(folder) : path.posix.isAbsolute(folder);
  if (!absolute || looksLikeOption(folder) || looksLikeOption(exe)) return { ok: false, reason: "rejected-argument" };
  // macOS: `open -a <abs .app> <folder>` only. Never `-b`, never a bare `open <folder>`, never `--args`.
  const command = kind === "app" ? MAC_OPEN : exe;
  const args = kind === "app" ? ["-a", exe, folder] : [folder];
  const options: SpawnOptions = { shell: false, detached: true, stdio: "ignore", cwd: home, env: scrubEnv(env) };
  try {
    const child = spawnFn(command, args, options);
    await new Promise<void>((resolve, reject) => {
      if (typeof child.once !== "function") return resolve();
      const timer = setTimeout(resolve, SPAWN_SETTLE_MS);
      child.once("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.once("spawn", () => {
        clearTimeout(timer);
        resolve();
      });
    });
    child.unref();
    return { ok: true };
  } catch {
    // No retry, and no error text: it can carry paths (FR-622).
    return { ok: false, reason: "spawn-failed" };
  }
}
