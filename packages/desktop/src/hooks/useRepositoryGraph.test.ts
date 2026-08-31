import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useRepositoryGraph } from "./useRepositoryGraph";
import { makeMockGitHydra } from "../test/mockGitHydra";
import { makeCommit, makeRepoState } from "../test/fixtures";

afterEach(() => {
  // @ts-expect-error test cleanup of the global bridge
  delete window.gitHydra;
});

/**
 * specs/graph-head-indicator-and-refresh-alerting.md Problem 2: revises FR-59/AC11's original
 * silent-auto-refresh plan. The watcher-change handler in `useRepositoryGraph` still tells "an
 * in-progress-operation change" apart from "ordinary ref churn" (same detection logic as before —
 * see that handler's own doc comment), but the *response* to an operation-state change is now an
 * alert (`operationStateAlert`), never a silent apply — matching FR-6's existing "alert, don't
 * silently apply" precedent for ordinary ref churn, just with distinct, operation-naming state.
 * These tests simulate the watcher firing (by invoking the callback captured from
 * `api.onRefsChanged`) exactly as `watchRepositoryRefs`'s real debounced `onChange` would, and
 * assert on the *effect* of that firing — mirroring test-agent's live reproduction (a real
 * mid-merge repo, an external `git merge --abort`).
 */
