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
 * specs/merge-rebase-conflict-resolution.md FR-59/AC11: the watcher-change handler in
 * `useRepositoryGraph` must tell "an in-progress-operation change" apart from "ordinary ref
 * churn" and react differently to each — see that handler's own doc comment for the full
 * reasoning. These tests simulate the watcher firing (by invoking the callback captured from
 * `api.onRefsChanged`) exactly as `watchRepositoryRefs`'s real debounced `onChange` would, and
 * assert on the *effect* of that firing (an automatic re-fetch actually landing in state), not
 * just a flag being set — mirroring test-agent's live reproduction (a real mid-merge repo, an
 * external `git merge --abort`, banner/conflicted-count going stale for 11+ seconds until a
 * manual click).
 */
describe("useRepositoryGraph — watcher-driven refresh (FR-59/AC11)", () => {
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

  it("auto-refreshes repoState + workingDirStatus silently when an operation-state change is detected, without surfacing the generic banner", async () => {
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

    await waitFor(() => expect(result.current.repoState?.inProgressOperation).toBe("merge"));
    expect(result.current.workingDirStatus?.conflicted).toBe(2);
    // The dangerous-if-stale banner data updated automatically — no generic "history changed"
    // prompt needed for this path.
    expect(result.current.hasExternalChanges).toBe(false);
  });

  it("bumps operationStateChangeSequence on a real operation-state change, so a caller (App) can refresh other operation-state-dependent UI it doesn't know about (AC11 follow-up: the Changes panel's own conflicted-file list)", async () => {
    const { api, result, fireWatcher } = await openReadyRepo({
      repoState: { inProgressOperation: null, inProgressOperationDetail: null },
      workingDirStatus: { hasChanges: false, staged: 0, unstaged: 0, untracked: 0, conflicted: 0 },
    });
    const before = result.current.operationStateChangeSequence;

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

    await waitFor(() => expect(result.current.operationStateChangeSequence).toBe(before + 1));
  });

  it("does not bump operationStateChangeSequence for ordinary ref churn (no operation-state change)", async () => {
    const { api, result, fireWatcher } = await openReadyRepo({
      repoState: { inProgressOperation: null, inProgressOperationDetail: null },
      workingDirStatus: { hasChanges: false, staged: 0, unstaged: 0, untracked: 0, conflicted: 0 },
    });
    const before = result.current.operationStateChangeSequence;

    vi.mocked(api.getState).mockResolvedValueOnce({
      ok: true,
      data: makeRepoState({ inProgressOperation: null, inProgressOperationDetail: null, headSha: "c1" }),
    });

    await fireWatcher();

    await waitFor(() => expect(result.current.hasExternalChanges).toBe(true));
    expect(result.current.operationStateChangeSequence).toBe(before);
  });

  it("clears the operation banner automatically when an external `git merge --abort` removes MERGE_HEAD (test-agent's exact live repro)", async () => {
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

    await waitFor(() => expect(result.current.repoState?.inProgressOperation).toBeNull());
    expect(result.current.workingDirStatus?.conflicted).toBe(0);
    expect(result.current.hasExternalChanges).toBe(false);
  });

  it("still surfaces the generic 'History changed outside GitHydra' banner for ordinary ref churn, and does not touch repoState/workingDirStatus (FR-6 precedent unchanged)", async () => {
    const { api, result, fireWatcher } = await openReadyRepo({
      repoState: { inProgressOperation: null, inProgressOperationDetail: null },
      workingDirStatus: { hasChanges: false, staged: 0, unstaged: 0, untracked: 0, conflicted: 0 },
    });

    const priorRepoState = result.current.repoState;
    const priorWorkingDirStatus = result.current.workingDirStatus;

    // Ordinary churn: getState reports the exact same operation identity as before (a branch
    // moved / a teammate pushed, nothing operation-related changed).
    vi.mocked(api.getState).mockResolvedValueOnce({
      ok: true,
      data: makeRepoState({ inProgressOperation: null, inProgressOperationDetail: null, headSha: "c1" }),
    });

    await fireWatcher();

    await waitFor(() => expect(result.current.hasExternalChanges).toBe(true));
    // Unlike the operation-change path, this one does not silently mutate state out from under a
    // mid-scroll/mid-selection user — repoState/workingDirStatus are left exactly as they were.
    expect(result.current.repoState).toEqual(priorRepoState);
    expect(result.current.workingDirStatus).toEqual(priorWorkingDirStatus);
    // And it must not have spent a call re-fetching working-dir status for this path.
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
  });
});
