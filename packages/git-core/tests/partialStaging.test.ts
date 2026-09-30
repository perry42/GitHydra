// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect, afterEach } from "vitest";
import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getFileDiff } from "../src/diff";
import { classifyRawDiff, buildPartialPatch, parseRawDiff } from "../src/diffPatch";
import {
  stageSelection,
  unstageSelection,
  discardSelection,
  _setPartialStagingAfterCheckHookForTests,
} from "../src/partialStaging";
import { stageFile } from "../src/staging";
import {
  GitCommandError,
  InvalidArgumentError,
  PartialStagingIneligibleError,
  StaleDiffError,
} from "../src/errors";
import { Repository } from "../src/index";
import type { FileDiffResult, TextFileDiff } from "../src/types";
import { git, initRepo, writeFile, commit, cleanup, setUpMaliciousFsmonitorRepo, fileExists } from "./testRepo";

const cleanupDirs: string[] = [];
afterEach(async () => {
  _setPartialStagingAfterCheckHookForTests(null);
  while (cleanupDirs.length) await cleanup(cleanupDirs.pop()!);
});

function gitBytes(cwd: string, args: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd, encoding: "buffer", maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) =>
      err ? reject(new Error(`git ${args.join(" ")}: ${stderr.toString()}`)) : resolve(stdout),
    );
  });
}

async function newRepo(): Promise<string> {
  const dir = await initRepo();
  cleanupDirs.push(dir);
  // Git for Windows defaults to autocrlf=true, which would hide the CRLF bytes under test.
  await git(dir, ["config", "core.autocrlf", "false"]);
  return dir;
}

async function indexBlob(dir: string, file: string): Promise<Buffer> {
  return gitBytes(dir, ["cat-file", "blob", `:${file}`]);
}

async function worktreeBytes(dir: string, file: string): Promise<Buffer> {
  return fs.readFile(path.join(dir, file));
}

async function textDiff(dir: string, side: "unstaged" | "staged", file: string): Promise<TextFileDiff & { fingerprint: string }> {
  const d: FileDiffResult = await getFileDiff(dir, { kind: side, path: file });
  if (d.status !== "ok" || !d.fingerprint) throw new Error(`expected ok diff with fingerprint, got ${d.status}`);
  return d as TextFileDiff & { fingerprint: string };
}

function numbered(n: number, edit: Record<number, string | null> = {}, extraAfter: Record<number, string[]> = {}): string {
  const out: string[] = [];
  for (let i = 1; i <= n; i++) {
    const v = edit[i] === undefined ? `line ${i}` : edit[i];
    if (v !== null) out.push(v);
    if (extraAfter[i]) out.push(...extraAfter[i]!);
  }
  return out.join("\n") + "\n";
}

/** Indexes (into DiffHunk.lines) of changed lines in a hunk. */
function changedIdx(hunkLines: { type: string }[]): number[] {
  return hunkLines.map((l, i) => (l.type === "context" ? -1 : i)).filter((i) => i >= 0);
}

async function threeHunkRepo(): Promise<{ dir: string; base: string; edited: string }> {
  const dir = await newRepo();
  const base = numbered(30);
  const edited = numbered(30, { 3: "CHANGED 3", 15: "CHANGED 15", 27: "CHANGED 27" });
  await writeFile(dir, "f.txt", base);
  await commit(dir, "base");
  await writeFile(dir, "f.txt", edited);
  return { dir, base, edited };
}

