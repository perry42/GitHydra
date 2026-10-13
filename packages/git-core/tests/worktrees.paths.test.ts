// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { validateWorktreeDestination } from "../src/worktreePaths";
import { defaultWorktreePath, sanitizeFolderName, isReservedDeviceName } from "../src/worktreeParse";
import { git, cleanup, makeRepoInTempParent, makeTempDir, tryMakeDirLink, writeFile } from "./testRepo";

/** specs/worktrees.md FR-609 (default folder) and FR-639 (destination validation). */
const dirs: string[] = [];
afterEach(async () => {
  while (dirs.length) await cleanup(dirs.pop()!);
});

describe("defaultWorktreePath (FR-609, pure)", () => {
  it.each([
    ["/home/me/acme", "feature/login", [], "/home/me/acme.worktrees/feature-login"],
    ["/home/me/acme", "main", [], "/home/me/acme.worktrees/main"],
    ["/home/me/acme.git", "main", [], "/home/me/acme.worktrees/main"], // bare repo: `.git` stripped
    ["/home/me/acme", "fix: a<b>c|d?e*f\"g", [], "/home/me/acme.worktrees/fix- a-b-c-d-e-f-g"],
    ["/home/me/acme", "feature/日本-é", [], "/home/me/acme.worktrees/feature-日本-é"],
    ["/home/me/acme", "release/1.0.", [], "/home/me/acme.worktrees/release-1.0"], // trailing dot trimmed
    ["/home/me/acme", "wip ", [], "/home/me/acme.worktrees/wip"], // trailing space trimmed
    ["/home/me/acme", "con", [], "/home/me/acme.worktrees/_con"],
    ["/home/me/acme", "NUL.txt", [], "/home/me/acme.worktrees/_NUL.txt"],
    ["/home/me/acme", "com1", [], "/home/me/acme.worktrees/_com1"],
    ["/home/me/acme", "...", [], "/home/me/acme.worktrees/worktree"], // empty slug
    ["/home/me/acme", "feature-x", ["feature-x"], "/home/me/acme.worktrees/feature-x-2"],
    ["/home/me/acme", "feature/x", ["Feature-X", "feature-x-2"], "/home/me/acme.worktrees/feature-x-3"],
  ] as const)("%s + %j (taken %j) -> %s", (main, branch, taken, expected) => {
    expect(defaultWorktreePath({ mainWorktreePath: main, branchName: branch, existingNames: taken })).toBe(expected);
  });

  it("follows Windows path style for a drive path, on any OS", () => {
    expect(defaultWorktreePath({ mainWorktreePath: "C:\\Users\\me\\my repo", branchName: "feature/a" })).toBe(
      "C:\\Users\\me\\my repo.worktrees\\feature-a",
    );
    expect(defaultWorktreePath({ mainWorktreePath: "C:/Users/me/acme", branchName: "x" })).toBe("C:\\Users\\me\\acme.worktrees\\x");
  });

  it("derives from the main repo, so two different linked views give the same folder", () => {
    const a = defaultWorktreePath({ mainWorktreePath: "/w/main-repo", branchName: "b" });
    const b = defaultWorktreePath({ mainWorktreePath: "/w/main-repo/", branchName: "b" });
    expect(a).toBe(b);
  });

  it("sanitizeFolderName and isReservedDeviceName", () => {
    expect(sanitizeFolderName("a\\b/c:d")).toBe("a-b-c-d");
    expect(sanitizeFolderName("x\u0007y")).toBe("x-y");
    expect(isReservedDeviceName("LPT9")).toBe(true);
    expect(isReservedDeviceName("console")).toBe(false);
    expect(isReservedDeviceName("aux.tar.gz")).toBe(true);
  });
});

