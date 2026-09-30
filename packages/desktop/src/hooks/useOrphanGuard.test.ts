// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { OrphanedHeadResult } from "@githydra/git-core";
import { makeMockGitHydra } from "../test/mockGitHydra";
import { useOrphanGuard } from "./useOrphanGuard";

const HEAD = "a".repeat(40);
const orphaned: OrphanedHeadResult = {
  status: "orphaned",
  reason: "orphaned",
  headSha: HEAD,
  total: 2,
  totalIsCapped: false,
  shown: [{ sha: HEAD, shortSha: "aaaaaaa", subject: "s" }],
};

function setup() {
  const api = makeMockGitHydra();
  vi.mocked(api.getOrphanedHeadCommits).mockResolvedValue({ ok: true, data: orphaned });
  const hook = renderHook(() => useOrphanGuard({ api }));
  return { api, ...hook };
}

describe("useOrphanGuard (FR-430 dialog state + banner lifecycle)", () => {
  it("opens the confirm dialog, Cancel resolves the checkout as cancelled and nothing is switched", async () => {
    const { api, result } = setup();
    let promise!: Promise<unknown>;
    act(() => {
      promise = result.current.guardedCheckout.switchBranch("main");
    });
    await waitFor(() => expect(result.current.pending?.phase).toBe("confirm"));
    expect(result.current.dialogOpen).toBe(true);
    act(() => result.current.chooseCancel());
    await expect(promise).resolves.toEqual({ cancelled: true });
    expect(result.current.dialogOpen).toBe(false);
    expect(api.switchBranch).not.toHaveBeenCalled();
    expect(result.current.leftBehind).toBeNull();
  });

  it("Leave: switches, then sets the banner; dismiss clears it", async () => {
    const { api, result } = setup();
    let promise!: Promise<unknown>;
    act(() => {
      promise = result.current.guardedCheckout.switchBranch("main");
    });
    await waitFor(() => expect(result.current.pending).not.toBeNull());
    act(() => result.current.chooseLeave());
    await act(async () => {
      await promise;
    });
    expect(api.switchBranch).toHaveBeenCalledWith("main", { expectedDetachedHeadSha: HEAD });
    expect(result.current.leftBehind).toMatchObject({ headSha: HEAD, shortSha: "aaaaaaa", total: 2 });
    act(() => result.current.dismissLeftBehind());
    expect(result.current.leftBehind).toBeNull();
  });

  it("naming step: cancelling it returns to the confirm dialog; saving it resolves 'created' and the guard re-queries", async () => {
    const { api, result } = setup();
    vi.mocked(api.getOrphanedHeadCommits)
      .mockResolvedValueOnce({ ok: true, data: orphaned })
      .mockResolvedValue({ ok: true, data: { ...orphaned, status: "none", reason: "no-orphans", headSha: null, total: 0, shown: [] } });
    let promise!: Promise<unknown>;
    act(() => {
      promise = result.current.guardedCheckout.switchBranch("main");
    });
    await waitFor(() => expect(result.current.pending?.phase).toBe("confirm"));
    act(() => result.current.chooseCreate());
    expect(result.current.pending?.phase).toBe("naming");
    act(() => result.current.namingCancelled());
    expect(result.current.pending?.phase).toBe("confirm");
    act(() => result.current.chooseCreate());
    act(() => result.current.namingCreated());
    await act(async () => {
      await promise;
    });
    expect(api.getOrphanedHeadCommits).toHaveBeenCalledTimes(2);
    expect(api.switchBranch).toHaveBeenCalledWith("main"); // branch now holds the commits: no expected sha
    expect(result.current.leftBehind).toBeNull();
  });

  it("reset (repo/tab switch) cancels a pending prompt and clears the banner", async () => {
    const { api, result } = setup();
    let promise!: Promise<unknown>;
    act(() => {
      promise = result.current.guardedCheckout.switchBranch("main");
    });
    await waitFor(() => expect(result.current.pending).not.toBeNull());
    act(() => result.current.reset());
    await expect(promise).resolves.toEqual({ cancelled: true });
    expect(result.current.pending).toBeNull();
    expect(api.switchBranch).not.toHaveBeenCalled();

    let p2!: Promise<unknown>;
    act(() => {
      p2 = result.current.guardedCheckout.switchBranch("main");
    });
    await waitFor(() => expect(result.current.pending).not.toBeNull());
    act(() => result.current.chooseLeave());
    await act(async () => {
      await p2;
    });
    expect(result.current.leftBehind).not.toBeNull();
    act(() => result.current.reset());
    expect(result.current.leftBehind).toBeNull();
  });

  it("a second checkout while a dialog is open is cancelled rather than stacking a second dialog", async () => {
    const { result } = setup();
    act(() => {
      void result.current.guardedCheckout.switchBranch("main");
    });
    await waitFor(() => expect(result.current.pending).not.toBeNull());
    let second!: Promise<unknown>;
    act(() => {
      second = result.current.guardedCheckout.switchBranch("other");
    });
    await expect(second).resolves.toEqual({ cancelled: true });
    expect(result.current.pending).not.toBeNull();
  });
});
