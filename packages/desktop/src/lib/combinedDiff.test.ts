// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from "vitest";
import type { CombinedDiffHunk } from "@githydra/git-core";
import {
  changedRowPositions,
  discardableRefs,
  fileStagingSummary,
  hunkChangedRefs,
  hunkStagedState,
  hunkWorktreeRange,
  rangeBetween,
  withStaged,
} from "./combinedDiff";

type L = CombinedDiffHunk["lines"][number];
const ctx = (): L => ({ type: "context", content: "c", oldLineNumber: 1, newLineNumber: 1, staged: false, discardable: false });
const chg = (type: "add" | "remove", staged: boolean): L => ({
  type,
  content: "x",
  oldLineNumber: null,
  newLineNumber: null,
  staged,
  discardable: !staged,
});
const hunk = (lines: L[], header = "@@ -1,2 +10,5 @@"): CombinedDiffHunk => ({
  header,
  oldStart: 1,
  oldLines: 2,
  newStart: 10,
  newLines: 5,
  lines,
  stagedState: "none",
});

describe("combinedDiff helpers", () => {
  const hunks = [hunk([ctx(), chg("remove", true), chg("add", false), ctx()]), hunk([chg("add", false)])];

  it("lists changed rows across hunks in reading order, skipping context (FR-483)", () => {
    expect(changedRowPositions(hunks)).toEqual([
      { hunk: 0, line: 1 },
      { hunk: 0, line: 2 },
      { hunk: 1, line: 0 },
    ]);
  });

  it("computes the hunk checkbox state from the lines: none / some / all (FR-477)", () => {
    expect(hunkStagedState(hunks[1]!)).toBe("none");
    expect(hunkStagedState(hunks[0]!)).toBe("some");
    expect(hunkStagedState(hunk([ctx(), chg("add", true), chg("remove", true)]))).toBe("all");
    expect(hunkStagedState(hunk([ctx()]))).toBe("none");
  });

  it("summarizes a file as mixed only when it has staged AND unstaged changed lines (FR-482)", () => {
    expect(fileStagingSummary(hunks)).toEqual({ anyStaged: true, anyUnstaged: true });
    expect(fileStagingSummary([hunk([chg("add", true)])])).toEqual({ anyStaged: true, anyUnstaged: false });
    expect(fileStagingSummary([hunk([chg("add", false)])])).toEqual({ anyStaged: false, anyUnstaged: true });
  });

  it("withStaged is immutable, ignores context lines, mirrors discardable, and refreshes the hunk state", () => {
    const next = withStaged(hunks, [{ hunkIndex: 0, lineIndex: 2 }, { hunkIndex: 0, lineIndex: 0 }], true);
    expect(next[0]!.lines[2]).toMatchObject({ staged: true, discardable: false });
    expect(next[0]!.lines[0]).toMatchObject({ staged: false });
    expect(next[0]!.stagedState).toBe("all");
    expect(next[1]).toBe(hunks[1]); // untouched hunks keep identity
    expect(hunks[0]!.lines[2]!.staged).toBe(false); // original not mutated
    const back = withStaged(next, [{ hunkIndex: 0, lineIndex: 1 }], false);
    expect(back[0]!.lines[1]).toMatchObject({ staged: false, discardable: true });
  });

  it("rangeBetween is order-independent and inclusive", () => {
    const order = changedRowPositions(hunks);
    const fwd = rangeBetween(order, { hunk: 0, line: 1 }, { hunk: 1, line: 0 });
    expect(fwd).toHaveLength(3);
    expect(rangeBetween(order, { hunk: 1, line: 0 }, { hunk: 0, line: 1 })).toEqual(fwd);
    expect(rangeBetween(order, { hunk: 0, line: 0 }, { hunk: 1, line: 0 })).toEqual([]); // context row is not addressable
  });

  it("discardableRefs keeps only unstaged changed lines (FR-478)", () => {
    const all = hunks.flatMap((h, i) => hunkChangedRefs(h, i));
    expect(discardableRefs(hunks, all)).toEqual([
      { hunkIndex: 0, lineIndex: 2 },
      { hunkIndex: 1, lineIndex: 0 },
    ]);
  });

  it("formats the worktree range of a hunk header for the discard confirmation", () => {
    expect(hunkWorktreeRange("@@ -1,2 +10,5 @@ fn")).toBe("10–14");
    expect(hunkWorktreeRange("@@ -1 +7 @@")).toBe("7");
    expect(hunkWorktreeRange("not a header")).toBeUndefined();
  });
});
