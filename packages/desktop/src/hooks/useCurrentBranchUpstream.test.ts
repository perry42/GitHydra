// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import type { LocalBranchInfo } from "@githydra/git-core";
import { makeMockGitHydra } from "../test/mockGitHydra";
import { useCurrentBranchUpstream } from "./useCurrentBranchUpstream";

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
    upstreamName: null,
    upstreamGone: false,
    ahead: null,
    behind: null,
    ...overrides,
  };
}

describe("useCurrentBranchUpstream (specs/online-sync-pull.md FR-343)", () => {
  it("resolves true once the current branch's own upstreamName is set", async () => {
    const api = makeMockGitHydra({
      localBranches: [
        branch({ name: "main", upstreamName: "origin/main" }),
        branch({ name: "other", upstreamName: null }),
      ],
    });

    const { result } = renderHook(() => useCurrentBranchUpstream({ api, enabled: true, currentBranch: "main" }));

    expect(result.current).toBe("loading");
    await waitFor(() => expect(result.current).toBe(true));
  });

  it("resolves false when the current branch has no configured upstream", async () => {
    const api = makeMockGitHydra({ localBranches: [branch({ name: "main", upstreamName: null })] });

    const { result } = renderHook(() => useCurrentBranchUpstream({ api, enabled: true, currentBranch: "main" }));

    await waitFor(() => expect(result.current).toBe(false));
  });

  it("stays 'loading' (never calls listBranches) when currentBranch is null — a bare repo/detached HEAD has nothing to look up", () => {
    const api = makeMockGitHydra({ localBranches: [branch({ name: "main", upstreamName: "origin/main" })] });

    const { result } = renderHook(() => useCurrentBranchUpstream({ api, enabled: true, currentBranch: null }));

    expect(result.current).toBe("loading");
    expect(api.listBranches).not.toHaveBeenCalled();
  });

  /**
   * Regression coverage for a real bug caught by `App.pull.e2e.test.tsx` (a real `RepoSession`,
   * which — unlike this file's in-memory mock — genuinely throws "No repository is open" for a
   * `listBranches()` call issued between `openRepoCancellable` resolving (which already populates
   * `repoState.currentBranch`) and the LATER `commitOpenRepo` step of that same open sequence
   * promoting the repo to live). Gating this hook on `currentBranch` alone raced that window and
   * permanently stuck the Pull button at "Checking upstream configuration…" for the rest of the
   * session, because nothing ever re-triggered the effect once `currentBranch` stopped changing.
   * `enabled` (mirroring `useDivergedBranches`'s own `graph.status === "ready"` gate) is what fixes
   * it — this test locks in that even a NON-null `currentBranch` must not, by itself, be enough to
   * trigger the read while `enabled` is still false.
   */
  it("never calls listBranches while enabled is false, even with a non-null currentBranch — the real-RepoSession race this hook exists to avoid", () => {
    const api = makeMockGitHydra({ localBranches: [branch({ name: "main", upstreamName: "origin/main" })] });

    const { result } = renderHook(() => useCurrentBranchUpstream({ api, enabled: false, currentBranch: "main" }));

    expect(result.current).toBe("loading");
    expect(api.listBranches).not.toHaveBeenCalled();
  });

  it("starts reading once enabled flips from false to true, with currentBranch already set", async () => {
    const api = makeMockGitHydra({ localBranches: [branch({ name: "main", upstreamName: "origin/main" })] });
    const { result, rerender } = renderHook(
      ({ enabled }) => useCurrentBranchUpstream({ api, enabled, currentBranch: "main" }),
      { initialProps: { enabled: false } },
    );

    expect(api.listBranches).not.toHaveBeenCalled();
    rerender({ enabled: true });

    await waitFor(() => expect(result.current).toBe(true));
  });

  it("refetches when reloadToken changes (e.g. after a fetch or branch mutation)", async () => {
    const api = makeMockGitHydra({ localBranches: [branch({ name: "main", upstreamName: null })] });
    const { result, rerender } = renderHook(
      ({ reloadToken }) => useCurrentBranchUpstream({ api, enabled: true, currentBranch: "main", reloadToken }),
      { initialProps: { reloadToken: 0 } },
    );

    await waitFor(() => expect(result.current).toBe(false));

    vi.mocked(api.listBranches).mockResolvedValueOnce({
      ok: true,
      data: [branch({ name: "main", upstreamName: "origin/main" })],
    });
    rerender({ reloadToken: 1 });

    await waitFor(() => expect(result.current).toBe(true));
  });
});
