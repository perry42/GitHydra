// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getBranchMergeState, getWorktreeRemovalState, removeWorktree, removeWorktreeAndDeleteBranch, countStatusEntries } from "../src/worktrees";
import { listWorktrees } from "../src/worktreeList";
import { _setWorktreeGitVersionForTests, _setWorktreeRunnerForTests } from "../src/worktreeRunner";
import { git, cleanup, commit, fileExists, makeRepoInTempParent, tryMakeDirLink, writeFile } from "./testRepo";
import { recordingRunner, samePath } from "./worktreeKit";

/** specs/worktrees.md AC5, AC6 and FR-603/605/641: real worktrees, the machine's own git. */
const dirs: string[] = [];
const children: ChildProcess[] = [];
beforeEach(() => {
  _setWorktreeGitVersionForTests(undefined);
  _setWorktreeRunnerForTests(null);
});
afterEach(async () => {
  _setWorktreeRunnerForTests(null);
  for (const c of children.splice(0)) c.kill();
  while (dirs.length) await cleanup(dirs.pop()!);
});

async function fixture(opts: { branch?: string; name?: string } = {}) {
  const { parent, repo } = await makeRepoInTempParent({ name: opts.name });
  dirs.push(parent);
  const branch = opts.branch ?? "topic";
  const wt = path.join(parent, "wt");
  await git(repo, ["worktree", "add", "-q", wt, "-b", branch]);
  const list = await listWorktrees(repo);
  const entry = list.entries.find((e) => e.branch === branch)!;
  return { parent, repo, wt, branch, id: entry.id!, confirmedPath: entry.path };
}

