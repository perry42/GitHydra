// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { LocalBranchInfo } from "@githydra/git-core";
import { makeMockGitHydra } from "../test/mockGitHydra";
import { usePushTarget } from "./usePushTarget";

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

describe("usePushTarget (specs/online-sync-push.md FR-345/FR-347)", () => {
  it("stays 'loading' and shows no picker before enabled", () => {
    const api = makeMockGitHydra({ remotes: ["origin"] });
    const { result } = renderHook(() => usePushTarget({ api, enabled: false, currentBranch: "main" }));

    expect(result.current.remotes).toBe("loading");
    expect(result.current.showRemotePicker).toBe(false);
    expect(result.current.selectedRemote).toBeNull();
    expect(api.listConfiguredRemotes).not.toHaveBeenCalled();
  });

  it("a single-remote repo defaults selectedRemote to it, with no picker shown (FR-345 zero-extra-click)", async () => {
    const api = makeMockGitHydra({
      remotes: ["origin"],
      localBranches: [branch({ name: "main" })],
    });
    const { result } = renderHook(() => usePushTarget({ api, enabled: true, currentBranch: "main" }));

    await waitFor(() => expect(result.current.remotes).toEqual(["origin"]));
    expect(result.current.showRemotePicker).toBe(false);
    expect(result.current.selectedRemote).toBe("origin");
  });

  it("a multi-remote repo shows the picker, defaulting to the branch's actually-tracked remote (not just the first)", async () => {
    const api = makeMockGitHydra({
      remotes: ["origin", "upstream"],
      localBranches: [branch({ name: "main", upstreamName: "upstream/main" })],
    });
    const { result } = renderHook(() => usePushTarget({ api, enabled: true, currentBranch: "main" }));

    await waitFor(() => expect(result.current.remotes).toEqual(["origin", "upstream"]));
    expect(result.current.showRemotePicker).toBe(true);
    expect(result.current.trackedRemoteName).toBe("upstream");
    expect(result.current.selectedRemote).toBe("upstream");
  });

  it("falls back to the first configured remote when the branch has no tracked remote yet", async () => {
    const api = makeMockGitHydra({
      remotes: ["origin", "upstream"],
      localBranches: [branch({ name: "feature", upstreamName: null })],
    });
    const { result } = renderHook(() => usePushTarget({ api, enabled: true, currentBranch: "feature" }));

    await waitFor(() => expect(result.current.remotes).toEqual(["origin", "upstream"]));
    expect(result.current.selectedRemote).toBe("origin");
  });

  it("an explicit setSelectedRemote call overrides the default until the remote list stops containing it", async () => {
    const api = makeMockGitHydra({
      remotes: ["origin", "upstream"],
      localBranches: [branch({ name: "main", upstreamName: "origin/main" })],
    });
    const { result } = renderHook(() => usePushTarget({ api, enabled: true, currentBranch: "main" }));

    await waitFor(() => expect(result.current.selectedRemote).toBe("origin"));
    act(() => result.current.setSelectedRemote("upstream"));
    expect(result.current.selectedRemote).toBe("upstream");
  });

  it("exposes the current branch's own behind count against its configured upstream", async () => {
    const api = makeMockGitHydra({
      remotes: ["origin"],
      localBranches: [branch({ name: "main", upstreamName: "origin/main", ahead: 1, behind: 3 })],
    });
    const { result } = renderHook(() => usePushTarget({ api, enabled: true, currentBranch: "main" }));

    await waitFor(() => expect(result.current.behind).toBe(3));
  });

  // toolbar-action-row redesign: `ahead` drives the Toolbar's own Push-segment pill — sourced from
  // the exact same `listBranches()` read `behind` already uses, no new git-core call/IPC.
  it("exposes the current branch's own ahead count from the same listBranches() read behind uses", async () => {
    const api = makeMockGitHydra({
      remotes: ["origin"],
      localBranches: [branch({ name: "main", upstreamName: "origin/main", ahead: 1, behind: 3 })],
    });
    const { result } = renderHook(() => usePushTarget({ api, enabled: true, currentBranch: "main" }));

    await waitFor(() => expect(result.current.ahead).toBe(1));
  });

  it("behind/ahead are both null when the current branch has no configured upstream at all", async () => {
    const api = makeMockGitHydra({
      remotes: ["origin"],
      localBranches: [branch({ name: "feature", upstreamName: null })],
    });
    const { result } = renderHook(() => usePushTarget({ api, enabled: true, currentBranch: "feature" }));

    await waitFor(() => expect(result.current.remotes).toEqual(["origin"]));
    expect(result.current.behind).toBeNull();
    expect(result.current.ahead).toBeNull();
  });

  it("refetches when reloadToken changes", async () => {
    const api = makeMockGitHydra({ remotes: ["origin"], localBranches: [branch({ name: "main" })] });
    const { result, rerender } = renderHook(
      ({ reloadToken }) => usePushTarget({ api, enabled: true, currentBranch: "main", reloadToken }),
      { initialProps: { reloadToken: 0 } },
    );

    await waitFor(() => expect(result.current.remotes).toEqual(["origin"]));

    vi.mocked(api.listConfiguredRemotes).mockResolvedValueOnce({ ok: true, data: ["origin", "fork"] });
    rerender({ reloadToken: 1 });

    await waitFor(() => expect(result.current.remotes).toEqual(["origin", "fork"]));
  });
});
