// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { addWorktree, type AddWorktreeSource } from "../src/worktrees";
import { listWorktrees } from "../src/worktreeList";
import { detectPostCheckoutHook } from "../src/worktreeHook";
import { defaultWorktreePath } from "../src/worktreeParse";
import { _setWorktreeGitVersionForTests, _setWorktreeRunnerForTests } from "../src/worktreeRunner";
import { git, cleanup, commit, fileExists, makeRepoInTempParent, seedBareRepo, snapshotTree, tryMakeDirLink, writeFile } from "./testRepo";
import { recordingRunner, samePath } from "./worktreeKit";

/** specs/worktrees.md AC1, AC3, AC4, AC9 (git-core half of AC21): real fixtures, the machine's own git. */
const dirs: string[] = [];
beforeEach(() => {
  _setWorktreeGitVersionForTests(undefined);
  _setWorktreeRunnerForTests(null);
});
afterEach(async () => {
  _setWorktreeRunnerForTests(null);
  while (dirs.length) await cleanup(dirs.pop()!);
});

async function hookFingerprint(repo: string): Promise<string> {
  const info = await detectPostCheckoutHook(repo);
  if (!info.present) throw new Error("no hook planted");
  return info.fingerprint;
}

const head = async (repo: string) => (await git(repo, ["rev-parse", "HEAD"])).stdout.trim();

