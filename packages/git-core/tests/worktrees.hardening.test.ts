// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { GitCommandError, NotAGitRepositoryError, OperationCancelledError, WorktreeOperationError } from "../src/errors";
import { getEmptyHooksDir } from "../src/emptyHooksDir";
import { runGit, runGitAllowingExitCodes } from "../src/gitProcess";
import { detectPostCheckoutHook } from "../src/worktreeHook";
import { listWorktrees } from "../src/worktreeList";
import { validateWorktreeDestination, verifyRegisteredWorktree } from "../src/worktreePaths";
import {
  addWorktree,
  busyInside,
  getBranchMergeState,
  getWorktreeRemovalState,
  isPlainRelativePath,
  parsePruneVerbose,
  pruneWorktree,
  removeWorktree,
  removeWorktreeAndDeleteBranch,
  unlinkReparsePoints,
} from "../src/worktrees";
import { _setWorktreeGitVersionForTests, _setWorktreeRunnerForTests, type WorktreeRunner } from "../src/worktreeRunner";
import { cleanup, commit, fileExists, git, makeRepoInTempParent, tryMakeDirLink, writeFile } from "./testRepo";
import { recordingRunner, type RecordedCall } from "./worktreeKit";

/** Security review of slice 1: M3-M6 and L1-L8 (specs/worktrees.md FR-601, 603, 604, 639, 640, 641, 638). */
const dirs: string[] = [];
const children: ChildProcess[] = [];
beforeEach(() => {
  _setWorktreeGitVersionForTests(undefined);
  _setWorktreeRunnerForTests(null);
});
afterEach(async () => {
  _setWorktreeRunnerForTests(null);
  _setWorktreeGitVersionForTests(undefined);
  for (const c of children.splice(0)) c.kill();
  while (dirs.length) await cleanup(dirs.pop()!);
});

const fwd = (p: string) => p.replace(/\\/g, "/");

async function fixture(branch = "topic") {
  const f = await makeRepoInTempParent();
  dirs.push(f.parent);
  const wt = path.join(f.parent, "wt");
  await git(f.repo, ["worktree", "add", "-q", wt, "-b", branch]);
  const entry = (await listWorktrees(f.repo)).entries.find((e) => e.branch === branch)!;
  return { ...f, wt, id: entry.id!, confirmedPath: entry.path };
}

/** Redirects one `worktree add` at an existing file so git itself fails after creating the branch. */
function failingAddRunner(repo: string, branch: string, before?: () => Promise<void>): { runner: WorktreeRunner; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const swap = (args: readonly string[]) => {
    if (!(args.includes("add") && args.includes("worktree") && args.includes(branch))) return args;
    const out = [...args];
    out[out.indexOf("--") + 1] = path.join(repo, "a.txt");
    return out;
  };
  return {
    calls,
    runner: {
      run: async (args, opts) => {
        calls.push({ args: [...args], opts });
        if (args.includes("worktree") && args.includes("add") && before) await before();
        return runGit(swap(args), opts);
      },
      runAllowing: (args, opts, allowed) => runGitAllowingExitCodes(args, opts, allowed),
    },
  };
}

