import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getWorkingDirectoryStatus, getWorkingDirectoryChanges } from "../src/workingDirStatus";
import type { WorkingDirectoryChanges, WorkingDirectoryStatus } from "../src/types";
import { git, initRepo, writeFile, commit, cleanup } from "./testRepo";

/**
 * Tech-debt verification (ROADMAP.md): the proposed hook consolidation in
 * `packages/desktop/src/hooks` wants `useRepositoryGraph`'s aggregate counts
 * (`getWorkingDirectoryStatus()`, `git status --porcelain=v1`) to be derived as `.length` of
 * `useChangesPanel`'s per-file arrays (`getWorkingDirectoryChanges()`, `git status --porcelain=v2`)
 * instead of running both `git status` spawns independently. That's only safe if v1's aggregate
 * counts and v2's per-file array lengths agree in EVERY category, for EVERY working-tree shape —
 * not just the common case. This file proves (or disproves) that equivalence empirically, against
 * real git, across every edge case this suite's existing fixtures cover: plain staged/unstaged/
 * untracked mixes, a staged rename, a path staged AND further edited, every conflict shape covered
 * elsewhere in this suite (both-modified, both-added, delete/modify, rename/rename, submodule
 * gitlink, binary), non-ASCII paths, and a repo with no commits yet.
 *
 * Deliberately calls the two real top-level functions (not just the two `parsePorcelain*`
 * functions in isolation) against the exact same on-disk repo state, back-to-back, so this is
 * a genuine end-to-end check of what the consolidation would actually rely on.
 */

const cleanupDirs: string[] = [];
afterEach(async () => {
  while (cleanupDirs.length) await cleanup(cleanupDirs.pop()!);
});

/** Assert every category's v1 count equals v2's corresponding array length, plus hasChanges. */
function assertCountsMatchArrayLengths(
  status: WorkingDirectoryStatus,
  changes: WorkingDirectoryChanges,
): void {
  expect(status.staged).toBe(changes.staged.length);
  expect(status.unstaged).toBe(changes.unstaged.length);
  expect(status.untracked).toBe(changes.untracked.length);
  expect(status.conflicted).toBe(changes.conflicted.length);
  expect(status.hasChanges).toBe(
    changes.staged.length + changes.unstaged.length + changes.untracked.length + changes.conflicted.length > 0,
  );
}

async function bothStatuses(
  dir: string,
): Promise<{ status: WorkingDirectoryStatus; changes: WorkingDirectoryChanges }> {
  // Sequential, not parallel: this proves the equivalence holds for one consistent repo state,
  // without also asserting anything about concurrent-spawn safety (a separate concern).
  const status = await getWorkingDirectoryStatus(dir);
  const changes = await getWorkingDirectoryChanges(dir);
  return { status, changes };
}