describe("addWorktree: success paths (AC1, AC3)", () => {
  it("free branch at the default sibling path; git lists it", async () => {
    const { parent, repo, worktreesDir } = await makeRepoInTempParent();
    dirs.push(parent);
    await git(repo, ["branch", "free"]);
    const list = await listWorktrees(repo);
    const dest = defaultWorktreePath({ mainWorktreePath: list.mainPath, branchName: "free" });
    expect(samePath(dest, path.join(worktreesDir, "free"))).toBe(true);

    const res = await addWorktree(repo, dest, { kind: "branch", branch: "free" });
    expect(res).toMatchObject({ ok: true, branch: "free", createdBranch: false, warning: null });
    expect(await fileExists(path.join(dest, "a.txt"))).toBe(true);
    const porcelain = (await git(repo, ["worktree", "list", "--porcelain"])).stdout;
    expect(porcelain).toContain("branch refs/heads/free");
    expect((await listWorktrees(repo)).entries.some((e) => e.branch === "free" && samePath(e.path, dest))).toBe(true);
  });

  it("repo path with spaces and a non-ASCII branch (feature/日本-é)", async () => {
    const { parent, repo } = await makeRepoInTempParent({ name: "my repo é" });
    dirs.push(parent);
    await git(repo, ["branch", "feature/日本-é"]);
    const list = await listWorktrees(repo);
    const dest = defaultWorktreePath({ mainWorktreePath: list.mainPath, branchName: "feature/日本-é" });
    expect(path.basename(dest)).toBe("feature-日本-é");
    expect(path.basename(path.dirname(dest))).toBe("my repo é.worktrees");

    const res = await addWorktree(repo, dest, { kind: "branch", branch: "feature/日本-é" });
    expect(res.ok).toBe(true);
    const after = await listWorktrees(repo);
    expect(after.entries.find((e) => e.branch === "feature/日本-é")?.path).toBeTruthy();
    expect(after.untrusted).toBe(false);
  });

  it("from a bare repository", async () => {
    const { parent, bare, worktreesDir } = await seedBareRepo();
    dirs.push(parent);
    const list = await listWorktrees(bare);
    const dest = defaultWorktreePath({ mainWorktreePath: list.mainPath, branchName: "main" });
    expect(samePath(dest, path.join(worktreesDir, "main"))).toBe(true);

    const res = await addWorktree(bare, dest, { kind: "branch", branch: "main" });
    expect(res).toMatchObject({ ok: true, branch: "main" });
    expect(await fileExists(path.join(dest, "a.txt"))).toBe(true);
  });

  it("when the source is itself a linked worktree, the default folder still derives from the main repo", async () => {
    const { parent, repo, worktreesDir } = await makeRepoInTempParent({ name: "mainrepo" });
    dirs.push(parent);
    const linked = path.join(parent, "elsewhere", "linked");
    await git(repo, ["worktree", "add", "-q", linked, "-b", "linked"]);
    await git(repo, ["branch", "target"]);

    const list = await listWorktrees(linked);
    const dest = defaultWorktreePath({ mainWorktreePath: list.mainPath, branchName: "target" });
    expect(samePath(dest, path.join(worktreesDir, "target"))).toBe(true);
    const res = await addWorktree(linked, dest, { kind: "branch", branch: "target" });
    expect(res).toMatchObject({ ok: true, branch: "target" });
  });

  it("new branch from a start commit: both the branch and the worktree exist", async () => {
    const { parent, repo, worktreesDir } = await makeRepoInTempParent();
    dirs.push(parent);
    const first = await head(repo);
    await writeFile(repo, "b.txt", "second\n");
    await commit(repo, "second");

    const dest = path.join(worktreesDir, "from-first");
    const res = await addWorktree(repo, dest, { kind: "newBranch", branch: "from-first", startPoint: first });
    expect(res).toMatchObject({ ok: true, branch: "from-first", createdBranch: true, head: first });
    expect((await git(repo, ["rev-parse", "refs/heads/from-first"])).stdout.trim()).toBe(first);
    expect(await fileExists(path.join(dest, "b.txt"))).toBe(false);
    expect((await listWorktrees(repo)).entries.some((e) => e.branch === "from-first")).toBe(true);
  });

  it("detached at a commit: branch null and a 7+ character head", async () => {
    const { parent, repo, worktreesDir } = await makeRepoInTempParent();
    dirs.push(parent);
    const sha = await head(repo);
    const res = await addWorktree(repo, path.join(worktreesDir, "det"), { kind: "detached", commit: sha });
    expect(res.ok).toBe(true);
    const entry = (await listWorktrees(repo)).entries.find((e) => e.detached)!;
    expect(entry.branch).toBeNull();
    expect(entry.head).toBe(sha);
    expect(entry.shortHead!.length).toBeGreaterThanOrEqual(7);
  });

  it("remote-only branch: creates a tracking branch named after it, with no network", async () => {
    const { parent, repo, worktreesDir } = await makeRepoInTempParent();
    dirs.push(parent);
    // An unreachable URL: any network attempt would fail or hang; the fixture only plants the remote-tracking ref.
    await git(repo, ["remote", "add", "origin", "https://unreachable.invalid/never.git"]);
    const sha = await head(repo);
    await git(repo, ["update-ref", "refs/remotes/origin/feature/remote-only", sha]);

    const dest = path.join(worktreesDir, "remote-only");
    const res = await addWorktree(repo, dest, { kind: "remoteBranch", remote: "origin", branch: "feature/remote-only" });
    expect(res).toMatchObject({ ok: true, branch: "feature/remote-only", createdBranch: true });
    expect((await git(repo, ["config", "branch.feature/remote-only.remote"])).stdout.trim()).toBe("origin");
    expect((await git(repo, ["config", "branch.feature/remote-only.merge"])).stdout.trim()).toBe("refs/heads/feature/remote-only");
  });
});

