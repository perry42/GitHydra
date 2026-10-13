// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { listWorktrees } from "../src/worktreeList";
import { git, cleanup, makeRepoInTempParent, seedBareRepo } from "./testRepo";
import { samePath } from "./worktreeKit";

/** specs/worktrees.md FR-601, AC1, AC3: typed entries from real fixtures on the machine's own git. */
const dirs: string[] = [];
afterEach(async () => {
  while (dirs.length) await cleanup(dirs.pop()!);
});

describe("listWorktrees (FR-601)", () => {
  it("lists main, linked, detached, locked (with reason) and two prunable entries, with spaces and non-ASCII names", async () => {
    const { parent, repo } = await makeRepoInTempParent();
    dirs.push(parent);
    const at = (n: string) => path.join(parent, n);
    await git(repo, ["worktree", "add", "-q", at("free tree"), "-b", "feature/日本-é"]);
    await git(repo, ["worktree", "add", "-q", "--detach", at("detached")]);
    await git(repo, ["worktree", "add", "-q", at("locked"), "-b", "locked-b"]);
    await git(repo, ["worktree", "lock", "--reason", "on a usb stick", at("locked")]);
    for (const n of ["gone-a", "gone-b"]) {
      await git(repo, ["worktree", "add", "-q", at(n), "-b", n]);
      await fs.rm(at(n), { recursive: true, force: true });
    }

    const list = await listWorktrees(repo);
    expect(list.untrusted).toBe(false);
    expect(list.entries).toHaveLength(6);

    const [main, ...linked] = list.entries;
    expect(main).toMatchObject({ id: null, isMain: true, isBare: false, branch: "main", supported: true, locked: false, prunable: false });
    expect(samePath(main!.path, repo)).toBe(true);
    expect(main!.head).toMatch(/^[0-9a-f]{40}$/);
    expect(list.mainPath).toBe(main!.path);

    const byBranch = (b: string) => linked.find((e) => e.branch === b)!;
    const free = byBranch("feature/日本-é");
    expect(samePath(free.path, at("free tree"))).toBe(true);
    expect(free).toMatchObject({ id: "free-tree", isMain: false, detached: false, supported: true, locked: false, prunable: false });

    const detached = linked.find((e) => e.detached)!;
    expect(detached.branch).toBeNull();
    expect(detached.head).toMatch(/^[0-9a-f]{40}$/);
    expect(detached.shortHead).toBe(detached.head!.slice(0, 7));
    expect(samePath(detached.path, at("detached"))).toBe(true);

    expect(byBranch("locked-b")).toMatchObject({ locked: true, lockReason: "on a usb stick", prunable: false });

    const gone = linked.filter((e) => e.prunable);
    expect(gone.map((e) => e.branch).sort()).toEqual(["gone-a", "gone-b"]);
    for (const e of gone) expect(e.prunableReason).toMatch(/non-existent/);
    expect(linked.map((e) => e.id)).toEqual([...linked.map((e) => e.id)].sort());
  });

  it("lists the same entries when the repo is opened from a linked worktree (main still first, id null)", async () => {
    const { parent, repo } = await makeRepoInTempParent();
    dirs.push(parent);
    const linkedDir = path.join(parent, "second");
    await git(repo, ["worktree", "add", "-q", linkedDir, "-b", "second"]);

    const fromMain = await listWorktrees(repo);
    const fromLinked = await listWorktrees(linkedDir);
    expect(fromLinked.entries.map((e) => [e.id, e.branch])).toEqual(fromMain.entries.map((e) => [e.id, e.branch]));
    expect(samePath(fromLinked.mainPath, repo)).toBe(true);
    expect(samePath(fromLinked.commonDir, path.join(repo, ".git"))).toBe(true);
  });

  it("lists a bare repository as the main entry, flagged bare, plus its linked worktrees", async () => {
    const { parent, bare } = await seedBareRepo();
    dirs.push(parent);
    const wt = path.join(parent, "bare-wt");
    await git(bare, ["worktree", "add", "-q", wt, "main"]);

    const list = await listWorktrees(bare);
    expect(list.untrusted).toBe(false);
    expect(list.entries[0]).toMatchObject({ id: null, isMain: true, isBare: true, branch: null, head: null });
    expect(samePath(list.mainPath, bare)).toBe(true);
    expect(list.entries[1]).toMatchObject({ isMain: false, branch: "main", supported: true });
    expect(samePath(list.entries[1]!.path, wt)).toBe(true);
  });

  it("lists an empty repository (unborn branch) without a HEAD id", async () => {
    const { parent, repo } = await makeRepoInTempParent({ withCommit: false });
    dirs.push(parent);
    const list = await listWorktrees(repo);
    expect(list.entries).toHaveLength(1);
    expect(list.entries[0]).toMatchObject({ isMain: true, branch: "main", head: null, shortHead: null });
  });

  it("an admin dir whose gitdir has no /.git suffix is listed unsupported (git prints the main path for it) and stays consistent", async () => {
    const { parent, repo } = await makeRepoInTempParent();
    dirs.push(parent);
    await git(repo, ["worktree", "add", "-q", path.join(parent, "odd"), "-b", "odd"]);
    await fs.writeFile(path.join(repo, ".git", "worktrees", "odd", "gitdir"), "/somewhere/else\n");

    const list = await listWorktrees(repo);
    const odd = list.entries.find((e) => e.id === "odd")!;
    expect(odd.supported).toBe(false);
    expect(list.untrusted).toBe(false);
  });

  it("a --separate-git-dir repo: git prints the git dir as main; the real working tree is recovered when opened from it", async () => {
    const { parent } = await makeRepoInTempParent({ withCommit: false });
    dirs.push(parent);
    const work = path.join(parent, "sep-work");
    const gitDir = path.join(parent, "sep-git.git");
    await fs.mkdir(work);
    await git(parent, ["init", "-q", "--initial-branch=main", "--separate-git-dir", gitDir, work]);
    await fs.writeFile(path.join(work, "a.txt"), "x\n");
    await git(work, ["add", "-A"]);
    await git(work, ["commit", "-q", "-m", "first"]);
    const linked = path.join(parent, "sep-linked");
    await git(work, ["worktree", "add", "-q", linked, "-b", "sep-b"]);

    const fromMain = await listWorktrees(work);
    expect(samePath(fromMain.mainPath, work)).toBe(true);
    expect(fromMain.mainPathIsGitDir).toBe(false);
    const fromLinked = await listWorktrees(linked);
    expect(fromLinked.mainPathIsGitDir).toBe(true);
    expect(samePath(fromLinked.mainPath, gitDir)).toBe(true);
  });

  it("a nonexistent path is a NotAGitRepositoryError, not a crash", async () => {
    await expect(listWorktrees(path.join(process.cwd(), ".tmp-test-repos", "definitely-missing-dir"))).rejects.toThrow(/Not a git repository/);
  });
});