describe("removeWorktree: outcomes (AC5)", () => {
  it("removes a clean worktree's folder and keeps its branch", async () => {
    const f = await fixture();
    const res = await removeWorktree(f.repo, f.id, { confirmedPath: f.confirmedPath });
    expect(res).toMatchObject({ ok: true, id: f.id, branch: "topic" });
    expect(await fileExists(f.wt)).toBe(false);
    expect((await listWorktrees(f.repo)).entries).toHaveLength(1);
    expect((await git(f.repo, ["branch", "--list", "topic"])).stdout).toContain("topic");
  });

  it("refuses a dirty worktree with the file count (untracked directories counted by their files) and deletes nothing", async () => {
    const f = await fixture();
    await writeFile(f.wt, "a.txt", "changed\n");
    await writeFile(f.wt, "newdir/one.txt", "1");
    await writeFile(f.wt, "newdir/two.txt", "2");
    await writeFile(f.wt, "newdir/deep/three.txt", "3");

    const state = await getWorktreeRemovalState(f.repo, f.id);
    expect(state).toMatchObject({ ok: true, count: 4 });
    const res = await removeWorktree(f.repo, f.id, { confirmedPath: f.confirmedPath });
    expect(res).toMatchObject({ ok: false, reason: "dirty", count: 4 });
    expect(await fileExists(path.join(f.wt, "newdir", "deep", "three.txt"))).toBe(true);
    expect((await listWorktrees(f.repo)).entries).toHaveLength(2);
  });

  it("force removes a dirty worktree, with exactly one force flag in the argv", async () => {
    const f = await fixture();
    await writeFile(f.wt, "scratch.txt", "x");
    const { runner, calls } = recordingRunner();
    _setWorktreeRunnerForTests(runner);
    const res = await removeWorktree(f.repo, f.id, { confirmedPath: f.confirmedPath, force: true, expectedCount: 1 });
    expect(res.ok).toBe(true);
    expect(await fileExists(f.wt)).toBe(false);
    const removes = calls.filter((c) => c.args.includes("remove"));
    expect(removes).toHaveLength(1);
    expect(removes[0]!.args.filter((a) => a === "--force")).toHaveLength(1);
  });

  it("force on a clean worktree passes no force flag at all", async () => {
    const f = await fixture();
    const { runner, calls } = recordingRunner();
    _setWorktreeRunnerForTests(runner);
    expect((await removeWorktree(f.repo, f.id, { confirmedPath: f.confirmedPath, force: true })).ok).toBe(true);
    expect(calls.some((c) => c.args.includes("--force"))).toBe(false);
  });

  it("removes an ignored-only worktree and its ignored files (the data-loss path the confirm must name)", async () => {
    const { parent, repo } = await makeRepoInTempParent();
    dirs.push(parent);
    await writeFile(repo, ".gitignore", "node_modules/\nbuild/\n");
    await commit(repo, "ignore rules");
    const wt = path.join(parent, "wt");
    await git(repo, ["worktree", "add", "-q", wt, "-b", "ign"]);
    await writeFile(wt, "node_modules/pkg/index.js", "module.exports = 1;");
    await writeFile(wt, "build/out.bin", "bin");

    const id = (await listWorktrees(repo)).entries[1]!.id!;
    expect(await getWorktreeRemovalState(repo, id)).toMatchObject({ ok: true, count: 0 });
    const res = await removeWorktree(repo, id, { confirmedPath: wt });
    expect(res.ok).toBe(true);
    expect(await fileExists(wt)).toBe(false);
  });

  it("refuses a locked worktree with its reason, and force does not override it", async () => {
    const f = await fixture();
    await git(f.repo, ["worktree", "lock", "--reason", "keep me", f.wt]);
    const { runner, calls } = recordingRunner();
    _setWorktreeRunnerForTests(runner);
    for (const force of [false, true]) {
      const res = await removeWorktree(f.repo, f.id, { confirmedPath: f.confirmedPath, force });
      expect(res).toMatchObject({ ok: false, reason: "locked", lockReason: "keep me" });
    }
    expect(calls.some((c) => c.args.includes("remove"))).toBe(false);
    expect(await fileExists(f.wt)).toBe(true);
  });

  it("hasSubmodules is its own reason; force then removes it", async () => {
    const { parent, repo } = await makeRepoInTempParent();
    dirs.push(parent);
    const subRepo = path.join(parent, "sub-origin");
    await fs.mkdir(subRepo);
    await git(parent, ["init", "-q", "--initial-branch=main", subRepo]);
    await writeFile(subRepo, "s.txt", "sub\n");
    await commit(subRepo, "sub first");
    // protocol.file.allow is a TEST-only concession for a local fixture; production never sets it (FR-632).
    await git(repo, ["-c", "protocol.file.allow=always", "submodule", "add", "-q", subRepo.replace(/\\/g, "/"), "sub"]);
    await commit(repo, "add submodule");
    const wt = path.join(parent, "wt-sub");
    await git(repo, ["worktree", "add", "-q", wt, "-b", "with-sub"]);
    await git(wt, ["-c", "protocol.file.allow=always", "submodule", "update", "--init", "-q"]);
    expect(await fileExists(path.join(wt, "sub", ".git"))).toBe(true);

    const id = (await listWorktrees(repo)).entries[1]!.id!;
    const refused = await removeWorktree(repo, id, { confirmedPath: wt });
    expect(refused).toMatchObject({ ok: false, reason: "hasSubmodules", submodules: ["sub"], dirtySubmodules: [] });
    expect(await fileExists(wt)).toBe(true);

    await writeFile(wt, "sub/s.txt", "dirty submodule\n");
    expect(await removeWorktree(repo, id, { confirmedPath: wt })).toMatchObject({ ok: false, reason: "dirty", dirtySubmodules: ["sub"] });

    const forced = await removeWorktree(repo, id, { confirmedPath: wt, force: true, expectedCount: 1, expectedSubmodules: ["sub"] });
    expect(forced.ok).toBe(true);
    expect(await fileExists(wt)).toBe(false);
  });

  it("refuses when the confirmed path no longer matches the listing", async () => {
    const f = await fixture();
    const res = await removeWorktree(f.repo, f.id, { confirmedPath: path.join(f.parent, "somewhere-else") });
    expect(res).toMatchObject({ ok: false, reason: "pathChanged" });
    expect(await fileExists(f.wt)).toBe(true);
  });

  it("a trailing separator on the confirmed path is the same folder", async () => {
    const f = await fixture();
    expect((await removeWorktree(f.repo, f.id, { confirmedPath: f.confirmedPath + path.sep })).ok).toBe(true);
  });

  it("unknown id and a missing folder are typed refusals", async () => {
    const f = await fixture();
    expect(await removeWorktree(f.repo, "nope", { confirmedPath: f.confirmedPath })).toMatchObject({ ok: false, reason: "notFound" });
    await fs.rm(f.wt, { recursive: true, force: true });
    expect(await removeWorktree(f.repo, f.id, { confirmedPath: f.confirmedPath })).toMatchObject({ ok: false, reason: "missing" });
  });

  it("runs git with the main worktree as cwd, never inside the target", async () => {
    const f = await fixture();
    const { runner, calls } = recordingRunner();
    _setWorktreeRunnerForTests(runner);
    await removeWorktree(f.repo, f.id, { confirmedPath: f.confirmedPath });
    const remove = calls.find((c) => c.args.includes("remove"))!;
    expect(samePath(remove.opts.cwd, f.repo)).toBe(true);
    expect(path.relative(f.wt, remove.opts.cwd).startsWith("..")).toBe(true);
  });

  it("refuses to remove the worktree the caller is operating from", async () => {
    const f = await fixture();
    expect(await removeWorktree(f.wt, f.id, { confirmedPath: f.confirmedPath })).toMatchObject({ ok: false, reason: "inUse" });
    expect(await fileExists(f.wt)).toBe(true);
  });

  it("a Windows 'busy folder' failure is the typed inUse refusal", async (ctx) => {
    if (process.platform !== "win32") return ctx.skip();
    const f = await fixture();
    // A process whose cwd is inside the worktree holds the folder open.
    const holder = spawn(process.execPath, ["-e", "setTimeout(()=>{},60000)"], { cwd: f.wt, stdio: "ignore" });
    children.push(holder);
    await new Promise((r) => setTimeout(r, 500));
    const res = await removeWorktree(f.repo, f.id, { confirmedPath: f.confirmedPath });
    expect(res).toMatchObject({ ok: false, reason: "inUse" });
  });
});

