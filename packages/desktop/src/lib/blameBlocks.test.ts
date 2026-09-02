import { describe, expect, it } from "vitest";
import type { BlameLine } from "@githydra/git-core";
import { groupBlameLines } from "./blameBlocks";

function line(sha: string, lineNumber: number): BlameLine {
  return {
    content: `content ${lineNumber}`,
    lineNumber,
    commit: {
      sha,
      abbrevSha: sha.slice(0, 7),
      authorName: "Ada Lovelace",
      authorEmail: "ada@example.com",
      authorDate: "2024-03-01T12:00:00+00:00",
      summary: "subject",
      isBoundary: false,
      isUncommitted: false,
    },
  };
}

describe("groupBlameLines", () => {
  it("returns an empty array for no lines", () => {
    expect(groupBlameLines([])).toEqual([]);
  });

  it("groups contiguous same-commit lines into one block (FR-132)", () => {
    const sha = "a".repeat(40);
    const lines = [line(sha, 1), line(sha, 2), line(sha, 3)];
    const blocks = groupBlameLines(lines);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.lines).toHaveLength(3);
    expect(blocks[0]!.commit.sha).toBe(sha);
  });

  it("starts a new block on every commit change, in file order", () => {
    const shaA = "a".repeat(40);
    const shaB = "b".repeat(40);
    const lines = [line(shaA, 1), line(shaA, 2), line(shaB, 3), line(shaA, 4)];
    const blocks = groupBlameLines(lines);
    expect(blocks.map((b) => b.commit.sha)).toEqual([shaA, shaB, shaA]);
    expect(blocks.map((b) => b.lines.length)).toEqual([2, 1, 1]);
  });

  it("never merges two non-adjacent runs from the same commit into one block", () => {
    const shaA = "a".repeat(40);
    const shaB = "b".repeat(40);
    const blocks = groupBlameLines([line(shaA, 1), line(shaB, 2), line(shaA, 3)]);
    expect(blocks).toHaveLength(3);
  });
});
