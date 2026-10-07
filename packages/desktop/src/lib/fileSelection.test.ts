// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from "vitest";
import type { WorkingDirectoryChanges, WorkingDirectoryFileChange } from "@githydra/git-core";
import {
  EMPTY_SELECTION,
  buildRows,
  eligibility,
  pathSample,
  reconcileSelection,
  rowKey,
  selectOnly,
  selectRange,
  selectSection,
  toBulkRow,
  toDiscardCandidate,
  toggleKey,
  uniquePathCount,
} from "./fileSelection";

const f = (
  path: string,
  category: WorkingDirectoryFileChange["category"],
  status: WorkingDirectoryFileChange["status"] = "modified",
): WorkingDirectoryFileChange => ({ path, category, status });
const changes = (c: Partial<WorkingDirectoryChanges>): WorkingDirectoryChanges => ({
  staged: [],
  unstaged: [],
  untracked: [],
  conflicted: [],
  ...c,
});

describe("buildRows (FR-505)", () => {
  it("orders Staged, Unstaged, Untracked, Conflicted and keys rows by section + path", () => {
    const rows = buildRows(
      changes({
        staged: [f("a", "staged")],
        unstaged: [f("b", "unstaged")],
        untracked: [f("c", "untracked", "added")],
        conflicted: [f("d", "conflicted", "unmerged")],
      }),
      new Set(),
    );
    expect(rows.map((r) => r.key)).toEqual(["staged:a", "unstaged:b", "untracked:c", "conflicted:d"]);
  });

  it("shows a partly staged file as two rows, marked on both only once the verdict says so (FR-482/FR-488)", () => {
    const c = changes({ staged: [f("m", "staged")], unstaged: [f("m", "unstaged")] });
    const marked = buildRows(c, new Set(["m"]));
    expect(marked.map((r) => [r.key, r.mixed, r.partlyStaged])).toEqual([
      ["staged:m", true, true],
      ["unstaged:m", true, true],
    ]);
    // Pending or ineligible verdict: same two rows, no marker, still known to be partly staged.
    expect(buildRows(c, new Set()).map((r) => [r.key, r.mixed, r.partlyStaged])).toEqual([
      ["staged:m", false, true],
      ["unstaged:m", false, true],
    ]);
  });

  it("a fully staged or plain unstaged file is not partly staged", () => {
    const rows = buildRows(changes({ staged: [f("s", "staged")], unstaged: [f("u", "unstaged")] }), new Set(["s", "u"]));
    expect(rows.map((r) => r.partlyStaged)).toEqual([false, false]);
  });

  it("flags an untracked nested repository (trailing slash) as a directory row", () => {
    const rows = buildRows(changes({ untracked: [f("vendor/lib/", "untracked", "added")] }), new Set());
    expect(rows[0]!.isDir).toBe(true);
  });

  it("is empty for a bare repository", () => {
    expect(buildRows(null, new Set())).toEqual([]);
  });
});

describe("selection transitions", () => {
  const rows = buildRows(
    changes({
      staged: [f("s1", "staged"), f("s2", "staged")],
      unstaged: [f("u1", "unstaged"), f("u2", "unstaged"), f("u3", "unstaged")],
      untracked: [f("t1", "untracked", "added")],
    }),
    new Set(),
  );

  it("toggle adds and removes a key and moves the anchor", () => {
    const a = toggleKey(selectOnly("staged:s1"), "unstaged:u2");
    expect([...a.keys].sort()).toEqual(["staged:s1", "unstaged:u2"]);
    expect(a.anchor).toBe("unstaged:u2");
    expect(toggleKey(a, "unstaged:u2").keys.has("unstaged:u2")).toBe(false);
  });

  it("a range spans sections from the anchor and keeps the anchor (D4)", () => {
    const r = selectRange(selectOnly("staged:s2"), rows, "unstaged:u2", false);
    expect([...r.keys]).toEqual(["staged:s2", "unstaged:u1", "unstaged:u2"]);
    expect(r.anchor).toBe("staged:s2");
    // Shrinking back replaces, not accumulates.
    expect([...selectRange(r, rows, "unstaged:u1", false).keys]).toEqual(["staged:s2", "unstaged:u1"]);
  });

  it("a range works upward and can be additive (Ctrl+Shift)", () => {
    const r = selectRange(selectOnly("untracked:t1"), rows, "unstaged:u3", false);
    expect([...r.keys].sort()).toEqual(["unstaged:u3", "untracked:t1"]);
    const add = selectRange({ keys: new Set(["staged:s1"]), anchor: "unstaged:u1" }, rows, "unstaged:u3", true);
    expect([...add.keys].sort()).toEqual(["staged:s1", "unstaged:u1", "unstaged:u2", "unstaged:u3"]);
  });

  it("with no anchor, a range starts from the fallback origin", () => {
    const r = selectRange(EMPTY_SELECTION, rows, "unstaged:u2", false, "staged:s2");
    expect([...r.keys]).toEqual(["staged:s2", "unstaged:u1", "unstaged:u2"]);
  });

  it("Ctrl+A selects only the focused row's section", () => {
    expect([...selectSection(rows, "unstaged").keys]).toEqual(["unstaged:u1", "unstaged:u2", "unstaged:u3"]);
  });
});

