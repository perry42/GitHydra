// SPDX-License-Identifier: GPL-3.0-or-later
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { commit, git, makeRepoInTempParent, writeFile, cleanup } from "./testRepo";
import type { WorktreeRunner } from "../src/worktreeRunner";
import { runGit, runGitAllowingExitCodes, type GitChildProcess } from "../src/gitProcess";

/** Shared fixtures for the copy-ignored tests (specs/worktree-copy-ignored.md AC 6-10). */

export const SENTINEL = "SENTINEL-SECRET-CONTENT-7f3a";

export interface CopyFixture {
  parent: string;
  repo: string;
  worktreesDir: string;
}

const dirs: string[] = [];
export async function cleanupCopyFixtures(): Promise<void> {
  while (dirs.length) await cleanup(dirs.pop()!);
}
export function track(dir: string): string {
  dirs.push(dir);
  return dir;
}

/** A repo with tracked `src/a.txt`, ignore rules, and a spread of ignored files (never committed). */
export async function makeCopyFixture(): Promise<CopyFixture> {
  const f = await makeRepoInTempParent();
  track(f.parent);
  await writeFile(f.repo, ".gitignore", "node_modules/\n.env\n*.log\n.cache/\n.vscode/\nnested/\nconfig.local\n");
  await writeFile(f.repo, "src/a.txt", "tracked\n");
  await commit(f.repo, "base");
  await writeFile(f.repo, ".env", `KEY=${SENTINEL}\n`);
  await writeFile(f.repo, "src/b.log", "log\n");
  await writeFile(f.repo, ".cache/x", "x\n");
  await writeFile(f.repo, ".cache/y", "yy\n");
  await writeFile(f.repo, "node_modules/pkg/index.js", "module\n");
  await writeFile(f.repo, ".vscode/settings.json", "{}\n");
  return f;
}

export async function addLinkedWorktree(f: CopyFixture, name: string, branch: string): Promise<string> {
  const dest = path.join(f.worktreesDir, name);
  await fs.mkdir(f.worktreesDir, { recursive: true });
  await git(f.repo, ["worktree", "add", "-q", "-b", branch, dest]);
  return dest;
}

/** Runner whose streaming spawn is replaced by a node script (stands in for a slow or flooding git); everything else is real. */
export function fakeSpawnRunner(script: string): { runner: WorktreeRunner; children: GitChildProcess[] } {
  const children: GitChildProcess[] = [];
  return {
    children,
    runner: {
      run: (a, o) => runGit(a, o),
      runAllowing: (a, o, allowed) => runGitAllowingExitCodes(a, o, allowed),
      spawn: () => {
        const child = spawn(process.execPath, ["-e", script], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true }) as GitChildProcess;
        children.push(child);
        return child;
      },
    },
  };
}

export function isAlive(pid: number | undefined): boolean {
  if (pid === undefined) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function waitUntil(cond: () => boolean, ms = 5000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return cond();
}

/** Directory symlink, or a Windows junction; false when neither can be created. */
export { tryMakeDirLink } from "./testRepo";
