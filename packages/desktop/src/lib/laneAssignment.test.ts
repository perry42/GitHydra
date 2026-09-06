// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from "vitest";
import type { CommitInfo } from "@githydra/git-core";
import { assignLanes } from "./laneAssignment";

function commit(sha: string, parents: string[], overrides: Partial<CommitInfo> = {}): CommitInfo {
  return {
    sha,
    abbrevSha: sha.slice(0, 7),
    parents,
    authorName: "Author",
    authorEmail: "author@example.com",
    authorDate: "2024-01-01T00:00:00+00:00",
    committerName: "Author",
    committerEmail: "author@example.com",
    committerDate: "2024-01-01T00:00:00+00:00",
    subject: `commit ${sha}`,
    body: "",
    message: `commit ${sha}`,
    refs: [],
    isHistoryBoundary: false,
    ...overrides,
  };
}

describe("assignLanes", () => {
  it("keeps a linear history in a single lane", () => {
    const commits = [commit("c3", ["c2"]), commit("c2", ["c1"]), commit("c1", [])];
    const rows = assignLanes(commits);
    expect(rows.map((r) => r.lane)).toEqual([0, 0, 0]);
    expect(rows[2]!.isRoot).toBe(true);
    expect(rows[0]!.isMerge).toBe(false);
  });

  it("gives a diverging branch its own lane and merges it back with no crossed labeling", () => {
    // main:    M (merge, parents [F2, B1]) -> F2 -> Base
    // feature:                  B1 -> Base
    const commits = [
      commit("M", ["F2", "B1"]),
      commit("F2", ["Base"]),
      commit("B1", ["Base"]),
      commit("Base", []),
    ];
    const rows = assignLanes(commits);
    const [mRow, f2Row, b1Row, baseRow] = rows;

    expect(mRow!.isMerge).toBe(true);
    expect(mRow!.isOctopus).toBe(false);
    expect(mRow!.lane).toBe(0);
    // The merge commit spawns a second lane for its second parent (B1).
    expect(f2Row!.lane).toBe(0);
    expect(b1Row!.lane).toBe(1);
    expect(b1Row!.colorSlot).toBe(1);
    // Both parents' lanes converge back onto Base's single lane.
    expect(baseRow!.lane).toBe(0);
    expect(baseRow!.isRoot).toBe(true);
    // Lane 1 should show as terminating (above=true, below=false) at Base's row.
    const lane1AtBase = baseRow!.lanes.find((l) => l.lane === 1);
    expect(lane1AtBase).toMatchObject({ above: true, below: false });
  });

  it("assigns octopus merges (3+ parents) without crashing and flags isOctopus", () => {
    const commits = [
      commit("Oct", ["A", "B", "C"]),
      commit("A", []),
      commit("B", []),
      commit("C", []),
    ];
    const rows = assignLanes(commits);
    expect(rows[0]!.isOctopus).toBe(true);
    expect(rows[0]!.isMerge).toBe(true);
    // Three distinct lanes: primary + two spawned for the extra parents.
    const lanesUsed = new Set(rows.slice(1).map((r) => r.lane));
    expect(lanesUsed.size).toBe(3);
  });

  it("renders an orphan branch as a separate root without merging into unrelated history", () => {
    const commits = [
      commit("main-2", ["main-1"]),
      commit("orphan-1", []), // unrelated root, shares no ancestor with main-*
      commit("main-1", []),
    ];
    const rows = assignLanes(commits);
    const orphanRow = rows.find((r) => r.commit.sha === "orphan-1")!;
    const main1Row = rows.find((r) => r.commit.sha === "main-1")!;
    expect(orphanRow.isRoot).toBe(true);
    expect(main1Row.isRoot).toBe(true);
    // Distinct lanes: no shared ancestry, so they must never share a lane slot at the same time.
    expect(orphanRow.lane).not.toBe(rows[0]!.lane);
  });

  it("treats a shallow/grafted history-boundary commit as a boundary, not a true root", () => {
    const commits = [commit("tip", ["truncated"]), commit("truncated", [], { isHistoryBoundary: true })];
    const rows = assignLanes(commits);
    const boundaryRow = rows.find((r) => r.commit.sha === "truncated")!;
    expect(boundaryRow.isRoot).toBe(false);
    expect(boundaryRow.commit.isHistoryBoundary).toBe(true);
  });

  it("reuses a freed lane slot only on the next row, never colliding within the same row", () => {
    // Merge frees lane 1 (B1 converges into lane 0 at Base) in the same row that Base itself
    // could theoretically want a new lane for another parent — verify no same-row aliasing bug.
    const commits = [
      commit("M", ["F2", "B1"]),
      commit("F2", ["Base"]),
      commit("B1", ["Base"]),
      commit("Base", ["Root", "Other"]), // Base is itself a merge, right where lane 1 frees up
      commit("Root", []),
      commit("Other", []),
    ];
    const rows = assignLanes(commits);
    const baseRow = rows.find((r) => r.commit.sha === "Base")!;
    // Base's own lane must still be 0 (mainline), and its newly spawned parent lane must not be
    // lane 1 in a way that corrupts lane 1's already-terminating segment in this same row.
    expect(baseRow.lane).toBe(0);
    const lane1Segment = baseRow.lanes.find((l) => l.lane === 1);
    expect(lane1Segment).toMatchObject({ above: true, below: false });
  });

  it("colors lanes from the fixed 8-hue palette and recycles past 8 concurrent lanes", () => {
    // 9 branch tips that all share one not-yet-emitted parent are genuinely concurrent (all 9
    // lanes stay open simultaneously, each still waiting on "shared-root") — unlike 9 sequential
    // single-commit roots, which correctly pack into lane 0 one after another since none of them
    // overlap. This is what should force a 9th on-screen lane and recycle back to palette slot 0.
    const commits = Array.from({ length: 9 }, (_, i) => commit(`tip-${i}`, ["shared-root"]));
    const rows = assignLanes(commits);
    expect(rows.map((r) => r.lane)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    expect(rows[8]!.colorSlot).toBe(0);
    expect(rows[0]!.colorSlot).toBe(0);
  });
});
