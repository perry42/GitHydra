// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getEmptyHooksDir } from "../src/emptyHooksDir";
import { GitCommandTimeoutError, WorktreeOperationError } from "../src/errors";
import { runGit, runGitAllowingExitCodes } from "../src/gitProcess";
import { listBranches } from "../src/branches";
import { detectPostCheckoutHook, prepareConsentedHooksDir, sweepStaleConsentDirs } from "../src/worktreeHook";
import { listWorktrees } from "../src/worktreeList";
import { visibleUntrustedText } from "../src/worktreeParse";
import { addWorktree, pruneWorktree, removeWorktree, unlinkReparsePoints, UnlinkWalkError } from "../src/worktrees";
import { _setWorktreeGitVersionForTests, _setWorktreeRunnerForTests } from "../src/worktreeRunner";
import { cleanup, commit, fileExists, git, makeRepoInTempParent, tryMakeDirLink, writeFile } from "./testRepo";
import { recordingRunner } from "./worktreeKit";

/** Second-pass security review of slice 1 (MED-1..3, LOW-4..10). */
const dirs: string[] = [];
beforeEach(() => {
  _setWorktreeGitVersionForTests(undefined);
  _setWorktreeRunnerForTests(null);
});
afterEach(async () => {
  _setWorktreeRunnerForTests(null);
  _setWorktreeGitVersionForTests(undefined);
  while (dirs.length) await cleanup(dirs.pop()!);
});

const fwd = (p: string) => p.replace(/\\/g, "/");
const verbs = (calls: { args: string[] }[], ...names: string[]) => calls.filter((c) => names.every((n) => c.args.includes(n)));

async function repoFixture() {
  const f = await makeRepoInTempParent();
  dirs.push(f.parent);
  return f;
}

describe("MED-2: a reparse point at a gitlink path is foreign and gets unlinked", () => {
  it("a submodule folder replaced by a link to an outside dir: after a forced remove the outside file survives", async (ctx) => {
    const f = await repoFixture();
    const subRepo = path.join(f.parent, "sub-origin");
    await fs.mkdir(subRepo);
    await git(f.parent, ["init", "-q", "--initial-branch=main", subRepo]);
    await writeFile(subRepo, "s.txt", "sub\n");
    await commit(subRepo, "sub first");
    // protocol.file.allow is a TEST-only concession for a local fixture.
    await git(f.repo, ["-c", "protocol.file.allow=always", "submodule", "add", "-q", fwd(subRepo), "sub"]);
    await commit(f.repo, "add submodule");
    const wt = path.join(f.parent, "wt");
    await git(f.repo, ["worktree", "add", "-q", wt, "-b", "gl"]);
    const outside = path.join(f.parent, "outside");
    await writeFile(outside, "precious.txt", "keep");
    await fs.rm(path.join(wt, "sub"), { recursive: true, force: true });
    if (!(await tryMakeDirLink(outside, path.join(wt, "sub")))) return ctx.skip();

    const id = (await listWorktrees(f.repo)).entries[1]!.id!;
    const res = await removeWorktree(f.repo, id, { confirmedPath: wt, force: true });
    expect(res, JSON.stringify(res)).toMatchObject({ ok: true });
    expect(await fs.readFile(path.join(outside, "precious.txt"), "utf8")).toBe("keep");
    expect(await fileExists(wt)).toBe(false);
  });
});

