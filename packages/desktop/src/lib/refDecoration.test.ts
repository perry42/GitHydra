import { describe, expect, it } from "vitest";
import type { RefInfo } from "@githydra/git-core";
import { decorateRefsForSha, indexRefsBySha, redecorateRows } from "./refDecoration";
import { makeCommit } from "../test/fixtures";
import { LaneAssigner } from "./laneAssignment";

const mainRef: RefInfo = {
  fullName: "refs/heads/main",
  shortName: "main",
  type: "local-branch",
  targetCommitSha: "c1",
  isAnnotatedTag: false,
  isSymbolic: false,
};

describe("indexRefsBySha / decorateRefsForSha", () => {
  it("groups refs by their target commit sha", () => {
    const map = indexRefsBySha([mainRef]);
    expect(map.get("c1")).toEqual([
      { name: "main", fullName: "refs/heads/main", type: "local-branch", isAnnotatedTag: undefined, isSymbolic: undefined },
    ]);
  });

  it("prepends the synthetic HEAD decoration only for the commit matching headSha", () => {
    const map = indexRefsBySha([mainRef]);
    expect(decorateRefsForSha("c1", map, "c1")).toEqual([
      { name: "HEAD", fullName: null, type: "head" },
      { name: "main", fullName: "refs/heads/main", type: "local-branch", isAnnotatedTag: undefined, isSymbolic: undefined },
    ]);
    expect(decorateRefsForSha("c1", map, "c2")).toEqual([
      { name: "main", fullName: "refs/heads/main", type: "local-branch", isAnnotatedTag: undefined, isSymbolic: undefined },
    ]);
  });

  it("returns no decorations for a sha with neither a matching ref nor HEAD", () => {
    const map = indexRefsBySha([mainRef]);
    expect(decorateRefsForSha("c99", map, "c1")).toEqual([]);
  });
});

// specs/graph-head-indicator-and-refresh-alerting.md Addendum 2, Problem 1a.
describe("redecorateRows", () => {
  function rowFor(sha: string, parents: string[], refsOverride: { name: string; fullName: string | null; type: "head" | "local-branch" }[]) {
    const commit = makeCommit(sha, parents, { refs: refsOverride });
    const assigner = new LaneAssigner();
    return assigner.next(commit);
  }

  it("removes a stale HEAD decoration from a row that is no longer HEAD, and adds it to the row that now is", () => {
    const oldHeadRow = rowFor("c2", ["c1"], [{ name: "HEAD", fullName: null, type: "head" }]);
    const newHeadRow = rowFor("c1", [], []);
    const rows = [oldHeadRow, newHeadRow];

    const next = redecorateRows(rows, [], "c1");

    expect(next).not.toBe(rows); // something changed — a fresh array is returned.
    const nextOldHead = next.find((r) => r.commit.sha === "c2")!;
    const nextNewHead = next.find((r) => r.commit.sha === "c1")!;
    expect(nextOldHead.commit.refs).toEqual([]);
    expect(nextNewHead.commit.refs).toEqual([{ name: "HEAD", fullName: null, type: "head" }]);
  });

  it("leaves rows whose refs didn't actually change untouched, and returns the same array reference when nothing changed at all", () => {
    const row = rowFor("c1", [], [{ name: "HEAD", fullName: null, type: "head" }]);
    const rows = [row];

    const next = redecorateRows(rows, [], "c1");

    expect(next).toBe(rows); // no-op: identical array reference.
    expect(next[0]).toBe(row); // no-op: identical row object reference.
  });

  it("re-decorates only the rows that changed, preserving object identity for the rest", () => {
    const staleHeadRow = rowFor("c2", ["c1"], [{ name: "HEAD", fullName: null, type: "head" }]);
    const untouchedRow = rowFor("c1", [], []);
    const rows = [staleHeadRow, untouchedRow];

    const next = redecorateRows(rows, [], null);

    expect(next).not.toBe(rows);
    expect(next[1]).toBe(untouchedRow); // unaffected row keeps its identity.
    expect(next[0]).not.toBe(staleHeadRow);
    expect(next[0]!.commit.refs).toEqual([]);
  });
});
