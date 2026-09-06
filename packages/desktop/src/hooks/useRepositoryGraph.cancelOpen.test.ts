// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useRepositoryGraph } from "./useRepositoryGraph";
import { makeMockGitHydra } from "../test/mockGitHydra";
import { makeCommit } from "../test/fixtures";
import type { IpcResult, OpenRepoOutcome } from "../../shared/ipcContract";
import type { RepositoryState } from "@githydra/git-core";

/**
 * specs/repo-open-feedback.md FR-167/FR-168/FR-169/FR-170: hook-level coverage for
 * `useRepositoryGraph`'s cancellable-open wiring — `App.repoOpenCancel.test.tsx` covers the same
 * behavior through the real UI (the Cancel button, entry points); this file exercises
 * `graph.openRepo`/`graph.cancelOpen` directly so the state-restoration mechanics (which internal
 * fields do/don't need restoring — see `OpenAttemptSnapshot`'s doc comment) are covered precisely,
 * independent of any particular rendered surface.
 */

afterEach(() => {
  // @ts-expect-error test cleanup of the global bridge
  delete window.gitHydra;
});

/** Mirrors `App.repoOpenElapsed.test.tsx`'s helper — a controllable, never-auto-resolving stand-in
 * for `api.openRepoCancellable`. */
function deferredOpenRepoCancellable(): {
  promise: Promise<OpenRepoOutcome>;
  resolveSettled: (result: IpcResult<{ path: string; state: RepositoryState }>) => void;
  resolveCancelled: () => void;
} {
  let resolve!: (outcome: OpenRepoOutcome) => void;
  const promise = new Promise<OpenRepoOutcome>((res) => {
    resolve = res;
  });
  return {
    promise,
    resolveSettled: (result) => resolve({ outcome: "settled", result }),
    resolveCancelled: () => resolve({ outcome: "cancelled" }),
  };
}