describe("removeWorktree: the main worktree and unsafe targets (FR-641)", () => {
  it("refuses the main worktree by id null and by every alias of its path", async () => {
    const f = await fixture({ name: "mainrepo-with-long-name" });
    const aliases = [
      f.repo,
      f.repo + path.sep,
      f.repo + "/",
      path.join(f.repo, "..", path.basename(f.repo)),
      path.join(f.repo, "sub", "..", ""),
    ];
    if (process.platform === "win32") aliases.push(f.repo.toUpperCase(), f.repo.toLowerCase());
    const short = process.platform === "win32" ? shortPathWindows(f.repo) : null;
    if (short && short.toLowerCase() !== f.repo.toLowerCase()) aliases.push(short);

    for (const alias of aliases) {
      expect(await removeWorktree(f.repo, null, { confirmedPath: alias }), alias).toMatchObject({ ok: false, reason: "main" });
      expect(await removeWorktree(f.repo, f.id, { confirmedPath: alias }), alias).toMatchObject({ ok: false, reason: "main" });
    }
    expect(await fileExists(path.join(f.repo, ".git"))).toBe(true);
    expect(await fileExists(f.wt)).toBe(true);
  });

  it("a registered entry that resolves to the main folder is refused as main", async () => {
    const f = await fixture();
    const gitdirFile = path.join(f.repo, ".git", "worktrees", f.id, "gitdir");
    // An alias of the main folder as a "linked" entry (forged admin data).
    await fs.writeFile(gitdirFile, `${path.join(f.repo, "..", path.basename(f.repo)).replace(/\\/g, "/")}/.git\n`);
    const entry = (await listWorktrees(f.repo)).entries[1]!;
    const res = await removeWorktree(f.repo, f.id, { confirmedPath: entry.path });
    expect(res).toMatchObject({ ok: false, reason: "main" });
    expect(await fileExists(path.join(f.repo, "a.txt"))).toBe(true);
  });

  it("refuses an entry that is an ancestor of the main folder or contains another worktree, and deletes nothing", async () => {
    const f = await fixture();
    const gitdirFile = path.join(f.repo, ".git", "worktrees", f.id, "gitdir");
    // A `.git` file at the claimed location keeps git from calling the entry prunable.
    await fs.writeFile(path.join(f.parent, ".git"), "gitdir: nowhere\n");
    await fs.writeFile(gitdirFile, `${f.parent.replace(/\\/g, "/")}/.git\n`);
    const entry = (await listWorktrees(f.repo)).entries[1]!;
    expect(await removeWorktree(f.repo, f.id, { confirmedPath: entry.path })).toMatchObject({ ok: false, reason: "unsafeTarget" });
    expect(await fileExists(path.join(f.repo, "a.txt"))).toBe(true);

    // Contains another registered worktree: the grandparent of `inner`.
    const container = path.join(f.parent, "container");
    const inner = path.join(container, "inner");
    await git(f.repo, ["worktree", "add", "-q", inner, "-b", "inner"]);
    await fs.writeFile(path.join(container, ".git"), "gitdir: nowhere\n");
    await fs.writeFile(gitdirFile, `${container.replace(/\\/g, "/")}/.git\n`);
    const forged = (await listWorktrees(f.repo)).entries.find((e) => e.id === f.id)!;
    expect(await removeWorktree(f.repo, f.id, { confirmedPath: forged.path })).toMatchObject({ ok: false, reason: "unsafeTarget" });
    expect(await fileExists(path.join(inner, "a.txt"))).toBe(true);
  });

  it("refuses a worktree folder that is a symlink or junction and leaves its target alone", async (ctx) => {
    const f = await fixture();
    const aside = path.join(f.parent, "aside");
    await fs.rename(f.wt, aside);
    if (!(await tryMakeDirLink(aside, f.wt))) {
      await fs.rename(aside, f.wt);
      return ctx.skip();
    }
    const res = await removeWorktree(f.repo, f.id, { confirmedPath: f.confirmedPath });
    expect(res).toMatchObject({ ok: false, reason: "symlinkTarget" });
    expect(await fileExists(path.join(aside, "a.txt"))).toBe(true);
  });

  it("a worktree containing a link to an outside directory: the outside file survives removal", async (ctx) => {
    const { parent, repo } = await makeRepoInTempParent();
    dirs.push(parent);
    await writeFile(repo, ".gitignore", "ignored-link\n");
    await commit(repo, "ignore the link");
    const wt = path.join(parent, "wt");
    await git(repo, ["worktree", "add", "-q", wt, "-b", "linky"]);
    const outside = path.join(parent, "outside");
    await writeFile(outside, "precious.txt", "keep me\n");
    if (!(await tryMakeDirLink(outside, path.join(wt, "ignored-link")))) return ctx.skip();

    const id = (await listWorktrees(repo)).entries[1]!.id!;
    const res = await removeWorktree(repo, id, { confirmedPath: wt });
    expect(res.ok).toBe(true);
    expect(await fileExists(wt)).toBe(false);
    expect(await fs.readFile(path.join(outside, "precious.txt"), "utf8")).toBe("keep me\n");
    if (process.platform === "win32") expect((res as { linksUnlinked: number }).linksUnlinked).toBe(1);
  });

  it("the same holds for an untracked link removed with the dirty-confirmed force", async (ctx) => {
    const f = await fixture();
    const outside = path.join(f.parent, "outside");
    await writeFile(outside, "precious.txt", "keep me\n");
    if (!(await tryMakeDirLink(outside, path.join(f.wt, "visible-link")))) return ctx.skip();

    const refused = await removeWorktree(f.repo, f.id, { confirmedPath: f.confirmedPath });
    expect(refused.ok).toBe(false);
    expect(await fileExists(path.join(outside, "precious.txt"))).toBe(true);
    const res = await removeWorktree(f.repo, f.id, { confirmedPath: f.confirmedPath, force: true, expectedCount: (refused as { count: number }).count });
    expect(res.ok).toBe(true);
    expect(await fs.readFile(path.join(outside, "precious.txt"), "utf8")).toBe("keep me\n");
  });
});

