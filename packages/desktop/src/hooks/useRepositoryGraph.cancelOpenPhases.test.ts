// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useRepositoryGraph } from "./useRepositoryGraph";
import { makeMockGitHydra } from "../test/mockGitHydra";
import { makeCommit } from "../test/fixtures";
import type { IpcResult } from "../../shared/ipcContract";
import type { CommitLogPage, WorkingDirectoryChanges } from "@githydra/git-core";

/**
 * specs/repo-open-feedback-fixes.md FR-197 through FR-200: hook-level coverage for cancellation
 * extended PAST `Repository.open()`'s own phase — into `refreshAuxData` (AC1) and `startReader`'s
 * log-reader creation/first-page fetch (AC2) — plus AC3 (double-cancel) and AC4 (cancel-after-
 * settle). Mirrors `useRepositoryGraph.cancelOpen.test.ts`'s own conventions (a controllable,
 * never-auto-resolving stand-in per phase, `cancelOpen()` invoked mid-flight, then the underlying
 * IPC call resolved as a real aborted call would — `{ ok: false, error: { name:
 * "OperationCancelledError", ... } }` — never a thrown/rejected promise, matching how every real
 * cancellable IPC handler in this app surfaces a cancellation).
 */

afterEach(() => {
  // @ts-expect-error test cleanup of the global bridge
  delete window.gitHydra;
});

const CANCELLED_ERROR = { name: "OperationCancelledError", message: "The operation was cancelled." } as const;

function deferredIpcResult<T>(): {
  promise: Promise<IpcResult<T>>;
  resolveCancelled: () => void;
} {
  let resolve!: (result: IpcResult<T>) => void;
  const promise = new Promise<IpcResult<T>>((res) => {
    resolve = res;
  });
  return {
    promise,
    resolveCancelled: () => resolve({ ok: false, error: CANCELLED_ERROR }),
  };
}