describe("hunk staging (AC1, AC3)", () => {
  it("stages exactly hunk 2, leaves the worktree byte-identical, then unstage restores the index", async () => {
    const { dir, base, edited } = await threeHunkRepo();
    const diff = await textDiff(dir, "unstaged", "f.txt");
    expect(diff.hunks).toHaveLength(3);
    expect(diff.partialStaging).toEqual({ eligible: true });

    await stageSelection(dir, "f.txt", diff.fingerprint, [{ hunkIndex: 1 }]);

    expect((await indexBlob(dir, "f.txt")).toString()).toBe(numbered(30, { 15: "CHANGED 15" }));
    expect(await worktreeBytes(dir, "f.txt")).toEqual(Buffer.from(edited));
    const cached = (await git(dir, ["diff", "--cached"])).stdout;
    expect(cached).toContain("+CHANGED 15");
    expect(cached).not.toContain("CHANGED 3");
    expect(cached).not.toContain("CHANGED 27");
    // Partially staged: still shows in the unstaged diff for the other two hunks.
    expect((await textDiff(dir, "unstaged", "f.txt")).hunks).toHaveLength(2);

    const staged = await textDiff(dir, "staged", "f.txt");
    await unstageSelection(dir, "f.txt", staged.fingerprint, [{ hunkIndex: 0 }]);
    expect((await indexBlob(dir, "f.txt")).toString()).toBe(base);
    expect((await git(dir, ["diff", "--cached"])).stdout).toBe("");
    expect(await worktreeBytes(dir, "f.txt")).toEqual(Buffer.from(edited));
  });

  it("stages hunks 1 and 3 together with correct recounted offsets", async () => {
    const dir = await newRepo();
    await writeFile(dir, "f.txt", numbered(40));
    await commit(dir, "base");
    // Hunk 1 grows the file by 2 lines, so hunk 3's new-side start shifts.
    await writeFile(dir, "f.txt", numbered(40, { 20: "CHANGED 20", 36: "CHANGED 36" }, { 3: ["ins a", "ins b"] }));
    const diff = await textDiff(dir, "unstaged", "f.txt");
    expect(diff.hunks).toHaveLength(3);
    await stageSelection(dir, "f.txt", diff.fingerprint, [{ hunkIndex: 0 }, { hunkIndex: 2 }]);
    expect((await indexBlob(dir, "f.txt")).toString()).toBe(
      numbered(40, { 36: "CHANGED 36" }, { 3: ["ins a", "ins b"] }),
    );
  });
});