describe("M3: Windows pre-unlink", () => {
  async function tree() {
    const parent = (await makeRepoInTempParent()).parent;
    dirs.push(parent);
    const root = path.join(parent, "root");
    const outside = path.join(parent, "outside");
    await writeFile(outside, "keep.txt", "keep");
    await fs.mkdir(root);
    return { parent, root, outside };
  }

  it("does nothing off Windows", async (ctx) => {
    if (process.platform === "win32") return ctx.skip();
    const t = await tree();
    expect(await unlinkReparsePoints(t.root, new Set())).toBe(0);
  });

  it("skips tracked links, unlinks untracked junctions, never enters them (junction under junction)", async (ctx) => {
    if (process.platform !== "win32") return ctx.skip();
    const t = await tree();
    const other = path.join(t.parent, "other");
    await writeFile(other, "other.txt", "other");
    await tryMakeDirLink(other, path.join(t.outside, "inner-junction"));
    if (!(await tryMakeDirLink(t.outside, path.join(t.root, "untracked-link")))) return ctx.skip();
    await tryMakeDirLink(t.outside, path.join(t.root, "tracked-link"));
    await fs.mkdir(path.join(t.root, "deep"));
    await tryMakeDirLink(other, path.join(t.root, "deep", "nested-link"));

    const n = await unlinkReparsePoints(t.root, new Set(["tracked-link"]));
    expect(n).toBe(2);
    expect(await fileExists(path.join(t.root, "untracked-link"))).toBe(false);
    expect(await fileExists(path.join(t.root, "deep", "nested-link"))).toBe(false);
    expect((await fs.lstat(path.join(t.root, "tracked-link"))).isSymbolicLink()).toBe(true);
    // Nothing behind any link was touched, including the junction that lives inside the outside folder.
    expect(await fs.readFile(path.join(t.outside, "keep.txt"), "utf8")).toBe("keep");
    expect((await fs.lstat(path.join(t.outside, "inner-junction"))).isSymbolicLink()).toBe(true);
    expect(await fs.readFile(path.join(other, "other.txt"), "utf8")).toBe("other");
  });

  it("a link whose name ends in a dot is unlinked as itself (extended-length paths)", async (ctx) => {
    if (process.platform !== "win32") return ctx.skip();
    const t = await tree();
    const dotted = `\\\\?\\${path.win32.resolve(t.root)}\\dotted.`;
    try {
      await fs.symlink(t.outside, dotted, "junction");
    } catch {
      return ctx.skip();
    }
    expect(await unlinkReparsePoints(t.root, new Set())).toBe(1);
    expect(await fs.readFile(path.join(t.outside, "keep.txt"), "utf8")).toBe("keep");
    expect(await fs.readdir(t.root)).toEqual([]);
  });

  it("a refusal after the pre-step still reports how many links were unlinked, and the files behind them survive", async (ctx) => {
    if (process.platform !== "win32") return ctx.skip();
    const f = await makeRepoInTempParent();
    dirs.push(f.parent);
    await writeFile(f.repo, ".gitignore", "ignored-link\n");
    await commit(f.repo, "ignore");
    const wt = path.join(f.parent, "wt");
    await git(f.repo, ["worktree", "add", "-q", wt, "-b", "busy"]);
    const outside = path.join(f.parent, "outside");
    await writeFile(outside, "keep.txt", "keep");
    if (!(await tryMakeDirLink(outside, path.join(wt, "ignored-link")))) return ctx.skip();
    const holder = spawn(process.execPath, ["-e", "setTimeout(()=>{},60000)"], { cwd: wt, stdio: "ignore" });
    children.push(holder);
    await new Promise((r) => setTimeout(r, 500));
    const id = (await listWorktrees(f.repo)).entries[1]!.id!;
    const res = await removeWorktree(f.repo, id, { confirmedPath: wt });
    expect(res).toMatchObject({ ok: false, reason: "inUse", linksUnlinked: 1 });
    expect(await fs.readFile(path.join(outside, "keep.txt"), "utf8")).toBe("keep");
  });
});

describe("M4: a planted network gitdir is never probed by `git worktree list`", () => {
  it("lists from the admin dirs only, fails closed, and refuses add, remove and prune", async () => {
    const f = await fixture("victim");
    await fs.writeFile(path.join(f.repo, ".git", "worktrees", f.id, "gitdir"), "//attacker/share/wt/.git\n");
    const { runner, calls } = recordingRunner();
    _setWorktreeRunnerForTests(runner);

    const list = await listWorktrees(f.repo);
    expect(calls.some((c) => c.args.includes("worktree") && c.args.includes("list"))).toBe(false);
    expect(list.untrusted).toBe(true);
    expect(list.untrustedReason).toBe("network-path");
    expect(list.entries[0]).toMatchObject({ isMain: true, branch: "main" });
    expect(list.entries[1]).toMatchObject({ id: f.id, supported: false, branch: "victim" });
    expect(list.entries[1]!.path).not.toContain("attacker");

    expect(await addWorktree(f.repo, path.join(f.parent, "new"), { kind: "detached", commit: "HEAD" })).toMatchObject({ ok: false, reason: "listUntrusted" });
    expect(await removeWorktree(f.repo, f.id, { confirmedPath: "//attacker/share/wt" })).toMatchObject({ ok: false, reason: "unsupported" });
    expect(await pruneWorktree(f.repo, f.id)).toMatchObject({ ok: false, reason: "unsupported" });
    expect(await verifyRegisteredWorktree(f.repo, f.id)).toEqual({ trusted: false, reason: "untrusted-list" });
    expect(await getWorktreeRemovalState(f.repo, f.id)).toMatchObject({ ok: false });
    for (const c of calls) expect(c.args.includes("remove") || c.args.includes("prune") || (c.args.includes("add") && c.args.includes("worktree"))).toBe(false);
  });
});

