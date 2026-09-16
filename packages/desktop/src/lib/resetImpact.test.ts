// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { describeResetHardDangerCounts, describeResetImpact } from "./resetImpact";

describe("describeResetImpact (specs/reset-to-here.md FR-368)", () => {
  it("'same': target is exactly the current HEAD commit", () => {
    const impact = describeResetImpact("same", null, "main");
    expect(impact).toEqual({ text: "No commits are being undone — main is already here.", critical: false });
  });

  it("'a-ancestor-of-b' (target is an ancestor of HEAD, the common backward case) — count shown, singular/plural correct", () => {
    expect(describeResetImpact("a-ancestor-of-b", 1, "main").text).toBe("1 commit will no longer be on main.");
    expect(describeResetImpact("a-ancestor-of-b", 3, "main").text).toBe("3 commits will no longer be on main.");
    expect(describeResetImpact("a-ancestor-of-b", 3, "main").critical).toBe(false);
  });

  it("'a-ancestor-of-b' falls back to non-numeric wording when the count read failed (null)", () => {
    expect(describeResetImpact("a-ancestor-of-b", null, "main").text).toBe("Some commits will no longer be on main.");
  });

  it("'b-ancestor-of-a' (HEAD is an ancestor of target, the forward case) — never shows a count, even when one is given", () => {
    expect(describeResetImpact("b-ancestor-of-a", 5, "main").text).toBe(
      "No commits will be lost — main moves forward, nothing is undone.",
    );
    expect(describeResetImpact("b-ancestor-of-a", null, "main").text).toBe(
      "No commits will be lost — main moves forward, nothing is undone.",
    );
  });

  it("'diverged' (real shared history) — names the branch-unique count", () => {
    expect(describeResetImpact("diverged", 2, "feature").text).toBe(
      "feature will move to a divergent commit. 2 commits currently unique to feature will no longer be reachable from it.",
    );
    expect(describeResetImpact("diverged", null, "feature").text).toBe(
      "feature will move to a divergent commit. Some commits currently unique to feature will no longer be reachable from it.",
    );
  });

  it("'no-common-ancestor' — critical emphasis, names the branch's full commit count", () => {
    const impact = describeResetImpact("no-common-ancestor", 7, "main");
    expect(impact.text).toBe(
      "This commit shares no history with main. All 7 of main's current commits will no longer be reachable from it.",
    );
    expect(impact.critical).toBe(true);
  });

  it("'no-common-ancestor' falls back to non-numeric wording when the count read failed (null), still critical", () => {
    const impact = describeResetImpact("no-common-ancestor", null, "main");
    expect(impact.text).toBe(
      "This commit shares no history with main. All of main's current commits will no longer be reachable from it.",
    );
    expect(impact.critical).toBe(true);
  });

  it("substitutes 'HEAD' cleanly for a detached session's branchLabel throughout", () => {
    expect(describeResetImpact("same", null, "HEAD").text).toBe("No commits are being undone — HEAD is already here.");
    expect(describeResetImpact("a-ancestor-of-b", 2, "HEAD").text).toBe("2 commits will no longer be on HEAD.");
  });
});

describe("describeResetHardDangerCounts (specs/reset-to-here.md FR-369)", () => {
  it("returns null (no callout) when the working tree is entirely clean", () => {
    expect(describeResetHardDangerCounts(0, 0, 0)).toBeNull();
  });

  it("names staged and unstaged together, matching the spec's own worked example", () => {
    expect(describeResetHardDangerCounts(3, 2, 0)).toBe("3 staged and 2 unstaged changes will be permanently discarded.");
  });

  it("names a single non-zero category alone, with correct singular/plural", () => {
    expect(describeResetHardDangerCounts(1, 0, 0)).toBe("1 staged change will be permanently discarded.");
    expect(describeResetHardDangerCounts(0, 2, 0)).toBe("2 unstaged changes will be permanently discarded.");
  });

  it("names all three categories, including conflicted files left over from a stash-apply conflict with no in-progress operation", () => {
    expect(describeResetHardDangerCounts(1, 2, 3)).toBe(
      "1 staged, 2 unstaged, and 3 conflicted changes will be permanently discarded.",
    );
  });
});