describe("reconcileSelection (FR-511)", () => {
  it("keeps selection when a path moves to another section and drops a vanished path silently", () => {
    const before = { keys: new Set(["unstaged:a", "unstaged:b", "unstaged:c"]), anchor: "unstaged:a" };
    const rows = buildRows(changes({ staged: [f("a", "staged")], unstaged: [f("c", "unstaged")] }), new Set());
    const after = reconcileSelection(before, rows);
    expect([...after.keys].sort()).toEqual(["staged:a", "unstaged:c"]);
    expect(after.anchor).toBe("staged:a");
  });

  it("prefers the same-section key of a partly staged path, else moves to its other row (FR-482)", () => {
    const both = buildRows(changes({ staged: [f("m", "staged")], unstaged: [f("m", "unstaged")] }), new Set(["m"]));
    const sel = selectOnly("staged:m");
    expect(reconcileSelection(sel, both)).toBe(sel);
    const onlyUnstaged = buildRows(changes({ unstaged: [f("m", "unstaged")] }), new Set());
    const moved = reconcileSelection(sel, onlyUnstaged);
    expect([...moved.keys]).toEqual(["unstaged:m"]);
    // Both rows selected and one vanishes: the selection collapses onto the survivor, counted once.
    const both2 = reconcileSelection({ keys: new Set(["staged:m", "unstaged:m"]), anchor: "staged:m" }, onlyUnstaged);
    expect([...both2.keys]).toEqual(["unstaged:m"]);
  });

  it("returns the same object when nothing changed", () => {
    const rows = buildRows(changes({ unstaged: [f("a", "unstaged")] }), new Set());
    const sel = selectOnly(rowKey("unstaged", "a"));
    expect(reconcileSelection(sel, rows)).toBe(sel);
  });
});

describe("eligibility (FR-506)", () => {
  const rows = buildRows(
    changes({
      staged: [f("s", "staged"), f("m", "staged")],
      unstaged: [f("u", "unstaged"), f("m", "unstaged")],
      untracked: [f("t", "untracked", "added"), f("nested/", "untracked", "added")],
      conflicted: [f("c", "conflicted", "unmerged")],
    }),
    new Set(["m"]),
  );
  const named = (names: string[]) => rows.filter((r) => names.includes(r.path));

  it("stage: Unstaged and Untracked rows; skips Staged and conflicted; a partly staged path is not 'skipped' for its Staged row", () => {
    const e = eligibility("stage", rows);
    expect(e.eligible.map((r) => r.path).sort()).toEqual(["m", "nested/", "t", "u"]);
    expect(e.eligible.find((r) => r.path === "m")!.section).toBe("unstaged");
    expect(e.skipped.map((s) => s.row.path).sort()).toEqual(["c", "s"]);
  });

  it("unstage: Staged rows only; the Unstaged row of a partly staged file has no Unstage", () => {
    const e = eligibility("unstage", rows);
    expect(e.eligible.map((r) => r.path).sort()).toEqual(["m", "s"]);
    expect(e.eligible.find((r) => r.path === "m")!.section).toBe("staged");
    expect(e.skipped.map((s) => s.row.path).sort()).toEqual(["c", "nested/", "t", "u"]);
  });

  it("discard: Unstaged and Untracked rows; never a Staged row (even of a partly staged file), directories or conflicted", () => {
    const e = eligibility("discard", rows);
    expect(e.eligible.find((r) => r.path === "m")!.section).toBe("unstaged");
    expect(e.eligible.map((r) => r.path).sort()).toEqual(["m", "t", "u"]);
    expect(e.skipped.find((s) => s.row.path === "nested/")!.reason).toMatch(/directories/i);
    expect(e.skipped.find((s) => s.row.path === "s")!.reason).toMatch(/unstage first/i);
  });

  it("counts a partly staged file once however many of its rows are selected (FR-482)", () => {
    const both = named(["m"]);
    expect(both).toHaveLength(2);
    expect(uniquePathCount(both)).toBe(1);
    expect(eligibility("ignore", both).eligible).toHaveLength(1);
    expect(eligibility("discard", both)).toMatchObject({ eligible: [{ section: "unstaged" }], skipped: [] });
    expect(eligibility("unstage", both)).toMatchObject({ eligible: [{ section: "staged" }], skipped: [] });
    expect(eligibility("stage", both)).toMatchObject({ eligible: [{ section: "unstaged" }], skipped: [] });
  });

  it("ignore: everything except conflicted rows (directory rows allowed)", () => {
    const e = eligibility("ignore", rows);
    expect(e.eligible.map((r) => r.path).sort()).toEqual(["m", "nested/", "s", "t", "u"]);
    expect(e.skipped.map((s) => s.row.path)).toEqual(["c"]);
    expect(e.skipped[0]!.reason).toMatch(/conflict/i);
  });

  it("maps rows to the git-core shapes: the Unstaged row of a partly staged file stages/discards as mixed, its Staged row unstages through the index-only staged section", () => {
    const stagedRow = named(["m"]).find((r) => r.section === "staged")!;
    const unstagedRow = named(["m"]).find((r) => r.section === "unstaged")!;
    expect(toBulkRow(unstagedRow, "stage")).toEqual({ path: "m", section: "mixed" });
    expect(toBulkRow(stagedRow, "unstage")).toEqual({ path: "m", section: "staged" });
    expect(toDiscardCandidate(unstagedRow)).toEqual({ path: "m", section: "mixed" });
    expect(toDiscardCandidate(named(["t"])[0]!)).toEqual({ path: "t", section: "untracked" });
    expect(toDiscardCandidate(named(["u"])[0]!)).toEqual({ path: "u", section: "unstaged" });
  });
});

describe("pathSample", () => {
  it("caps the list and counts the rest", () => {
    const paths = Array.from({ length: 12 }, (_, i) => `p${i}`);
    expect(pathSample(paths)).toEqual({ shown: paths.slice(0, 8), more: 4 });
    expect(pathSample(paths.slice(0, 3))).toEqual({ shown: paths.slice(0, 3), more: 0 });
  });
});
