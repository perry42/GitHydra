// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import type { CombinedDiffHunk, WorkingDirectoryChanges, WorkingDirectoryFileChange } from "@githydra/git-core";
import { makeMockGitHydra } from "../test/mockGitHydra";
import { MAX_MIXED_CANDIDATES_PER_PASS, mixedCandidatePaths, useMixedFilePaths } from "./useMixedFilePaths";

// specs/hunk-line-staging.md FR-482: only paths in BOTH lists can be mixed, and only git-core can say if they are eligible.
const entry = (path: string, category: "staged" | "unstaged", status: WorkingDirectoryFileChange["status"] = "modified"): WorkingDirectoryFileChange => ({
  path,
  status,
  category,
});

const changes = (staged: WorkingDirectoryFileChange[], unstaged: WorkingDirectoryFileChange[]): WorkingDirectoryChanges => ({
  staged,
  unstaged,
  untracked: [],
  conflicted: [],
});

const hunksWith = (staged: boolean[]): CombinedDiffHunk[] => [
  {
    header: "@@ -1 +1 @@",
    oldStart: 1,
    oldLines: 1,
    newStart: 1,
    newLines: 1,
    stagedState: "some",
    lines: staged.map((s) => ({ type: "add" as const, content: "x", oldLineNumber: null, newLineNumber: 1, staged: s, discardable: !s })),
  },
];

describe("mixedCandidatePaths", () => {
  it("is only the modified paths present in both Staged and Unstaged", () => {
    const c = changes(
      [entry("a", "staged"), entry("b", "staged"), entry("c", "staged", "added")],
      [entry("a", "unstaged"), entry("c", "unstaged"), entry("d", "unstaged")],
    );
    expect(mixedCandidatePaths(c)).toEqual(["a"]);
  });

  it("lists candidates in Unstaged order so the top rows are judged first", () => {
    const c = changes([entry("a", "staged"), entry("b", "staged")], [entry("b", "unstaged"), entry("a", "unstaged")]);
    expect(mixedCandidatePaths(c)).toEqual(["b", "a"]);
  });

  it("is empty when either list is empty or the repo is bare", () => {
    expect(mixedCandidatePaths(null)).toEqual([]);
    expect(mixedCandidatePaths(changes([entry("a", "staged")], []))).toEqual([]);
  });
})

const W = { timeout: 4000 };
const sep = { ok: true, data: { mode: "separate", reason: "renamed" } } as const;
const mixedRes = { ok: true, data: { mode: "combined", fingerprint: "f", hunks: hunksWith([true, false]) } } as const;