describe("line staging (AC2, AC3)", () => {
  // One hunk with 5 changed lines: -l4 +L4 -l5 +x +y
  async function fixture(): Promise<{ dir: string; edited: string; base: string }> {
    const dir = await newRepo();
    const base = numbered(10);
    const edited = numbered(10, { 4: "L4", 5: null }, { 6: ["x", "y"] });
    await writeFile(dir, "f.txt", base);
    await commit(dir, "base");
    await writeFile(dir, "f.txt", edited);
    return { dir, edited, base };
  }

  it("stages 2 of 5 lines; the unselected '-' lines stay as context", async () => {
    const { dir, edited } = await fixture();
    const diff = await textDiff(dir, "unstaged", "f.txt");
    expect(diff.hunks).toHaveLength(1);
    const lines = diff.hunks[0]!.lines;
    const idx = changedIdx(lines);
    expect(idx).toHaveLength(5);
    const pick = [lines.findIndex((l) => l.content === "L4"), lines.findIndex((l) => l.content === "x")];

    await stageSelection(dir, "f.txt", diff.fingerprint, [{ hunkIndex: 0, lineIndexes: pick }]);

    // git emits -4 -5 +L4, so the kept context lines 4,5 precede L4; x is added after 6; y is not staged
    expect((await indexBlob(dir, "f.txt")).toString()).toBe(
      ["line 1", "line 2", "line 3", "line 4", "line 5", "L4", "line 6", "x", "line 7", "line 8", "line 9", "line 10", ""].join("\n"),
    );
    expect(await worktreeBytes(dir, "f.txt")).toEqual(Buffer.from(edited));
  });

  it("unstages 2 of 5 lines; an unselected '-' stays staged", async () => {
    const { dir } = await fixture();
    await git(dir, ["add", "f.txt"]);
    const staged = await textDiff(dir, "staged", "f.txt");
    const lines = staged.hunks[0]!.lines;
    const pick = [lines.findIndex((l) => l.content === "L4"), lines.findIndex((l) => l.content === "x")];

    await unstageSelection(dir, "f.txt", staged.fingerprint, [{ hunkIndex: 0, lineIndexes: pick }]);

    // -l4/-l5 deletions stay staged, +y stays staged; +L4 and +x are unstaged
    expect((await indexBlob(dir, "f.txt")).toString()).toBe(
      ["line 1", "line 2", "line 3", "line 6", "y", "line 7", "line 8", "line 9", "line 10", ""].join("\n"),
    );
    const unstaged = await textDiff(dir, "unstaged", "f.txt");
    const adds = unstaged.hunks.flatMap((h) => h.lines.filter((l) => l.type === "add").map((l) => l.content));
    expect(adds.sort()).toEqual(["L4", "x"]);
  });

  it("stage then unstage of the same lines round-trips the index to HEAD", async () => {
    const { dir, base } = await fixture();
    const diff = await textDiff(dir, "unstaged", "f.txt");
    const sel = [{ hunkIndex: 0, lineIndexes: [diff.hunks[0]!.lines.findIndex((l) => l.content === "y")] }];
    await stageSelection(dir, "f.txt", diff.fingerprint, sel);
    expect((await git(dir, ["diff", "--cached", "--numstat"])).stdout.trim()).toBe("1\t0\tf.txt");
    const staged = await textDiff(dir, "staged", "f.txt");
    await unstageSelection(dir, "f.txt", staged.fingerprint, [
      { hunkIndex: 0, lineIndexes: [staged.hunks[0]!.lines.findIndex((l) => l.content === "y")] },
    ]);
    expect((await indexBlob(dir, "f.txt")).toString()).toBe(base);
  });

  it("rejects selecting a context line, an unknown hunk, or an empty selection, changing nothing", async () => {
    const { dir } = await fixture();
    const diff = await textDiff(dir, "unstaged", "f.txt");
    const before = (await git(dir, ["ls-files", "-s"])).stdout;
    const ctx = diff.hunks[0]!.lines.findIndex((l) => l.type === "context");
    await expect(stageSelection(dir, "f.txt", diff.fingerprint, [{ hunkIndex: 0, lineIndexes: [ctx] }])).rejects.toBeInstanceOf(InvalidArgumentError);
    await expect(stageSelection(dir, "f.txt", diff.fingerprint, [{ hunkIndex: 5 }])).rejects.toBeInstanceOf(InvalidArgumentError);
    await expect(stageSelection(dir, "f.txt", diff.fingerprint, [])).rejects.toBeInstanceOf(InvalidArgumentError);
    expect((await git(dir, ["ls-files", "-s"])).stdout).toBe(before);
  });
});

