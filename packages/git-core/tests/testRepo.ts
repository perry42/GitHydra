// SPDX-License-Identifier: GPL-3.0-or-later
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";

/** Minimal, direct git invocation for test fixture setup — deliberately separate from the
 * library's own gitProcess.ts so tests don't depend on the code under test to build fixtures. */
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

let counter = 0;

/** Create a fresh temp directory for a test repo. Caller is responsible for cleanup via cleanupTestRepo. */
export async function makeTempDir(): Promise<string> {
  counter += 1;
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "githydra-git-core-"));
  return base;
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

export async function commit(repoDir: string, message: string, opts: { allowEmpty?: boolean } = {}): Promise<string> {
  await git(repoDir, ["add", "-A"]);
  const args = ["commit", "-q", "-m", message];
  if (opts.allowEmpty) args.push("--allow-empty");
  await git(repoDir, args);
  const { stdout } = await git(repoDir, ["rev-parse", "HEAD"]);
  return stdout.trim();
}

export async function cleanup(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 5 });
}

export async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Seed a repo with `count` linear commits that each modify a single file, via a synthetic
 * `git fast-import` stream instead of spawning `git commit` `count` times — the standard fast
 * way to build a large synthetic history for a test (thousands of sequential real `git commit`
 * invocations would make a scale test far too slow to run as part of the normal suite).
 *
 * Deliberately built directly against `git fast-import`'s stdin protocol (commit/mark/data
 * blocks), the same "shell out to real git, never hand-roll its object formats" rule the actual
 * library code follows — fast-import IS a real, documented git plumbing command, not a
 * hand-rolled object writer.
 *
 * Returns the created commits' SHAs oldest-first (mark 1 == the first/root commit, mark `count`
 * == the newest/HEAD commit) — the reverse of `git log`'s own newest-first order, matching this
 * suite's existing convention (see e.g. blame.test.ts's "pages a file's commit history, newest
 * first", which builds its small fixture oldest-first and reverses for comparison).
 *
 * Does not check out the resulting commit's tree into the working directory by default (the
 * `checkout` option) — nothing under test here (`git log --follow`) reads the working tree, so
 * skipping it keeps this fast at large commit counts.
 */
export async function seedLinearHistoryViaFastImport(
  repoDir: string,
  opts: { count: number; filePath?: string; branch?: string; checkout?: boolean },
): Promise<string[]> {
  const filePath = opts.filePath ?? "a.txt";
  const branch = opts.branch ?? "main";
  const count = opts.count;
  if (count <= 0) throw new Error("count must be positive");

  const authorName = "Test Author";
  const authorEmail = "author@example.com";
  const baseEpochSeconds = 1_600_000_000; // arbitrary fixed base; strictly increasing per commit below.

  const chunks: Buffer[] = [];
  const push = (s: string) => chunks.push(Buffer.from(s, "utf8"));

  for (let i = 1; i <= count; i++) {
    const when = `${baseEpochSeconds + i} +0000`;
    const message = `commit ${i}`;
    const content = `content ${i}\n`;
    const messageBytes = Buffer.byteLength(message, "utf8");
    const contentBytes = Buffer.byteLength(content, "utf8");

    push(`commit refs/heads/${branch}\n`);
    push(`mark :${i}\n`);
    push(`author ${authorName} <${authorEmail}> ${when}\n`);
    push(`committer ${authorName} <${authorEmail}> ${when}\n`);
    push(`data ${messageBytes}\n${message}\n`);
    if (i > 1) push(`from :${i - 1}\n`);
    push(`M 100644 inline ${filePath}\n`);
    push(`data ${contentBytes}\n${content}\n`);
  }

  const stream = Buffer.concat(chunks);
  const exportMarksPath = path.join(repoDir, ".git", "fast-import-marks-tmp");

  await new Promise<void>((resolve, reject) => {
    const child = spawn("git", ["fast-import", "--quiet", `--export-marks=${exportMarksPath}`], {
      cwd: repoDir,
      shell: false,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: authorName,
        GIT_AUTHOR_EMAIL: authorEmail,
        GIT_COMMITTER_NAME: authorName,
        GIT_COMMITTER_EMAIL: authorEmail,
        GIT_TERMINAL_PROMPT: "0",
      },
    });
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`git fast-import failed (${code}): ${stderr}`));
        return;
      }
      resolve();
    });
    child.stdin.end(stream);
  });

  const marksContent = await fs.readFile(exportMarksPath, "utf8");
  const markToSha = new Map<number, string>();
  for (const line of marksContent.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const [markToken, sha] = trimmed.split(" ");
    if (!markToken || !sha) continue;
    markToSha.set(Number(markToken.slice(1)), sha);
  }

  const shas: string[] = [];
  for (let i = 1; i <= count; i++) {
    const sha = markToSha.get(i);
    if (!sha) throw new Error(`git fast-import did not export mark :${i}`);
    shas.push(sha);
  }

  if (opts.checkout) {
    await git(repoDir, ["checkout", "-q", "-f", branch]);
  }

  return shas;
}

/**
 * Set up a temp repo whose *local* `.git/config` sets `core.fsmonitor` to an external script
 * that writes a marker file (outside the repo) when executed. Shared by regression tests across
 * this suite that prove a given git-core call site does NOT execute that hook — see
 * `withFsmonitorNeutralized`'s doc comment in `src/gitProcess.ts` for the full vulnerability
 * writeup. Pushes every directory it creates onto the caller's `cleanupDirs` array.
 */
export async function setUpMaliciousFsmonitorRepo(
  cleanupDirs: string[],
  opts: { seedCommit?: boolean } = {},
): Promise<{ dir: string; markerPath: string }> {
  const dir = await initRepo();
  cleanupDirs.push(dir);
  if (opts.seedCommit !== false) {
    await writeFile(dir, "a.txt", "hello");
    await commit(dir, "first");
  }

  // The malicious script and its marker file deliberately live OUTSIDE the repo's working
  // tree (a sibling temp dir), so callers' own file/status assertions aren't confused by an
  // extra untracked path inside the repo.
  const outsideDir = await makeTempDir();
  cleanupDirs.push(outsideDir);
  const markerPath = `${outsideDir.replace(/\\/g, "/")}/PWNED_MARKER`;
  const scriptPath = `${outsideDir.replace(/\\/g, "/")}/fsmonitor-marker.sh`;
  await writeFile(outsideDir, "fsmonitor-marker.sh", `#!/bin/sh\necho PWNED > "${markerPath}"\n`);
  await git(dir, ["config", "core.fsmonitor", scriptPath]);

  return { dir, markerPath };
}