describe("addWorktree: refusals leave NO side effects (AC4)", () => {
  async function state(repo: string, parent: string) {
    return {
      porcelain: (await git(repo, ["worktree", "list", "--porcelain"])).stdout,
      refs: (await git(repo, ["for-each-ref"])).stdout,
      parentTree: await snapshotTree(parent),
    };
  }

  async function expectRefusal(repo: string, parent: string, dest: string, source: AddWorktreeSource, reason: string, destinationReason?: string) {
    const before = await state(repo, parent);
    const res = await addWorktree(repo, dest, source);
    expect(res).toMatchObject(destinationReason ? { ok: false, reason, destinationReason } : { ok: false, reason });
    expect(await state(repo, parent)).toEqual(before);
    return res;
  }

  it("non-empty target folder", async () => {
    const { parent, repo, worktreesDir } = await makeRepoInTempParent();
    dirs.push(parent);
    await git(repo, ["branch", "b1"]);
    const dest = path.join(worktreesDir, "busy");
    await writeFile(dest, "x.txt", "occupied");
    await expectRefusal(repo, parent, dest, { kind: "branch", branch: "b1" }, "destination", "notEmpty");
  });

  it("inside the repository working tree and inside its .git", async () => {
    const { parent, repo } = await makeRepoInTempParent();
    dirs.push(parent);
    await git(repo, ["branch", "b1"]);
    await expectRefusal(repo, parent, path.join(repo, "sub", "wt"), { kind: "branch", branch: "b1" }, "destination", "insideRepo");
    await expectRefusal(repo, parent, path.join(repo, ".git", "wt"), { kind: "branch", branch: "b1" }, "destination", "insideRepo");
  });

  it("an existing worktree's folder (names its branch) and a branch checked out in another worktree (names its path)", async () => {
    const { parent, repo, worktreesDir } = await makeRepoInTempParent();
    dirs.push(parent);
    const first = path.join(worktreesDir, "first");
    expect((await addWorktree(repo, first, { kind: "newBranch", branch: "taken", startPoint: "HEAD" })).ok).toBe(true);

    await git(repo, ["branch", "spare"]);
    const res = await expectRefusal(repo, parent, first, { kind: "branch", branch: "spare" }, "destination", "alreadyWorktree");
    expect(res).toMatchObject({ branch: "taken" });

    const other = await expectRefusal(repo, parent, path.join(worktreesDir, "second"), { kind: "branch", branch: "taken" }, "branchCheckedOut");
    expect(samePath((other as { worktreePath: string }).worktreePath, first)).toBe(true);
    // The current branch of the main worktree can never get a second worktree either.
    await expectRefusal(repo, parent, path.join(worktreesDir, "third"), { kind: "branch", branch: "main" }, "branchCheckedOut");
  });

  it("bad, taken and unknown names", async () => {
    const { parent, repo, worktreesDir } = await makeRepoInTempParent();
    dirs.push(parent);
    await git(repo, ["branch", "exists"]);
    const dest = path.join(worktreesDir, "x");
    await expectRefusal(repo, parent, dest, { kind: "newBranch", branch: "bad name~^", startPoint: "HEAD" }, "invalidBranchName");
    await expectRefusal(repo, parent, dest, { kind: "newBranch", branch: "--evil", startPoint: "HEAD" }, "invalidBranchName");
    await expectRefusal(repo, parent, dest, { kind: "newBranch", branch: "@{-1}", startPoint: "HEAD" }, "invalidBranchName");
    await expectRefusal(repo, parent, dest, { kind: "newBranch", branch: "exists", startPoint: "HEAD" }, "branchExists");
    await expectRefusal(repo, parent, dest, { kind: "branch", branch: "nope" }, "branchNotFound");
    await expectRefusal(repo, parent, dest, { kind: "newBranch", branch: "fresh", startPoint: "no-such-rev" }, "startPointNotFound");
    await expectRefusal(repo, parent, dest, { kind: "newBranch", branch: "fresh", startPoint: "--upload-pack=x" }, "startPointNotFound");
    await expectRefusal(repo, parent, dest, { kind: "remoteBranch", remote: "origin", branch: "x" }, "remoteNotFound");
  });

  it("an empty repository has nothing to start from", async () => {
    const { parent, repo, worktreesDir } = await makeRepoInTempParent({ withCommit: false });
    dirs.push(parent);
    await expectRefusal(repo, parent, path.join(worktreesDir, "x"), { kind: "newBranch", branch: "fresh", startPoint: "HEAD" }, "emptyRepository");
  });

  it("a symlink/junction leaf", async (ctx) => {
    const { parent, repo, worktreesDir } = await makeRepoInTempParent();
    dirs.push(parent);
    await git(repo, ["branch", "b1"]);
    const target = path.join(parent, "link-target");
    await fs.mkdir(target);
    await fs.mkdir(worktreesDir);
    const link = path.join(worktreesDir, "linked");
    if (!(await tryMakeDirLink(target, link))) return ctx.skip();
    await expectRefusal(repo, parent, link, { kind: "branch", branch: "b1" }, "destination", "symlinkLeaf");
  });

  it("UNC and drive-root destinations", async () => {
    const { parent, repo } = await makeRepoInTempParent();
    dirs.push(parent);
    await git(repo, ["branch", "b1"]);
    await expectRefusal(repo, parent, "//server/share/wt", { kind: "branch", branch: "b1" }, "destination", "unc");
    await expectRefusal(repo, parent, "\\\\server\\share\\wt", { kind: "branch", branch: "b1" }, "destination", "unc");
    await expectRefusal(repo, parent, "relative/wt", { kind: "branch", branch: "b1" }, "destination", "notAbsolute");
    await expectRefusal(repo, parent, path.parse(repo).root, { kind: "branch", branch: "b1" }, "destination", "driveRoot");
  });

  it("a read-only parent leaves no new branch (POSIX only)", async (ctx) => {
    if (process.platform === "win32" || (process.getuid && process.getuid() === 0)) return ctx.skip();
    const { parent, repo, worktreesDir } = await makeRepoInTempParent();
    dirs.push(parent);
    await fs.mkdir(worktreesDir);
    await fs.chmod(worktreesDir, 0o555);
    try {
      const before = await state(repo, parent);
      const res = await addWorktree(repo, path.join(worktreesDir, "wt"), { kind: "newBranch", branch: "never", startPoint: "HEAD" });
      expect(res.ok).toBe(false);
      expect((await git(repo, ["for-each-ref", "refs/heads/never"])).stdout).toBe("");
      expect(await state(repo, parent)).toEqual(before);
    } finally {
      await fs.chmod(worktreesDir, 0o755);
    }
  });
});

