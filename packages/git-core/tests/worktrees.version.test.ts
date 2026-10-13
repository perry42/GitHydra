// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect } from "vitest";
import { compareGitVersion, gitVersionAtLeast, parseGitVersionString, WORKTREE_LIST_Z_MIN_VERSION } from "../src/gitVersion";
import {
  analyzeGitdirFile,
  parseStrictPorcelainBlocks,
  parseWorktreeListPorcelain,
  splitPorcelainNewline,
  splitPorcelainNul,
} from "../src/worktreeParse";
import { porcelainToNul } from "./worktreeKit";

/** specs/worktrees.md FR-601 / FR-632: version parsing ignores vendor suffixes; the strict parser rejects anything git does not print. */
describe("parseGitVersionString", () => {
  it.each([
    ["git version 2.31.1.windows.1", 2, 31, 1],
    ["git version 2.45.1.windows.1\n", 2, 45, 1],
    ["git version 2.39.5 (Apple Git-154)", 2, 39, 5],
    ["git version 2.24.0", 2, 24, 0],
    ["git version 2.44.0.rc1", 2, 44, 0],
    ["git version 2.50", 2, 50, 0],
    ["v2.36.0-rc2", 2, 36, 0],
    ["2.36.0", 2, 36, 0],
  ])("%j", (raw, major, minor, patch) => {
    expect(parseGitVersionString(raw)).toEqual({ major, minor, patch });
  });

  it("returns null when there is no version", () => {
    expect(parseGitVersionString("")).toBeNull();
    expect(parseGitVersionString("git version unknown")).toBeNull();
  });

  it("gates -z at 2.36 and treats an unknown version as too old", () => {
    expect(gitVersionAtLeast(parseGitVersionString("git version 2.31.1.windows.1"), WORKTREE_LIST_Z_MIN_VERSION)).toBe(false);
    expect(gitVersionAtLeast(parseGitVersionString("git version 2.35.9"), WORKTREE_LIST_Z_MIN_VERSION)).toBe(false);
    expect(gitVersionAtLeast(parseGitVersionString("git version 2.36.0"), WORKTREE_LIST_Z_MIN_VERSION)).toBe(true);
    expect(gitVersionAtLeast(parseGitVersionString("git version 2.45.1.windows.1"), WORKTREE_LIST_Z_MIN_VERSION)).toBe(true);
    expect(gitVersionAtLeast(parseGitVersionString("git version 3.0.0"), WORKTREE_LIST_Z_MIN_VERSION)).toBe(true);
    expect(gitVersionAtLeast(null, WORKTREE_LIST_Z_MIN_VERSION)).toBe(false);
    expect(compareGitVersion({ major: 2, minor: 31, patch: 1 }, { major: 2, minor: 31, patch: 0 })).toBeGreaterThan(0);
  });
});

const SHA = "a".repeat(40);

