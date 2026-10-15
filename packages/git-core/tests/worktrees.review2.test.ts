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
    const res = await removeWorktree(f.repo, id, { confirmedPath: wt, force: true, expectedCount: 1 });
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

async function repoWithHook(body = "#!/bin/sh\nexit 0\n") {
  const f = await repoFixture();
  await git(f.repo, ["branch", "b1"]);
  const hook = path.join(f.repo, ".git", "hooks", "post-checkout");
  await fs.mkdir(path.dirname(hook), { recursive: true });
  await fs.writeFile(hook, body);
  await fs.chmod(hook, 0o755);
  return { ...f, hook };
}

describe("LOW-6: a timeout during add", () => {
  it("keeps a worktree that appeared and reports createdButFailed (no rollback)", async () => {
    const f = await repoFixture();
    _setWorktreeRunnerForTests({
      run: async (args, opts) => {
        const r = await runGit(args, opts);
        if (args.includes("worktree") && args.includes("add")) throw new GitCommandTimeoutError(args, 1000);
        return r;
      },
      runAllowing: (args, opts, allowed) => runGitAllowingExitCodes(args, opts, allowed),
    });
    const dest = path.join(f.worktreesDir, "slow");
    const res = await addWorktree(f.repo, dest, { kind: "newBranch", branch: "slow", startPoint: "HEAD" });
    expect(res).toMatchObject({ ok: true, warning: { reason: "createdButFailed" }, branch: "slow" });
    expect(await fileExists(path.join(dest, "a.txt"))).toBe(true);
    expect((await git(f.repo, ["branch", "--list", "slow"])).stdout).toContain("slow");
  });

  it("with nothing created it rolls back and throws only the redacted typed error", async () => {
    const f = await repoFixture();
    _setWorktreeRunnerForTests({
      run: async (args, opts) => {
        if (args.includes("worktree") && args.includes("add")) {
          await git(f.repo, ["branch", "slowless", "HEAD"]); // what `-b` would have created before the hang
          throw new GitCommandTimeoutError(args, 1000);
        }
        return runGit(args, opts);
      },
      runAllowing: (args, opts, allowed) => runGitAllowingExitCodes(args, opts, allowed),
    });
    const err = await addWorktree(f.repo, path.join(f.worktreesDir, "w"), { kind: "newBranch", branch: "slowless", startPoint: "HEAD" }).catch((e) => e);
    expect(err).toBeInstanceOf(WorktreeOperationError);
    expect((err as WorktreeOperationError).reason).toBe("timeout");
    expect(JSON.stringify(err)).not.toContain("core.");
    expect((await git(f.repo, ["branch", "--list", "slowless"])).stdout.trim()).toBe("");
  });
});