describe("MED-3: Windows paths that are not a drive letter are network-suspect", () => {
  it.each([["NT UNC", "\\??\\UNC\\attacker\\share\\wt\\.git\n"], ["single backslash", "\\attacker\\share\\wt\\.git\n"], ["device", "\\\\.\\UNC\\attacker\\share\\.git\n"]])(
    "%s gitdir: never run `worktree list/add/remove/prune`",
    async (_n, content) => {
      const f = await repoFixture();
      const wt = path.join(f.parent, "victim");
      await git(f.repo, ["worktree", "add", "-q", wt, "-b", "victim"]);
      const id = (await listWorktrees(f.repo)).entries[1]!.id!;
      await fs.writeFile(path.join(f.repo, ".git", "worktrees", id, "gitdir"), content);
      const { runner, calls } = recordingRunner();
      _setWorktreeRunnerForTests(runner);

      const list = await listWorktrees(f.repo);
      if (process.platform === "win32") {
        expect(list.untrustedReason).toBe("network-path");
        expect(list.entries[1]).toMatchObject({ supported: false });
      }
      await addWorktree(f.repo, path.join(f.parent, "n"), { kind: "detached", commit: "HEAD" });
      await removeWorktree(f.repo, id, { confirmedPath: "\\??\\UNC\\attacker\\share\\wt" });
      await pruneWorktree(f.repo, id);
      if (process.platform === "win32") {
        expect(verbs(calls, "worktree", "list")).toHaveLength(0);
        expect(verbs(calls, "worktree", "add")).toHaveLength(0);
        expect(verbs(calls, "worktree", "remove")).toHaveLength(0);
        expect(verbs(calls, "worktree", "prune")).toHaveLength(0);
      }
    },
  );
});

describe("LOW-7: pre-unlink walk guards", () => {
  it("tracked-link matching is case-insensitive on Windows", async (ctx) => {
    if (process.platform !== "win32") return ctx.skip();
    const f = await repoFixture();
    const root = path.join(f.parent, "root");
    const outside = path.join(f.parent, "outside");
    await writeFile(outside, "k.txt", "k");
    await fs.mkdir(root);
    if (!(await tryMakeDirLink(outside, path.join(root, "TrackedLink")))) return ctx.skip();
    expect(await unlinkReparsePoints(root, new Set(["trackedlink"]))).toBe(0);
    expect((await fs.lstat(path.join(root, "TrackedLink"))).isSymbolicLink()).toBe(true);
  });

  it("a folder that cannot be listed is a distinct failure, not 'in use'", async (ctx) => {
    if (process.platform !== "win32") return ctx.skip();
    await expect(unlinkReparsePoints(path.join(os.tmpdir(), "githydra-no-such-root-xyz"), new Set())).rejects.toBeInstanceOf(UnlinkWalkError);
  });

  it("the target is re-lstat'ed right before the walk: a link swapped in after the checks is refused and nothing is unlinked", async (ctx) => {
    const f = await repoFixture();
    const wt = path.join(f.parent, "wt");
    await git(f.repo, ["worktree", "add", "-q", wt, "-b", "swap"]);
    const id = (await listWorktrees(f.repo)).entries[1]!.id!;
    const aside = path.join(f.parent, "aside");
    let done = 0;
    let swapped = false;
    const swap = async () => {
      if (swapped) return;
      swapped = true;
      await fs.rename(wt, aside);
      if (!(await tryMakeDirLink(aside, wt))) {
        await fs.rename(aside, wt);
        swapped = false;
      }
    };
    _setWorktreeRunnerForTests({
      run: async (args, opts) => {
        const r = await runGit(args, opts);
        if ((args.includes("status") || args.includes("ls-files")) && ++done === 2) await swap();
        return r;
      },
      runAllowing: (args, opts, allowed) => runGitAllowingExitCodes(args, opts, allowed),
    });
    const res = await removeWorktree(f.repo, id, { confirmedPath: wt });
    if (!swapped) return ctx.skip();
    expect(res).toMatchObject({ ok: false, reason: "unsafeTarget" });
    expect(await fileExists(path.join(aside, "a.txt"))).toBe(true);
  });

  it("a failing ls-files in the removal pre-step fails closed before any unlink or remove", async () => {
    const f = await repoFixture();
    const wt = path.join(f.parent, "wt");
    await git(f.repo, ["worktree", "add", "-q", wt, "-b", "lsfail"]);
    const id = (await listWorktrees(f.repo)).entries[1]!.id!;
    const calls: string[][] = [];
    _setWorktreeRunnerForTests({
      run: async (args, opts) => {
        calls.push([...args]);
        if (args.includes("ls-files")) {
          const { GitCommandError } = await import("../src/errors");
          throw new GitCommandError("fail SECRET", args, 99, "fatal: SECRET");
        }
        return runGit(args, opts);
      },
      runAllowing: (args, opts, allowed) => runGitAllowingExitCodes(args, opts, allowed),
    });
    await expect(removeWorktree(f.repo, id, { confirmedPath: wt })).rejects.toBeInstanceOf(WorktreeOperationError);
    expect(calls.some((c) => c.includes("remove"))).toBe(false);
    expect(await fileExists(path.join(wt, "a.txt"))).toBe(true);
  });
});