describe("removal pre-check fallback after the symbolic-link refusal", () => {
  it("flags the submodule check as incomplete, and only for that exact error", async () => {
    const f = await fixture("topic");
    const refuse = (stderr: string) => {
      const rec = recordingRunner();
      _setWorktreeRunnerForTests({
        run: (args, opts) =>
          args.includes("--ignore-submodules=none") ? Promise.reject(new GitCommandError("git failed", args, 128, stderr)) : rec.runner.run(args, opts),
        runAllowing: rec.runner.runAllowing,
      });
      return rec;
    };
    const rec = refuse("fatal: expected submodule path 'x' not to be a symbolic link");
    expect(await getWorktreeRemovalState(f.repo, f.id)).toMatchObject({ ok: true, submoduleCheckIncomplete: true });
    expect(rec.calls.some((c) => c.args.includes("--ignore-submodules=dirty"))).toBe(true);
    _setWorktreeRunnerForTests(null);
    expect(await getWorktreeRemovalState(f.repo, f.id)).not.toHaveProperty("submoduleCheckIncomplete");
    refuse("fatal: something else");
    await expect(getWorktreeRemovalState(f.repo, f.id)).rejects.toBeInstanceOf(WorktreeOperationError);
  });
});

describe("M5: a nested remove target must not hide tracked files of main", () => {
  it("a planted `src/.git` back-link does not make the tracked `src` removable", async () => {
    const f = await makeRepoInTempParent();
    dirs.push(f.parent);
    await writeFile(f.repo, "src/code.ts", "tracked\n");
    await commit(f.repo, "src");
    await git(f.repo, ["worktree", "add", "-q", path.join(f.parent, "wt"), "-b", "decoy"]);
    const id = (await listWorktrees(f.repo)).entries[1]!.id!;
    await fs.writeFile(path.join(f.repo, "src", ".git"), `gitdir: ${fwd(path.join(f.repo, ".git", "worktrees", id))}\n`);
    await fs.writeFile(path.join(f.repo, ".git", "worktrees", id, "gitdir"), `${fwd(path.join(f.repo, "src", ".git"))}\n`);

    const list = await listWorktrees(f.repo);
    expect(list.untrusted).toBe(false);
    expect(await verifyRegisteredWorktree(f.repo, id, { list })).toMatchObject({ trusted: true });
    expect(await getWorktreeRemovalState(f.repo, id)).toEqual({ ok: false, reason: "tracked-in-main" });
    const res = await removeWorktree(f.repo, id, { confirmedPath: list.entries[1]!.path, force: true });
    expect(res).toMatchObject({ ok: false, reason: "unsafeTarget" });
    expect(await fs.readFile(path.join(f.repo, "src", "code.ts"), "utf8")).toContain("tracked");
  });
});

