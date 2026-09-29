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

    await waitFor(() => expect(result.current.diverged.has("diverged")).toBe(true));
    expect(result.current.diverged.size).toBe(1);
  });

  it("returns empty collections when disabled, without calling listBranches", () => {
    const api = makeMockGitHydra({ localBranches: [branch({ name: "diverged", ahead: 1, behind: 1 })] });

    const { result } = renderHook(() => useDivergedBranches({ api, enabled: false }));

    expect(result.current.diverged.size).toBe(0);
    expect(result.current.syncedUpstream.size).toBe(0);
    expect(api.listBranches).not.toHaveBeenCalled();
  });

  it("refetches when reloadToken changes (e.g. after a fetch completes)", async () => {
    const api = makeMockGitHydra({ localBranches: [] });
    const { result, rerender } = renderHook(
      ({ reloadToken }) => useDivergedBranches({ api, enabled: true, reloadToken }),
      { initialProps: { reloadToken: 0 } },
    );

    await waitFor(() => expect(api.listBranches).toHaveBeenCalledTimes(1));
    expect(result.current.diverged.size).toBe(0);

    vi.mocked(api.listBranches).mockResolvedValueOnce({
      ok: true,
      data: [branch({ name: "now-diverged", ahead: 1, behind: 1 })],
    });
    rerender({ reloadToken: 1 });

    await waitFor(() => expect(result.current.diverged.has("now-diverged")).toBe(true));
  });

  // specs/ref-chip-synced-upstream-merge.md FR-1/FR-2: derived from the exact same listBranches()
  // read as `diverged` above — no second IPC call, just a second derived collection.
  describe("syncedUpstream (specs/ref-chip-synced-upstream-merge.md FR-1/FR-2)", () => {
    it("maps a branch name to its upstream's short name only when ahead===0 && behind===0 && a real, non-gone upstream is configured", async () => {
      const api = makeMockGitHydra({
        localBranches: [
          branch({ name: "up-to-date", ahead: 0, behind: 0 }), // upstreamName defaults to "origin/up-to-date"
          branch({ name: "diverged", ahead: 2, behind: 3 }),
          branch({ name: "ahead-only", ahead: 2, behind: 0 }),
          branch({ name: "behind-only", ahead: 0, behind: 2 }),
          branch({ name: "no-upstream", upstreamName: null, ahead: null, behind: null }),
          branch({ name: "gone-upstream", ahead: 0, behind: 0, upstreamGone: true }),
        ],
      });

      const { result } = renderHook(() => useDivergedBranches({ api, enabled: true }));

      await waitFor(() => expect(result.current.syncedUpstream.size).toBe(1));
      expect(result.current.syncedUpstream.get("up-to-date")).toBe("origin/up-to-date");
      expect(result.current.syncedUpstream.has("diverged")).toBe(false);
      expect(result.current.syncedUpstream.has("ahead-only")).toBe(false);
      expect(result.current.syncedUpstream.has("behind-only")).toBe(false);
      expect(result.current.syncedUpstream.has("no-upstream")).toBe(false);
      expect(result.current.syncedUpstream.has("gone-upstream")).toBe(false);
    });

    it("makes exactly one listBranches() call even though both diverged and syncedUpstream are derived (FR-2)", async () => {
      const api = makeMockGitHydra({
        localBranches: [branch({ name: "up-to-date", ahead: 0, behind: 0 })],
      });

      renderHook(() => useDivergedBranches({ api, enabled: true }));

      await waitFor(() => expect(api.listBranches).toHaveBeenCalledTimes(1));
    });
  });
});
