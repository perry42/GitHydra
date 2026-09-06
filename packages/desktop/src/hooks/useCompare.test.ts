// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { useCompareDetail } from "./useCompare";
import { makeCommit } from "../test/fixtures";
import { makeMockGitHydra } from "../test/mockGitHydra";

describe("useCompareDetail (specs/compare-commits.md)", () => {
  it("resolves both commits' summaries and the changed-file list", async () => {
    const api = makeMockGitHydra({
      commits: [makeCommit("t1", ["b1"]), makeCommit("b1", [])],
      compareChangedFiles: [{ path: "a.ts", status: "modified" }],
    });
    const { result } = renderHook(() => useCompareDetail(api, { baseSha: "b1", targetSha: "t1" }));

    expect(result.current.status).toBe("loading");
    await waitFor(() => expect(result.current.status).toBe("ready"));
    if (result.current.status !== "ready") throw new Error("expected ready");
    expect(result.current.base.sha).toBe("b1");
    expect(result.current.target.sha).toBe("t1");
    expect(result.current.files).toEqual([{ path: "a.ts", status: "modified" }]);
  });

  it("surfaces an error state when either commit can't be found", async () => {
    const api = makeMockGitHydra({ commits: [makeCommit("t1", ["b1"])] });
    const { result } = renderHook(() => useCompareDetail(api, { baseSha: "missing", targetSha: "t1" }));

    await waitFor(() => expect(result.current.status).toBe("error"));
  });

  it("drops a superseded fetch's result when `target` changes before it resolves (race-safety, same pattern as useBlame/useFileDiff)", async () => {
    const api = makeMockGitHydra({
      commits: [makeCommit("t1", ["b1"]), makeCommit("b1", []), makeCommit("t2", [])],
    });
    const { result, rerender } = renderHook(({ target }) => useCompareDetail(api, target), {
      initialProps: { target: { baseSha: "b1", targetSha: "t1" } },
    });

    rerender({ target: { baseSha: "b1", targetSha: "t2" } });
    await waitFor(() => expect(result.current.status).toBe("ready"));
    if (result.current.status !== "ready") throw new Error("expected ready");
    expect(result.current.target.sha).toBe("t2");
  });
});