describe("M6: rollback deletes only what this call created", () => {
  it("keeps the branch when the post-failure listing cannot be read", async () => {
    const f = await makeRepoInTempParent();
    dirs.push(f.parent);
    const fail = failingAddRunner(f.repo, "keepme");
    let addSeen = false;
    _setWorktreeRunnerForTests({
      run: async (args, opts) => {
        if (addSeen && args.includes("worktree") && args.includes("list")) throw new GitCommandError("boom", args, 1, "fatal: boom");
        if (args.includes("worktree") && args.includes("add")) addSeen = true;
        return fail.runner.run(args, opts);
      },
      runAllowing: fail.runner.runAllowing,
    });
    await expect(addWorktree(f.repo, path.join(f.worktreesDir, "w"), { kind: "newBranch", branch: "keepme", startPoint: "HEAD" })).rejects.toBeInstanceOf(WorktreeOperationError);
    expect((await git(f.repo, ["branch", "--list", "keepme"])).stdout).toContain("keepme");
  });

  it("a branch created concurrently under the same name and commit survives (git says 'already exists')", async () => {
    const f = await makeRepoInTempParent();
    dirs.push(f.parent);
    const sha = (await git(f.repo, ["rev-parse", "HEAD"])).stdout.trim();
    const { runner } = failingAddRunner(f.repo, "racy", async () => {
      await git(f.repo, ["branch", "racy", sha]);
    });
    _setWorktreeRunnerForTests(runner);
    await expect(addWorktree(f.repo, path.join(f.worktreesDir, "w"), { kind: "newBranch", branch: "racy", startPoint: "HEAD" })).rejects.toBeInstanceOf(WorktreeOperationError);
    expect((await git(f.repo, ["rev-parse", "refs/heads/racy"])).stdout.trim()).toBe(sha);
  });

  async function remoteFixture() {
    const f = await makeRepoInTempParent();
    dirs.push(f.parent);
    await git(f.repo, ["remote", "add", "origin", "https://unreachable.invalid/x.git"]);
    await git(f.repo, ["update-ref", "refs/remotes/origin/feat", (await git(f.repo, ["rev-parse", "HEAD"])).stdout.trim()]);
    return f;
  }

  it("a pre-existing branch.<n>.description survives a failed add; a section this call created is removed again", async () => {
    const f = await remoteFixture();
    await git(f.repo, ["config", "branch.feat.description", "my notes"]);
    _setWorktreeRunnerForTests(failingAddRunner(f.repo, "feat").runner);
    await expect(addWorktree(f.repo, path.join(f.worktreesDir, "w"), { kind: "remoteBranch", remote: "origin", branch: "feat" })).rejects.toBeInstanceOf(WorktreeOperationError);
    _setWorktreeRunnerForTests(null);
    expect((await git(f.repo, ["config", "branch.feat.description"])).stdout.trim()).toBe("my notes");
    expect((await git(f.repo, ["branch", "--list", "feat"])).stdout.trim()).toBe("");

    const g = await remoteFixture();
    _setWorktreeRunnerForTests(failingAddRunner(g.repo, "feat").runner);
    await expect(addWorktree(g.repo, path.join(g.worktreesDir, "w"), { kind: "remoteBranch", remote: "origin", branch: "feat" })).rejects.toBeInstanceOf(WorktreeOperationError);
    _setWorktreeRunnerForTests(null);
    const left = await runGitAllowingExitCodes(["config", "--get-regexp", "^branch\\."], { cwd: g.repo }, [0, 1]);
    expect(left.stdout).not.toContain("branch.feat.");
  });
});