describe("stale guard (AC4, AC5)", () => {
  it("AC4: refuses with STALE_DIFF and changes nothing when the file changed after the diff was shown", async () => {
    const { dir } = await threeHunkRepo();
    const diff = await textDiff(dir, "unstaged", "f.txt");
    await writeFile(dir, "f.txt", numbered(30, { 3: "CHANGED 3", 15: "EXTERNAL", 27: "CHANGED 27" }));
    const indexBefore = (await git(dir, ["ls-files", "-s"])).stdout;

    const err = await stageSelection(dir, "f.txt", diff.fingerprint, [{ hunkIndex: 1 }]).catch((e) => e);
    expect(err).toBeInstanceOf(StaleDiffError);
    expect((err as StaleDiffError).code).toBe("STALE_DIFF");
    expect((await git(dir, ["ls-files", "-s"])).stdout).toBe(indexBefore);
    expect((await git(dir, ["diff", "--cached"])).stdout).toBe("");
    // The fresh diff carries a new fingerprint the caller can use after re-selecting.
    const fresh = await textDiff(dir, "unstaged", "f.txt");
    expect(fresh.fingerprint).not.toBe(diff.fingerprint);
    await stageSelection(dir, "f.txt", fresh.fingerprint, [{ hunkIndex: 1 }]);
  });

  it("refuses unstage and discard with STALE_DIFF too", async () => {
    const { dir } = await threeHunkRepo();
    await git(dir, ["add", "f.txt"]);
    const staged = await textDiff(dir, "staged", "f.txt");
    await git(dir, ["reset", "-q"]);
    await expect(unstageSelection(dir, "f.txt", staged.fingerprint, [{ hunkIndex: 0 }])).rejects.toBeInstanceOf(StaleDiffError);
    const worktreeBefore = await worktreeBytes(dir, "f.txt");
    await expect(discardSelection(dir, "f.txt", "0".repeat(64), [{ hunkIndex: 0 }])).rejects.toBeInstanceOf(StaleDiffError);
    expect(await worktreeBytes(dir, "f.txt")).toEqual(worktreeBefore);
  });

  it("AC5: a change to the index between the check and the apply makes git apply refuse; index unchanged by us", async () => {
    const { dir } = await threeHunkRepo();
    const diff = await textDiff(dir, "unstaged", "f.txt");
    let treeAfterInjection = "";
    _setPartialStagingAfterCheckHookForTests(async () => {
      // Someone else stages the whole file in the gap.
      await git(dir, ["add", "f.txt"]);
      treeAfterInjection = (await git(dir, ["write-tree"])).stdout.trim();
    });
    await expect(stageSelection(dir, "f.txt", diff.fingerprint, [{ hunkIndex: 1 }])).rejects.toBeInstanceOf(GitCommandError);
    expect((await git(dir, ["write-tree"])).stdout.trim()).toBe(treeAfterInjection);
  });

  it("AC5: a worktree change between the check and the apply makes discard refuse without touching the file", async () => {
    const { dir } = await threeHunkRepo();
    const diff = await textDiff(dir, "unstaged", "f.txt");
    const injected = numbered(30, { 3: "CHANGED 3", 15: "INJECTED", 27: "CHANGED 27" });
    _setPartialStagingAfterCheckHookForTests(async () => {
      await writeFile(dir, "f.txt", injected);
    });
    await expect(discardSelection(dir, "f.txt", diff.fingerprint, [{ hunkIndex: 1 }])).rejects.toBeInstanceOf(GitCommandError);
    expect((await worktreeBytes(dir, "f.txt")).toString()).toBe(injected);
  });
});

