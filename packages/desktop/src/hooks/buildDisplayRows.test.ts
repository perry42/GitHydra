// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { buildDisplayRows } from "./useRepositoryGraph";
import { layOut, makeCommit } from "../test/fixtures";

const status = { hasChanges: true, staged: 0, unstaged: 1, untracked: 0, conflicted: 0 };

// main merge M above feature tip F: M(parents A,F) -> F -> A, so HEAD (F) is not the first row.
const merged = layOut([
  makeCommit("M", ["A", "F"]),
  makeCommit("F", ["A"]),
  makeCommit("A", []),
]);

describe("buildDisplayRows WIP connector", () => {
  it("HEAD at row 0 points at display index 1", () => {
    const rows = buildDisplayRows(layOut([makeCommit("A", ["B"]), makeCommit("B", [])]), status, "A");
    expect(rows[0]).toMatchObject({ kind: "uncommitted", headRowIndex: 1 });
  });

  it("HEAD below a merge on main keeps HEAD's lane and its true row index", () => {
    const rows = buildDisplayRows(merged, status, "F");
    const wip = rows[0]!;
    expect(wip.kind).toBe("uncommitted");
    if (wip.kind !== "uncommitted") return;
    expect(wip.headRowIndex).toBe(2);
    expect(wip.lane).toBe(merged[1]!.lane);
    expect(wip.lane).not.toBe(merged[0]!.lane);
  });

  it("detached HEAD on a loaded commit behaves the same", () => {
    const rows = buildDisplayRows(merged, status, "A");
    expect(rows[0]).toMatchObject({ kind: "uncommitted", headRowIndex: 3 });
  });

  it("HEAD not loaded yet gives a null index (line runs off the loaded slice)", () => {
    expect(buildDisplayRows(merged, status, "zzz")[0]).toMatchObject({ kind: "uncommitted", headRowIndex: null, lane: 0 });
  });

  it("unborn HEAD yields no WIP row; no changes yields no WIP row", () => {
    expect(buildDisplayRows([], status, null)).toEqual([]);
    expect(buildDisplayRows(merged, { ...status, hasChanges: false }, "F")).toHaveLength(3);
  });
});