describe("L1: admin files are only read when they are regular files", () => {
  it("a directory called gitdir is skipped, consistently with git", async () => {
    const f = await fixture("topic");
    const gitdir = path.join(f.repo, ".git", "worktrees", f.id, "gitdir");
    await fs.rm(gitdir);
    await fs.mkdir(gitdir);
    const list = await listWorktrees(f.repo);
    expect(list.entries).toHaveLength(1);
    expect(list.untrusted).toBe(false);
  });

  it("a symlink planted as gitdir is not followed (needs symlink rights)", async (ctx) => {
    const f = await fixture("topic");
    const gitdir = path.join(f.repo, ".git", "worktrees", f.id, "gitdir");
    const target = path.join(f.parent, "elsewhere-gitdir");
    await fs.copyFile(gitdir, target);
    await fs.rm(gitdir);
    try {
      await fs.symlink(target, gitdir, "file");
    } catch {
      return ctx.skip();
    }
    const { runner } = recordingRunner();
    _setWorktreeRunnerForTests(runner);
    const list = await listWorktrees(f.repo);
    expect(list.entries.map((e) => e.id)).toEqual([null]);
  });

  it("a FIFO planted as gitdir or locked never blocks (POSIX)", async (ctx) => {
    if (process.platform === "win32") return ctx.skip();
    const f = await fixture("topic");
    const fifo = path.join(f.repo, ".git", "worktrees", f.id, "locked");
    execFileSync("mkfifo", [fifo]);
    const started = Date.now();
    await listWorktrees(f.repo);
    expect(Date.now() - started).toBeLessThan(15_000);
  });

  it("a FIFO makes the list untrusted with the special-file reason and git never lists (POSIX)", async (ctx) => {
    if (process.platform === "win32") return ctx.skip();
    const f = await fixture("topic");
    execFileSync("mkfifo", [path.join(f.repo, ".git", "worktrees", f.id, "locked")]);
    const { runner, calls } = recordingRunner();
    _setWorktreeRunnerForTests(runner);
    const list = await listWorktrees(f.repo);
    expect(list).toMatchObject({ untrusted: true, untrustedReason: "special-file" });
    expect(calls.some((c) => c.args.includes("worktree") && c.args.includes("list"))).toBe(false);
    expect(await addWorktree(f.repo, path.join(f.parent, "new"), { kind: "detached", commit: "HEAD" })).toMatchObject({ ok: false, reason: "listUntrusted" });
  });

  for (const name of ["locked", "HEAD", "commondir", "gitdir"]) it(`a symlink to a UNC-looking target at ${name} is not followed and fails closed`, async (ctx) => {
    const f = await fixture("topic");
    const file = path.join(f.repo, ".git", "worktrees", f.id, name);
    await fs.rm(file, { force: true });
    try {
      await fs.symlink("//attacker.invalid/share/f", file, "file");
    } catch {
      return ctx.skip(); // symlink creation needs rights on Windows
    }
    const { runner, calls } = recordingRunner();
    _setWorktreeRunnerForTests(runner);
    const list = await listWorktrees(f.repo);
    expect(list.untrusted).toBe(true);
    expect(list.untrustedReason).toBe("special-file");
    expect(calls.some((c) => c.args.includes("worktree") && c.args.includes("list"))).toBe(false);
  });

  it("a symlink to a FIFO does not hang (POSIX)", async (ctx) => {
    if (process.platform === "win32") return ctx.skip();
    const f = await fixture("topic");
    const fifo = path.join(f.parent, "pipe");
    execFileSync("mkfifo", [fifo]);
    const link = path.join(f.repo, ".git", "worktrees", f.id, "locked");
    await fs.symlink(fifo, link);
    const started = Date.now();
    const list = await listWorktrees(f.repo);
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(list).toMatchObject({ untrusted: true, untrustedReason: "special-file" });
  });
});

