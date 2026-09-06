// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { sortShasInGraphOrder } from "./cherryPickOrder";
import { makeCommit, makeDisplayRows } from "../test/fixtures";

describe("sortShasInGraphOrder (specs/cherry-pick.md FR-114)", () => {
  it("sorts a multi-commit selection into oldest-first graph order regardless of click order (AC2)", () => {
    // Newest-first graph order, matching CommitGraph's own convention: c3 (newest) -> c2 -> c1 (oldest).
    const rows = makeDisplayRows([
      makeCommit("c3", ["c2"]),
      makeCommit("c2", ["c1"]),
      makeCommit("c1", []),
    ]);
    // Clicked in an arbitrary order: c1 first, then c3, then c2.
    expect(sortShasInGraphOrder(["c1", "c3", "c2"], rows)).toEqual(["c1", "c2", "c3"]);
  });

  it("is a no-op for an already-sorted single-commit selection", () => {
    const rows = makeDisplayRows([makeCommit("c2", ["c1"]), makeCommit("c1", [])]);
    expect(sortShasInGraphOrder(["c1"], rows)).toEqual(["c1"]);
  });

  it("defensively sorts an unresolvable sha after every resolvable one, without throwing", () => {
    const rows = makeDisplayRows([makeCommit("c2", ["c1"]), makeCommit("c1", [])]);
    expect(sortShasInGraphOrder(["ghost", "c2", "c1"], rows)).toEqual(["c1", "c2", "ghost"]);
  });
});
