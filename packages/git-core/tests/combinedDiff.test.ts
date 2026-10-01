// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect, afterEach } from "vitest";
import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getCombinedFileDiff, toggleCombinedLines, discardCombinedLines } from "../src/combinedStaging";
import { _setPartialStagingAfterCheckHookForTests } from "../src/partialStaging";
import { GitCommandError, InvalidArgumentError, LinesNotDiscardableError, PartialStagingIneligibleError, StaleDiffError } from "../src/errors";
import { Repository } from "../src/index";
import type { CombinedFileDiffResult, CombinedLineRef } from "../src/types";
import { git, initRepo, writeFile, commit, cleanup } from "./testRepo";

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
  await git(dir, ["config", "core.autocrlf", "false"]);
  return dir;
}

const indexBlob = (dir: string, file: string): Promise<Buffer> => gitBytes(dir, ["cat-file", "blob", `:${file}`]);
const worktreeBytes = (dir: string, file: string): Promise<Buffer> => fs.readFile(path.join(dir, file));

/** Sets the index to `content` without touching HEAD, then leaves the worktree at `worktree`. */
async function stageContent(dir: string, file: string, content: string, worktree: string): Promise<void> {
  await writeFile(dir, file, content);
  await git(dir, ["add", file]);
  await writeFile(dir, file, worktree);
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

type Combined = Extract<CombinedFileDiffResult, { mode: "combined" }>;

async function combined(dir: string, file: string): Promise<Combined> {
  const r = await getCombinedFileDiff(dir, file);
  if (r.mode !== "combined") throw new Error(`expected combined, got separate (${r.reason})`);
  return r;
}

/** "+content" / "-content" mapped to its staged flag, in diff order. */
function flags(r: Combined): string[] {
  return r.hunks.flatMap((h) => h.lines.filter((l) => l.type !== "context").map((l) => `${l.type === "add" ? "+" : "-"}${l.content}:${l.staged ? "S" : "U"}`));
}

function refs(r: Combined, pred: (type: string, content: string, hunk: number) => boolean): CombinedLineRef[] {
  const out: CombinedLineRef[] = [];
  r.hunks.forEach((h, hunkIndex) =>
    h.lines.forEach((l, lineIndex) => {
      if (l.type !== "context" && pred(l.type, l.content, hunkIndex)) out.push({ hunkIndex, lineIndex });
    }),
  );
  return out;
}

const hunkRefs = (r: Combined, hunkIndex: number): CombinedLineRef[] => refs(r, (_t, _c, h) => h === hunkIndex);

async function threeHunkRepo(): Promise<{ dir: string; base: string; edited: string }> {
  const dir = await newRepo();
  const base = numbered(30);
  const edited = numbered(30, { 3: "CHANGED 3", 15: "CHANGED 15", 27: "CHANGED 27" });
  await writeFile(dir, "f.txt", base);
  await commit(dir, "base");
  await writeFile(dir, "f.txt", edited);
  return { dir, base, edited };
}

describe("per-line staged state (FR-479)", () => {
  it("reports staged flags for a 3-hunk file with different staged subsets", async () => {
    const { dir, edited } = await threeHunkRepo();
    expect(flags(await combined(dir, "f.txt")).every((f) => f.endsWith(":U"))).toBe(true);

    // hunk 2 fully staged, hunk 1 half staged (deletion only), hunk 3 unstaged
    await stageContent(dir, "f.txt", numbered(30, { 3: null, 15: "CHANGED 15" }), edited);
    const r = await combined(dir, "f.txt");
    expect(r.hunks).toHaveLength(3);
    expect(flags(r)).toEqual([
      "-line 3:S", "+CHANGED 3:U",
      "-line 15:S", "+CHANGED 15:S",
      "-line 27:U", "+CHANGED 27:U",
    ]);
    expect(r.hunks.map((h) => h.stagedState)).toEqual(["some", "all", "none"]);
    // The context lines keep git's numbering (old = HEAD, new = worktree).
    expect(r.hunks[1]!.lines.find((l) => l.content === "CHANGED 15")).toMatchObject({ oldLineNumber: null, newLineNumber: 15 });
    expect(await worktreeBytes(dir, "f.txt")).toEqual(Buffer.from(edited));
  });

  it("keeps a fully staged file as one combined view with everything ticked", async () => {
    const { dir } = await threeHunkRepo();
    await git(dir, ["add", "f.txt"]);
    const r = await combined(dir, "f.txt");
    expect(r.hunks.map((h) => h.stagedState)).toEqual(["all", "all", "all"]);
  });

  it("marks only unstaged lines discardable", async () => {
    const { dir, edited } = await threeHunkRepo();
    await stageContent(dir, "f.txt", numbered(30, { 15: "CHANGED 15" }), edited);
    const r = await combined(dir, "f.txt");
    const all = r.hunks.flatMap((h) => h.lines.filter((l) => l.type !== "context"));
    expect(all.every((l) => l.discardable === !l.staged)).toBe(true);
    expect(all.some((l) => l.staged) && all.some((l) => !l.staged)).toBe(true);
    expect(r.hunks[0]!.lines.filter((l) => l.type === "context").every((l) => !l.staged && !l.discardable)).toBe(true);
  });

  it("falls back for a line staged and then edited again in the worktree (an index-only line cannot be shown)", async () => {
    const dir = await newRepo();
    await writeFile(dir, "f.txt", numbered(30));
    await commit(dir, "base");
    await stageContent(dir, "f.txt", numbered(30, { 5: "STAGED5" }), numbered(30, { 5: "EDIT5", 20: "WT20" }));
    expect(await getCombinedFileDiff(dir, "f.txt")).toEqual({ mode: "separate", reason: "ambiguous" });
  });
});

describe("toggling lines and hunks (AC1, AC2, AC4)", () => {
  async function fixture(): Promise<{ dir: string; base: string; edited: string }> {
    const dir = await newRepo();
    const base = numbered(10);
    const edited = numbered(10, { 4: "L4", 5: null }, { 6: ["x", "y"] });
    await writeFile(dir, "f.txt", base);
    await commit(dir, "base");
    await writeFile(dir, "f.txt", edited);
    return { dir, base, edited };
  }

  it("stages exactly one added line and toggling back restores the prior index bytes", async () => {
    const { dir, base, edited } = await fixture();
    const before = await indexBlob(dir, "f.txt");
    let r = await combined(dir, "f.txt");
    await toggleCombinedLines(dir, "f.txt", r.fingerprint, refs(r, (_t, c) => c === "x"), "stage");
    expect((await indexBlob(dir, "f.txt")).toString()).toBe(
      ["line 1", "line 2", "line 3", "line 4", "line 5", "line 6", "x", "line 7", "line 8", "line 9", "line 10", ""].join("\n"),
    );
    expect(await worktreeBytes(dir, "f.txt")).toEqual(Buffer.from(edited));
    r = await combined(dir, "f.txt");
    expect(flags(r).filter((f) => f.endsWith(":S"))).toEqual(["+x:S"]);

    await toggleCombinedLines(dir, "f.txt", r.fingerprint, refs(r, (_t, c) => c === "x"), "unstage");
    expect((await indexBlob(dir, "f.txt")).equals(before)).toBe(true);
    expect((await indexBlob(dir, "f.txt")).toString()).toBe(base);
  });

  it("stages a '-' line alone (the deletion goes into the index) and unstages it again", async () => {
    const { dir, base } = await fixture();
    let r = await combined(dir, "f.txt");
    await toggleCombinedLines(dir, "f.txt", r.fingerprint, refs(r, (t, c) => t === "remove" && c === "line 5"), "stage");
    expect((await indexBlob(dir, "f.txt")).toString()).toBe(numbered(10, { 5: null }));
    r = await combined(dir, "f.txt");
    expect(flags(r).filter((f) => f.endsWith(":S"))).toEqual(["-line 5:S"]);
    await toggleCombinedLines(dir, "f.txt", r.fingerprint, refs(r, (t, c) => t === "remove" && c === "line 5"), "unstage");
    expect((await indexBlob(dir, "f.txt")).toString()).toBe(base);
  });

  it("stages and unstages one whole hunk, leaving the worktree byte-identical (AC1)", async () => {
    const { dir, base, edited } = await threeHunkRepo();
    let r = await combined(dir, "f.txt");
    await toggleCombinedLines(dir, "f.txt", r.fingerprint, hunkRefs(r, 1), "stage");
    expect((await indexBlob(dir, "f.txt")).toString()).toBe(numbered(30, { 15: "CHANGED 15" }));
    expect(await worktreeBytes(dir, "f.txt")).toEqual(Buffer.from(edited));
    const cached = (await git(dir, ["diff", "--cached"])).stdout;
    expect(cached).toContain("+CHANGED 15");
    expect(cached).not.toContain("CHANGED 3");
    r = await combined(dir, "f.txt");
    expect(r.hunks.map((h) => h.stagedState)).toEqual(["none", "all", "none"]);

    await toggleCombinedLines(dir, "f.txt", r.fingerprint, hunkRefs(r, 1), "unstage");
    expect((await indexBlob(dir, "f.txt")).toString()).toBe(base);
  });

  it("hunk checkbox states: mixed becomes all when the rest is staged, then none when unstaged (AC4)", async () => {
    const { dir, edited } = await fixture();
    let r = await combined(dir, "f.txt");
    expect(r.hunks.map((h) => h.stagedState)).toEqual(["none"]);
    await toggleCombinedLines(dir, "f.txt", r.fingerprint, refs(r, (_t, c) => c === "x"), "stage");
    r = await combined(dir, "f.txt");
    expect(r.hunks.map((h) => h.stagedState)).toEqual(["some"]);

    // The UI sends the hunk's lines to stage the rest; the already staged one is skipped.
    await toggleCombinedLines(dir, "f.txt", r.fingerprint, hunkRefs(r, 0), "stage");
    expect((await indexBlob(dir, "f.txt")).equals(Buffer.from(edited))).toBe(true);
    r = await combined(dir, "f.txt");
    expect(r.hunks.map((h) => h.stagedState)).toEqual(["all"]);

    await toggleCombinedLines(dir, "f.txt", r.fingerprint, hunkRefs(r, 0), "unstage");
    expect((await git(dir, ["diff", "--cached"])).stdout).toBe("");
    expect((await combined(dir, "f.txt")).hunks.map((h) => h.stagedState)).toEqual(["none"]);
  });

  it("does nothing when every line is already in the target state", async () => {
    const { dir } = await fixture();
    const r = await combined(dir, "f.txt");
    const before = (await git(dir, ["ls-files", "-s"])).stdout;
    await toggleCombinedLines(dir, "f.txt", r.fingerprint, hunkRefs(r, 0), "unstage");
    expect((await git(dir, ["ls-files", "-s"])).stdout).toBe(before);
  });

  it("stages a line in a partly staged file on top of the existing index", async () => {
    const { dir, edited } = await threeHunkRepo();
    await stageContent(dir, "f.txt", numbered(30, { 3: null, 15: "CHANGED 15" }), edited);
    const r = await combined(dir, "f.txt");
    await toggleCombinedLines(dir, "f.txt", r.fingerprint, refs(r, (_t, c) => c === "CHANGED 27"), "stage");
    expect((await indexBlob(dir, "f.txt")).toString()).toBe(numbered(30, { 3: null, 15: "CHANGED 15" }, { 27: ["CHANGED 27"] }));
  });
});

describe("byte exactness (AC3)", () => {
  it("keeps CRLF endings when toggling a line and a hunk", async () => {
    const dir = await newRepo();
    const crlf = (s: string): string => s.replace(/\n/g, "\r\n");
    await writeFile(dir, "w.txt", crlf(numbered(30)));
    await commit(dir, "base");
    const edited = crlf(numbered(30, { 3: "CHANGED 3", 4: "CHANGED 4", 27: "CHANGED 27" }));
    await writeFile(dir, "w.txt", edited);
    let r = await combined(dir, "w.txt");
    expect(r.hunks).toHaveLength(2);
    await toggleCombinedLines(dir, "w.txt", r.fingerprint, refs(r, (t, c) => t === "add" && c === "CHANGED 3\r"), "stage");
    // The unselected '-' lines stay as context, so the staged addition lands after "line 4".
    expect(await indexBlob(dir, "w.txt")).toEqual(Buffer.from(crlf(numbered(30, {}, { 4: ["CHANGED 3"] }))));
    r = await combined(dir, "w.txt");
    await toggleCombinedLines(dir, "w.txt", r.fingerprint, hunkRefs(r, 1), "stage");
    expect((await indexBlob(dir, "w.txt")).toString()).toContain("CHANGED 27\r\n");
    r = await combined(dir, "w.txt");
    await toggleCombinedLines(dir, "w.txt", r.fingerprint, hunkRefs(r, 0).concat(hunkRefs(r, 1)), "stage");
    expect(await indexBlob(dir, "w.txt")).toEqual(Buffer.from(edited));
    r = await combined(dir, "w.txt");
    await toggleCombinedLines(dir, "w.txt", r.fingerprint, hunkRefs(r, 0).concat(hunkRefs(r, 1)), "unstage");
    expect((await git(dir, ["diff", "--cached"])).stdout).toBe("");
    expect(await worktreeBytes(dir, "w.txt")).toEqual(Buffer.from(edited));
  });

  it("toggles the last line of a file without a trailing newline and keeps the marker correct", async () => {
    const dir = await newRepo();
    await writeFile(dir, "n.txt", numbered(30).slice(0, -1));
    await commit(dir, "base");
    const edited = numbered(30, { 2: "CHANGED 2", 30: "CHANGED 30" }).slice(0, -1);
    await writeFile(dir, "n.txt", edited);
    let r = await combined(dir, "n.txt");
    expect(r.hunks).toHaveLength(2);
    await toggleCombinedLines(dir, "n.txt", r.fingerprint, hunkRefs(r, 1), "stage");
    expect(await indexBlob(dir, "n.txt")).toEqual(Buffer.from(numbered(30, { 30: "CHANGED 30" }).slice(0, -1)));
    r = await combined(dir, "n.txt");
    expect(r.hunks.map((h) => h.stagedState)).toEqual(["none", "all"]);
    await toggleCombinedLines(dir, "n.txt", r.fingerprint, hunkRefs(r, 1), "unstage");
    expect(await indexBlob(dir, "n.txt")).toEqual(Buffer.from(numbered(30).slice(0, -1)));
    await toggleCombinedLines(dir, "n.txt", (await combined(dir, "n.txt")).fingerprint, hunkRefs(r, 0).concat(hunkRefs(r, 1)), "stage");
    expect(await indexBlob(dir, "n.txt")).toEqual(Buffer.from(edited));
  });

  it("refuses a selection that splits a line from its no-newline partner and changes nothing", async () => {
    const dir = await newRepo();
    await writeFile(dir, "n.txt", "a\nz");
    await commit(dir, "base");
    await writeFile(dir, "n.txt", "a\nz\nw"); // -z(no NL) +z +w(no NL)
    const r = await combined(dir, "n.txt");
    const before = (await git(dir, ["ls-files", "-s"])).stdout;
    await expect(toggleCombinedLines(dir, "n.txt", r.fingerprint, refs(r, (_t, c) => c === "w"), "stage")).rejects.toBeInstanceOf(InvalidArgumentError);
    expect((await git(dir, ["ls-files", "-s"])).stdout).toBe(before);
    await toggleCombinedLines(dir, "n.txt", r.fingerprint, hunkRefs(r, 0), "stage");
    expect(await indexBlob(dir, "n.txt")).toEqual(Buffer.from("a\nz\nw"));
  });

  it("handles non-ASCII file names and content", async () => {
    const dir = await newRepo();
    await writeFile(dir, "héllo wörld.txt", numbered(30).replace("line 3\n", "línea 3 中\n"));
    await commit(dir, "base");
    await writeFile(dir, "héllo wörld.txt", numbered(30, { 3: "cambiado \u{1F600}", 27: "x" }).replace("line 3\n", "línea 3 中\n"));
    const r = await combined(dir, "héllo wörld.txt");
    expect(r.hunks.flatMap((h) => h.lines.map((l) => l.content))).toContain("cambiado \u{1F600}");
    await toggleCombinedLines(dir, "héllo wörld.txt", r.fingerprint, hunkRefs(r, r.hunks.length - 1), "stage");
    expect((await indexBlob(dir, "héllo wörld.txt")).toString()).toContain("\nx\n");
  });
});

describe("ranges and failure (AC5, AC13)", () => {
  it("applies a range spanning staged and unstaged lines in one operation", async () => {
    const { dir, edited } = await threeHunkRepo();
    await stageContent(dir, "f.txt", numbered(30, { 15: "CHANGED 15" }), edited);
    const r = await combined(dir, "f.txt");
    await toggleCombinedLines(dir, "f.txt", r.fingerprint, refs(r, () => true), "stage");
    expect((await indexBlob(dir, "f.txt")).equals(Buffer.from(edited))).toBe(true);
    const r2 = await combined(dir, "f.txt");
    await toggleCombinedLines(dir, "f.txt", r2.fingerprint, refs(r2, () => true), "unstage");
    expect((await git(dir, ["diff", "--cached"])).stdout).toBe("");
  });

  it("applies nothing when one line of the range is invalid", async () => {
    const { dir } = await threeHunkRepo();
    const r = await combined(dir, "f.txt");
    const ctx: CombinedLineRef = { hunkIndex: 0, lineIndex: r.hunks[0]!.lines.findIndex((l) => l.type === "context") };
    const before = (await git(dir, ["ls-files", "-s"])).stdout;
    await expect(toggleCombinedLines(dir, "f.txt", r.fingerprint, [...hunkRefs(r, 1), ctx], "stage")).rejects.toBeInstanceOf(InvalidArgumentError);
    await expect(toggleCombinedLines(dir, "f.txt", r.fingerprint, [{ hunkIndex: 9, lineIndex: 0 }], "stage")).rejects.toBeInstanceOf(InvalidArgumentError);
    await expect(toggleCombinedLines(dir, "f.txt", r.fingerprint, [], "stage")).rejects.toBeInstanceOf(InvalidArgumentError);
    expect((await git(dir, ["ls-files", "-s"])).stdout).toBe(before);
  });

  it("surfaces git's message for a locked index and leaves a consistent state", async () => {
    const { dir, edited } = await threeHunkRepo();
    const r = await combined(dir, "f.txt");
    await fs.writeFile(path.join(dir, ".git", "index.lock"), "");
    const err = await toggleCombinedLines(dir, "f.txt", r.fingerprint, hunkRefs(r, 1), "stage").catch((e) => e);
    expect(err).toBeInstanceOf(GitCommandError);
    expect((err as GitCommandError).stderr).toMatch(/index\.lock/);
    await fs.rm(path.join(dir, ".git", "index.lock"));
    expect((await git(dir, ["diff", "--cached"])).stdout).toBe("");
    expect(await worktreeBytes(dir, "f.txt")).toEqual(Buffer.from(edited));
  });
});

describe("stale guard (AC7)", () => {
  it("refuses with STALE_DIFF when the worktree changed, and when the index changed", async () => {
    const { dir } = await threeHunkRepo();
    const r = await combined(dir, "f.txt");
    await writeFile(dir, "f.txt", numbered(30, { 3: "CHANGED 3", 15: "EXTERNAL", 27: "CHANGED 27" }));
    const before = (await git(dir, ["ls-files", "-s"])).stdout;
    const err = await toggleCombinedLines(dir, "f.txt", r.fingerprint, hunkRefs(r, 1), "stage").catch((e) => e);
    expect(err).toBeInstanceOf(StaleDiffError);
    expect((err as StaleDiffError).code).toBe("STALE_DIFF");
    expect((await git(dir, ["ls-files", "-s"])).stdout).toBe(before);
    await expect(discardCombinedLines(dir, "f.txt", r.fingerprint, hunkRefs(r, 1))).rejects.toBeInstanceOf(StaleDiffError);

    const fresh = await combined(dir, "f.txt");
    expect(fresh.fingerprint).not.toBe(r.fingerprint);
    await git(dir, ["add", "f.txt"]); // index changed behind the diff
    await expect(toggleCombinedLines(dir, "f.txt", fresh.fingerprint, hunkRefs(fresh, 0), "unstage")).rejects.toBeInstanceOf(StaleDiffError);
  });

  it("refuses a change injected between the check and the apply; the index is untouched by us", async () => {
    const { dir } = await threeHunkRepo();
    const r = await combined(dir, "f.txt");
    let treeAfter = "";
    _setPartialStagingAfterCheckHookForTests(async () => {
      await writeFile(dir, "f.txt", numbered(30, { 3: "CHANGED 3", 15: "INJECTED", 27: "CHANGED 27" }));
      await git(dir, ["add", "f.txt"]);
      treeAfter = (await git(dir, ["write-tree"])).stdout.trim();
    });
    await expect(toggleCombinedLines(dir, "f.txt", r.fingerprint, hunkRefs(r, 1), "stage")).rejects.toBeInstanceOf(GitCommandError);
    expect((await git(dir, ["write-tree"])).stdout.trim()).toBe(treeAfter);
  });

  it("changes the fingerprint when only the worktree bytes change", async () => {
    const { dir } = await threeHunkRepo();
    const a = await combined(dir, "f.txt");
    await writeFile(dir, "f.txt", numbered(30, { 3: "CHANGED 3", 15: "CHANGED 15", 27: "CHANGED 27 again" }));
    expect((await combined(dir, "f.txt")).fingerprint).not.toBe(a.fingerprint);
  });
});

describe("fallback (AC8, FR-481)", () => {
  async function reason(dir: string, file: string): Promise<string> {
    const r = await getCombinedFileDiff(dir, file);
    expect(r.mode, file).toBe("separate");
    return r.mode === "separate" ? r.reason : "";
  }

  it("falls back for untracked, added, deleted, renamed, binary, mode-only, too-large and non-UTF-8 files", async () => {
    const dir = await newRepo();
    await writeFile(dir, "keep.txt", "keep\n");
    await writeFile(dir, "del.txt", "del\n");
    await writeFile(dir, "old.txt", "rename me please\nsecond line\nthird line\n");
    await writeFile(dir, "s.sh", "echo hi\n");
    await fs.writeFile(path.join(dir, "b.bin"), Buffer.from([0, 1, 2, 3, 0, 5]));
    await fs.writeFile(path.join(dir, "l.txt"), Buffer.from("caf\xe9\nsecond\n", "latin1"));
    const big = "x".repeat(70) + "\n";
    await writeFile(dir, "big.txt", big.repeat(40_000));
    await commit(dir, "base");

    await writeFile(dir, "new.txt", "x\n");
    await writeFile(dir, "added.txt", "a\n");
    await git(dir, ["add", "added.txt"]);
    await fs.rm(path.join(dir, "del.txt"));
    await git(dir, ["mv", "old.txt", "moved.txt"]);
    await git(dir, ["update-index", "--chmod=+x", "s.sh"]);
    await fs.writeFile(path.join(dir, "b.bin"), Buffer.from([0, 9, 2, 3, 0, 5, 7]));
    await fs.writeFile(path.join(dir, "l.txt"), Buffer.from("caf\xe9 au lait\nsecond\n", "latin1"));
    await writeFile(dir, "big.txt", big.repeat(40_000) + "tail\n");

    expect(await reason(dir, "new.txt")).toBe("untracked");
    expect(await reason(dir, "added.txt")).toBe("added");
    expect(await reason(dir, "del.txt")).toBe("deleted");
    expect(await reason(dir, "moved.txt")).toBe("added");
    expect(await reason(dir, "old.txt")).toBe("deleted");
    expect(await reason(dir, "s.sh")).toBe("mode-change");
    expect(await reason(dir, "b.bin")).toBe("binary");
    expect(await reason(dir, "l.txt")).toBe("non-utf8");
    expect(await reason(dir, "big.txt")).toBe("too-large");
    expect(await reason(dir, "keep.txt")).toBe("no-changes");
    await expect(toggleCombinedLines(dir, "new.txt", "x", [{ hunkIndex: 0, lineIndex: 0 }], "stage")).rejects.toBeInstanceOf(PartialStagingIneligibleError);
  });

  it("falls back for a conflicted file", async () => {
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
    expect(await reason(dir, "c.txt")).toBe("conflicted");
  });

  it("falls back for a symlink and for an unborn HEAD", async () => {
    const dir = await newRepo();
    await writeFile(dir, "u.txt", "u\n");
    await git(dir, ["add", "u.txt"]);
    expect(await reason(dir, "u.txt")).toBe("added"); // no commit yet
    await commit(dir, "base");
    await writeFile(dir, "target.txt", "u.txt");
    const oid = (await git(dir, ["hash-object", "-w", "--", "target.txt"])).stdout.trim();
    await git(dir, ["update-index", "--add", "--cacheinfo", `120000,${oid},link`]);
    await git(dir, ["commit", "-q", "-m", "link"]);
    expect(await reason(dir, "link")).toBe("symlink");
  });

  it("falls back as ambiguous when the staged/unstaged alignment of repeated lines is not unique, never half-ticking", async () => {
    const dir = await newRepo();
    await writeFile(dir, "r.txt", "A\nB\nA\n");
    await commit(dir, "base");
    await stageContent(dir, "r.txt", "B\nA\n", "A\nB\n");
    const r = await getCombinedFileDiff(dir, "r.txt");
    expect(r).toEqual({ mode: "separate", reason: "ambiguous" });
    await expect(toggleCombinedLines(dir, "r.txt", "any", [{ hunkIndex: 0, lineIndex: 0 }], "stage")).rejects.toBeInstanceOf(StaleDiffError);
  });

  it("is exact on randomized repeated-line fixtures: either separate, or staging everything / unstaging everything round-trips", async () => {
    let seed = 12345;
    const rnd = (n: number): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    const mutate = (lines: string[]): string[] => {
      const out = [...lines];
      for (let k = 0, n = 1 + rnd(3); k < n; k++) {
        const op = rnd(3);
        const at = rnd(out.length + 1);
        if (op === 0) out.splice(at, 0, "ABC"[rnd(3)]!);
        else if (op === 1 && out.length > 1) out.splice(at % out.length, 1);
        else if (out.length > 0) out[at % out.length] = "ABC"[rnd(3)]!;
      }
      return out;
    };
    const toText = (l: string[]): string => l.join("\n") + "\n";
    let combinedCount = 0;
    let separateCount = 0;
    for (let iter = 0; iter < 14; iter++) {
      const dir = await newRepo();
      const h = Array.from({ length: 8 + rnd(6) }, () => "ABC"[rnd(3)]!);
      const i = mutate(h);
      const w = mutate(i);
      await writeFile(dir, "z.txt", toText(h));
      await commit(dir, "base");
      await stageContent(dir, "z.txt", toText(i), toText(w));
      const r = await getCombinedFileDiff(dir, "z.txt");
      if (r.mode === "separate") {
        separateCount++;
        continue;
      }
      combinedCount++;
      const everything = refs(r, () => true);
      await toggleCombinedLines(dir, "z.txt", r.fingerprint, everything, "stage");
      expect((await indexBlob(dir, "z.txt")).toString(), `seed iter ${iter}`).toBe(toText(w));
      const r2 = await combined(dir, "z.txt");
      expect(r2.hunks.every((x) => x.stagedState === "all")).toBe(true);
      await toggleCombinedLines(dir, "z.txt", r2.fingerprint, refs(r2, () => true), "unstage");
      expect((await indexBlob(dir, "z.txt")).toString(), `seed iter ${iter}`).toBe(toText(h));
    }
    expect(combinedCount + separateCount).toBe(14);
    expect(combinedCount).toBeGreaterThan(0);
  }, 120_000);
});

describe("discard (AC9)", () => {
  it("discards unstaged lines only and leaves the index untouched, even with staged changes in the file", async () => {
    const dir = await newRepo();
    await writeFile(dir, "f.txt", numbered(30));
    await commit(dir, "base");
    await stageContent(dir, "f.txt", numbered(30, { 3: "CHANGED 3" }), numbered(30, { 3: "CHANGED 3", 15: "CHANGED 15", 27: "CHANGED 27" }));
    const indexBefore = (await git(dir, ["ls-files", "-s"])).stdout;
    const r = await combined(dir, "f.txt");
    await discardCombinedLines(dir, "f.txt", r.fingerprint, hunkRefs(r, 1));
    expect((await worktreeBytes(dir, "f.txt")).toString()).toBe(numbered(30, { 3: "CHANGED 3", 27: "CHANGED 27" }));
    expect((await git(dir, ["ls-files", "-s"])).stdout).toBe(indexBefore);
  });

  it("discards an unstaged deletion by restoring the line", async () => {
    const dir = await newRepo();
    await writeFile(dir, "f.txt", numbered(10));
    await commit(dir, "base");
    await writeFile(dir, "f.txt", numbered(10, { 8: null }));
    const r = await combined(dir, "f.txt");
    await discardCombinedLines(dir, "f.txt", r.fingerprint, refs(r, (t) => t === "remove"));
    expect((await worktreeBytes(dir, "f.txt")).toString()).toBe(numbered(10));
  });

  it("refuses staged lines with LinesNotDiscardableError, changing nothing", async () => {
    const dir = await newRepo();
    await writeFile(dir, "f.txt", numbered(30));
    await commit(dir, "base");
    const wt = numbered(30, { 5: "EDIT5", 20: "WT20" });
    await stageContent(dir, "f.txt", numbered(30, { 5: "EDIT5" }), wt);
    const r = await combined(dir, "f.txt");
    const indexBefore = (await git(dir, ["ls-files", "-s"])).stdout;
    for (const pick of [refs(r, (_t, c) => c === "EDIT5"), refs(r, () => true)]) {
      const err = await discardCombinedLines(dir, "f.txt", r.fingerprint, pick).catch((e) => e);
      expect(err).toBeInstanceOf(LinesNotDiscardableError);
      expect((err as LinesNotDiscardableError).code).toBe("LINES_NOT_DISCARDABLE");
    }
    expect((await worktreeBytes(dir, "f.txt")).toString()).toBe(wt);
    expect((await git(dir, ["ls-files", "-s"])).stdout).toBe(indexBefore);
  });
});

describe("environment", () => {
  it("works in a linked worktree", async () => {
    const dir = await newRepo();
    await writeFile(dir, "f.txt", numbered(30));
    await commit(dir, "base");
    const wt = `${dir}-linked`;
    cleanupDirs.push(wt);
    await git(dir, ["worktree", "add", "-q", wt, "-b", "side"]);
    await fs.writeFile(path.join(wt, "f.txt"), numbered(30, { 3: "CHANGED 3", 27: "CHANGED 27" }));
    const r = await combined(wt, "f.txt");
    await toggleCombinedLines(wt, "f.txt", r.fingerprint, hunkRefs(r, 1), "stage");
    expect((await indexBlob(wt, "f.txt")).toString()).toBe(numbered(30, { 27: "CHANGED 27" }));
    expect((await git(wt, ["status", "--porcelain"])).stdout).toBe("MM f.txt\n");
  });

  it("is exposed through Repository and rejects an escaping path", async () => {
    const { dir } = await threeHunkRepo();
    const repo = await Repository.open(dir);
    const r = await repo.getCombinedFileDiff("f.txt");
    expect(r.mode).toBe("combined");
    if (r.mode !== "combined") return;
    await repo.toggleCombinedLines("f.txt", r.fingerprint, hunkRefs(r as Combined, 0), "stage");
    expect((await indexBlob(dir, "f.txt")).toString()).toBe(numbered(30, { 3: "CHANGED 3" }));
    await expect(repo.getCombinedFileDiff("../outside.txt")).rejects.toBeInstanceOf(InvalidArgumentError);
  });

  it("does not leave an index.lock or rewrite the index when only reading", async () => {
    const { dir } = await threeHunkRepo();
    const before = (await fs.stat(path.join(dir, ".git", "index"))).mtimeMs;
    await combined(dir, "f.txt");
    expect((await fs.stat(path.join(dir, ".git", "index"))).mtimeMs).toBe(before);
    await expect(fs.access(path.join(dir, ".git", "index.lock"))).rejects.toBeTruthy();
  });
});
