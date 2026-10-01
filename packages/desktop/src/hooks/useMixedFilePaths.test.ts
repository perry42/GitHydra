// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import type { CombinedDiffHunk, WorkingDirectoryChanges, WorkingDirectoryFileChange } from "@githydra/git-core";
import { makeMockGitHydra } from "../test/mockGitHydra";
import { mixedCandidatePaths, useMixedFilePaths } from "./useMixedFilePaths";

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

  it("is empty when either list is empty or the repo is bare", () => {
    expect(mixedCandidatePaths(null)).toEqual([]);
    expect(mixedCandidatePaths(changes([entry("a", "staged")], []))).toEqual([]);
  });

  it("caps the candidates so hundreds of partly staged files never fan out into hundreds of reads", () => {
    const names = Array.from({ length: 300 }, (_, i) => `f${i}`);
    const c = changes(names.map((n) => entry(n, "staged")), names.map((n) => entry(n, "unstaged")));
    expect(mixedCandidatePaths(c)).toHaveLength(100);
  });
});

describe("useMixedFilePaths", () => {
  it("queries only candidates, reports the ones whose combined diff is genuinely mixed, and skips the known path", async () => {
    const api = makeMockGitHydra();
    vi.mocked(api.getCombinedFileDiff).mockImplementation(async (path) => {
      if (path === "mixed.ts") return { ok: true, data: { mode: "combined", fingerprint: "f", hunks: hunksWith([true, false]) } };
      if (path === "inelig.ts") return { ok: true, data: { mode: "separate", reason: "renamed" } };
      return { ok: true, data: { mode: "combined", fingerprint: "f", hunks: hunksWith([true, true]) } };
    });
    const c = changes(
      [entry("mixed.ts", "staged"), entry("inelig.ts", "staged"), entry("full.ts", "staged"), entry("open.ts", "staged"), entry("only-staged.ts", "staged")],
      [entry("mixed.ts", "unstaged"), entry("inelig.ts", "unstaged"), entry("full.ts", "unstaged"), entry("open.ts", "unstaged")],
    );
    const { result } = renderHook(() => useMixedFilePaths(api, c, { path: "open.ts", mixed: true }));
    // open.ts is decided by the diff already on screen, before (and without) any query.
    expect(result.current.has("open.ts")).toBe(true);
    await waitFor(() => expect(result.current.has("mixed.ts")).toBe(true));
    expect([...result.current].sort()).toEqual(["mixed.ts", "open.ts"]);
    const asked = vi.mocked(api.getCombinedFileDiff).mock.calls.map((x) => x[0]).sort();
    expect(asked).toEqual(["full.ts", "inelig.ts", "mixed.ts"]);
  });

  it("leaves a file in both sections (not mixed) when its read fails", async () => {
    const api = makeMockGitHydra();
    vi.mocked(api.getCombinedFileDiff).mockResolvedValue({ ok: false, error: { name: "GitCommandError", message: "x" } });
    const c = changes([entry("a", "staged")], [entry("a", "unstaged")]);
    const { result } = renderHook(() => useMixedFilePaths(api, c, null));
    await waitFor(() => expect(api.getCombinedFileDiff).toHaveBeenCalled());
    expect(result.current.size).toBe(0);
  });

  it("limits concurrent reads", async () => {
    const api = makeMockGitHydra();
    let live = 0;
    let peak = 0;
    vi.mocked(api.getCombinedFileDiff).mockImplementation(async () => {
      live++;
      peak = Math.max(peak, live);
      await new Promise((r) => setTimeout(r, 5));
      live--;
      return { ok: true, data: { mode: "separate", reason: "binary" } };
    });
    const names = Array.from({ length: 20 }, (_, i) => `f${i}`);
    const c = changes(names.map((n) => entry(n, "staged")), names.map((n) => entry(n, "unstaged")));
    renderHook(() => useMixedFilePaths(api, c, null));
    await waitFor(() => expect(api.getCombinedFileDiff).toHaveBeenCalledTimes(20));
    expect(peak).toBeLessThanOrEqual(4);
  });

  it("keeps a cached verdict across a refresh (no flicker) and drops it once the path leaves both lists", async () => {
    const api = makeMockGitHydra();
    vi.mocked(api.getCombinedFileDiff).mockResolvedValue({
      ok: true,
      data: { mode: "combined", fingerprint: "f", hunks: hunksWith([true, false]) },
    });
    const first = changes([entry("a", "staged")], [entry("a", "unstaged")]);
    const { result, rerender } = renderHook(({ c }) => useMixedFilePaths(api, c, null), { initialProps: { c: first } });
    await waitFor(() => expect(result.current.has("a")).toBe(true));
    rerender({ c: changes([entry("a", "staged")], [entry("a", "unstaged")]) }); // a refresh: new object, same files
    expect(result.current.has("a")).toBe(true);
    rerender({ c: changes([], [entry("a", "unstaged")]) });
    expect(result.current.has("a")).toBe(false);
  });
});