describe("validateWorktreeDestination (FR-639)", () => {
  async function repoFixture() {
    const f = await makeRepoInTempParent();
    dirs.push(f.parent);
    return f;
  }

  it("accepts a fresh sibling path and an existing empty folder, and does not create anything", async () => {
    const f = await repoFixture();
    const fresh = path.join(f.worktreesDir, "fresh");
    expect(await validateWorktreeDestination(f.repo, fresh)).toMatchObject({ ok: true });
    await expect(fs.stat(f.worktreesDir)).rejects.toThrow();

    await fs.mkdir(fresh, { recursive: true });
    expect(await validateWorktreeDestination(f.repo, fresh)).toMatchObject({ ok: true });
  });

  it.each([
    ["UNC backslash", "\\\\server\\share\\wt", "unc"],
    ["UNC forward slash", "//server/share/wt", "unc"],
    ["extended UNC", "\\\\?\\UNC\\server\\share\\wt", "unc"],
    ["device path", "\\\\.\\C:\\wt", "unc"],
    ["relative", "some/relative/path", "notAbsolute"],
    ["empty", "", "invalidPath"],
  ])("refuses %s by string, before any filesystem access", async (_n, dest, reason) => {
    const f = await repoFixture();
    expect(await validateWorktreeDestination(f.repo, dest)).toMatchObject({ ok: false, reason });
  });

  it("refuses a drive root, the home directory and Windows-hostile leaf names", async () => {
    const f = await repoFixture();
    expect(await validateWorktreeDestination(f.repo, path.parse(f.repo).root)).toMatchObject({ ok: false, reason: "driveRoot" });

    const fakeHome = await makeTempDir();
    dirs.push(fakeHome);
    const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
    process.env.HOME = fakeHome;
    process.env.USERPROFILE = fakeHome;
    try {
      expect(os.homedir()).toBe(fakeHome);
      expect(await validateWorktreeDestination(f.repo, fakeHome)).toMatchObject({ ok: false, reason: "homeDirectory" });
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }

    for (const leaf of ["bad<name", "bad|name", "trailing.", "trailing ", "nul", "COM1.txt", "q?", "star*"]) {
      expect(await validateWorktreeDestination(f.repo, path.join(f.worktreesDir, leaf)), leaf).toMatchObject({ ok: false, reason: "invalidLeafName" });
    }
  });

  it("refuses paths over 260 characters on Windows (after realpath expansion)", async (ctx) => {
    if (process.platform !== "win32") return ctx.skip();
    const f = await repoFixture();
    const long = path.join(f.worktreesDir, "x".repeat(250));
    expect(await validateWorktreeDestination(f.repo, long)).toMatchObject({ ok: false, reason: "tooLong" });
  });

  it("refuses a symlink or junction leaf, even one pointing at an empty folder", async (ctx) => {
    const f = await repoFixture();
    const target = path.join(f.parent, "target");
    await fs.mkdir(target);
    const link = path.join(f.parent, "link");
    if (!(await tryMakeDirLink(target, link))) return ctx.skip();
    expect(await validateWorktreeDestination(f.repo, link)).toMatchObject({ ok: false, reason: "symlinkLeaf" });
  });

  it("refuses a non-empty folder and a plain file", async () => {
    const f = await repoFixture();
    const busy = path.join(f.parent, "busy");
    await writeFile(busy, "x", "1");
    expect(await validateWorktreeDestination(f.repo, busy)).toMatchObject({ ok: false, reason: "notEmpty" });
    expect(await validateWorktreeDestination(f.repo, path.join(busy, "x"))).toMatchObject({ ok: false, reason: "notADirectory" });
    expect(await validateWorktreeDestination(f.repo, path.join(busy, "x", "deeper"))).toMatchObject({ ok: false, reason: "notADirectory" });
  });

  it("refuses inside the repo, inside a registered worktree, an ancestor of either, and an existing worktree (naming its branch)", async () => {
    const f = await repoFixture();
    const wt = path.join(f.worktreesDir, "first");
    await git(f.repo, ["worktree", "add", "-q", wt, "-b", "first"]);

    expect(await validateWorktreeDestination(f.repo, path.join(f.repo, "inner"))).toMatchObject({ ok: false, reason: "insideRepo" });
    expect(await validateWorktreeDestination(f.repo, f.repo)).toMatchObject({ ok: false, reason: "insideRepo" });
    expect(await validateWorktreeDestination(f.repo, path.join(wt, "inner"))).toMatchObject({ ok: false, reason: "insideWorktree" });
    expect(await validateWorktreeDestination(f.repo, wt)).toMatchObject({ ok: false, reason: "alreadyWorktree", branch: "first" });
    expect(await validateWorktreeDestination(f.repo, f.parent)).toMatchObject({ ok: false, reason: "ancestorOfRepo" });

    // An ancestor of a worktree that is NOT an ancestor of the main repo.
    const deep = path.join(f.parent, "deep", "er", "wt");
    await git(f.repo, ["worktree", "add", "-q", deep, "-b", "deep"]);
    expect(await validateWorktreeDestination(f.repo, path.join(f.parent, "deep"))).toMatchObject({ ok: false, reason: "ancestorOfWorktree" });
  });

  it("refuses inside a git dir that lives outside the working tree (--separate-git-dir)", async () => {
    const f = await makeRepoInTempParent({ withCommit: false });
    dirs.push(f.parent);
    const sep = path.join(f.parent, "sep");
    const gitDir = path.join(f.parent, "elsewhere.git");
    await fs.mkdir(sep);
    await git(f.parent, ["init", "-q", "--separate-git-dir", gitDir, sep]);
    expect(await validateWorktreeDestination(sep, path.join(gitDir, "wt"))).toMatchObject({ ok: false, reason: "insideGitDir" });
  });

  it("refuses inside a bare repository's folder", async () => {
    const parent = await makeTempDir();
    dirs.push(parent);
    const bare = path.join(parent, "b.git");
    await git(parent, ["init", "-q", "--bare", bare]);
    expect(await validateWorktreeDestination(bare, path.join(bare, "wt"))).toMatchObject({ ok: false, reason: "insideRepo" });
    expect(await validateWorktreeDestination(bare, path.join(parent, "b.worktrees", "x"))).toMatchObject({ ok: true });
  });

  it("a read-only parent is refused up front (POSIX only)", async (ctx) => {
    if (process.platform === "win32" || (process.getuid && process.getuid() === 0)) return ctx.skip();
    const f = await repoFixture();
    await fs.mkdir(f.worktreesDir);
    await fs.chmod(f.worktreesDir, 0o555);
    try {
      expect(await validateWorktreeDestination(f.repo, path.join(f.worktreesDir, "x"))).toMatchObject({ ok: false, reason: "parentNotWritable" });
    } finally {
      await fs.chmod(f.worktreesDir, 0o755);
    }
  });
});