describe("addWorktree: hooks and fsmonitor never run unless the user allowed the hook (AC9, FR-638)", () => {
  async function plantedRepo() {
    const { parent, repo, worktreesDir } = await makeRepoInTempParent();
    dirs.push(parent);
    await git(repo, ["branch", "b1"]);
    await git(repo, ["branch", "b2"]);
    const outside = path.join(parent, "outside");
    await fs.mkdir(outside);
    const fwd = (p: string) => p.replace(/\\/g, "/");
    const hookSentinel = path.join(outside, "hook-sentinel");
    const fsmSentinel = path.join(outside, "fsm-sentinel");
    const hook = path.join(repo, ".git", "hooks", "post-checkout");
    await fs.writeFile(hook, `#!/bin/sh\necho ran >> "${fwd(hookSentinel)}"\n`);
    await fs.chmod(hook, 0o755);
    const fsmScript = path.join(outside, "fsm.sh");
    await fs.writeFile(fsmScript, `#!/bin/sh\necho ran >> "${fwd(fsmSentinel)}"\n`);
    await fs.chmod(fsmScript, 0o755);
    await git(repo, ["config", "core.fsmonitor", fwd(fsmScript)]);
    return { parent, repo, worktreesDir, hookSentinel, fsmSentinel };
  }

  it("positive control: plain git really does fire both planted programs on `worktree add`", async () => {
    const p = await plantedRepo();
    await git(p.repo, ["worktree", "add", "-q", path.join(p.worktreesDir, "control"), "b1"]);
    expect(await fileExists(p.hookSentinel)).toBe(true);
    expect(await fileExists(p.fsmSentinel)).toBe(true);
  });

  it("addWorktree leaves neither sentinel", async () => {
    const p = await plantedRepo();
    const res = await addWorktree(p.repo, path.join(p.worktreesDir, "safe"), { kind: "branch", branch: "b1" });
    expect(res.ok).toBe(true);
    expect(await fileExists(p.hookSentinel)).toBe(false);
    expect(await fileExists(p.fsmSentinel)).toBe(false);
  });

  it("runPostCheckoutHook:true runs the hook exactly once (fsmonitor stays neutralised) and still creates the worktree", async () => {
    const p = await plantedRepo();
    const dest = path.join(p.worktreesDir, "trusted");
    const res = await addWorktree(p.repo, dest, { kind: "branch", branch: "b2" }, { runPostCheckoutHook: true, expectedHookFingerprint: await hookFingerprint(p.repo) });
    expect(res).toMatchObject({ ok: true, warning: null });
    expect((await fs.readFile(p.hookSentinel, "utf8")).trim().split(/\r?\n/)).toEqual(["ran"]);
    expect(await fileExists(p.fsmSentinel)).toBe(false);
    expect(await fileExists(path.join(dest, "a.txt"))).toBe(true);
  });

  it("a failing allowed hook reports 'created, but' and keeps the worktree", async () => {
    const p = await plantedRepo();
    const hook = path.join(p.repo, ".git", "hooks", "post-checkout");
    await fs.writeFile(hook, "#!/bin/sh\nexit 3\n");
    const dest = path.join(p.worktreesDir, "kept");
    const res = await addWorktree(p.repo, dest, { kind: "branch", branch: "b1" }, { runPostCheckoutHook: true, expectedHookFingerprint: await hookFingerprint(p.repo) });
    expect(res).toMatchObject({ ok: true, warning: { reason: "createdButFailed" }, branch: "b1" });
    expect((await listWorktrees(p.repo)).entries.some((e) => e.branch === "b1")).toBe(true);
    expect(await fileExists(path.join(dest, "a.txt"))).toBe(true);
  });

  it("every add argv carries the fsmonitor and hooks overrides, the option terminator and an absolute path", async () => {
    const p = await plantedRepo();
    const { runner, calls } = recordingRunner();
    _setWorktreeRunnerForTests(runner);
    const dest = path.join(p.worktreesDir, "argv");
    await addWorktree(p.repo, dest, { kind: "branch", branch: "b1" });
    const add = calls.find((c) => c.args.includes("add"))!;
    expect(add.args.slice(0, 2)).toEqual(["-c", "core.fsmonitor=false"]);
    expect(add.args.some((a) => a.startsWith("core.hooksPath="))).toBe(true);
    const term = add.args.indexOf("--");
    expect(path.isAbsolute(add.args[term + 1]!)).toBe(true);
    expect(add.opts.cwd).toBeTruthy();
  });
});

