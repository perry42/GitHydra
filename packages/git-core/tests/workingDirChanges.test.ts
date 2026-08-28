import { describe, it, expect, afterEach } from "vitest";
import { getWorkingDirectoryChanges, parsePorcelainV2Changes } from "../src/workingDirStatus";
import { git, initRepo, writeFile, commit, cleanup } from "./testRepo";

const cleanupDirs: string[] = [];
afterEach(async () => {
  while (cleanupDirs.length) await cleanup(cleanupDirs.pop()!);
});

describe("parsePorcelainV2Changes", () => {
  it("returns empty buckets for empty output", () => {
    expect(parsePorcelainV2Changes("")).toEqual({
      staged: [],
      unstaged: [],
      untracked: [],
      conflicted: [],
    });
  });

  it("parses an ordinary staged-only entry", () => {
    const record = "1 M. N... 100644 100644 100644 abc123 abc123 staged.txt";
    const result = parsePorcelainV2Changes(record + "\0");
    expect(result.staged).toEqual([{ path: "staged.txt", status: "modified", category: "staged" }]);
    expect(result.unstaged).toEqual([]);
  });

  it("parses an ordinary unstaged-only entry", () => {
    const record = "1 .M N... 100644 100644 100644 abc123 abc123 unstaged.txt";
    const result = parsePorcelainV2Changes(record + "\0");
    expect(result.unstaged).toEqual([{ path: "unstaged.txt", status: "modified", category: "unstaged" }]);
    expect(result.staged).toEqual([]);
  });

  it("parses a path that is both staged and unstaged as two independent entries", () => {
    const record = "1 MM N... 100644 100644 100644 abc123 abc123 both.txt";
    const result = parsePorcelainV2Changes(record + "\0");
    expect(result.staged).toEqual([{ path: "both.txt", status: "modified", category: "staged" }]);
    expect(result.unstaged).toEqual([{ path: "both.txt", status: "modified", category: "unstaged" }]);
  });

  it("parses a renamed/copied entry with origPath and similarity", () => {
    const record = "2 R. N... 100644 100644 100644 abc123 abc123 R100 new.txt";
    const origPath = "old.txt";
    const result = parsePorcelainV2Changes(record + "\0" + origPath + "\0");
    expect(result.staged).toEqual([
      { path: "new.txt", oldPath: "old.txt", status: "renamed", category: "staged", similarity: 100 },
    ]);
  });

  it("parses an untracked entry", () => {
    const result = parsePorcelainV2Changes("? new-file.txt\0");
    expect(result.untracked).toEqual([{ path: "new-file.txt", status: "added", category: "untracked" }]);
  });

  it("parses an unmerged (conflicted) entry into its own category, not staged/unstaged", () => {
    const record = "u UU N... 100644 100644 100644 100644 abc abc abc conflicted.txt";
    const result = parsePorcelainV2Changes(record + "\0");
    expect(result.conflicted).toEqual([{ path: "conflicted.txt", status: "unmerged", category: "conflicted" }]);
    expect(result.staged).toEqual([]);
    expect(result.unstaged).toEqual([]);
  });
});

describe("getWorkingDirectoryChanges", () => {
  it("returns empty buckets for a clean working tree", async () => {
    const dir = await initRepo();
    cleanupDirs.push(dir);
    await writeFile(dir, "a.txt", "hello");
    await commit(dir, "first");

    const changes = await getWorkingDirectoryChanges(dir);
    expect(changes).toEqual({ staged: [], unstaged: [], untracked: [], conflicted: [] });
  });

  it("splits staged, unstaged, and untracked changes into their own buckets", async () => {
    const dir = await initRepo();
    cleanupDirs.push(dir);
    await writeFile(dir, "a.txt", "1");
    await writeFile(dir, "b.txt", "1");
    await commit(dir, "base");

    await writeFile(dir, "a.txt", "2"); // unstaged modify
    await writeFile(dir, "b.txt", "2");
    await git(dir, ["add", "b.txt"]); // staged modify
    await writeFile(dir, "c.txt", "new content"); // untracked

    const changes = await getWorkingDirectoryChanges(dir);
    expect(changes.staged.map((f) => f.path)).toEqual(["b.txt"]);
    expect(changes.unstaged.map((f) => f.path)).toEqual(["a.txt"]);
    expect(changes.untracked.map((f) => f.path)).toEqual(["c.txt"]);
    expect(changes.conflicted).toEqual([]);
  });

  it("reports a path staged AND further edited as one entry in each bucket", async () => {
    const dir = await initRepo();
    cleanupDirs.push(dir);
    await writeFile(dir, "a.txt", "1");
    await commit(dir, "base");

    await writeFile(dir, "a.txt", "2");
    await git(dir, ["add", "a.txt"]); // stage edit #1
    await writeFile(dir, "a.txt", "3"); // further worktree edit on top

    const changes = await getWorkingDirectoryChanges(dir);
    expect(changes.staged.map((f) => f.path)).toEqual(["a.txt"]);
    expect(changes.unstaged.map((f) => f.path)).toEqual(["a.txt"]);
  });

  it("detects a rename staged via `git mv`, with oldPath and similarity populated", async () => {
    const dir = await initRepo();
    cleanupDirs.push(dir);
    await writeFile(dir, "original.txt", "some content that stays mostly the same\nacross the rename\n");
    await commit(dir, "base");
    await git(dir, ["mv", "original.txt", "renamed.txt"]);

    const changes = await getWorkingDirectoryChanges(dir);
    const renamed = changes.staged.find((f) => f.path === "renamed.txt");
    expect(renamed).toBeDefined();
    expect(renamed!.status).toBe("renamed");
    expect(renamed!.oldPath).toBe("original.txt");
    expect(renamed!.similarity).toBeGreaterThan(0);
  });

  it("reports an unresolved merge conflict as its own category, not staged/unstaged", async () => {
    const dir = await initRepo();
    cleanupDirs.push(dir);
    await writeFile(dir, "a.txt", "base\n");
    await commit(dir, "base");
    await git(dir, ["checkout", "-q", "-b", "feature"]);
    await writeFile(dir, "a.txt", "feature change\n");
    await commit(dir, "feature change");
    await git(dir, ["checkout", "-q", "main"]);
    await writeFile(dir, "a.txt", "main change\n");
    await commit(dir, "main change");
    await git(dir, ["merge", "-q", "feature"]).catch(() => {
      /* expected to fail with a conflict */
    });

    const changes = await getWorkingDirectoryChanges(dir);
    expect(changes.conflicted.map((f) => f.path)).toEqual(["a.txt"]);
    expect(changes.staged).toEqual([]);
    expect(changes.unstaged).toEqual([]);
  });

  it("supports non-ASCII filenames", async () => {
    const dir = await initRepo();
    cleanupDirs.push(dir);
    await writeFile(dir, "base.txt", "1");
    await commit(dir, "base");
    await writeFile(dir, "résumé-日本語.txt", "new content");

    const changes = await getWorkingDirectoryChanges(dir);
    expect(changes.untracked.map((f) => f.path)).toContain("résumé-日本語.txt");
  });
});
