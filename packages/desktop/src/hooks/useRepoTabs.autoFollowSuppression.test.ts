// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { OpenRepoOutcome } from "../../shared/ipcContract";
import { useRepositoryGraph } from "./useRepositoryGraph";
import { useRepoTabs } from "./useRepoTabs";
import { makeMockGitHydra } from "../test/mockGitHydra";
import { makeCommit } from "../test/fixtures";

/**
 * specs/graph-head-indicator-and-refresh-alerting.md Addendum 3 — hook-level coverage (no
 * `<App/>`/`<CommitGraph/>`) for `followSignal` staying unbumped across a tab-reactivation replay
 * of a remembered selection, on both the fast (`instant-tab-revisit.md`) and full-reload paths.
 * `CommitGraph.test.tsx`'s own "Addendum 3" describe block covers the other half of the contract —
 * that a `selectedSha` change with an UNCHANGED `followSignal` never scrolls/chases pagination.
 * Combined, the two prove the whole chain: `useRepoTabs.ts` never calls the genuine
 * `selectCommit()` path for a replay, and `CommitGraph` never auto-follows unless that genuine path
 * actually fired.
 */

afterEach(() => {
  // @ts-expect-error test cleanup of the global bridge
  delete window.gitHydra;
  window.localStorage.clear();
});

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

describe("useRepoTabs — auto-follow suppressed on reactivation replay (Addendum 3)", () => {
  it("AC1: a clean fast-path reactivation restores the remembered selection without bumping followSignal", async () => {
    const api = makeMockGitHydra({
      repoPath: "/repoA",
      commits: [
        makeCommit("a3", ["a2"], { subject: "A3" }),
        makeCommit("a2", ["a1"], { subject: "A2" }),
        makeCommit("a1", [], { subject: "A1" }),
      ],
      reposByPath: { "/repoB": { commits: [makeCommit("b1", [], { subject: "B" })] } },
    });
    const { result } = renderTabs(api);

    await act(async () => {
      await result.current.tabs.openNewTab();
    });
    await waitFor(() => expect(result.current.graph.repoPath).toBe("/repoA"));

    // A genuine, deliberate selection — the real `selectCommit()` path — bumps followSignal, same
    // as a real click or app-initiated HEAD move would.
    act(() => result.current.graph.selectCommit("a1"));
    await waitFor(() => expect(result.current.graph.commitDetail.status).toBe("ready"));
    const followSignalAfterGenuineSelect = result.current.graph.followSignal;
    expect(followSignalAfterGenuineSelect).toBeGreaterThan(0);

    // Background tab A (this snapshots its cache, including the ready commitDetail above) and
    // switch into a new tab B.
    vi.mocked(api.openRepoDialog).mockResolvedValueOnce({ ok: true, data: "/repoB" });
    await act(async () => {
      await result.current.tabs.openNewTab();
    });
    await waitFor(() => expect(result.current.graph.repoPath).toBe("/repoB"));

    const tabAId = result.current.tabs.tabs[0]!.id;
    vi.mocked(api.createLogReader).mockClear();
    await act(async () => {
      await result.current.tabs.activateTab(tabAId);
    });
    await waitFor(() => expect(result.current.graph.repoPath).toBe("/repoA"));

    // Nothing changed in repo A while backgrounded — FR-242's fast path hits (no reader
    // recreated), and the cached ready `commitDetail` is restored directly.
    expect(api.createLogReader).not.toHaveBeenCalled();
    expect(result.current.graph.selectedSha).toBe("a1");
    expect(result.current.graph.commitDetail.status).toBe("ready");
    // AC1: no NEW follow was triggered by reactivating the tab — `followSignal` is exactly what it
    // was after the earlier genuine selection, not bumped again.
    expect(result.current.graph.followSignal).toBe(followSignalAfterGenuineSelect);
  });

  it("AC2: an external change that forces a full reload on reactivation still replays the remembered selection without bumping followSignal", async () => {
    const api = makeMockGitHydra({
      repoPath: "/repoA",
      commits: [
        makeCommit("a3", ["a2"], { subject: "A3" }),
        makeCommit("a2", ["a1"], { subject: "A2" }),
        makeCommit("a1", [], { subject: "A1" }),
      ],
      reposByPath: { "/repoB": { commits: [makeCommit("b1", [], { subject: "B" })] } },
    });
    const { result } = renderTabs(api);

    await act(async () => {
      await result.current.tabs.openNewTab();
    });
    await waitFor(() => expect(result.current.graph.repoPath).toBe("/repoA"));

    act(() => result.current.graph.selectCommit("a1"));
    await waitFor(() => expect(result.current.graph.commitDetail.status).toBe("ready"));
    const followSignalAfterGenuineSelect = result.current.graph.followSignal;
    expect(followSignalAfterGenuineSelect).toBeGreaterThan(0);

    vi.mocked(api.openRepoDialog).mockResolvedValueOnce({ ok: true, data: "/repoB" });
    await act(async () => {
      await result.current.tabs.openNewTab();
    });
    await waitFor(() => expect(result.current.graph.repoPath).toBe("/repoB"));

    // Simulate a real external change to repo A while it was backgrounded (a new commit landed on
    // HEAD) — forces `reactivateTab()`'s FR-243 full-reload fallback instead of the fast path.
    vi.mocked(api.openRepoCancellable).mockImplementationOnce(
      async (path: string): Promise<OpenRepoOutcome> => ({
        outcome: "settled",
        result: {
          ok: true,
          data: {
            path,
            pickedPath: path,
            state: {
              gitDir: "/repoA/.git",
              commonGitDir: "/repoA/.git",
              workdir: "/repoA",
              isBare: false,
              isShallow: false,
              isWorktree: false,
              isEmpty: false,
              isUnbornHead: false,
              isDetachedHead: false,
              currentBranch: "main",
              headSha: "a3-new",
              inProgressOperation: null,
              inProgressOperationDetail: null,
            },
          },
        },
      }),
    );

    const tabAId = result.current.tabs.tabs[0]!.id;
    vi.mocked(api.createLogReader).mockClear();
    // Note: the "no chase-pagination fires" half of AC2 needs a live `CommitGraph` to observe
    // `onLoadMore` directly — that's `CommitGraph.test.tsx`'s own Addendum 3 coverage. This test
    // proves the precondition that guarantees it: `followSignal` staying unchanged below, which is
    // exactly what stops `CommitGraph`'s auto-follow effect (and therefore its chase) from ever
    // running for this reactivation.
    await act(async () => {
      await result.current.tabs.activateTab(tabAId);
    });
    await waitFor(() => expect(result.current.graph.status).toBe("ready"));

    // FR-243: the mismatch forced exactly today's full reload.
    expect(api.createLogReader).toHaveBeenCalled();
    // AC2: the remembered selection is still replayed (selection state itself updates correctly —
    // `remember-last-selected-file.md`'s DetailPanel/ChangesPanel content still works)...
    await waitFor(() => expect(result.current.graph.selectedSha).toBe("a1"));
    await waitFor(() => expect(result.current.graph.commitDetail.status).toBe("ready"));
    // ...but via `restoreSelection()`, not `selectCommit()` — `followSignal` is unchanged from
    // before this reactivation, so `CommitGraph` never auto-scrolls or chases pagination for it.
    expect(result.current.graph.followSignal).toBe(followSignalAfterGenuineSelect);
  });
});