describe("useMixedFilePaths", () => {
  it("marks nothing before a verdict: no marker flashes on a file that may turn out ineligible, and the verdict never adds or removes rows (FR-482)", () => {
    const api = makeMockGitHydra();
    const c = changes([entry("a", "staged"), entry("b", "staged")], [entry("a", "unstaged"), entry("b", "unstaged")]);
    const { result } = renderHook(() => useMixedFilePaths(api, c, null));
    expect([...result.current]).toEqual([]);
    expect(api.getCombinedFileDiff).not.toHaveBeenCalled();
  });

  it("adds the marker only for a file whose verdict is combined and genuinely partly staged; separate, fully staged or unreadable files never get one", async () => {
    const api = makeMockGitHydra();
    vi.mocked(api.getCombinedFileDiff).mockImplementation(async (path) => {
      if (path === "mixed.ts") return mixedRes;
      if (path === "inelig.ts") return sep;
      if (path === "full.ts") return { ok: true, data: { mode: "combined", fingerprint: "f", hunks: hunksWith([true, true]) } };
      return { ok: false, error: { name: "GitCommandError", message: "x" } };
    });
    const names = ["mixed.ts", "inelig.ts", "full.ts", "bad.ts", "open.ts"];
    const c = changes(names.map((n) => entry(n, "staged")), names.map((n) => entry(n, "unstaged")));
    const { result } = renderHook(() => useMixedFilePaths(api, c, { path: "open.ts", mixed: true }));
    await waitFor(() => expect([...result.current].sort()).toEqual(["mixed.ts", "open.ts"]), W);
    const asked = vi.mocked(api.getCombinedFileDiff).mock.calls.map((x) => x[0]).sort();
    expect(asked).toEqual(["bad.ts", "full.ts", "inelig.ts", "mixed.ts"]); // the open file is never queried
  });

  it("limits concurrent reads and the reads per pass, but chains passes until every file has a verdict", async () => {
    const api = makeMockGitHydra();
    let live = 0;
    let peak = 0;
    vi.mocked(api.getCombinedFileDiff).mockImplementation(async () => {
      live++;
      peak = Math.max(peak, live);
      await new Promise((r) => setTimeout(r, 2));
      live--;
      return sep;
    });
    const n = MAX_MIXED_CANDIDATES_PER_PASS + 10;
    const names = Array.from({ length: n }, (_, i) => `f${i}`);
    const c = changes(names.map((x) => entry(x, "staged")), names.map((x) => entry(x, "unstaged")));
    const { result } = renderHook(() => useMixedFilePaths(api, c, null));
    await waitFor(() => expect(api.getCombinedFileDiff).toHaveBeenCalledTimes(n), W);
    await waitFor(() => expect(result.current.size).toBe(0), W);
    expect(peak).toBeLessThanOrEqual(4);
  });

  it("debounces: rapid refreshes with a changing file set start one pass, not one per refresh", async () => {
    const api = makeMockGitHydra();
    vi.mocked(api.getCombinedFileDiff).mockResolvedValue(mixedRes);
    const mk = (n: number) => {
      const names = Array.from({ length: n }, (_, i) => `f${i}`);
      return changes(names.map((x) => entry(x, "staged")), names.map((x) => entry(x, "unstaged")));
    };
    const { rerender } = renderHook(({ c }) => useMixedFilePaths(api, c, null), { initialProps: { c: mk(2) } });
    rerender({ c: mk(3) });
    rerender({ c: mk(4) });
    await waitFor(() => expect(api.getCombinedFileDiff).toHaveBeenCalledTimes(4), W);
    await new Promise((r) => setTimeout(r, 600));
    expect(api.getCombinedFileDiff).toHaveBeenCalledTimes(4); // each path read exactly once
  });

  it("a stale pass stops spending reads once superseded or unmounted", async () => {
    const api = makeMockGitHydra();
    const gate: Array<() => void> = [];
    vi.mocked(api.getCombinedFileDiff).mockImplementation(
      () => new Promise((res) => gate.push(() => res(mixedRes))),
    );
    const names = Array.from({ length: 30 }, (_, i) => `f${i}`);
    const c = changes(names.map((x) => entry(x, "staged")), names.map((x) => entry(x, "unstaged")));
    const { unmount } = renderHook(() => useMixedFilePaths(api, c, null));
    await waitFor(() => expect(gate.length).toBe(3), W); // concurrency 3, all blocked
    unmount();
    gate.splice(0).forEach((g) => g());
    await new Promise((r) => setTimeout(r, 50));
    expect(api.getCombinedFileDiff).toHaveBeenCalledTimes(3); // workers did not pick up the next paths
  });

  it("reuses a cached verdict across a refresh with an unchanged file state and drops it once the path leaves both lists", async () => {
    const api = makeMockGitHydra();
    vi.mocked(api.getCombinedFileDiff).mockResolvedValue(sep);
    const mk = () => changes([entry("a", "staged")], [entry("a", "unstaged")]);
    const { result, rerender } = renderHook(({ c }) => useMixedFilePaths(api, c, null), { initialProps: { c: mk() } });
    await waitFor(() => expect(api.getCombinedFileDiff).toHaveBeenCalledTimes(1), W);
    rerender({ c: mk() });
    await new Promise((r) => setTimeout(r, 600));
    expect(result.current.has("a")).toBe(false);
    expect(api.getCombinedFileDiff).toHaveBeenCalledTimes(1);
    rerender({ c: changes([], [entry("a", "unstaged")]) });
    expect(result.current.has("a")).toBe(false);
  });
});