describe("useRepositoryGraph — cancellation extended to the aux-data/log-reader phases (repo-open-feedback-fixes.md FR-197-200)", () => {
  it("AC1: cancelling while refreshAuxData (getWorkingDirectoryChanges) is in flight rolls back exactly like a phase-one cancellation — no rows/refs/stash count from the cancelled attempt ever render", async () => {
    const api = makeMockGitHydra({ commits: [makeCommit("a1")] });
    window.gitHydra = api;
    const deferred = deferredIpcResult<WorkingDirectoryChanges | null>();
    vi.mocked(api.getWorkingDirectoryChanges).mockReturnValueOnce(deferred.promise);
    const { result } = renderHook(() => useRepositoryGraph());

    let openPromise!: Promise<boolean>;
    act(() => {
      openPromise = result.current.openRepo("/repo");
    });
    await waitFor(() => expect(result.current.status).toBe("opening"));
    // `openRepoCancellable` itself already resolved (the mock resolves it immediately) —
    // `refreshAuxData` is now the one in flight, stuck on `getWorkingDirectoryChanges`.
    await waitFor(() => expect(api.getWorkingDirectoryChanges).toHaveBeenCalledTimes(1));

    act(() => result.current.cancelOpen());
    expect(api.cancelOpenRepo).toHaveBeenCalledTimes(1);

    deferred.resolveCancelled();
    await act(async () => {
      await openPromise;
    });

    // Same outcome contract as a phase-one cancellation: back to idle (this was a fresh tab's
    // first-ever open), never ready, never error, never any of the cancelled attempt's own data.
    expect(result.current.status).toBe("idle");
    expect(result.current.repoPath).toBeNull();
    expect(result.current.refs).toEqual([]);
    expect(result.current.workingDirChanges).toBeNull();
    expect(result.current.stashCount).toBeNull();
    expect(api.createLogReader).not.toHaveBeenCalled();

    // AC3/no-orphan: the underlying (mocked) call already "terminated" via the cancelled result
    // above; a real signal-based abort's actual process-kill behavior is covered end-to-end by
    // git-core's own `gitProcess.test.ts`/`commitLog.test.ts` suites — this asserts the RENDERER
    // side of the contract, that no further reads for this cancelled attempt are ever issued.
    expect(api.getRefs).toHaveBeenCalledTimes(1);
    expect(api.getUpstreamBranch).toHaveBeenCalledTimes(1);
  });

  it("AC1: cancelling during refreshAuxData restores a previously-ready repo's exact prior state, not the cancelled attempt's", async () => {
    const api = makeMockGitHydra({
      repoPath: "/repoA",
      commits: [makeCommit("a1", [], { subject: "Repo A commit" })],
      reposByPath: { "/repoB": { commits: [makeCommit("b1", [], { subject: "Repo B commit" })] } },
    });
    window.gitHydra = api;
    const { result } = renderHook(() => useRepositoryGraph());

    await act(async () => {
      await result.current.openRepo("/repoA");
    });
    await waitFor(() => expect(result.current.status).toBe("ready"));
    const priorRefs = result.current.refs;
    const priorRepoPath = result.current.repoPath;

    const deferred = deferredIpcResult<WorkingDirectoryChanges | null>();
    vi.mocked(api.getWorkingDirectoryChanges).mockReturnValueOnce(deferred.promise);

    let openPromise!: Promise<boolean>;
    act(() => {
      openPromise = result.current.openRepo("/repoB");
    });
    await waitFor(() => expect(result.current.status).toBe("opening"));
    await waitFor(() => expect(api.getWorkingDirectoryChanges).toHaveBeenCalledTimes(2));

    act(() => result.current.cancelOpen());
    deferred.resolveCancelled();
    await act(async () => {
      const cancelled = await openPromise;
      expect(cancelled).toBe(true);
    });

    expect(result.current.status).toBe("ready");
    expect(result.current.repoPath).toBe(priorRepoPath);
    expect(result.current.refs).toEqual(priorRefs);
    expect(result.current.repoPath).not.toBe("/repoB");
  });

  it("AC2: cancelling while startReader's first readPage is in flight rolls back — never renders the cancelled attempt's rows", async () => {
    const api = makeMockGitHydra({ commits: [makeCommit("a1")] });
    window.gitHydra = api;
    const deferred = deferredIpcResult<CommitLogPage>();
    vi.mocked(api.readPage).mockReturnValueOnce(deferred.promise);
    const { result } = renderHook(() => useRepositoryGraph());

    let openPromise!: Promise<boolean>;
    act(() => {
      openPromise = result.current.openRepo("/repo");
    });
    await waitFor(() => expect(result.current.status).toBe("opening"));
    // refreshAuxData has already resolved (default mocks are synchronous); createLogReader has
    // already produced a reader id, and the first readPage() call is now the one in flight.
    await waitFor(() => expect(api.createLogReader).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(api.readPage).toHaveBeenCalledTimes(1));

    act(() => result.current.cancelOpen());
    deferred.resolveCancelled();
    await act(async () => {
      const cancelled = await openPromise;
      expect(cancelled).toBe(true);
    });

    expect(result.current.status).toBe("idle");
    expect(result.current.displayRows).toEqual([]);
    expect(result.current.repoPath).toBeNull();
    // No orphaned reader-id left behind in this hook's own bookkeeping — `loadMore()` (were it
    // callable from idle) would have nothing to page against.
    expect(result.current.hasMore).toBe(false);
  });

  it("AC3: clicking Cancel twice in rapid succession during the aux-data phase is a genuine no-op the second time — no error, no double rollback", async () => {
    const api = makeMockGitHydra({ commits: [makeCommit("a1")] });
    window.gitHydra = api;
    const deferred = deferredIpcResult<WorkingDirectoryChanges | null>();
    vi.mocked(api.getWorkingDirectoryChanges).mockReturnValueOnce(deferred.promise);
    const { result } = renderHook(() => useRepositoryGraph());

    let openPromise!: Promise<boolean>;
    act(() => {
      openPromise = result.current.openRepo("/repo");
    });
    await waitFor(() => expect(result.current.status).toBe("opening"));
    await waitFor(() => expect(api.getWorkingDirectoryChanges).toHaveBeenCalledTimes(1));

    expect(() => {
      act(() => result.current.cancelOpen());
      act(() => result.current.cancelOpen());
    }).not.toThrow();
    // Both clicks forward the SAME requestId — `api.cancelOpenRepo`'s own idempotency (real
    // `RepoSession.cancelOpen`/`AbortController.abort()`) is what makes a second call harmless;
    // nothing here queues a second, separate rollback.
    expect(api.cancelOpenRepo).toHaveBeenCalledTimes(2);
    const [firstCallId] = vi.mocked(api.cancelOpenRepo).mock.calls[0]!;
    const [secondCallId] = vi.mocked(api.cancelOpenRepo).mock.calls[1]!;
    expect(secondCallId).toBe(firstCallId);

    deferred.resolveCancelled();
    await act(async () => {
      const cancelled = await openPromise;
      expect(cancelled).toBe(true);
    });
    expect(result.current.status).toBe("idle");
  });

  it("AC4: clicking Cancel after the attempt has already fully settled (success) is a no-op — no crash, no state change", async () => {
    const api = makeMockGitHydra({ repoPath: "/repo", commits: [makeCommit("a1", [], { subject: "Repo commit" })] });
    window.gitHydra = api;
    const { result } = renderHook(() => useRepositoryGraph());

    await act(async () => {
      await result.current.openRepo("/repo");
    });
    await waitFor(() => expect(result.current.status).toBe("ready"));
    vi.mocked(api.cancelOpenRepo).mockClear();

    expect(() => act(() => result.current.cancelOpen())).not.toThrow();
    expect(api.cancelOpenRepo).not.toHaveBeenCalled();
    expect(result.current.status).toBe("ready");
    expect(result.current.repoPath).toBe("/repo");
  });

  it("AC4: clicking Cancel after the attempt has already fully settled (genuine error) is a no-op — no crash, no state change", async () => {
    const api = makeMockGitHydra({ commits: [makeCommit("a1")] });
    window.gitHydra = api;
    vi.mocked(api.openRepoCancellable).mockResolvedValueOnce({
      outcome: "settled",
      result: { ok: false, error: { name: "NotAGitRepositoryError", message: "not a git repository" } },
    });
    const { result } = renderHook(() => useRepositoryGraph());

    await act(async () => {
      await result.current.openRepo("/broken");
    });
    await waitFor(() => expect(result.current.status).toBe("error"));

    expect(() => act(() => result.current.cancelOpen())).not.toThrow();
    expect(api.cancelOpenRepo).not.toHaveBeenCalled();
    expect(result.current.status).toBe("error");
  });

  it("no path through the sequence leaves status stuck at \"opening\" after Cancel is acknowledged (FR-200) — settles to idle even when cancelled mid-aux-data-phase", async () => {
    const api = makeMockGitHydra({ commits: [makeCommit("a1")] });
    window.gitHydra = api;
    const deferred = deferredIpcResult<WorkingDirectoryChanges | null>();
    vi.mocked(api.getWorkingDirectoryChanges).mockReturnValueOnce(deferred.promise);
    const { result } = renderHook(() => useRepositoryGraph());

    let openPromise!: Promise<boolean>;
    act(() => {
      openPromise = result.current.openRepo("/repo");
    });
    await waitFor(() => expect(result.current.status).toBe("opening"));
    act(() => result.current.cancelOpen());
    deferred.resolveCancelled();
    await act(async () => {
      await openPromise;
    });

    expect(result.current.status).not.toBe("opening");
    expect(result.current.status).toBe("idle");
  });
});