describe("useRepositoryGraph — watcher-driven refresh alerting (graph-head-indicator-and-refresh-alerting.md Problem 2)", () => {
  async function openReadyRepo(apiOverrides: Parameters<typeof makeMockGitHydra>[0] = {}) {
    const api = makeMockGitHydra({
      commits: [makeCommit("c1")],
      ...apiOverrides,
    });
    let onRefsChangedListener: (() => void) | null = null;
    vi.mocked(api.onRefsChanged).mockImplementation((listener) => {
      onRefsChangedListener = listener;
      return () => {
        onRefsChangedListener = null;
      };
    });

    // The hook creates its own `api` internally via `getGitHydraApi()`, which reads the global
    // `window.gitHydra` bridge stub at call time — must be set before the hook mounts, same
    // convention every other test in this suite (App.test.tsx et al.) uses.
    window.gitHydra = api;
    const { result } = renderHook(() => useRepositoryGraph());

    await act(async () => {
      await result.current.openRepo("/repo");
    });
    await waitFor(() => expect(result.current.status).toBe("ready"));

    const fireWatcher = async () => {
      expect(onRefsChangedListener).not.toBeNull();
      await act(async () => {
        onRefsChangedListener!();
        // Let the handler's internal `await api.getState()` / `await api.getWorkingDirStatus()`
        // microtasks flush.
        await Promise.resolve();
        await Promise.resolve();
      });
    };

    return { api, result, fireWatcher };
  }

  it("surfaces a distinct operationStateAlert (naming the operation) instead of silently applying repoState/workingDirStatus when an operation-state change is detected", async () => {
    const { api, result, fireWatcher } = await openReadyRepo({
      repoState: { inProgressOperation: null, inProgressOperationDetail: null },
      workingDirStatus: { hasChanges: false, staged: 0, unstaged: 0, untracked: 0, conflicted: 0 },
    });

    expect(result.current.repoState?.inProgressOperation).toBeNull();

    // Simulate a `git merge` started from a separate terminal: getState now reports an
    // in-progress merge with conflicts, exactly as a fresh disk read would after MERGE_HEAD
    // appears.
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
    vi.mocked(api.getState).mockResolvedValueOnce({ ok: true, data: mergingState });
    vi.mocked(api.getWorkingDirStatus).mockResolvedValueOnce({
      ok: true,
      data: { hasChanges: true, staged: 0, unstaged: 0, untracked: 0, conflicted: 2 },
    });

    await fireWatcher();

    // The alert names the detected operation...
    await waitFor(() => expect(result.current.operationStateAlert).toEqual({ operation: "merge" }));
    // ...but nothing was silently applied: the previously-displayed state persists until Refresh.
    expect(result.current.repoState?.inProgressOperation).toBeNull();
    expect(result.current.workingDirStatus?.conflicted).toBe(0);
    // And this is a distinct alert, not the generic ref-churn banner flag.
    expect(result.current.hasExternalChanges).toBe(false);
    // Nor did it spend a call re-fetching working-dir status before the user acknowledges it.
    expect(api.getWorkingDirStatus).toHaveBeenCalledTimes(1); // only the initial openRepo fetch.
  });

  it("surfaces operationStateAlert (naming the previous operation) when an external abort clears MERGE_HEAD (test-agent's exact live repro)", async () => {
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
    const { api, result, fireWatcher } = await openReadyRepo({
      repoState: mergingState,
      workingDirStatus: { hasChanges: true, staged: 0, unstaged: 0, untracked: 0, conflicted: 2 },
    });

    await waitFor(() => expect(result.current.repoState?.inProgressOperation).toBe("merge"));

    // `git merge --abort` from a separate terminal: MERGE_HEAD is gone, conflicts are cleared.
    const abortedState = makeRepoState({ inProgressOperation: null, inProgressOperationDetail: null });
    vi.mocked(api.getState).mockResolvedValueOnce({ ok: true, data: abortedState });
    vi.mocked(api.getWorkingDirStatus).mockResolvedValueOnce({
      ok: true,
      data: { hasChanges: false, staged: 0, unstaged: 0, untracked: 0, conflicted: 0 },
    });

    await fireWatcher();

    // Named after the *previous* operation (merge), since that's what the still-displayed banner
    // is about and what the user needs Refresh to reconcile.
    await waitFor(() => expect(result.current.operationStateAlert).toEqual({ operation: "merge" }));
    // Stale-but-previously-correct state persists — no silent apply.
    expect(result.current.repoState?.inProgressOperation).toBe("merge");
    expect(result.current.workingDirStatus?.conflicted).toBe(2);
  });

  it("does not surface operationStateAlert for ordinary ref churn (no operation-state change) — falls back to hasExternalChanges, FR-6 precedent unchanged", async () => {
    const { api, result, fireWatcher } = await openReadyRepo({
      repoState: { inProgressOperation: null, inProgressOperationDetail: null },
      workingDirStatus: { hasChanges: false, staged: 0, unstaged: 0, untracked: 0, conflicted: 0 },
    });

    const priorRepoState = result.current.repoState;
    const priorWorkingDirStatus = result.current.workingDirStatus;

    // Ordinary churn: getState reports the same operation identity as before (nothing operation-
    // related changed) but a genuinely different HEAD — specs/self-write-refresh-suppression.md's
    // expected-diff comparison (folded into this same watcher-fired handler) only alerts on a real
    // mismatch against the last confirmed snapshot, so this must actually differ, not just repeat
    // the same state, to exercise "a branch moved / a teammate pushed" rather than a no-op fire.
    vi.mocked(api.getState).mockResolvedValueOnce({
      ok: true,
      data: makeRepoState({ inProgressOperation: null, inProgressOperationDetail: null, headSha: "c2" }),
    });

    await fireWatcher();

    await waitFor(() => expect(result.current.hasExternalChanges).toBe(true));
    expect(result.current.operationStateAlert).toBeNull();
    // Unchanged from FR-6's precedent: repoState/workingDirStatus are left exactly as they were.
    expect(result.current.repoState).toEqual(priorRepoState);
    expect(result.current.workingDirStatus).toEqual(priorWorkingDirStatus);
    // And it must not have spent a call re-fetching working-dir status for this path.
    expect(api.getWorkingDirStatus).toHaveBeenCalledTimes(1); // only the initial openRepo fetch.
  });

  it("clicking refresh() applies the new repoState/workingDirStatus and clears operationStateAlert (AC3/AC5)", async () => {
    const { api, result, fireWatcher } = await openReadyRepo({
      repoState: { inProgressOperation: null, inProgressOperationDetail: null },
      workingDirStatus: { hasChanges: false, staged: 0, unstaged: 0, untracked: 0, conflicted: 0 },
    });

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
    vi.mocked(api.getState).mockResolvedValueOnce({ ok: true, data: mergingState });
    vi.mocked(api.getWorkingDirStatus).mockResolvedValueOnce({
      ok: true,
      data: { hasChanges: true, staged: 0, unstaged: 0, untracked: 0, conflicted: 2 },
    });

    await fireWatcher();
    await waitFor(() => expect(result.current.operationStateAlert).toEqual({ operation: "merge" }));

    // Refresh re-fetches everything via the normal `openRepo` path (same convention other tests in
    // this suite use to simulate "the repo now looks like this on disk" — `openRepo`'s mock reads
    // its own record snapshot for `state`, not the `getState` mock's queued responses, which the
    // watcher's own `getState` call above already consumed).
    vi.mocked(api.openRepo).mockResolvedValueOnce({
      ok: true,
      data: { path: "/repo", state: mergingState },
    });
    vi.mocked(api.getWorkingDirStatus).mockResolvedValueOnce({
      ok: true,
      data: { hasChanges: true, staged: 0, unstaged: 0, untracked: 0, conflicted: 2 },
    });

    await act(async () => {
      await result.current.refresh();
    });

    expect(result.current.operationStateAlert).toBeNull();
    expect(result.current.repoState?.inProgressOperation).toBe("merge");
    expect(result.current.workingDirStatus?.conflicted).toBe(2);
  });

  it("still surfaces the generic 'History changed outside GitHydra' banner for ordinary ref churn, and does not touch repoState/workingDirStatus (FR-6 precedent unchanged)", async () => {
    const { api, result, fireWatcher } = await openReadyRepo({
      repoState: { inProgressOperation: null, inProgressOperationDetail: null },
      workingDirStatus: { hasChanges: false, staged: 0, unstaged: 0, untracked: 0, conflicted: 0 },
    });

    const priorRepoState = result.current.repoState;
    const priorWorkingDirStatus = result.current.workingDirStatus;

    // Genuinely different HEAD (see the previous test's comment on why this must actually differ).
    vi.mocked(api.getState).mockResolvedValueOnce({
      ok: true,
      data: makeRepoState({ inProgressOperation: null, inProgressOperationDetail: null, headSha: "c2" }),
    });

    await fireWatcher();

    await waitFor(() => expect(result.current.hasExternalChanges).toBe(true));
    expect(result.current.repoState).toEqual(priorRepoState);
    expect(result.current.workingDirStatus).toEqual(priorWorkingDirStatus);
    expect(api.getWorkingDirStatus).toHaveBeenCalledTimes(1); // only the initial openRepo fetch.
  });

  it("clears hasExternalChanges on manual refresh, same as before this change", async () => {
    const { api, result, fireWatcher } = await openReadyRepo();
    vi.mocked(api.getState).mockResolvedValueOnce({
      ok: true,
      data: makeRepoState({ inProgressOperation: null, inProgressOperationDetail: null }),
    });
    await fireWatcher();
    await waitFor(() => expect(result.current.hasExternalChanges).toBe(true));

    await act(async () => {
      await result.current.refresh();
    });
    expect(result.current.hasExternalChanges).toBe(false);
    expect(result.current.operationStateAlert).toBeNull();
  });
});