describe("removeWorktreeAndDeleteBranch (AC6, FR-605)", () => {
  it("removes the worktree first, then deletes a merged branch with branch -d (never the force variant)", async () => {
    const f = await fixture({ branch: "merged-topic" });
    const { runner, calls } = recordingRunner();
    _setWorktreeRunnerForTests(runner);
    const res = await removeWorktreeAndDeleteBranch(f.repo, f.id, { confirmedPath: f.confirmedPath, expectedMerged: true });
    expect(res).toMatchObject({ ok: true, branch: { status: "deleted", name: "merged-topic" }, outcomeDiffersFromPreview: false });
    expect(await fileExists(f.wt)).toBe(false);
    expect((await git(f.repo, ["branch", "--list", "merged-topic"])).stdout.trim()).toBe("");

    const verbs = calls.map((c) => c.args.find((a) => a === "remove" || a === "branch")).filter(Boolean);
    expect(verbs).toEqual(["remove", "branch"]);
    const del = calls.find((c) => c.args.includes("branch") && c.args.includes("-d"))!;
    expect(del.args).not.toContain("-D");
  });

  it("keeps an unmerged branch, reports the real commit count, and the worktree stays removed", async () => {
    const f = await fixture({ branch: "unmerged-topic" });
    await writeFile(f.wt, "feature.txt", "work\n");
    await commit(f.wt, "feature one");
    await writeFile(f.wt, "feature2.txt", "more\n");
    await commit(f.wt, "feature two");

    expect(await getBranchMergeState(f.repo, "unmerged-topic")).toMatchObject({ exists: true, merged: false, unmergedCommits: 2, reference: "HEAD" });
    const { runner, calls } = recordingRunner();
    _setWorktreeRunnerForTests(runner);
    const res = await removeWorktreeAndDeleteBranch(f.repo, f.id, { confirmedPath: f.confirmedPath, expectedMerged: true });
    expect(res).toMatchObject({
      ok: true,
      branch: { status: "kept", name: "unmerged-topic", why: "unmerged", unmergedCommits: 2 },
      outcomeDiffersFromPreview: true,
    });
    expect(await fileExists(f.wt)).toBe(false);
    expect((await git(f.repo, ["branch", "--list", "unmerged-topic"])).stdout).toContain("unmerged-topic");
    expect(calls.every((c) => !c.args.includes("-D"))).toBe(true);
  });

  it("never calls branch -d when the worktree removal is refused", async () => {
    const f = await fixture({ branch: "dirty-topic" });
    await writeFile(f.wt, "dirty.txt", "x");
    const { runner, calls } = recordingRunner();
    _setWorktreeRunnerForTests(runner);
    const res = await removeWorktreeAndDeleteBranch(f.repo, f.id, { confirmedPath: f.confirmedPath });
    expect(res).toMatchObject({ ok: false, reason: "dirty" });
    expect(calls.some((c) => c.args.includes("branch") && c.args.includes("-d"))).toBe(false);
    expect((await git(f.repo, ["branch", "--list", "dirty-topic"])).stdout).toContain("dirty-topic");
  });

  it("a detached worktree has no branch to delete", async () => {
    const { parent, repo } = await makeRepoInTempParent();
    dirs.push(parent);
    const wt = path.join(parent, "det");
    await git(repo, ["worktree", "add", "-q", "--detach", wt]);
    const id = (await listWorktrees(repo)).entries[1]!.id!;
    const res = await removeWorktreeAndDeleteBranch(repo, id, { confirmedPath: wt });
    expect(res).toMatchObject({ ok: true, branch: { status: "none" } });
  });
});