describe("byte exactness (AC6)", () => {
  it("keeps CRLF line endings byte-exact when staging a hunk and lines", async () => {
    const dir = await newRepo();
    const crlf = (s: string) => s.replace(/\n/g, "\r\n");
    await writeFile(dir, "w.txt", crlf(numbered(30)));
    await commit(dir, "base");
    const edited = crlf(numbered(30, { 3: "CHANGED 3", 4: "CHANGED 4", 27: "CHANGED 27" }));
    await writeFile(dir, "w.txt", edited);

    const diff = await textDiff(dir, "unstaged", "w.txt");
    expect(diff.hunks).toHaveLength(2);
    const l = diff.hunks[0]!.lines;
    await stageSelection(dir, "w.txt", diff.fingerprint, [
      { hunkIndex: 0, lineIndexes: [l.findIndex((x) => x.content === "CHANGED 3\r"), l.findIndex((x) => x.content === "line 3\r")] },
    ]);
    // -3 -4 +C3 +C4 with only -3/+C3 chosen: the unselected -4 stays as context before C3.
    expect(await indexBlob(dir, "w.txt")).toEqual(
      Buffer.from(crlf(numbered(30, { 3: "line 4", 4: "CHANGED 3" })), "utf8"),
    );
    const staged = await textDiff(dir, "staged", "w.txt");
    await unstageSelection(dir, "w.txt", staged.fingerprint, [{ hunkIndex: 0 }]);
    expect((await git(dir, ["diff", "--cached"])).stdout).toBe("");
    const again = await textDiff(dir, "unstaged", "w.txt");
    await stageSelection(dir, "w.txt", again.fingerprint, [{ hunkIndex: 1 }]);
    expect(await indexBlob(dir, "w.txt")).toEqual(Buffer.from(crlf(numbered(30, { 27: "CHANGED 27" }))));
    expect(await worktreeBytes(dir, "w.txt")).toEqual(Buffer.from(edited));
  });

  it("stages the last line of a file with no trailing newline, marker preserved", async () => {
    const dir = await newRepo();
    await writeFile(dir, "n.txt", "a\nb\n");
    await commit(dir, "base");
    await writeFile(dir, "n.txt", "a\nb\nc");
    const diff = await textDiff(dir, "unstaged", "n.txt");
    const idx = changedIdx(diff.hunks[0]!.lines);
    await stageSelection(dir, "n.txt", diff.fingerprint, [{ hunkIndex: 0, lineIndexes: idx }]);
    expect(await indexBlob(dir, "n.txt")).toEqual(Buffer.from("a\nb\nc"));
    expect((await git(dir, ["status", "--porcelain"])).stdout).toBe("M  n.txt\n");
  });

  it("stages a no-newline last hunk alone and leaves the earlier hunk unstaged", async () => {
    const dir = await newRepo();
    await writeFile(dir, "n.txt", numbered(30).slice(0, -1)); // no trailing newline
    await commit(dir, "base");
    const edited = numbered(30, { 2: "CHANGED 2", 30: "CHANGED 30" }).slice(0, -1);
    await writeFile(dir, "n.txt", edited);
    const diff = await textDiff(dir, "unstaged", "n.txt");
    expect(diff.hunks).toHaveLength(2);
    await stageSelection(dir, "n.txt", diff.fingerprint, [{ hunkIndex: 1 }]);
    expect(await indexBlob(dir, "n.txt")).toEqual(Buffer.from(numbered(30, { 30: "CHANGED 30" }).slice(0, -1)));
    expect(await worktreeBytes(dir, "n.txt")).toEqual(Buffer.from(edited));
    // and it unstages back
    const staged = await textDiff(dir, "staged", "n.txt");
    await unstageSelection(dir, "n.txt", staged.fingerprint, [{ hunkIndex: 0 }]);
    expect(await indexBlob(dir, "n.txt")).toEqual(Buffer.from(numbered(30).slice(0, -1)));
  });

  it("refuses a selection that would split a line from its no-newline partner, changing nothing", async () => {
    const dir = await newRepo();
    await writeFile(dir, "n.txt", "a\nz");
    await commit(dir, "base");
    await writeFile(dir, "n.txt", "a\nz\nw"); // -z(no NL) +z +w(no NL)
    const diff = await textDiff(dir, "unstaged", "n.txt");
    const lines = diff.hunks[0]!.lines;
    const w = lines.findIndex((l) => l.content === "w");
    const before = (await git(dir, ["ls-files", "-s"])).stdout;
    await expect(stageSelection(dir, "n.txt", diff.fingerprint, [{ hunkIndex: 0, lineIndexes: [w] }])).rejects.toBeInstanceOf(InvalidArgumentError);
    expect((await git(dir, ["ls-files", "-s"])).stdout).toBe(before);
    await stageSelection(dir, "n.txt", diff.fingerprint, [{ hunkIndex: 0 }]);
    expect(await indexBlob(dir, "n.txt")).toEqual(Buffer.from("a\nz\nw"));
  });

  it("handles non-ASCII content and file names", async () => {
    const dir = await newRepo();
    await writeFile(dir, "héllo wörld.txt", numbered(30).replace("line 3\n", "línea 3 中\n"));
    await commit(dir, "base");
    await writeFile(dir, "héllo wörld.txt", numbered(30, { 3: "cambiado \u{1F600}", 27: "x" }).replace("line 3\n", "línea 3 中\n"));
    const diff = await textDiff(dir, "unstaged", "héllo wörld.txt");
    expect(diff.partialStaging).toEqual({ eligible: true });
    await stageSelection(dir, "héllo wörld.txt", diff.fingerprint, [{ hunkIndex: diff.hunks.length - 1 }]);
    expect((await indexBlob(dir, "héllo wörld.txt")).toString()).toContain("\nx\n");
  });
});