describe("L2: no raw GitCommandError escapes a public entry point", () => {
  /** Runs `call` once to count git invocations, then again failing each invocation in turn with an unexpected exit code. */
  async function sweep(call: () => Promise<unknown>): Promise<void> {
    _setWorktreeGitVersionForTests({ major: 2, minor: 31, patch: 1 });
    const rec = recordingRunner();
    _setWorktreeRunnerForTests(rec.runner);
    await call();
    const total = rec.calls.length;
    expect(total).toBeGreaterThan(0);
    for (let k = 1; k <= total; k++) {
      let n = 0;
      const boom = (args: readonly string[]) => new GitCommandError("git failed: SECRET-STDERR core.fsmonitor=false", args, 99, "fatal: SECRET-STDERR");
      _setWorktreeRunnerForTests({
        run: (args, opts) => (++n === k ? Promise.reject(boom(args)) : runGit(args, opts)),
        runAllowing: (args, opts, allowed) => (++n === k ? Promise.reject(boom(args)) : runGitAllowingExitCodes(args, opts, allowed)),
      });
      try {
        await call();
      } catch (err) {
        const typed = err instanceof WorktreeOperationError || err instanceof NotAGitRepositoryError || err instanceof OperationCancelledError;
        expect(typed, `call ${k}/${total}: ${String(err)}`).toBe(true);
        expect(`${(err as Error).message} ${JSON.stringify(err)}`).not.toMatch(/SECRET-STDERR|core\.fsmonitor/);
      }
    }
  }

  it("read-only entry points: list, validate, verify, removal state, merge state, hook detection", async () => {
    const f = await fixture("topic");
    await sweep(() => listWorktrees(f.repo));
    await sweep(() => validateWorktreeDestination(f.repo, path.join(f.worktreesDir, "new")));
    await sweep(() => verifyRegisteredWorktree(f.repo, f.id));
    await sweep(() => getWorktreeRemovalState(f.repo, f.id));
    await sweep(() => getBranchMergeState(f.repo, "topic"));
    await sweep(() => detectPostCheckoutHook(f.repo));
  });

  it("add, remove and prune on their refusal paths", async () => {
    const f = await fixture("topic");
    await writeFile(f.wt, "dirty.txt", "x");
    await git(f.repo, ["worktree", "add", "-q", path.join(f.parent, "gone"), "-b", "gone"]);
    await git(f.repo, ["worktree", "add", "-q", path.join(f.parent, "gone2"), "-b", "gone2"]);
    await fs.rm(path.join(f.parent, "gone"), { recursive: true, force: true });
    await fs.rm(path.join(f.parent, "gone2"), { recursive: true, force: true });
    await fs.mkdir(path.join(f.parent, "occupied"));
    await writeFile(path.join(f.parent, "occupied"), "x.txt", "x");

    await sweep(() => addWorktree(f.repo, path.join(f.parent, "occupied"), { kind: "newBranch", branch: "n1", startPoint: "HEAD" }));
    await sweep(() => addWorktree(f.repo, path.join(f.worktreesDir, "r"), { kind: "remoteBranch", remote: "nope", branch: "x" }));
    await sweep(() => removeWorktree(f.repo, f.id, { confirmedPath: f.confirmedPath }));
    await sweep(() => removeWorktreeAndDeleteBranch(f.repo, f.id, { confirmedPath: f.confirmedPath }));
    await sweep(() => pruneWorktree(f.repo, "gone"));
  });

  it("the stderr-parsed owner path is only returned when the listing knows it", async () => {
    const f = await makeRepoInTempParent();
    dirs.push(f.parent);
    await git(f.repo, ["branch", "owned"]);
    const real = path.join(f.parent, "real");
    await git(f.repo, ["worktree", "add", "-q", real, "owned"]);
    // A stale listing before the add: the branch looks free, git then names the real owner path.
    const list = await listWorktrees(f.repo);
    let first = true;
    _setWorktreeRunnerForTests({
      run: async (args, opts) => {
        if (args.includes("worktree") && args.includes("list") && first) {
          first = false;
          const out = await runGit(args, opts);
          return { ...out, stdout: out.stdout.replace(/branch refs\/heads\/owned\n/, "detached\n") };
        }
        return runGit(args, opts);
      },
      runAllowing: (args, opts, allowed) => runGitAllowingExitCodes(args, opts, allowed),
    });
    const res = await addWorktree(f.repo, path.join(f.worktreesDir, "again"), { kind: "branch", branch: "owned" });
    expect(list.entries).toHaveLength(2);
    expect(res).toMatchObject({ ok: false, reason: "branchCheckedOut", branch: "owned" });
    // The stderr path is the real worktree, which the (stale) listing knows by path.
    expect((res as { worktreePath?: string }).worktreePath).toBeDefined();
    expect(path.resolve((res as { worktreePath: string }).worktreePath).toLowerCase()).toBe(path.resolve(real).toLowerCase());
  });
});

