// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Test-only helper: real, on-disk temp git repo fixtures for the desktop package's integration
 * suite (`App.stash.e2e.test.tsx`) — deliberately independent of git-core's own
 * `packages/git-core/tests/testRepo.ts` (not exported from `@githydra/git-core`'s public API), but
 * the same minimal, direct-`git`-invocation technique: never routes through the code under test.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { spawn } from "node:child_process";

export function git(
  cwd: string,
  args: string[],
  extraEnv: Record<string, string> = {},
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd,
      shell: false,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "Test Author",
        GIT_AUTHOR_EMAIL: "author@example.com",
        GIT_COMMITTER_NAME: "Test Committer",
        GIT_COMMITTER_EMAIL: "committer@example.com",
        GIT_TERMINAL_PROMPT: "0",
        ...extraEnv,
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`git ${args.join(" ")} failed (${code}): ${stderr}`));
        return;
      }
      resolve({ stdout, stderr, code });
    });
  });
}

/**
 * ROADMAP.md's git-core test-flakiness tech debt (2026-09-07 update): mirrors
 * `packages/git-core/tests/testRepo.ts`'s own fix — fixtures live under a gitignored in-package
 * folder rather than the OS temp directory, so a single antivirus exclusion on the project folder
 * actually covers the many real `git.exe` processes/files these e2e suites spawn.
 */
const TEMP_ROOT = path.join(process.cwd(), ".tmp-test-repos");

export async function makeTempDir(prefix = "githydra-desktop-e2e-"): Promise<string> {
  await fs.mkdir(TEMP_ROOT, { recursive: true });
  return fs.mkdtemp(path.join(TEMP_ROOT, prefix));
}

export async function initRepo(opts: { bare?: boolean } = {}): Promise<string> {
  const dir = await makeTempDir();
  const args = ["init", "-q", "--initial-branch=main"];
  if (opts.bare) args.push("--bare");
  args.push(dir);
  await git(process.cwd(), args);
  return dir;
}

export async function writeFile(repoDir: string, relPath: string, contents: string): Promise<void> {
  const full = path.join(repoDir, relPath);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, contents, "utf8");
}

export async function readFile(repoDir: string, relPath: string): Promise<string> {
  const full = path.join(repoDir, relPath);
  return fs.readFile(full, "utf8");
}

export async function commitAll(repoDir: string, message: string): Promise<string> {
  await git(repoDir, ["add", "-A"]);
  await git(repoDir, ["commit", "-q", "-m", message]);
  const { stdout } = await git(repoDir, ["rev-parse", "HEAD"]);
  return stdout.trim();
}

export async function addWorktree(repoDir: string, branchName: string): Promise<string> {
  const worktreeDir = await makeTempDir("githydra-desktop-e2e-wt-");
  // Remove the empty dir mkdtemp created — `git worktree add` insists on creating its own target.
  await fs.rm(worktreeDir, { recursive: true, force: true });
  await git(repoDir, ["worktree", "add", "-q", "-b", branchName, worktreeDir]);
  return worktreeDir;
}

export async function cleanup(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 5 });
}

export async function statusPorcelain(repoDir: string): Promise<string> {
  const { stdout } = await git(repoDir, ["status", "--porcelain"]);
  return stdout;
}

export async function stashList(repoDir: string): Promise<string[]> {
  const { stdout } = await git(repoDir, ["stash", "list"]);
  return stdout.split("\n").filter(Boolean);
}