describe("discard (AC8)", () => {
  it("discards one hunk from the worktree only; the index is untouched even with staged changes in the same file", async () => {
    const dir = await newRepo();
    await writeFile(dir, "f.txt", numbered(30));
    await commit(dir, "base");
    await writeFile(dir, "f.txt", numbered(30, { 3: "CHANGED 3" }));
    await git(dir, ["add", "f.txt"]);
    await writeFile(dir, "f.txt", numbered(30, { 3: "CHANGED 3", 15: "CHANGED 15", 27: "CHANGED 27" }));
    const indexBefore = (await git(dir, ["ls-files", "-s"])).stdout;
    const treeBefore = (await git(dir, ["write-tree"])).stdout;

    const diff = await textDiff(dir, "unstaged", "f.txt");
    expect(diff.hunks).toHaveLength(2);
    await discardSelection(dir, "f.txt", diff.fingerprint, [{ hunkIndex: 0 }]);

    expect((await worktreeBytes(dir, "f.txt")).toString()).toBe(numbered(30, { 3: "CHANGED 3", 27: "CHANGED 27" }));
    expect((await git(dir, ["ls-files", "-s"])).stdout).toBe(indexBefore);
    expect((await git(dir, ["write-tree"])).stdout).toBe(treeBefore);
  });

  it("discards selected lines: an unselected '+' line stays, an unselected '-' line stays deleted", async () => {
    const dir = await newRepo();
    await writeFile(dir, "f.txt", numbered(10));
    await commit(dir, "base");
    await writeFile(dir, "f.txt", numbered(10, { 4: "L4", 5: null }, { 6: ["x", "y"] }));
    const diff = await textDiff(dir, "unstaged", "f.txt");
    const lines = diff.hunks[0]!.lines;
    // Discard "+L4" and "+x" only.
    await discardSelection(dir, "f.txt", diff.fingerprint, [
      { hunkIndex: 0, lineIndexes: [lines.findIndex((l) => l.content === "L4"), lines.findIndex((l) => l.content === "x")] },
    ]);
    expect((await worktreeBytes(dir, "f.txt")).toString()).toBe(
      ["line 1", "line 2", "line 3", "line 6", "y", "line 7", "line 8", "line 9", "line 10", ""].join("\n"),
    );
    expect((await git(dir, ["diff", "--cached"])).stdout).toBe("");
  });
});