describe("useRepositoryGraph — cancellable open (repo-open-feedback.md FR-167/168/169/170)", () => {
  it("FR-167: passes a requestId to openRepoCancellable, and cancelOpen() forwards that same requestId to cancelOpenRepo", async () => {
    const api = makeMockGitHydra({ commits: [makeCommit("a1")] });
    window.gitHydra = api;
    const deferred = deferredOpenRepoCancellable();
    vi.mocked(api.openRepoCancellable).mockReturnValueOnce(deferred.promise);
    const { result } = renderHook(() => useRepositoryGraph());

    let openPromise!: Promise<boolean>;
    act(() => {
      openPromise = result.current.openRepo("/repo");
    });
    await waitFor(() => expect(result.current.status).toBe("opening"));

    expect(api.openRepoCancellable).toHaveBeenCalledTimes(1);
    const [, requestId] = vi.mocked(api.openRepoCancellable).mock.calls[0]!;
    expect(typeof requestId).toBe("string");
    expect(requestId.length).toBeGreaterThan(0);

    act(() => {
      result.current.cancelOpen();
    });
    expect(api.cancelOpenRepo).toHaveBeenCalledWith(requestId);

    deferred.resolveCancelled();
    await act(async () => {
      await openPromise;
    });
  });

  it("cancelOpen() is a safe no-op when nothing is in flight (no prior open, and after a settle)", async () => {
    const api = makeMockGitHydra({ commits: [makeCommit("a1")] });
    window.gitHydra = api;
    const { result } = renderHook(() => useRepositoryGraph());

    // Nothing ever opened yet.
    act(() => result.current.cancelOpen());
    expect(api.cancelOpenRepo).not.toHaveBeenCalled();

    // A normal, already-settled open — cancelOpen afterward must still no-op (AC9: safe to call
    // speculatively/repeatedly, never throws, never double-cancels a finished attempt).
    await act(async () => {
      await result.current.openRepo("/repo");
    });
    await waitFor(() => expect(result.current.status).toBe("ready"));

    act(() => result.current.cancelOpen());
    expect(api.cancelOpenRepo).not.toHaveBeenCalled();
  });

  it("FR-168/FR-169: canceling a fresh tab's first-ever open restores the idle state — never ready, never error", async () => {
    const api = makeMockGitHydra({ commits: [makeCommit("a1")] });
    window.gitHydra = api;
    const deferred = deferredOpenRepoCancellable();
    vi.mocked(api.openRepoCancellable).mockReturnValueOnce(deferred.promise);
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

    expect(result.current.status).toBe("idle");
    expect(result.current.errorMessage).toBeNull();
    expect(result.current.repoPath).toBeNull();
    // FR-169: never the canceled attempt's error state.
    expect(result.current.status).not.toBe("error");
    // No further git reads should have been triggered for the canceled attempt.
    expect(api.getRefs).not.toHaveBeenCalled();
    expect(api.createLogReader).not.toHaveBeenCalled();
  });

  it("FR-168: canceling an open that was replacing an already-ready repo restores that exact prior repo/selection/filter, not the canceled attempt's data", async () => {
    const api = makeMockGitHydra({
      repoPath: "/repoA",
      commits: [makeCommit("a1", [], { subject: "Repo A commit" })],
      reposByPath: {
        "/repoB": { commits: [makeCommit("b1", [], { subject: "Repo B commit" })] },
      },
    });
    window.gitHydra = api;
    const { result } = renderHook(() => useRepositoryGraph());

    await act(async () => {
      await result.current.openRepo("/repoA");
    });
    await waitFor(() => expect(result.current.status).toBe("ready"));

    // Give the ready repo some state that a naive implementation could clobber. "Ada" matches
    // `makeCommit`'s default author, so the filtered view still contains the one commit — this
    // also proves the filter genuinely applied (`filter` state lands synchronously, but the
    // filtered reader's own row fetch is async, so both are awaited before capturing "prior").
    act(() => result.current.selectCommit("a1"));
    await waitFor(() => expect(result.current.commitDetail.status).toBe("ready"));
    act(() => result.current.applyFilter({ author: "Ada" }));
    await waitFor(() => expect(result.current.filter).toEqual({ author: "Ada" }));
    await waitFor(() => expect(result.current.displayRows.length).toBe(1));

    const priorRepoPath = result.current.repoPath;
    const priorFilter = result.current.filter;
    const priorSelectedSha = result.current.selectedSha;
    const priorRows = result.current.displayRows;

    const deferred = deferredOpenRepoCancellable();
    vi.mocked(api.openRepoCancellable).mockReturnValueOnce(deferred.promise);

    let openPromise!: Promise<boolean>;
    act(() => {
      openPromise = result.current.openRepo("/repoB");
    });
    await waitFor(() => expect(result.current.status).toBe("opening"));

    act(() => result.current.cancelOpen());
    deferred.resolveCancelled();
    await act(async () => {
      await openPromise;
    });

    // FR-168: exactly what was showing before this attempt — the previous repo, still ready.
    expect(result.current.status).toBe("ready");
    expect(result.current.repoPath).toBe(priorRepoPath);
    expect(result.current.filter).toEqual(priorFilter);
    expect(result.current.selectedSha).toBe(priorSelectedSha);
    expect(result.current.displayRows).toEqual(priorRows);
    // Never the canceled attempt's repo.
    expect(result.current.repoPath).not.toBe("/repoB");
  });

  it("FR-170: the exact same cancel/restore behavior applies whether openRepo is called for a brand-new path or a same-path reopen — no special-casing by caller", async () => {
    const api = makeMockGitHydra({
      repoPath: "/repo",
      commits: [makeCommit("a1", [], { subject: "Repo commit" })],
    });
    window.gitHydra = api;
    const { result } = renderHook(() => useRepositoryGraph());

    await act(async () => {
      await result.current.openRepo("/repo");
    });
    await waitFor(() => expect(result.current.status).toBe("ready"));

    const deferred = deferredOpenRepoCancellable();
    vi.mocked(api.openRepoCancellable).mockReturnValueOnce(deferred.promise);

    // A same-path reopen (e.g. a "recent entry" reopen, or a manual refresh-like reopen) still
    // goes through the identical cancellable path and restores identically on cancel.
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

    expect(result.current.status).toBe("ready");
    expect(result.current.repoPath).toBe("/repo");
  });

  it("an open that settles (success) before any cancel behaves exactly as before — no regression", async () => {
    const api = makeMockGitHydra({
      repoPath: "/repo",
      commits: [makeCommit("a1", [], { subject: "Repo commit" })],
    });
    window.gitHydra = api;
    const { result } = renderHook(() => useRepositoryGraph());

    await act(async () => {
      await result.current.openRepo("/repo");
    });
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.repoPath).toBe("/repo");
    expect(result.current.errorMessage).toBeNull();
  });

  it("an open that settles with a genuine error before any cancel still shows the error state (FR-169 scope: only a real cancel suppresses it)", async () => {
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
    expect(result.current.errorMessage).toMatch(/not a git repository/i);
  });
});
