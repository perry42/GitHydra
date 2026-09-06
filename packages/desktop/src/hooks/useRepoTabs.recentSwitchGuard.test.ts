// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useRepositoryGraph } from "./useRepositoryGraph";
import { useRepoTabs } from "./useRepoTabs";
import { makeMockGitHydra } from "../test/mockGitHydra";
import { makeCommit, makeRepoState } from "../test/fixtures";
import type { IpcResult, OpenRepoOutcome } from "../../shared/ipcContract";
import type { RepositoryState } from "@githydra/git-core";

/**
 * security review (specs/repo-list.md): `openRecentInNewTab`'s existing-tab dedup branch (AC4)
 * used to call `activateTab` and unconditionally report `"activated-existing"` — but `activateTab`
 * itself silently no-ops (via its own `beginSwitch()` guard) when a switch is already in flight, so
 * a recent-list click landing mid-switch had no effect yet was reported as a success. This is the
 * hook-level proof of the fix: `switchingRef.current` is checked *before* calling `activateTab`,
 * reporting `"cancelled"` instead in that case. The UI-level defense (`EmptyState`'s own `disabled`
 * prop, driven by `useRepoTabs`'s `switching`) already prevents a real click from reaching this
 * code path in practice — this test bypasses that entirely and calls the hook function directly,
 * exercising the defense-in-depth guard itself.
 */

afterEach(() => {
  // @ts-expect-error test cleanup of the global bridge
  delete window.gitHydra;
});

function deferredOpenRepoCancellable(): {
  promise: Promise<OpenRepoOutcome>;
  resolveSettled: (result: IpcResult<{ path: string; state: RepositoryState }>) => void;
} {
  let resolve!: (outcome: OpenRepoOutcome) => void;
  const promise = new Promise<OpenRepoOutcome>((res) => {
    resolve = res;
  });
  return {
    promise,
    resolveSettled: (result) => resolve({ outcome: "settled", result }),
  };
}

function renderTabs(api: ReturnType<typeof makeMockGitHydra>) {
  window.gitHydra = api;
  return renderHook(() => {
    const graph = useRepositoryGraph();
    const tabs = useRepoTabs({
      graph,
      rightPanel: "none",
      setRightPanel: () => {},
      getSeedRightPanel: () => "none",
    });
    return { graph, tabs };
  });
}

describe("useRepoTabs — recent-open dedup vs. an in-flight switch", () => {
  it("openRecentInNewTab reports 'cancelled' (not an unconditional 'activated-existing') when the matching tab's own activateTab would be swallowed by an in-flight switch", async () => {
    const api = makeMockGitHydra({
      repoPath: "/repoA",
      commits: [makeCommit("a1", [], { subject: "Repo A commit" })],
      reposByPath: {
        "/repoB": { commits: [makeCommit("b1", [], { subject: "Repo B commit" })] },
      },
    });
    const { result } = renderTabs(api);

    // Bootstrap tab 1 (repoA) then tab 2 (repoB) — tab 2 ends up active.
    await act(async () => {
      await result.current.tabs.openNewTab();
    });
    vi.mocked(api.openRepoDialog).mockResolvedValueOnce({ ok: true, data: "/repoB" });
    await act(async () => {
      await result.current.tabs.openNewTab();
    });
    expect(result.current.tabs.tabs).toHaveLength(2);
    const tabA = result.current.tabs.tabs[0]!;

    // Start switching back to tab A, but leave that switch in flight (never resolved).
    const deferred = deferredOpenRepoCancellable();
    vi.mocked(api.openRepoCancellable).mockReturnValueOnce(deferred.promise);
    let activatePromise!: Promise<void>;
    act(() => {
      activatePromise = result.current.tabs.activateTab(tabA.id);
    });
    expect(result.current.tabs.switching).toBe(true);

    // A recent-list click for the SAME path lands mid-switch — `activateTab` itself would
    // silently no-op it (already switching), so this must report "cancelled", never an
    // unconditional "activated-existing" that would make a caller treat it as a success.
    let outcome!: string;
    await act(async () => {
      outcome = await result.current.tabs.openRecentInNewTab("/repoA");
    });
    expect(outcome).toBe("cancelled");

    // Clean up the still-in-flight activation so the test doesn't leave a dangling promise.
    await act(async () => {
      deferred.resolveSettled({ ok: true, data: { path: "/repoA", state: makeRepoState({ headSha: "a1" }) } });
      await activatePromise;
    });
    expect(result.current.tabs.switching).toBe(false);
  });
});
