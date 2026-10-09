// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { matchLines, recoverBlocks } from "./conflictRecover";

const MERGED = [
  "head",
  "<<<<<<< ours",
  "top1",
  "||||||| base",
  "old1",
  "=======",
  "bot1",
  ">>>>>>> theirs",
  "mid",
  "<<<<<<< ours",
  "top2",
  "top2b",
  "||||||| base",
  "old2",
  "=======",
  "bot2",
  ">>>>>>> theirs",
  "tail",
  "",
].join("\n");

const join = (...lines: string[]) => lines.join("\n");
const sliceOf = (text: string, r: { from: number; to: number }) => text.slice(r.from, r.to);

describe("matchLines", () => {
  it("matches equal text one to one and unmatched lines to -1", () => {
    expect([...matchLines(["a", "b", "c"], ["a", "b", "c"])!]).toEqual([0, 1, 2]);
    expect([...matchLines(["a", "b", "c"], ["a", "x", "c"])!]).toEqual([0, -1, 2]);
    expect([...matchLines(["a", "b", "c", "d"], ["b", "d"])!]).toEqual([-1, 0, -1, 1]);
    expect([...matchLines([], ["a"])!]).toEqual([]);
  });

  it("gives up rather than guess when the texts are too far apart", () => {
    const a = Array.from({ length: 50 }, (_, i) => `a${i}`);
    const b = Array.from({ length: 50 }, (_, i) => `b${i}`);
    expect(matchLines(a, b, 10)).toBeNull();
  });
});

describe("recoverBlocks (specs/edit-in-diff.md FR-557, FR-565)", () => {
  it("finds a resolved block between the unchanged lines around its original markers", () => {
    const current = join("head", "top1", "mid", "<<<<<<< ours", "top2", "top2b", "||||||| base", "old2", "=======", "bot2", ">>>>>>> theirs", "tail", "");
    const r = recoverBlocks(MERGED, current);
    expect(r).toHaveLength(2);
    expect(sliceOf(current, r[0]!)).toBe("top1\n");
    expect(r[0]).toMatchObject({ ours: "top1\n", theirs: "bot1\n", base: "old1\n" });
    // The block that still has markers is found too; the editor prefers the parsed marker block over it.
    expect(sliceOf(current, r[1]!)).toContain("<<<<<<< ours");
  });

  it("treats removed-both-sides as an empty region and hand-written text as the region", () => {
    const current = join("head", "mid", "my own\ntext", "tail", "");
    const r = recoverBlocks(MERGED, current);
    expect(r).toHaveLength(2);
    expect(r[0]!.from).toBe(r[0]!.to);
    expect(sliceOf(current, r[1]!)).toBe("my own\ntext\n");
  });

  it("works when the first or the last line of the file is inside a conflict", () => {
    const merged = join("<<<<<<< ours", "a", "=======", "b", ">>>>>>> theirs", "keep", "<<<<<<< ours", "c", "=======", "d", ">>>>>>> theirs");
    const current = join("b", "keep", "c");
    const r = recoverBlocks(merged, current);
    expect(r).toHaveLength(2);
    expect(sliceOf(current, r[0]!)).toBe("b\n");
    expect(sliceOf(current, r[1]!)).toBe("c");
  });

  it("leaves out conflicts it cannot place: adjacent ones, or a neighbour line that was edited too", () => {
    const adjacent = join("x", "<<<<<<< ours", "a", "=======", "b", ">>>>>>> theirs", "<<<<<<< ours", "c", "=======", "d", ">>>>>>> theirs", "y", "");
    expect(recoverBlocks(adjacent, join("x", "a", "c", "y", ""))).toEqual([]);
    const edited = recoverBlocks(MERGED, join("HEAD CHANGED", "top1", "mid", "top2", "tail", ""));
    expect(edited.every((b) => b.ours !== "top1\n")).toBe(true);
  });

  it("returns nothing for a buffer with bare carriage returns, an unparseable original, or no conflicts", () => {
    expect(recoverBlocks(MERGED, "head\r\nmid\r\n")).toEqual([]);
    expect(recoverBlocks("a\n<<<<<<< ours\nx\n", "a\n")).toEqual([]);
    expect(recoverBlocks("a\nb\n", "a\nb\n")).toEqual([]);
  });

  it("reads the original through CRLF stage text", () => {
    const merged = MERGED.replace(/\n/g, "\r\n");
    const current = join("head", "top1", "mid", "tail", "").replace(/$/, "");
    expect(recoverBlocks(merged, current).length).toBeGreaterThan(0);
  });
});
