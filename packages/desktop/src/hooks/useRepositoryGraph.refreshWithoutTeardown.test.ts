// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useRepositoryGraph } from "./useRepositoryGraph";
import { makeMockGitHydra } from "../test/mockGitHydra";
import { makeCommit, makeLocalBranch, makeRepoState } from "../test/fixtures";
import type { IpcResult } from "../../shared/ipcContract";
import type { RefInfo, RepositoryState } from "@githydra/git-core";

function ok<T>(data: T): IpcResult<T> {
  return { ok: true, data };
}

function mainRef(targetCommitSha: string): RefInfo {
  return {
    fullName: "refs/heads/main",
    shortName: "main",
    type: "local-branch",
    targetCommitSha,
    isAnnotatedTag: false,
    isSymbolic: false,
  };
}

function featureRef(targetCommitSha: string): RefInfo {
  return {
    fullName: "refs/heads/feature",
    shortName: "feature",
    type: "local-branch",
    targetCommitSha,
    isAnnotatedTag: false,
    isSymbolic: false,
  };
}

afterEach(() => {
  // @ts-expect-error test cleanup of the global bridge
  delete window.gitHydra;
  vi.restoreAllMocks();
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

  /** Same as `openReadyRepo`, but also captures the watcher listener `api.onRefsChanged`
   * registers, for tests that need to drive `hasExternalChanges`/`operationStateAlert` into a real
   * non-default value first (security review's Issue 2 regression coverage below). */
  async function openReadyRepoWithWatcher() {
    const api = makeMockGitHydra({ commits: [makeCommit("c1")], refs: [mainRef("c1")] });
    let listener: (() => void) | null = null;
    vi.mocked(api.onRefsChanged).mockImplementation((l) => {
      listener = l;
      return () => {
        listener = null;
      };
    });
    window.gitHydra = api;
    const { result } = renderHook(() => useRepositoryGraph());
    await act(async () => {
      await result.current.openRepo("/repo");
    });
    await waitFor(() => expect(result.current.status).toBe("ready"));
    const fireWatcher = async () => {
      expect(listener).not.toBeNull();
      await act(async () => {
        listener!();
        await Promise.resolve();
        await Promise.resolve();
      });
    };
    return { api, result, fireWatcher };
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

  /**
   * security review finding (post-39b7301): manual `refresh()` is reachable at any time — gated
   * only by `isRefreshing`/`canRefresh`, never by whether a real `beginMutation()`-gated operation
   * (branch switch, stash op, cherry-pick, conflict Continue/Abort) has a FIFO entry outstanding.
   * `refreshRefsAndRows`'s FIFO `shift()` assumes issue order matches resolution order because
   * every OTHER caller IS itself that operation's own settle step — an interleaved manual refresh
   * breaks that assumption, consuming the entry a real gated mutation's own settle call still
   * needs. Fixed via `refreshRefsAndRows(expected, { closesGate: false })`, which `refresh()` now
   * always passes.
   */
  it("security review fix: an interleaved manual refresh() does not consume a real gated mutation's FIFO entry", async () => {
    const api = makeMockGitHydra({
      commits: [makeCommit("c1")],
      refs: [mainRef("c1"), featureRef("c1")],
      localBranches: [
        makeLocalBranch("main", { isCurrent: true, tipSha: "c1" }),
        makeLocalBranch("feature", { isCurrent: false, tipSha: "c1" }),
      ],
    });
    window.gitHydra = api;
    const { result } = renderHook(() => useRepositoryGraph());
    await act(async () => {
      await result.current.openRepo("/repo");
    });

    // A real gated mutation begins (e.g. Continue on a paused merge) — opens the FIFO gate.
    act(() => result.current.beginMutation());

    // While that mutation is still in flight (its own settle call hasn't run yet), the user clicks
    // manual Refresh. Before the fix, this `shift()`ed and consumed the FIFO entry above.
    await act(async () => {
      await result.current.refresh();
    });

    // The gated mutation itself now settles: its own current branch (main) legitimately advances
    // to c2, but a second process also retargeted `feature` during this exact window — the same
    // fixture `useRepositoryGraph.selfWriteSuppression.test.ts`'s AC5-false-negative regression
    // test uses. If the interleaved `refresh()` above had consumed the FIFO entry, this call's own
    // `shift()` would see `undefined` and silently skip this diff entirely.
    vi.mocked(api.getState).mockResolvedValueOnce(ok(makeRepoState({ currentBranch: "main", headSha: "c2" })));
    vi.mocked(api.getRefs).mockResolvedValueOnce(ok([mainRef("c2"), featureRef("c3-not-ours")]));

    await act(async () => {
      await result.current.refreshRefsAndRows();
    });

    expect(result.current.hasExternalChanges).toBe(true);
  });

  /**
   * security review finding (post-39b7301): `refresh()` cleared `hasExternalChanges`/
   * `operationStateAlert` synchronously up front (so a *successful* refresh dismisses whatever
   * either was warning about), but a thrown failure only logged the error — it never restored
   * either flag. `operationStateAlert !== null` gates `App.tsx`'s Continue/Abort/Accept Ours/
   * Accept Theirs/Mark-as-resolved actions; silently leaving it cleared after a refresh that never
   * actually reconfirmed anything would unblock those actions against never-reconfirmed state.
   * Fixed by capturing both flags' pre-refresh values and restoring them in the `catch` block.
   */
  it("security review fix: a failed refresh restores operationStateAlert to its pre-refresh value, not null", async () => {
    const { api, result, fireWatcher } = await openReadyRepoWithWatcher();

    const mergingState = makeRepoState({
      inProgressOperation: "merge",
      inProgressOperationDetail: {
        kind: "merge",
        headSha: "c1",
        headSubject: "Commit c1",
        mergeHeadSha: "feature123",
        mergeHeadSubject: "Feature work",
        incomingRef: "feature",
      },
    });
    vi.mocked(api.getState).mockResolvedValueOnce(ok(mergingState));
    await fireWatcher();
    await waitFor(() => expect(result.current.operationStateAlert).toEqual({ operation: "merge" }));

    // The refresh the alert's own banner triggers now fails outright (the file's own doc comments
    // cite a Windows git-lock collision surviving `withGitLockRetry`'s one retry, or the repo
    // becoming briefly inaccessible, as real causes).
    vi.mocked(api.getState).mockRejectedValueOnce(new Error("boom"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    await act(async () => {
      await result.current.refresh();
    });

    // Not cleared: nothing was actually reconfirmed, so the conflict-action gate this alert drives
    // must stay exactly as protective as it was before the failed click.
    expect(result.current.operationStateAlert).toEqual({ operation: "merge" });
    consoleError.mockRestore();
  });

  it("security review fix: a failed refresh restores hasExternalChanges to its pre-refresh value, not false", async () => {
    const { api, result, fireWatcher } = await openReadyRepoWithWatcher();

    vi.mocked(api.getState).mockResolvedValueOnce(
      ok(makeRepoState({ inProgressOperation: null, inProgressOperationDetail: null, headSha: "different-sha" })),
    );
    await fireWatcher();
    await waitFor(() => expect(result.current.hasExternalChanges).toBe(true));

    vi.mocked(api.getState).mockRejectedValueOnce(new Error("boom"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    await act(async () => {
      await result.current.refresh();
    });

    expect(result.current.hasExternalChanges).toBe(true);
    consoleError.mockRestore();
  });

  /**
   * second security review finding (post-2d719ad): the restore-on-failure fix above must not
   * unconditionally overwrite with the closure-captured pre-refresh-click snapshot —
   * `onRefsChanged`'s watcher effect is gated only by an open mutation gate
   * (`pendingMutationsRef.current.length > 0`), never by `isRefreshing`, so a genuinely new
   * external event (a teammate's push, an operation starting/ending elsewhere) can legitimately
   * set `operationStateAlert`/`hasExternalChanges` while this call's own `refreshRefsAndRows` fetch
   * is still in flight. If that fetch then throws, the `catch` block must leave the
   * concurrently-detected value alone, not clobber it back to whatever it was before the user even
   * clicked Refresh — fixed via the functional-update form (`(current) => current === <cleared
   * value> ? prior : current`).
   */
  it("security review fix (round 2): a genuinely new alert detected mid-refresh survives a subsequent refresh failure, unclobbered", async () => {
    const { api, result, fireWatcher } = await openReadyRepoWithWatcher();
    expect(result.current.operationStateAlert).toBeNull();
    expect(result.current.hasExternalChanges).toBe(false);

    // `refresh()`'s own fetch stalls indefinitely until `rejectGetState` below settles it — the
    // control point for the race this test reproduces.
    let rejectGetState!: (err: unknown) => void;
    const stalled = new Promise<IpcResult<RepositoryState>>((_resolve, reject) => {
      rejectGetState = reject;
    });
    vi.mocked(api.getState).mockReturnValueOnce(stalled);

    let refreshPromise!: Promise<void>;
    act(() => {
      refreshPromise = result.current.refresh();
    });

    // A genuinely new external change (an operation started elsewhere) is detected by the watcher
    // while `refresh()`'s own fetch is still in flight — a real, legitimate race (the watcher isn't
    // gated by `isRefreshing`), not a contrived one.
    const mergingState = makeRepoState({
      inProgressOperation: "merge",
      inProgressOperationDetail: {
        kind: "merge",
        headSha: "c1",
        headSubject: "Commit c1",
        mergeHeadSha: "feature123",
        mergeHeadSubject: "Feature work",
        incomingRef: "feature",
      },
    });
    vi.mocked(api.getState).mockResolvedValueOnce(ok(mergingState));
    await fireWatcher();
    await waitFor(() => expect(result.current.operationStateAlert).toEqual({ operation: "merge" }));

    // Now `refresh()`'s own stalled fetch fails outright.
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    await act(async () => {
      rejectGetState(new Error("boom"));
      await refreshPromise;
    });

    // The concurrently-detected, genuinely new alert must survive — not be clobbered back to the
    // pre-refresh-click `null` this same call cleared it to.
    expect(result.current.operationStateAlert).toEqual({ operation: "merge" });
    consoleError.mockRestore();
  });
});