describe("porcelain v1 aggregate counts == porcelain v2 per-file array lengths (tech-debt verification)", () => {
  it("clean working tree: all zero/empty", async () => {
    const dir = await initRepo();
    cleanupDirs.push(dir);
    await writeFile(dir, "a.txt", "hello");
    await commit(dir, "first");

    const { status, changes } = await bothStatuses(dir);
    assertCountsMatchArrayLengths(status, changes);
    expect(status.hasChanges).toBe(false);
  });

  it("ordinary mix: staged modify, unstaged modify, untracked file, and a path both staged+unstaged", async () => {
    const dir = await initRepo();
    cleanupDirs.push(dir);
    await writeFile(dir, "a.txt", "1");
    await writeFile(dir, "b.txt", "1");
    await writeFile(dir, "c.txt", "1");
    await commit(dir, "base");

    await writeFile(dir, "a.txt", "2"); // unstaged only
    await writeFile(dir, "b.txt", "2");
    await git(dir, ["add", "b.txt"]); // staged only
    await writeFile(dir, "c.txt", "2");
    await git(dir, ["add", "c.txt"]); // staged...
    await writeFile(dir, "c.txt", "3"); // ...then further unstaged edit on top
    await writeFile(dir, "d.txt", "new"); // untracked

    const { status, changes } = await bothStatuses(dir);
    assertCountsMatchArrayLengths(status, changes);
    expect(status.staged).toBe(2); // b.txt, c.txt
    expect(status.unstaged).toBe(2); // a.txt, c.txt
    expect(status.untracked).toBe(1);
  });

  it("staged rename via git mv (single R100 entry)", async () => {
    const dir = await initRepo();
    cleanupDirs.push(dir);
    await writeFile(
      dir,
      "original.txt",
      "line one\nline two\nline three\nline four\nline five\nline six\n",
    );
    await writeFile(dir, "other.txt", "unrelated\n");
    await commit(dir, "base");
    await git(dir, ["mv", "original.txt", "renamed.txt"]);
    await writeFile(dir, "other.txt", "unrelated, modified\n"); // plain unstaged alongside the rename

    const { status, changes } = await bothStatuses(dir);
    assertCountsMatchArrayLengths(status, changes);
    expect(status.staged).toBe(1);
    expect(status.unstaged).toBe(1);
  });

  it("a staged rename that is further edited in the worktree on top (rename in both staged and unstaged buckets)", async () => {
    const dir = await initRepo();
    cleanupDirs.push(dir);
    await writeFile(
      dir,
      "original.txt",
      "line one\nline two\nline three\nline four\nline five\nline six\n",
    );
    await commit(dir, "base");
    await git(dir, ["mv", "original.txt", "renamed.txt"]);
    await writeFile(dir, "renamed.txt", "line one\nline two\nline three\nline four\nline five\nCHANGED\n");

    const { status, changes } = await bothStatuses(dir);
    assertCountsMatchArrayLengths(status, changes);
    expect(status.staged).toBe(1);
    expect(status.unstaged).toBe(1);
  });

  it("both-modified merge conflict (UU), alongside an unrelated ordinary unstaged edit", async () => {
    const dir = await initRepo();
    cleanupDirs.push(dir);
    await writeFile(dir, "a.txt", "base\n");
    await writeFile(dir, "clean.txt", "1\n");
    await commit(dir, "base");
    await git(dir, ["checkout", "-q", "-b", "feature"]);
    await writeFile(dir, "a.txt", "feature change\n");
    await commit(dir, "feature change");
    await git(dir, ["checkout", "-q", "main"]);
    await writeFile(dir, "a.txt", "main change\n");
    await commit(dir, "main change");
    await writeFile(dir, "clean.txt", "2\n");
    await git(dir, ["merge", "-q", "feature"]).catch(() => {});

    const { status, changes } = await bothStatuses(dir);
    assertCountsMatchArrayLengths(status, changes);
    expect(status.conflicted).toBe(1);
    expect(status.unstaged).toBe(1); // clean.txt
  });

  it("both-added (add/add) conflict (AA), no common ancestor", async () => {
    const dir = await initRepo();
    cleanupDirs.push(dir);
    await writeFile(dir, "seed.txt", "seed\n");
    await commit(dir, "seed");
    await git(dir, ["checkout", "-q", "-b", "feature"]);
    await writeFile(dir, "b.txt", "feature content\n");
    await commit(dir, "add b (feature)");
    await git(dir, ["checkout", "-q", "main"]);
    await writeFile(dir, "b.txt", "main content\n");
    await commit(dir, "add b (main)");
    await git(dir, ["merge", "-q", "feature"]).catch(() => {});

    const { status, changes } = await bothStatuses(dir);
    assertCountsMatchArrayLengths(status, changes);
    expect(status.conflicted).toBe(1);
  });

  it("delete/modify conflict (deleted-by-us, DU)", async () => {
    const dir = await initRepo();
    cleanupDirs.push(dir);
    await writeFile(dir, "c.txt", "base\n");
    await commit(dir, "base");
    await git(dir, ["checkout", "-q", "-b", "feature"]);
    await writeFile(dir, "c.txt", "feature change\n");
    await commit(dir, "modify (feature)");
    await git(dir, ["checkout", "-q", "main"]);
    await git(dir, ["rm", "-q", "c.txt"]);
    await commit(dir, "delete (main)");
    await git(dir, ["merge", "-q", "feature"]).catch(() => {});

    const { status, changes } = await bothStatuses(dir);
    assertCountsMatchArrayLengths(status, changes);
    expect(status.conflicted).toBe(1);
  });

  it("rename/rename conflict: three distinct conflicted paths (UA/AU/DD) from a single logical conflict", async () => {
    const dir = await initRepo();
    cleanupDirs.push(dir);
    await writeFile(dir, "e.txt", "line1\nline2\nline3\nline4\nline5\nline6\n");
    await commit(dir, "base");
    await git(dir, ["checkout", "-q", "-b", "feature"]);
    await git(dir, ["mv", "e.txt", "e-feature.txt"]);
    await commit(dir, "rename (feature)");
    await git(dir, ["checkout", "-q", "main"]);
    await git(dir, ["mv", "e.txt", "e-main.txt"]);
    await commit(dir, "rename (main)");
    await git(dir, ["merge", "-q", "feature"]).catch(() => {});

    const { status, changes } = await bothStatuses(dir);
    assertCountsMatchArrayLengths(status, changes);
    // The one logical rename/rename conflict surfaces as THREE separate conflicted paths
    // (e-feature.txt: UA, e-main.txt: AU, e.txt: DD) in both porcelain versions alike.
    expect(status.conflicted).toBe(3);
    expect(changes.conflicted.map((f) => f.path).sort()).toEqual(["e-feature.txt", "e-main.txt", "e.txt"]);
  });

  it("submodule gitlink conflict (UU on a 160000 gitlink entry, not a regular blob)", async () => {
    const dir = await initRepo();
    cleanupDirs.push(dir);
    await writeFile(dir, "readme.txt", "x\n");
    await commit(dir, "base");
    const shaBase = "1111111111111111111111111111111111111111";
    const shaMain = "3333333333333333333333333333333333333333";
    const shaFeature = "2222222222222222222222222222222222222222";
    const rawCommit = async (message: string): Promise<void> => {
      await git(dir, ["commit", "-q", "-m", message]);
    };
    await git(dir, ["update-index", "--add", "--cacheinfo", `160000,${shaBase},sub`]);
    await rawCommit("add gitlink");
    await git(dir, ["checkout", "-q", "-b", "feature"]);
    await git(dir, ["update-index", "--add", "--cacheinfo", `160000,${shaFeature},sub`]);
    await rawCommit("feature bump");
    await git(dir, ["checkout", "-q", "main"]);
    await git(dir, ["update-index", "--add", "--cacheinfo", `160000,${shaMain},sub`]);
    await rawCommit("main bump");
    await git(dir, ["merge", "-q", "feature"]).catch(() => {});

    const { status, changes } = await bothStatuses(dir);
    assertCountsMatchArrayLengths(status, changes);
    expect(status.conflicted).toBe(1);
  });

  it("binary file conflict", async () => {
    const dir = await initRepo();
    cleanupDirs.push(dir);
    await fs.writeFile(path.join(dir, "img.bin"), Buffer.from([0, 1, 2, 3, 0, 255]));
    await commit(dir, "base binary");
    await git(dir, ["checkout", "-q", "-b", "feature"]);
    await fs.writeFile(path.join(dir, "img.bin"), Buffer.from([0, 9, 9, 9, 0, 255]));
    await commit(dir, "feature binary change");
    await git(dir, ["checkout", "-q", "main"]);
    await fs.writeFile(path.join(dir, "img.bin"), Buffer.from([0, 5, 5, 5, 0, 255]));
    await commit(dir, "main binary change");
    await git(dir, ["merge", "-q", "feature"]).catch(() => {});

    const { status, changes } = await bothStatuses(dir);
    assertCountsMatchArrayLengths(status, changes);
    expect(status.conflicted).toBe(1);
  });

  it("non-ASCII file and directory names, mixed staged/unstaged/untracked", async () => {
    const dir = await initRepo();
    cleanupDirs.push(dir);
    await writeFile(dir, "base.txt", "1");
    await commit(dir, "base");
    await writeFile(dir, "résumé-日本語.txt", "new content"); // untracked
    await writeFile(dir, "café/nested-文件.txt", "content"); // untracked, non-ASCII dir
    await writeFile(dir, "base.txt", "2");
    await git(dir, ["add", "base.txt"]); // staged

    const { status, changes } = await bothStatuses(dir);
    assertCountsMatchArrayLengths(status, changes);
    expect(status.untracked).toBe(2);
    expect(status.staged).toBe(1);
  });

  it("repo with no commits yet: staged-add and untracked coexist with no HEAD to diff against", async () => {
    const dir = await initRepo();
    cleanupDirs.push(dir);
    await writeFile(dir, "a.txt", "a");
    await git(dir, ["add", "a.txt"]);
    await writeFile(dir, "b.txt", "b"); // untracked

    const { status, changes } = await bothStatuses(dir);
    assertCountsMatchArrayLengths(status, changes);
    expect(status.staged).toBe(1);
    expect(status.untracked).toBe(1);
  });

  it("typechange (tracked file replaced by a different type) shows as an ordinary unstaged change, not double-counted", async () => {
    const dir = await initRepo();
    cleanupDirs.push(dir);
    await writeFile(dir, "f.txt", "content\n");
    await commit(dir, "base");
    await fs.rm(path.join(dir, "f.txt"));
    // Deliberate plain-delete-then-recreate-as-different-type stand-in: a real symlink swap
    // needs elevated privileges on some Windows configs (see conflicts.test.ts's trySymlink
    // fallback pattern), and the git status codes this exercises (a worktree-only "D" or "T"
    // against an unchanged index) are what the count-equivalence logic actually branches on.
    await fs.mkdir(path.join(dir, "f.txt"));
    await writeFile(dir, "f.txt/inner.txt", "now a directory\n");

    const { status, changes } = await bothStatuses(dir);
    assertCountsMatchArrayLengths(status, changes);
  });

  it("conflicted path coexisting with an unrelated staged rename and an unrelated untracked file, all at once", async () => {
    const dir = await initRepo();
    cleanupDirs.push(dir);
    await writeFile(dir, "a.txt", "base\n");
    await writeFile(dir, "original.txt", "line one\nline two\nline three\nline four\nline five\nline six\n");
    await commit(dir, "base");
    await git(dir, ["checkout", "-q", "-b", "feature"]);
    await writeFile(dir, "a.txt", "feature change\n");
    await commit(dir, "feature change");
    await git(dir, ["checkout", "-q", "main"]);
    await writeFile(dir, "a.txt", "main change\n");
    await commit(dir, "main change");
    await git(dir, ["merge", "-q", "feature"]).catch(() => {});
    await git(dir, ["mv", "original.txt", "renamed.txt"]); // unrelated staged rename alongside the conflict
    await writeFile(dir, "new-file.txt", "untracked"); // unrelated untracked alongside the conflict

    const { status, changes } = await bothStatuses(dir);
    assertCountsMatchArrayLengths(status, changes);
    expect(status.conflicted).toBe(1);
    expect(status.staged).toBe(1);
    expect(status.untracked).toBe(1);
  });
});