describe("eligibility (FR-452)", () => {
  async function expectIneligible(dir: string, file: string, fp: string, reasons: string[]): Promise<void> {
    const err = await stageSelection(dir, file, fp, [{ hunkIndex: 0 }]).catch((e) => e);
    expect(err).toBeInstanceOf(PartialStagingIneligibleError);
    expect(reasons).toContain((err as PartialStagingIneligibleError).reason);
  }

  it("rejects untracked files", async () => {
    const dir = await newRepo();
    await writeFile(dir, "a.txt", "1\n");
    await commit(dir, "base");
    await writeFile(dir, "new.txt", "x\n");
    await expectIneligible(dir, "new.txt", "deadbeef", ["untracked"]);
  });

  it("rejects added, deleted and renamed files from the staged side", async () => {
    const dir = await newRepo();
    await writeFile(dir, "keep.txt", "keep\n");
    await writeFile(dir, "del.txt", "del\n");
    await writeFile(dir, "old.txt", "rename me please\nsecond line\nthird line\n");
    await commit(dir, "base");
    await writeFile(dir, "added.txt", "a\n");
    await git(dir, ["add", "added.txt"]);
    await git(dir, ["rm", "-q", "del.txt"]);
    await git(dir, ["mv", "old.txt", "new.txt"]);
    for (const [file, reason] of [["added.txt", "added"], ["del.txt", "deleted"], ["new.txt", "added"]] as const) {
      const fp = "0".repeat(64);
      const err = await unstageSelection(dir, file, fp, [{ hunkIndex: 0 }]).catch((e) => e);
      expect(err, file).toBeInstanceOf(PartialStagingIneligibleError);
      expect((err as PartialStagingIneligibleError).reason).toBe(reason);
    }
    const d = await getFileDiff(dir, { kind: "staged", path: "added.txt" });
    expect(d.status === "ok" && d.partialStaging).toEqual({ eligible: false, reason: "added" });
  });

  it("rejects a mode-only change", async () => {
    const dir = await newRepo();
    await writeFile(dir, "s.sh", "echo hi\n");
    await commit(dir, "base");
    await git(dir, ["update-index", "--chmod=+x", "s.sh"]);
    await expect(unstageSelection(dir, "s.sh", "0".repeat(64), [{ hunkIndex: 0 }])).rejects.toMatchObject({ reason: "mode-change" });
  });

  it("rejects binary files", async () => {
    const dir = await newRepo();
    await fs.writeFile(path.join(dir, "b.bin"), Buffer.from([0, 1, 2, 3, 0, 5]));
    await commit(dir, "base");
    await fs.writeFile(path.join(dir, "b.bin"), Buffer.from([0, 9, 2, 3, 0, 5, 7]));
    await expectIneligible(dir, "b.bin", "x", ["binary"]);
  });

  it("rejects a non-UTF-8 text file", async () => {
    const dir = await newRepo();
    await fs.writeFile(path.join(dir, "l.txt"), Buffer.from("caf\xe9\nsecond\n", "latin1"));
    await commit(dir, "base");
    await fs.writeFile(path.join(dir, "l.txt"), Buffer.from("caf\xe9 au lait\nsecond\n", "latin1"));
    const d = await getFileDiff(dir, { kind: "unstaged", path: "l.txt" });
    expect(d.status === "ok" && d.partialStaging).toEqual({ eligible: false, reason: "non-utf8" });
    await expectIneligible(dir, "l.txt", "x", ["non-utf8"]);
  });

  it("rejects a too-large file", async () => {
    const dir = await newRepo();
    const big = "x".repeat(70) + "\n";
    await writeFile(dir, "big.txt", big.repeat(40_000));
    await commit(dir, "base");
    await writeFile(dir, "big.txt", big.repeat(40_000) + "tail\n");
    await expectIneligible(dir, "big.txt", "x", ["too-large"]);
  });

  it("rejects a conflicted file", async () => {
    const dir = await newRepo();
    await writeFile(dir, "c.txt", "base\n");
    await commit(dir, "base");
    await git(dir, ["checkout", "-q", "-b", "other"]);
    await writeFile(dir, "c.txt", "other\n");
    await commit(dir, "other");
    await git(dir, ["checkout", "-q", "main"]);
    await writeFile(dir, "c.txt", "main\n");
    await commit(dir, "main");
    await git(dir, ["merge", "other"]).catch(() => undefined);
    await expectIneligible(dir, "c.txt", "x", ["conflicted"]);
    const d = await getFileDiff(dir, { kind: "unstaged", path: "c.txt" });
    expect(d.status === "ok" && d.partialStaging).toMatchObject({ eligible: false, reason: "conflicted" });
  });

  it("classifies symlink, submodule and type-change diff headers", () => {
    const hdr = (extra: string) => `diff --git a/x b/x\n${extra}--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n`;
    expect(classifyRawDiff(hdr("index 111..222 120000\n"))).toBe("symlink");
    expect(classifyRawDiff(hdr("index 111..222 160000\n"))).toBe("submodule");
    expect(classifyRawDiff("diff --git a/x b/x\nindex 111..222 160000\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-Subproject commit 1\n+Subproject commit 2\n")).toBe("submodule");
    expect(classifyRawDiff(hdr("old mode 100644\nnew mode 120000\n"))).toBe("type-change");
    expect(classifyRawDiff(hdr("old mode 100644\nnew mode 100755\n"))).toBe("mode-change");
    expect(classifyRawDiff(hdr("index 111..222 100644\n"))).toBeNull();
    expect(classifyRawDiff("")).toBe("empty");
  });

  it("builds nothing from a selection with no changed lines", () => {
    const raw = parseRawDiff("diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n a\n-b\n+c\n");
    expect(() => buildPartialPatch(raw, [{ hunkIndex: 0, lineIndexes: [0] }], "forward")).toThrow(InvalidArgumentError);
  });
});

