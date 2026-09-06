// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { useStashDiff } from "./useStashDiff";
import { makeMockGitHydra } from "../test/mockGitHydra";

const okDiff: import("@githydra/git-core").FileDiffResult = {
  status: "ok",
  isBinary: false,
  hunks: [
    {
      header: "@@ -1 +1 @@",
      oldStart: 1,
      oldLines: 1,
      newStart: 1,
      newLines: 1,
      lines: [{ type: "add" as const, content: "x", oldLineNumber: null, newLineNumber: 1 }],
    },
  ],
};

describe("useStashDiff", () => {
  it("is idle when index is null", () => {
    const api = makeMockGitHydra();
    const { result } = renderHook(() => useStashDiff(api, null));
    expect(result.current.status).toBe("idle");
    expect(result.current.files).toEqual([]);
  });

  it("FR-83/FR-95: fetches the stash's full diff and auto-selects the first file", async () => {
    const api = makeMockGitHydra({
      stashDiffs: {
        0: {
          files: [
            { path: "a.ts", status: "modified", isUntracked: false, diff: okDiff },
            { path: "b.ts", status: "added", isUntracked: true, diff: okDiff },
          ],
        },
      },
    });
    const { result } = renderHook(() => useStashDiff(api, 0));
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.files.map((f) => f.path)).toEqual(["a.ts", "b.ts"]);
    expect(result.current.selectedPath).toBe("a.ts");
  });

  it("selectFile switches which file's diff is shown", async () => {
    const api = makeMockGitHydra({
      stashDiffs: {
        0: {
          files: [
            { path: "a.ts", status: "modified", isUntracked: false, diff: okDiff },
            { path: "b.ts", status: "added", isUntracked: true, diff: okDiff },
          ],
        },
      },
    });
    const { result } = renderHook(() => useStashDiff(api, 0));
    await waitFor(() => expect(result.current.status).toBe("ready"));

    result.current.selectFile("b.ts");
    await waitFor(() => expect(result.current.selectedPath).toBe("b.ts"));
  });

  it("re-fetches when the selected index changes", async () => {
    const api = makeMockGitHydra({
      stashDiffs: {
        0: { files: [{ path: "a.ts", status: "modified", isUntracked: false, diff: okDiff }] },
        1: { files: [{ path: "b.ts", status: "added", isUntracked: false, diff: okDiff }] },
      },
    });
    const { result, rerender } = renderHook(({ index }) => useStashDiff(api, index), { initialProps: { index: 0 } });
    await waitFor(() => expect(result.current.selectedPath).toBe("a.ts"));

    rerender({ index: 1 });
    await waitFor(() => expect(result.current.selectedPath).toBe("b.ts"));
  });
});