describe("L3: hooks and fsmonitor stay off for list, status, remove, prune, branch -d and rollback", () => {
  const script = (sentinel: string) => `#!/bin/sh\necho ran >> "${fwd(sentinel)}"\n`;

  it("core.fsmonitor sentinels: list, dirty count (status), remove and prune never fire it", async () => {
    const f = await fixture("topic");
    await git(f.repo, ["worktree", "add", "-q", path.join(f.parent, "gone"), "-b", "gone"]);
    await fs.rm(path.join(f.parent, "gone"), { recursive: true, force: true });
    const outside = path.join(f.parent, "outside");
    await fs.mkdir(outside);
    const sentinel = path.join(outside, "fsm-sentinel");
    const fsm = path.join(outside, "fsm.sh");
    await fs.writeFile(fsm, script(sentinel));
    await fs.chmod(fsm, 0o755);
    await git(f.repo, ["config", "core.fsmonitor", fwd(fsm)]);

    await git(f.wt, ["status"]); // positive control: plain git fires it
    expect(await fileExists(sentinel)).toBe(true);
    await fs.rm(sentinel);

    await listWorktrees(f.repo);
    expect(await getWorktreeRemovalState(f.repo, f.id)).toMatchObject({ ok: true });
    expect(await pruneWorktree(f.repo, "gone")).toMatchObject({ ok: true });
    expect(await removeWorktree(f.repo, f.id, { confirmedPath: f.confirmedPath })).toMatchObject({ ok: true });
    expect(await fileExists(sentinel)).toBe(false);
  });

  async function refTransactionRepo() {
    const f = await makeRepoInTempParent();
    dirs.push(f.parent);
    const outside = path.join(f.parent, "outside");
    await fs.mkdir(outside);
    const sentinel = path.join(outside, "reftx-sentinel");
    const hook = path.join(f.repo, ".git", "hooks", "reference-transaction");
    await fs.mkdir(path.dirname(hook), { recursive: true });
    await fs.writeFile(hook, script(sentinel));
    await fs.chmod(hook, 0o755);
    return { ...f, sentinel };
  }

  it("branch -d after a remove does not fire reference-transaction (control: plain git does)", async () => {
    const f = await refTransactionRepo();
    await git(f.repo, ["branch", "plain-delete"]);
    await git(f.repo, ["branch", "-d", "plain-delete"]);
    expect(await fileExists(f.sentinel)).toBe(true);
    await fs.rm(f.sentinel);

    const wt = path.join(f.parent, "wt");
    expect((await addWorktree(f.repo, wt, { kind: "newBranch", branch: "merged-topic", startPoint: "HEAD" })).ok).toBe(true);
    const entry = (await listWorktrees(f.repo)).entries[1]!;
    const res = await removeWorktreeAndDeleteBranch(f.repo, entry.id!, { confirmedPath: entry.path });
    expect(res).toMatchObject({ ok: true, branch: { status: "deleted" } });
    expect(await fileExists(f.sentinel)).toBe(false);
  });

  it("the rollback update-ref does not fire it either", async () => {
    const f = await refTransactionRepo();
    _setWorktreeRunnerForTests(failingAddRunner(f.repo, "rolled").runner);
    await expect(addWorktree(f.repo, path.join(f.worktreesDir, "w"), { kind: "newBranch", branch: "rolled", startPoint: "HEAD" })).rejects.toBeInstanceOf(WorktreeOperationError);
    _setWorktreeRunnerForTests(null);
    expect((await git(f.repo, ["branch", "--list", "rolled"])).stdout.trim()).toBe("");
    expect(await fileExists(f.sentinel)).toBe(false);
  });
});

describe("L4: destination hygiene", () => {
  it.each([".GIT", ".git", "git~1", "GIT~1", ".git.", "CONIN$", "CONOUT$", "COM\u00b9", "LPT\u00b2", "com\u00b3.txt"])("refuses the leaf %j", async (leaf) => {
    const f = await makeRepoInTempParent();
    dirs.push(f.parent);
    expect(await validateWorktreeDestination(f.repo, path.join(f.parent, leaf))).toMatchObject({ ok: false, reason: "invalidLeafName" });
  });

  it("refuses .git, git~1 and device names anywhere in the folders it would create", async () => {
    const f = await makeRepoInTempParent();
    dirs.push(f.parent);
    for (const mid of [".git", ".GIT", "git~1", "nul", "CONOUT$", "bad|name"]) {
      expect(await validateWorktreeDestination(f.repo, path.join(f.parent, "a", mid, "leaf")), mid).toMatchObject({ ok: false, reason: "invalidLeafName" });
    }
  });

  it("hands git the realpath-resolved destination", async (ctx) => {
    const f = await makeRepoInTempParent();
    dirs.push(f.parent);
    const real = path.join(f.parent, "real-parent");
    await fs.mkdir(real);
    const link = path.join(f.parent, "link-parent");
    if (!(await tryMakeDirLink(real, link))) return ctx.skip();
    await git(f.repo, ["branch", "viaLink"]);
    const { runner, calls } = recordingRunner();
    _setWorktreeRunnerForTests(runner);
    const res = await addWorktree(f.repo, path.join(link, "wt"), { kind: "branch", branch: "viaLink" });
    expect(res.ok).toBe(true);
    const add = calls.find((c) => c.args.includes("worktree") && c.args.includes("add"))!;
    const given = add.args[add.args.indexOf("--") + 1]!;
    expect(path.resolve(given).toLowerCase()).toBe(path.join(await fs.realpath(real), "wt").toLowerCase());
    expect(res.ok && res.entry).toBeTruthy();
  });
});