describe("addWorktree: rollback removes only what this call created", () => {
  it("a failed add after git created the branch deletes that branch again and leaves other state alone", async () => {
    const { parent, repo, worktreesDir } = await makeRepoInTempParent();
    dirs.push(parent);
    await git(repo, ["branch", "pre-existing"]);
    // Force git itself to fail after `-b` created the branch: a dangling gitdir file target makes the add abort.
    const { runner } = recordingRunner((args) => (args.includes("add") ? { args: [...args.slice(0, args.indexOf("--") + 1), path.join(repo, "a.txt"), args[args.length - 1]!] } : undefined));
    _setWorktreeRunnerForTests(runner);
    await expect(addWorktree(repo, path.join(worktreesDir, "rb"), { kind: "newBranch", branch: "rolled-back", startPoint: "HEAD" })).rejects.toMatchObject({
      name: "WorktreeOperationError",
    });
    _setWorktreeRunnerForTests(null);
    expect((await git(repo, ["for-each-ref", "--format=%(refname:short)", "refs/heads"])).stdout.split("\n").filter(Boolean).sort()).toEqual(["main", "pre-existing"]);
    expect(await fileExists(path.join(worktreesDir, "rb"))).toBe(false);
    expect(await fileExists(worktreesDir)).toBe(false);
  });
});
