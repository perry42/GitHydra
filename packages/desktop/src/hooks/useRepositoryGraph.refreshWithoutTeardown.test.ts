// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useRepositoryGraph } from "./useRepositoryGraph";
import { makeMockGitHydra } from "../test/mockGitHydra";
import { makeCommit, makeRepoState } from "../test/fixtures";
import type { IpcResult } from "../../shared/ipcContract";
import type { RepositoryState } from "@githydra/git-core";

afterEach(() => {
  // @ts-expect-error test cleanup of the global bridge
  delete window.gitHydra;
});

/**
 * specs/refresh-without-teardown.md: a manual refresh used to call `openRepo(repoPath)` again,
 * which flips `status` to `"opening"` (unmounting the graph/side panels in favor of
 * `OpeningSpinner`, per `App.tsx`'s `MainArea`) and bumps `openSequence` (force-remounting every
 * panel keyed on it) for the entire round trip. `refresh()` now calls `refreshRefsAndRows()`
 * instead, which never touches either. These tests exercise the hook directly (DOM-level
 * mount/remount assertions for AC2/AC3 live in `App.test.tsx`/`App.selfWriteRefreshSuppression.
 * test.tsx` instead, since `status`/`openSequence` are the actual signals those panels key/gate
 * on).
 */
describe("useRepositoryGraph — refresh() no longer tears down (specs/refresh-without-teardown.md)", () => {
  async function openReadyRepo() {
    const api = makeMockGitHydra({ commits: [makeCommit("c2", ["c1"]), makeCommit("c1")] });
    window.gitHydra = api;
    const { result } = renderHook(() => useRepositoryGraph());
    await act(async () => {
      await result.current.openRepo("/repo");
    });
    await waitFor(() => expect(result.current.status).toBe("ready"));
    return { api, result };
  }

  it("AC1: never transitions status away from 'ready' and never bumps openSequence", async () => {
    const { result } = await openReadyRepo();
    const openSequenceBefore = result.current.openSequence;
    const statusValuesSeen = new Set<string>([result.current.status]);

    await act(async () => {
      const p = result.current.refresh();
      // Capture status synchronously, before any microtask of the refresh could have resolved —
      // this is exactly the window the old `openRepo`-based implementation flipped `status` to
      // `"opening"` in.
      statusValuesSeen.add(result.current.status);
      await p;
      statusValuesSeen.add(result.current.status);
    });

    expect(statusValuesSeen).toEqual(new Set(["ready"]));
    expect(result.current.openSequence).toBe(openSequenceBefore);
  });

  it("AC4: isRefreshing is true only for the duration of an in-flight refresh, then clears", async () => {
    const { api, result } = await openReadyRepo();
    expect(result.current.isRefreshing).toBe(false);

    let resolveGetState: (value: IpcResult<RepositoryState>) => void;
    const deferred = new Promise<IpcResult<RepositoryState>>((resolve) => {
      resolveGetState = resolve;
    });
    vi.mocked(api.getState).mockReturnValueOnce(deferred);

    let refreshPromise!: Promise<void>;
    act(() => {
      refreshPromise = result.current.refresh();
    });
    await waitFor(() => expect(result.current.isRefreshing).toBe(true));

    // Still in flight: the rest of the app must have something to show a busy affordance from.
    expect(result.current.isRefreshing).toBe(true);

    await act(async () => {
      resolveGetState({ ok: true, data: makeRepoState({ headSha: "c1" }) });
      await refreshPromise;
    });

    expect(result.current.isRefreshing).toBe(false);
  });

  // `refresh()` deliberately never lets a failure escape as a rejected promise — nearly every
  // call site invokes it fire-and-forget (`void graph.refresh()`), which was safe before this
  // change because `openRepo()` (what `refresh()` used to call) already contained its own
  // failures. See `refresh`'s own doc comment for the full reasoning.
  it("AC4: isRefreshing clears even when the refresh fails, and the failure never escapes as a rejection", async () => {
    const { api, result } = await openReadyRepo();
    vi.mocked(api.getState).mockRejectedValueOnce(new Error("boom"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    await act(async () => {
      await expect(result.current.refresh()).resolves.toBeUndefined();
    });

    expect(result.current.isRefreshing).toBe(false);
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it("AC6: a selected commit that still exists after refresh keeps its selection and Detail panel untouched", async () => {
    const { result } = await openReadyRepo();

    await act(async () => {
      result.current.selectCommit("c1");
    });
    await waitFor(() => expect(result.current.commitDetail.status).toBe("ready"));
    const detailBefore = result.current.commitDetail;

    await act(async () => {
      await result.current.refresh();
    });

    expect(result.current.selectedSha).toBe("c1");
    expect(result.current.commitDetail).toBe(detailBefore);
  });

  it("AC7: still fully recovers from an actual external change (new commits pulled, branch moved)", async () => {
    const { api, result } = await openReadyRepo();
    expect(result.current.repoState?.headSha).toBe("c2");

    const newHeadState = makeRepoState({ headSha: "c3" });
    vi.mocked(api.getState).mockResolvedValueOnce({ ok: true, data: newHeadState });
    // A fresh pull added c3 on top of the existing history.
    vi.mocked(api.createLogReader).mockImplementationOnce((_filter, _requestId) => {
      return Promise.resolve({ ok: true, data: "reader-after-pull" });
    });
    vi.mocked(api.readPage).mockImplementationOnce((_readerId, _count) =>
      Promise.resolve({
        ok: true,
        data: { commits: [makeCommit("c3", ["c2"]), makeCommit("c2", ["c1"]), makeCommit("c1")], done: true },
      }),
    );

    await act(async () => {
      await result.current.refresh();
    });

    expect(result.current.repoState?.headSha).toBe("c3");
    expect(result.current.displayRows.some((r) => r.kind === "commit" && r.laid.commit.sha === "c3")).toBe(true);
  });
});