describe("LOW-6/LOW-10: consent dir cleanup, sweep and typed errors", () => {
  it("sweepStaleConsentDirs removes old githydra-hook-* dirs only", async () => {
    const tmp = await makeRepoInTempParent({ withCommit: false });
    dirs.push(tmp.parent);
    const old = path.join(tmp.parent, "githydra-hook-old");
    const fresh = path.join(tmp.parent, "githydra-hook-fresh");
    const other = path.join(tmp.parent, "unrelated-old");
    for (const d of [old, fresh, other]) await fs.mkdir(d);
    const longAgo = new Date(Date.now() - 3 * 3600_000);
    await fs.utimes(old, longAgo, longAgo);
    await fs.utimes(other, longAgo, longAgo);
    expect(await sweepStaleConsentDirs(3600_000, tmp.parent)).toBe(1);
    expect(await fileExists(old)).toBe(false);
    expect(await fileExists(fresh)).toBe(true);
    expect(await fileExists(other)).toBe(true);
  });

  it("a swap between detection and copy is caught by the copy hash and returns null", async () => {
    const f = await repoWithHook("#!/bin/sh\necho one\n");
    const info = await detectPostCheckoutHook(f.repo);
    if (!info.present) throw new Error("hook expected");
    await fs.writeFile(f.hook, "#!/bin/sh\necho SWAPPED\n");
    expect(await prepareConsentedHooksDir(info)).toBeNull();
  });

  it("a raw filesystem error from prepareConsentedHooksDir becomes the redacted typed error", async () => {
    const f = await repoWithHook();
    const info = await detectPostCheckoutHook(f.repo);
    if (!info.present) throw new Error("hook expected");
    const err = await prepareConsentedHooksDir({ ...info, hookPath: path.join(f.parent, "no-such-hook") }).catch((e) => e);
    expect(err).toBeInstanceOf(WorktreeOperationError);
    expect((err as WorktreeOperationError).reason).toBe("io-failed");
    expect(`${(err as Error).message} ${JSON.stringify(err)}`).not.toContain("no-such-hook");
  });

  it("a symlinked hook is detected and runs from its copy (needs symlink rights)", async (ctx) => {
    const f = await repoFixture();
    await git(f.repo, ["branch", "b1"]);
    const real = path.join(f.parent, "real-hook.sh");
    const sentinel = path.join(f.parent, "sentinel");
    await fs.writeFile(real, `#!/bin/sh\necho ran >> "${fwd(sentinel)}"\n`);
    await fs.chmod(real, 0o755);
    const hook = path.join(f.repo, ".git", "hooks", "post-checkout");
    await fs.mkdir(path.dirname(hook), { recursive: true });
    try {
      await fs.symlink(real, hook, "file");
    } catch {
      return ctx.skip();
    }
    const info = await detectPostCheckoutHook(f.repo);
    expect(info.present).toBe(true);
    if (!info.present) return;
    const res = await addWorktree(f.repo, path.join(f.worktreesDir, "w"), { kind: "branch", branch: "b1" }, { runPostCheckoutHook: true, expectedHookFingerprint: info.fingerprint });
    expect(res.ok).toBe(true);
    expect((await fs.readFile(sentinel, "utf8")).trim()).toBe("ran");
  });

  it("core.hooksPath set through an includeIf is still overridden by the -c override", async () => {
    const f = await repoFixture();
    await git(f.repo, ["branch", "b1"]);
    const hooks = path.join(f.parent, "included-hooks");
    await fs.mkdir(hooks);
    const sentinel = path.join(f.parent, "included-sentinel");
    await fs.writeFile(path.join(hooks, "post-checkout"), `#!/bin/sh\necho ran >> "${fwd(sentinel)}"\n`);
    await fs.chmod(path.join(hooks, "post-checkout"), 0o755);
    const extra = path.join(f.parent, "extra.cfg");
    await fs.writeFile(extra, `[core]\n\thooksPath = ${fwd(hooks)}\n`);
    await git(f.repo, ["config", `includeIf.gitdir/i:${fwd(f.repo)}/.git.path`, fwd(extra)]);
    expect((await git(f.repo, ["config", "core.hooksPath"])).stdout.trim()).toBe(fwd(hooks));

    const info = await detectPostCheckoutHook(f.repo);
    expect(info.present && info.hooksPathConfig).toBe(fwd(hooks));
    const res = await addWorktree(f.repo, path.join(f.worktreesDir, "w"), { kind: "branch", branch: "b1" });
    expect(res.ok).toBe(true);
    expect(await fileExists(sentinel)).toBe(false);
  });
});

describe("LOW-9: more invisible characters and binary hook previews", () => {
  it("escapes soft hyphen, combining grapheme joiner, hangul fillers, mongolian selectors, variation selectors, braille blank and tag characters", () => {
    const cps = [0xad, 0x34f, 0x115f, 0x1160, 0x17b4, 0x17b5, 0x180b, 0x180f, 0x3164, 0xfe00, 0xfe0f, 0xffa0, 0x2800, 0xe0000, 0xe0041, 0xe007f];
    for (const cp of cps) {
      expect(visibleUntrustedText(`a${String.fromCodePoint(cp)}b`), cp.toString(16)).toBe(`a\\u{${cp.toString(16)}}b`);
    }
    expect(visibleUntrustedText("plain text ünï 日本")).toBe("plain text ünï 日本");
  });

  it("previewIsBinary flags NUL bytes and heavy U+FFFD in the head, not ordinary text", async () => {
    const bin = await repoWithHook("#!/bin/sh\n");
    await fs.writeFile(bin.hook, Buffer.concat([Buffer.from("#!/bin/sh\n"), Buffer.from([0, 1, 2, 3]), Buffer.from("echo x\n")]));
    const a = await detectPostCheckoutHook(bin.repo);
    const junk = await repoWithHook("#!/bin/sh\n");
    await fs.writeFile(junk.hook, Buffer.concat([Buffer.from("#!/bin/sh\n"), Buffer.alloc(400, 0xff)]));
    const b = await detectPostCheckoutHook(junk.repo);
    const text = await repoWithHook("#!/bin/sh\necho hi\n");
    const c = await detectPostCheckoutHook(text.repo);
    expect(a.present && a.previewIsBinary).toBe(true);
    expect(b.present && b.previewIsBinary).toBe(true);
    expect(c.present && c.previewIsBinary).toBe(false);
  });
});