describe("failure handling (AC11) and safety (FR-451, FR-456)", () => {
  it("surfaces git's error for a locked index and leaves a consistent state", async () => {
    const { dir, edited } = await threeHunkRepo();
    const diff = await textDiff(dir, "unstaged", "f.txt");
    const statusBefore = (await git(dir, ["status", "--porcelain"])).stdout;
    await fs.writeFile(path.join(dir, ".git", "index.lock"), "");

    const err = await stageSelection(dir, "f.txt", diff.fingerprint, [{ hunkIndex: 1 }]).catch((e) => e);
    expect(err).toBeInstanceOf(GitCommandError);
    expect((err as GitCommandError).stderr).toMatch(/index\.lock/);

    await fs.rm(path.join(dir, ".git", "index.lock"));
    expect((await git(dir, ["status", "--porcelain"])).stdout).toBe(statusBefore);
    expect(await worktreeBytes(dir, "f.txt")).toEqual(Buffer.from(edited));
    expect((await git(dir, ["diff", "--cached"])).stdout).toBe("");
  });

  it("rejects a path that escapes the working directory", async () => {
    const { dir } = await threeHunkRepo();
    await expect(stageSelection(dir, "../outside.txt", "x", [{ hunkIndex: 0 }])).rejects.toBeInstanceOf(InvalidArgumentError);
  });

  it("does not execute a repo-local core.fsmonitor hook", async () => {
    const cleanups: string[] = [];
    const { dir, markerPath } = await setUpMaliciousFsmonitorRepo(cleanups);
    try {
      await writeFile(dir, "a.txt", numbered(10));
      await commit(dir, "more");
      await writeFile(dir, "a.txt", numbered(10, { 5: "changed" }));
      const diff = await textDiff(dir, "unstaged", "a.txt");
      await fs.rm(markerPath, { force: true }); // the fixture's own commit ran the hook; only the operation matters here
      await stageSelection(dir, "a.txt", diff.fingerprint, [{ hunkIndex: 0 }]);
      expect(await fileExists(markerPath)).toBe(false);
    } finally {
      for (const c of cleanups) await cleanup(c);
    }
  });

  it("does not run hooks", async () => {
    const { dir } = await threeHunkRepo();
    const marker = path.join(dir, "hook-ran");
    for (const h of ["pre-commit", "post-checkout", "post-index-change"]) {
      await fs.writeFile(path.join(dir, ".git", "hooks", h), `#!/bin/sh\ntouch "${marker.replace(/\\/g, "/")}"\n`, { mode: 0o755 });
    }
    const diff = await textDiff(dir, "unstaged", "f.txt");
    await fs.rm(marker, { force: true });
    await stageSelection(dir, "f.txt", diff.fingerprint, [{ hunkIndex: 0 }]);
    expect(await fileExists(marker)).toBe(false);
  });

  it("is exposed on Repository and works in a linked worktree", async () => {
    const { dir } = await threeHunkRepo();
    await git(dir, ["add", "f.txt"]);
    await git(dir, ["commit", "-q", "-m", "edited"]);
    const wt = path.join(dir, "..", `${path.basename(dir)}-wt`);
    await git(dir, ["worktree", "add", "-q", wt, "-b", "wt-branch"]);
    cleanupDirs.push(wt);
    await writeFile(wt, "f.txt", numbered(30, { 3: "WT 3", 20: "WT 20" }));
    const repo = await Repository.open(wt);
    const diff = await repo.getUnstagedFileDiff("f.txt");
    if (diff.status !== "ok" || !diff.fingerprint) throw new Error("expected ok diff");
    await repo.stageSelection("f.txt", diff.fingerprint, [{ hunkIndex: 0 }]);
    const staged = await repo.getStagedFileDiff("f.txt");
    expect(staged.status === "ok" && staged.hunks).toHaveLength(1);
    const sd = staged as TextFileDiff;
    await repo.unstageSelection("f.txt", sd.fingerprint!, [{ hunkIndex: 0 }]);
    expect((await git(wt, ["diff", "--cached"])).stdout).toBe("");
    await stageFile(wt, "f.txt");
  });
});
