// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

// Wrap spawn so every real git subprocess's env can be inspected.
const spawnedEnvs: Array<NodeJS.ProcessEnv | undefined> = [];
vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    spawn: ((cmd: string, args: string[], options: { env?: NodeJS.ProcessEnv }) => {
      spawnedEnvs.push(options?.env);
      return (actual.spawn as (...a: unknown[]) => unknown)(cmd, args, options);
    }) as typeof actual.spawn,
  };
});

import {
  runGit,
  runGitAllowingExitCodes,
  runGitBuffer,
  runGitWithInput,
  spawnGit,
  retryOnIndexLockContention,
  withReadOnlyIndex,
  _setLockRetryDelaysForTests,
  _resetLockBreakerForTests,
} from "../src/gitProcess";
import { GitCommandError } from "../src/errors";
import { getWorkingDirectoryStatus } from "../src/workingDirStatus";
import { stageFile, unstageFile } from "../src/staging";
import { git, initRepo, writeFile, commit, cleanup } from "./testRepo";

const dirs: string[] = [];
afterEach(async () => {
  while (dirs.length) await cleanup(dirs.pop()!);
  _setLockRetryDelaysForTests(null);
  _resetLockBreakerForTests();
});

async function repoWithFile(): Promise<string> {
  const dir = await initRepo();
  dirs.push(dir);
  await writeFile(dir, "f.txt", "1\n");
  await commit(dir, "first");
  await writeFile(dir, "f.txt", "2\n");
  return dir;
}

const lockOf = (dir: string) => path.join(dir, ".git", "index.lock");
const LOCK_STDERR = "fatal: Unable to create '/x/.git/index.lock': File exists.\n\nAnother git process seems to be running in this repository";

describe("GIT_OPTIONAL_LOCKS=0 on every spawn", () => {
  it("is set for every run*/spawn entry point", async () => {
    const dir = await repoWithFile();
    spawnedEnvs.length = 0;
    await runGit(["status", "--porcelain"], { cwd: dir });
    await runGitAllowingExitCodes(["diff", "--quiet"], { cwd: dir }, [0, 1]);
    await runGitBuffer(["rev-parse", "HEAD"], { cwd: dir });
    await runGitWithInput(["hash-object", "--stdin"], { cwd: dir }, "x");
    const child = spawnGit(["rev-parse", "HEAD"], { cwd: dir });
    await new Promise((r) => child.on("close", r));
    expect(spawnedEnvs.length).toBeGreaterThanOrEqual(5);
    for (const env of spawnedEnvs) expect(env?.GIT_OPTIONAL_LOCKS).toBe("0");
  });
});

describe("reads while .git/index.lock is held (regression guard; git itself already tolerates this for status)", () => {
  it("do not fail on, create, or remove a foreign lock", async () => {
    const dir = await repoWithFile();
    fs.writeFileSync(lockOf(dir), "");
    await getWorkingDirectoryStatus(dir);
    await runGit(["status", "--porcelain"], { cwd: dir }); // deliberately without withReadOnlyIndex
    await runGit(["diff", "--stat"], { cwd: dir });
    await runGit(withReadOnlyIndex(["ls-files", "--stage"]), { cwd: dir });
    expect(fs.existsSync(lockOf(dir))).toBe(true);
  });
});