describe("strict porcelain parser", () => {
  const parse = (text: string) => {
    const split = splitPorcelainNewline(text);
    return split ? parseStrictPorcelainBlocks(split) : null;
  };

  it("parses main, branch, detached, bare, locked with and without reason, prunable", () => {
    const text = [
      "worktree /r", `HEAD ${SHA}`, "branch refs/heads/main", "",
      "worktree /w1", `HEAD ${SHA}`, "detached", "locked", "",
      "worktree /w2", `HEAD ${SHA}`, "branch refs/heads/x", "locked why not", "prunable gitdir file points to non-existent location", "",
      "",
    ].join("\n");
    const blocks = parse(text)!;
    expect(blocks).toHaveLength(3);
    expect(blocks[0]).toMatchObject({ path: "/r", head: SHA, branchFullName: "refs/heads/main" });
    expect(blocks[1]).toMatchObject({ detached: true, locked: true, lockReason: null });
    expect(blocks[2]).toMatchObject({ locked: true, lockReason: "why not", prunable: true, prunableReason: "gitdir file points to non-existent location" });
  });

  it("a bare entry has no HEAD line; an unborn HEAD id is null", () => {
    const text = ["worktree /bare.git", "bare", "", `worktree /u`, `HEAD ${"0".repeat(40)}`, "branch refs/heads/main", "", ""].join("\n");
    const blocks = parse(text)!;
    expect(blocks[0]).toMatchObject({ bare: true, head: null });
    expect(blocks[1]).toMatchObject({ head: null, branchFullName: "refs/heads/main" });
  });

  it.each([
    ["unknown key", ["worktree /a", `HEAD ${SHA}`, "surprise", "", ""]],
    ["duplicate HEAD", ["worktree /a", `HEAD ${SHA}`, `HEAD ${SHA}`, "", ""]],
    ["duplicate branch", ["worktree /a", `HEAD ${SHA}`, "branch refs/heads/a", "branch refs/heads/b", "", ""]],
    ["HEAD before worktree", [`HEAD ${SHA}`, "worktree /a", "", ""]],
    ["prunable before locked", ["worktree /a", `HEAD ${SHA}`, "detached", "prunable x", "locked y", "", ""]],
    ["bad id", ["worktree /a", "HEAD nothex", "detached", "", ""]],
    ["missing trailing blank", ["worktree /a", `HEAD ${SHA}`, "detached"]],
    ["double blank", ["worktree /a", `HEAD ${SHA}`, "", "", ""]],
    ["empty path", ["worktree ", `HEAD ${SHA}`, "", ""]],
  ])("rejects %s", (_n, lines) => {
    expect(parse(lines.join("\n"))).toBeNull();
  });

  it("the NUL format round-trips the newline one", () => {
    const text = ["worktree /r", `HEAD ${SHA}`, "branch refs/heads/main", "", "worktree /w", `HEAD ${SHA}`, "detached", "locked because", "", ""].join("\n");
    const viaNul = parseStrictPorcelainBlocks(splitPorcelainNul(porcelainToNul(text))!);
    expect(viaNul).toEqual(parse(text));
  });

  it("a path with a line break stays one NUL field", () => {
    const nul = `worktree /x\nHEAD ${SHA}\0HEAD ${SHA}\0detached\0\0`;
    const blocks = parseStrictPorcelainBlocks(splitPorcelainNul(nul)!)!;
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.path).toBe(`/x\nHEAD ${SHA}`);
  });
});

describe("analyzeGitdirFile", () => {
  it("accepts a normal absolute gitdir with one trailing terminator", () => {
    expect(analyzeGitdirFile("/home/me/wt/.git\n")).toMatchObject({ supported: true, worktreePath: "/home/me/wt", gitPrintsPath: "/home/me/wt" });
    expect(analyzeGitdirFile("C:/work/wt/.git\r\n")).toMatchObject({ supported: true, worktreePath: "C:/work/wt" });
    expect(analyzeGitdirFile("/home/me/wt/.git")).toMatchObject({ supported: true });
  });

  it.each([
    ["interior LF", "/a/.git\nHEAD x\n\nworktree /evil/.git\n"],
    ["interior CR", "/a\r/b/.git\n"],
    ["two trailing newlines", "/a/b/.git\n\n"],
    ["trailing blanks git would trim", "/a/b/.git \n"],
    ["no /.git suffix", "/a/b\n"],
    ["relative", "../x/.git\n"],
    ["NUL", "/a/\0b/.git\n"],
    ["empty path", "/.git\n"],
  ])("marks %s unsupported", (_n, text) => {
    expect(analyzeGitdirFile(text).supported).toBe(false);
  });

  it("flags the forged-row signature", () => {
    expect(analyzeGitdirFile("/a/.git\nHEAD x\n\nworktree /evil").hasInteriorBreak).toBe(true);
    expect(analyzeGitdirFile("/a/b/.git\n").hasInteriorBreak).toBe(false);
  });
});

describe("the lenient parser branches.ts keeps using", () => {
  it("is unchanged: tolerant of CRLF, first-wins fields, ignores HEAD/locked/prunable", () => {
    const out = "worktree /r\r\nHEAD abc\r\nbranch refs/heads/main\r\n\r\nworktree /b.git\r\nbare\r\n\r\nworktree /d\r\nHEAD abc\r\ndetached\r\nlocked x\r\n\r\n";
    expect(parseWorktreeListPorcelain(out)).toEqual([
      { path: "/r", branchFullName: "refs/heads/main", isBare: false },
      { path: "/b.git", branchFullName: null, isBare: true },
      { path: "/d", branchFullName: null, isBare: false },
    ]);
  });
});