describe("countStatusEntries", () => {
  it("counts entries and skips the extra path of a rename", () => {
    const z = ["R  new.txt", "old.txt", " M a.txt", "?? dir/b.txt", ""].join("\0");
    expect(countStatusEntries(z)).toEqual({ count: 3, paths: ["new.txt", "a.txt", "dir/b.txt"] });
    expect(countStatusEntries("")).toEqual({ count: 0, paths: [] });
  });
});

function shortPathWindows(p: string): string | null {
  try {
    const ps = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const out = execFileSync(ps, ["-NoProfile", "-Command", "(New-Object -ComObject Scripting.FileSystemObject).GetFolder($env:P).ShortPath"], {
      encoding: "utf8",
      env: { ...process.env, P: p },
    });
    return out.trim() || null;
  } catch {
    return null;
  }
}

describe("forced removal is bound to what the user saw (slice-2 review MED-1)", () => {
  async function dirtyFixture(n = 3) {
    const f = await fixture();
    for (let i = 0; i < n; i++) await writeFile(f.wt, `scratch/${i}.txt`, "x");
    return f;
  }

  it("refuses after the count changed, with the fresh numbers, and removes nothing", async () => {
    const f = await dirtyFixture(3);
    for (let i = 0; i < 400; i++) await writeFile(f.wt, `appeared/${i}.txt`, "y");
    const { runner, calls } = recordingRunner();
    _setWorktreeRunnerForTests(runner);
    const res = await removeWorktree(f.repo, f.id, { confirmedPath: f.confirmedPath, force: true, expectedCount: 3 });
    expect(res).toMatchObject({ ok: false, reason: "dirty", count: 403 });
    expect(calls.some((c) => c.args.includes("remove"))).toBe(false);
    expect(await fileExists(path.join(f.wt, "appeared", "399.txt"))).toBe(true);
  });

  it("removes when the expectation matches", async () => {
    const f = await dirtyFixture(3);
    const { runner, calls } = recordingRunner();
    _setWorktreeRunnerForTests(runner);
    const res = await removeWorktree(f.repo, f.id, { confirmedPath: f.confirmedPath, force: true, expectedCount: 3, expectedSubmodules: [] });
    expect(res.ok).toBe(true);
    expect(calls.filter((c) => c.args.includes("--force"))).toHaveLength(1);
    expect(await fileExists(f.wt)).toBe(false);
  });

  it("force without an expectation is refused (expectationRequired)", async () => {
    const f = await dirtyFixture(2);
    const res = await removeWorktree(f.repo, f.id, { confirmedPath: f.confirmedPath, force: true });
    expect(res).toMatchObject({ ok: false, reason: "expectationRequired" });
    expect(await fileExists(path.join(f.wt, "scratch", "0.txt"))).toBe(true);
  });

  it("a clean worktree never gets the force flag, expectation or not", async () => {
    const f = await fixture();
    const { runner, calls } = recordingRunner();
    _setWorktreeRunnerForTests(runner);
    expect((await removeWorktree(f.repo, f.id, { confirmedPath: f.confirmedPath, force: true, expectedCount: 25 })).ok).toBe(true);
    expect(calls.some((c) => c.args.includes("--force"))).toBe(false);
  });

  it("locked and main ignore force and expectation", async () => {
    const f = await dirtyFixture(1);
    await git(f.repo, ["worktree", "lock", "--reason", "r", f.wt]);
    expect(await removeWorktree(f.repo, f.id, { confirmedPath: f.confirmedPath, force: true, expectedCount: 1 })).toMatchObject({ ok: false, reason: "locked" });
    expect(await removeWorktree(f.repo, null, { confirmedPath: f.repo, force: true, expectedCount: 0 })).toMatchObject({ ok: false, reason: "main" });
  });

  it("a changed submodule list is refused even when the count matches", async () => {
    const { parent, repo } = await makeRepoInTempParent();
    dirs.push(parent);
    const subRepo = path.join(parent, "sub-origin");
    await fs.mkdir(subRepo);
    await git(parent, ["init", "-q", "--initial-branch=main", subRepo]);
    await writeFile(subRepo, "s.txt", "sub\n");
    await commit(subRepo, "sub first");
    await git(repo, ["-c", "protocol.file.allow=always", "submodule", "add", "-q", subRepo.replace(/\\/g, "/"), "sub"]);
    await commit(repo, "add submodule");
    const wt = path.join(parent, "wt-sub");
    await git(repo, ["worktree", "add", "-q", wt, "-b", "with-sub"]);
    await git(wt, ["-c", "protocol.file.allow=always", "submodule", "update", "--init", "-q"]);
    const id = (await listWorktrees(repo)).entries[1]!.id!;
    // The user saw "no submodules, 0 changes"; a populated submodule exists now.
    const res = await removeWorktree(repo, id, { confirmedPath: wt, force: true, expectedCount: 0, expectedSubmodules: [] });
    expect(res).toMatchObject({ ok: false, reason: "hasSubmodules", submodules: ["sub"] });
    expect(await fileExists(wt)).toBe(true);
    const ok = await removeWorktree(repo, id, { confirmedPath: wt, force: true, expectedCount: 0, expectedSubmodules: ["sub"] });
    expect(ok.ok).toBe(true);
  });
});