describe("L5: lossy UTF-8 makes an entry unsupported", () => {
  it("a gitdir with invalid bytes is listed but never openable", async () => {
    const f = await fixture("topic");
    const gitdir = path.join(f.repo, ".git", "worktrees", f.id, "gitdir");
    const honest = (await fs.readFile(gitdir, "utf8")).replace(/\r?\n$/, "").replace(/\/\.git$/, "");
    await fs.writeFile(gitdir, Buffer.concat([Buffer.from(`${honest}-`), Buffer.from([0xff, 0xfe]), Buffer.from("/.git\n")]));
    const list = await listWorktrees(f.repo);
    expect(list.entries.find((e) => e.id === f.id)).toMatchObject({ supported: false });
    expect(await removeWorktree(f.repo, f.id, { confirmedPath: honest })).toMatchObject({ ok: false });
  });
});

describe("L6: the private empty hooks dir is re-checked on every use", () => {
  it("is recreated when it vanished", async () => {
    const first = await getEmptyHooksDir();
    await fs.rmdir(first);
    const second = await getEmptyHooksDir();
    expect((await fs.stat(second)).isDirectory()).toBe(true);
    expect(second.startsWith(fwd(os.tmpdir()))).toBe(true);
    expect(await getEmptyHooksDir()).toBe(second);
    await fs.rmdir(second).catch(() => undefined);
  });
});

describe("L7: prune output parsing", () => {
  it("matches known ids by prefix, so an id like `a: b` parses and forged or control-character ids are ignored", () => {
    const text = [
      "Removing worktrees/a: b: gitdir file points to non-existent location",
      "Removing worktrees/forged: made up by hand",
      "Removing worktrees/line",
      "break: gitdir file does not exist",
      "Removing worktrees/plain: gitdir file does not exist",
    ].join("\n");
    expect(parsePruneVerbose(text, ["a: b", "line\nbreak", "plain"])).toEqual([
      { id: "a: b", reason: "gitdir file points to non-existent location" },
      { id: "plain", reason: "gitdir file does not exist" },
    ]);
    expect(parsePruneVerbose("Removing worktrees/x\ty: r\nRemoving worktrees/ok: r")).toEqual([{ id: "ok", reason: "r" }]);
  });

  it("reports an id removed beyond the plan (found by the admin-dir diff, not by parsing)", async () => {
    const { parent, repo } = await makeRepoInTempParent();
    dirs.push(parent);
    for (const n of ["gone-a", "gone-b"]) {
      await git(repo, ["worktree", "add", "-q", path.join(parent, n), "-b", n]);
      await fs.rm(path.join(parent, n), { recursive: true, force: true });
    }
    const { runner } = recordingRunner((args) =>
      args.includes("--dry-run") ? { stdout: () => "", stderr: () => "Removing worktrees/gone-a: gitdir file points to non-existent location\n" } : args.includes("prune") ? { stdout: () => "garbled\n", stderr: () => "" } : undefined,
    );
    _setWorktreeRunnerForTests(runner);
    const res = await pruneWorktree(repo, "gone-a");
    expect(res).toMatchObject({ ok: true });
    expect((res as { alsoForgot: { id: string }[] }).alsoForgot.map((x) => x.id)).toEqual(["gone-b"]);
    expect((res as { forgotten: { id: string }[] }).forgotten.map((x) => x.id).sort()).toEqual(["gone-a", "gone-b"]);
  });
});

describe("L8", () => {
  it("only plain relative submodule paths are statted", () => {
    for (const ok of ["sub", "a/b", "dir with space/x"]) expect(isPlainRelativePath(ok), ok).toBe(true);
    for (const bad of ["", "../x", "a/../b", "/abs", "C:/abs", "C:rel", "a\\..\\b", "x\0y"]) expect(isPlainRelativePath(bad), bad).toBe(false);
  });

  it("a busy/permission message only counts as in use when it names a path inside the target", () => {
    const target = path.join(os.tmpdir(), "wt-target");
    const inside = path.join(target, "node_modules", "x");
    const outside = path.join(os.tmpdir(), "somewhere-else", "file");
    expect(busyInside(`error: failed to delete '${inside}': Directory not empty`, [target])).toBe(true);
    expect(busyInside(`error: failed to delete '${outside}': Permission denied`, [target])).toBe(false);
    expect(busyInside("fatal: Permission denied", [target])).toBe(false);
    expect(busyInside("fatal: unrelated failure", [target])).toBe(false);
    expect(busyInside(`error: Invalid argument '${inside}'`, [target])).toBe(true);
  });
});