void [getEmptyHooksDir, GitCommandTimeoutError, listBranches, detectPostCheckoutHook, prepareConsentedHooksDir, sweepStaleConsentDirs, visibleUntrustedText];

describe("MED-1: the branch listing never runs `git worktree list` over a planted network path", () => {
  it("skips the call, reports no 'checked out elsewhere' data and flags the repo", async () => {
    const f = await repoFixture();
    const wt = path.join(f.parent, "victim");
    await git(f.repo, ["worktree", "add", "-q", wt, "-b", "victim"]);
    const id = (await listWorktrees(f.repo)).entries[1]!.id!;

    const control = recordingRunner();
    _setWorktreeRunnerForTests(control.runner);
    const normal = await listBranches(f.repo);
    expect(verbs(control.calls, "worktree", "list").length).toBe(1);
    expect(normal.find((b) => b.name === "victim")!.checkedOutInWorktree).not.toBeNull();
    expect(normal.every((b) => b.worktreeInfoUnavailable === undefined)).toBe(true);

    await fs.writeFile(path.join(f.repo, ".git", "worktrees", id, "gitdir"), "//attacker/share/wt/.git\n");
    const planted = recordingRunner();
    _setWorktreeRunnerForTests(planted.runner);
    const branches = await listBranches(f.repo);
    expect(verbs(planted.calls, "worktree", "list")).toHaveLength(0);
    expect(branches.map((b) => b.name).sort()).toEqual(["main", "victim"]);
    expect(branches.every((b) => b.checkedOutInWorktree === null && b.worktreeInfoUnavailable === true)).toBe(true);
  });
});

describe("LOW-4: config-based hooks", () => {
  it("on a git that honours them (version gate), a hook.* key refuses add with and without consent; below the gate it is ignored", async () => {
    const f = await repoFixture();
    await git(f.repo, ["branch", "b1"]);
    await git(f.repo, ["config", "hook.sneaky.command", "echo hi"]);

    _setWorktreeGitVersionForTests({ major: 2, minor: 54, patch: 0 });
    expect(await addWorktree(f.repo, path.join(f.worktreesDir, "w1"), { kind: "branch", branch: "b1" })).toMatchObject({ ok: false, reason: "configHooks" });
    expect(await fileExists(f.worktreesDir)).toBe(false);

    _setWorktreeGitVersionForTests({ major: 2, minor: 31, patch: 1 });
    expect(await addWorktree(f.repo, path.join(f.worktreesDir, "w2"), { kind: "branch", branch: "b1" })).toMatchObject({ ok: true });
  });
});

describe("LOW-5: the empty hooks dir must stay empty and private", () => {
  it("a file planted in the cached dir makes the next use recreate it", async () => {
    const first = await getEmptyHooksDir();
    await fs.writeFile(path.join(first, "post-checkout"), "#!/bin/sh\necho planted\n");
    const second = await getEmptyHooksDir();
    expect(second).not.toBe(first);
    expect(await fs.readdir(second)).toEqual([]);
    await fs.rm(path.join(first, "post-checkout"));
    await fs.rmdir(first).catch(() => undefined);
    await fs.rmdir(second).catch(() => undefined);
  });

  it("a group/world-accessible mode is recreated (POSIX)", async (ctx) => {
    if (process.platform === "win32") return ctx.skip();
    const first = await getEmptyHooksDir();
    await fs.chmod(first, 0o755);
    const second = await getEmptyHooksDir();
    expect(second).not.toBe(first);
    await fs.rmdir(first).catch(() => undefined);
    await fs.rmdir(second).catch(() => undefined);
  });
});
