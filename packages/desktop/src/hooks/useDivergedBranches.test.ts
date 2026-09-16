// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import type { LocalBranchInfo } from "@githydra/git-core";
import { makeMockGitHydra } from "../test/mockGitHydra";
import { useDivergedBranches } from "./useDivergedBranches";

function branch(overrides: Partial<LocalBranchInfo> & Pick<LocalBranchInfo, "name">): LocalBranchInfo {
  return {
    fullName: `refs/heads/${overrides.name}`,
    tipSha: "a".repeat(40),
    tipSubject: "",
    tipAuthorName: "",
    tipAuthorEmail: "",
    tipAuthorDate: "",
    tipCommitterDate: "",
    isCurrent: false,
    checkedOutInWorktree: null,
    upstreamName: "origin/" + overrides.name,
    upstreamGone: false,
    ahead: null,
    behind: null,
    ...overrides,
  };
}

describe("useDivergedBranches", () => {
  it("includes only branches with both ahead > 0 and behind > 0 (FR-326)", async () => {
    const api = makeMockGitHydra({
      localBranches: [
        branch({ name: "diverged", ahead: 2, behind: 3 }),
        branch({ name: "ahead-only", ahead: 2, behind: 0 }),
        branch({ name: "behind-only", ahead: 0, behind: 2 }),
        branch({ name: "up-to-date", ahead: 0, behind: 0 }),
        branch({ name: "no-upstream", ahead: null, behind: null }),
      ],
    });

    const { result } = renderHook(() => useDivergedBranches({ api, enabled: true }));

    await waitFor(() => expect(result.current.has("diverged")).toBe(true));
    expect(result.current.size).toBe(1);
  });

  it("returns an empty set when disabled, without calling listBranches", () => {
    const api = makeMockGitHydra({ localBranches: [branch({ name: "diverged", ahead: 1, behind: 1 })] });

    const { result } = renderHook(() => useDivergedBranches({ api, enabled: false }));

    expect(result.current.size).toBe(0);
    expect(api.listBranches).not.toHaveBeenCalled();
  });

  it("refetches when reloadToken changes (e.g. after a fetch completes)", async () => {
    const api = makeMockGitHydra({ localBranches: [] });
    const { result, rerender } = renderHook(
      ({ reloadToken }) => useDivergedBranches({ api, enabled: true, reloadToken }),
      { initialProps: { reloadToken: 0 } },
    );

    await waitFor(() => expect(api.listBranches).toHaveBeenCalledTimes(1));
    expect(result.current.size).toBe(0);

    vi.mocked(api.listBranches).mockResolvedValueOnce({
      ok: true,
      data: [branch({ name: "now-diverged", ahead: 1, behind: 1 })],
    });
    rerender({ reloadToken: 1 });

    await waitFor(() => expect(result.current.has("now-diverged")).toBe(true));
  });
});