describe("retryOnIndexLockContention", () => {
  beforeEach(() => {
    _setLockRetryDelaysForTests([40, 80, 160, 320]);
    _resetLockBreakerForTests();
  });

  it("a mutation succeeds once a foreign lock disappears mid-retry", async () => {
    const dir = await repoWithFile();
    fs.writeFileSync(lockOf(dir), "");
    setTimeout(() => fs.rmSync(lockOf(dir), { force: true }), 100);
    await stageFile(dir, "f.txt");
    expect((await git(dir, ["status", "--porcelain"])).stdout).toContain("M  f.txt");
  });

  it("surfaces the original error when the lock persists, leaves the lock alone", async () => {
    const dir = await repoWithFile();
    await stageFile(dir, "f.txt");
    fs.writeFileSync(lockOf(dir), "");
    await expect(unstageFile(dir, "f.txt")).rejects.toThrow(/index\.lock': File exists/);
    expect(fs.existsSync(lockOf(dir))).toBe(true);
    fs.rmSync(lockOf(dir));
    expect((await git(dir, ["status", "--porcelain"])).stdout).toContain("M  f.txt"); // index unchanged
  });

  it("retries a bounded number of times", async () => {
    let calls = 0;
    const args = ["restore", "--staged", "--", "f"];
    await expect(
      retryOnIndexLockContention(args, { cwd: "." }, async () => {
        calls++;
        throw new GitCommandError("x", args, 128, LOCK_STDERR);
      }),
    ).rejects.toBeInstanceOf(GitCommandError);
    expect(calls).toBe(5);
  });

  it("never retries a non-lock exit 128, other exit codes, or non-whitelisted verbs", async () => {
    const cases: Array<[string[], number, string]> = [
      [["restore", "--staged", "--", "f"], 128, "fatal: pathspec 'f' did not match any files"],
      [["add", "--", "f"], 128, "fatal: Unable to create '/x/.git/refs/heads/a.lock': File exists."],
      [["add", "--", "f"], 1, LOCK_STDERR],
      [["commit", "-F", "-"], 128, LOCK_STDERR],
      [["add", "--", "f"], 128, "fatal: Unable to create '/x/.git/refs/heads/index.lock': File exists."],
      [["add", "--", "f"], 128, "fatal: Unable to create '/x/.git/modules/m/refs/heads/index.lock': File exists."],
      [["add", "--", "f"], 128, "fatal: Unable to create '/x/foo.index.lock': File exists."],
      [["add", "--", "f"], 128, "fatal: pathspec 'Unable to create '/x/.git/index.lock': File exists' did not match\nfatal: other"],
      [["add", "--", "f"], 128, "error: x\nfatal: Unable to create '/x/.git/index.lock': File exists."],
      [["cherry-pick", "a", "b"], 128, LOCK_STDERR],
      [["-c", "core.fsmonitor=false", "rebase", "x"], 128, LOCK_STDERR],
    ];
    for (const [args, code, stderr] of cases) {
      let calls = 0;
      await expect(
        retryOnIndexLockContention(args, { cwd: "." }, async () => {
          calls++;
          throw new GitCommandError("x", args, code, stderr);
        }),
      ).rejects.toBeInstanceOf(GitCommandError);
      expect(calls).toBe(1);
    }
  });

  it("retries for linked-worktree and submodule git-dir lock layouts", async () => {
    for (const p of ["/r/.git/worktrees/wt1/index.lock", "/r/.git/modules/sub/index.lock", "/r/.git/modules/a/b/index.lock", "C:\\r\\.git\\index.lock"]) {
      let calls = 0;
      const args = ["add", "--", "f"];
      await retryOnIndexLockContention(args, { cwd: "." }, async () => {
        if (++calls < 2) throw new GitCommandError("x", args, 128, `fatal: Unable to create '${p}': File exists.`);
        return 1;
      });
      expect(calls).toBe(2);
    }
  });

  it("a real linked worktree and submodule lock are retried then succeed", async () => {
    const dir = await repoWithFile();
    await git(dir, ["add", "f.txt"]);
    await git(dir, ["commit", "-qm", "c"]);
    const wt = dir + "-wt";
    dirs.push(wt);
    await git(dir, ["worktree", "add", "-q", wt, "-b", "wtb"]);
    await writeFile(wt, "f.txt", "changed\n");
    const gd = (await git(wt, ["rev-parse", "--absolute-git-dir"])).stdout.trim();
    fs.writeFileSync(path.join(gd, "index.lock"), "");
    setTimeout(() => fs.rmSync(path.join(gd, "index.lock"), { force: true }), 100);
    await stageFile(wt, "f.txt");
    expect((await git(wt, ["status", "--porcelain"])).stdout).toContain("M  f.txt");
  });

  it("circuit breaker: with a persistent lock, queued mutations fail fast after the first exhausts", async () => {
    const dir = await repoWithFile();
    fs.writeFileSync(lockOf(dir), "");
    const t0 = Date.now();
    const results = await Promise.allSettled(Array.from({ length: 20 }, () => stageFile(dir, "f.txt")));
    const elapsed = Date.now() - t0;
    expect(results.every((r) => r.status === "rejected")).toBe(true);
    for (const r of results) expect(String((r as PromiseRejectedResult).reason)).toMatch(/index\.lock': File exists/);
    expect(elapsed).toBeLessThan(5_000); // unbroken: 20 x 0.6 s of backoff alone
  }, 60_000);

  it("looks past prepended global flags to find the verb", async () => {
    let calls = 0;
    const args = ["--literal-pathspecs", "-c", "core.fsmonitor=false", "add", "--", "f"];
    const r = await retryOnIndexLockContention(args, { cwd: "." }, async () => {
      if (++calls < 3) throw new GitCommandError("x", args, 128, LOCK_STDERR);
      return "ok";
    });
    expect(r).toBe("ok");
  });
});

describe("concurrency stress", () => {
  it("10 concurrent reads plus stage/unstage cycles yield zero lock errors", async () => {
    const dir = await repoWithFile();
    let stop = false;
    const failures: string[] = [];
    const readers = Array.from({ length: 10 }, async (_, i) => {
      while (!stop) {
        try {
          if (i % 3 === 0) await getWorkingDirectoryStatus(dir);
          else if (i % 3 === 1) await runGit(["diff", "--stat"], { cwd: dir });
          else await runGit(["status", "--porcelain"], { cwd: dir });
        } catch (e) {
          // Windows can transiently deny an index open; only lock errors are under test here.
          if (/index\.lock/.test(String(e))) failures.push(String(e));
        }
      }
    });
    const deadline = Date.now() + 15_000;
    for (let i = 0; i < 8 && Date.now() < deadline; i++) {
      try {
        await stageFile(dir, "f.txt");
        await unstageFile(dir, "f.txt");
      } catch (e) {
        failures.push(String(e));
      }
    }
    stop = true;
    await Promise.all(readers);
    expect(failures).toEqual([]);
  }, 60_000);
});
