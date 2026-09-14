// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useRepositoryGraph } from "./useRepositoryGraph";
import { makeMockGitHydra } from "../test/mockGitHydra";
import { makeCommit } from "../test/fixtures";
import type { IpcResult } from "../../shared/ipcContract";
import type { RepositoryState } from "@githydra/git-core";

afterEach(() => {
  // @ts-expect-error test cleanup of the global bridge
  delete window.gitHydra;
  vi.restoreAllMocks();
});

async function openReadyRepo() {
  const api = makeMockGitHydra({ commits: [makeCommit("c1")] });
  window.gitHydra = api;
  const { result } = renderHook(() => useRepositoryGraph());
  await act(async () => {
    await result.current.openRepo("/repo");
  });
  await waitFor(() => expect(result.current.status).toBe("ready"));
  return { api, result };
}

/**
 * Bug fix regression coverage: a real full-suite run of `App.cherryPick.e2e.test.tsx` surfaced an
 * unhandled promise rejection (`Error: No repository is open`) escaping from
 * `useRepositoryGraph.ts`'s `refreshRefsAndRows` — App.tsx's two production call sites
 * (`cherryPickActions`'s `onSettled`, `StatusBanner`'s `onOperationChanged`) both invoke it
 * fire-and-forget (`() => void graph.refreshRefsAndRows()`), never awaiting or catching its result.
 * `refreshRefsAndRows` itself deliberately still throws on a genuine failure (`refresh()` depends
 * on observing that throw to correctly restore `hasExternalChanges`/`operationStateAlert` — see its
 * own doc comment) — so the fix is `refreshRefsAndRowsInBackground`, a wrapper that never rejects,
 * for exactly these fire-and-forget call sites to use instead. See that function's own
 * implementation comment in `useRepositoryGraph.ts` for the full root-cause analysis, including why
 * this is a real (if narrow) production risk, not just a test-cleanup artifact: a user can close a
 * tab, or open a different repo, while an earlier cherry-pick/Continue/Abort settle callback's
 * refresh is still mid-flight, in exactly the same shape this test reproduces directly (no mocked
 * internals, no reaching into React internals — just the hook's own public API).
 */
describe("useRepositoryGraph — refreshRefsAndRowsInBackground never lets a stale-repo refresh escape as an unhandled rejection", () => {
  it("resolves cleanly (never throws, never triggers an unhandled rejection) when the repo closes while the underlying read is still in flight", async () => {
    const { api, result } = await openReadyRepo();

    // Control point: `getState` is the first read `refreshRefsAndRows` awaits (via `Promise.all`)
    // — held pending here to stand in for a main-process read that's still mid-flight at the exact
    // moment the repo closes out from under it (a tab close, "+ New tab").
    let rejectGetState!: (err: unknown) => void;
    const stalled = new Promise<IpcResult<RepositoryState>>((_resolve, reject) => {
      rejectGetState = reject;
    });
    vi.mocked(api.getState).mockReturnValueOnce(stalled);

    const unhandled: unknown[] = [];
    const onUnhandledRejection = (err: unknown) => unhandled.push(err);
    process.on("unhandledRejection", onUnhandledRejection);

    let backgroundRefreshPromise!: Promise<void>;
    act(() => {
      // Mirrors App.tsx's real call sites: fire-and-forget, nothing here awaits or catches it.
      backgroundRefreshPromise = result.current.refreshRefsAndRowsInBackground();
    });

    // The repo closes while the refresh above is still stuck at its very first await — this is
    // what bumps `generationRef.current` synchronously, exactly as it would in real usage
    // (`closeRepo`'s own implementation bumps it before its own first `await`).
    await act(async () => {
      await result.current.closeRepo();
    });

    // The stale read now finally settles, with the exact failure shape a torn-down session
    // produces (`RepoSession.getOpenRepo()`'s `"No repository is open"`).
    rejectGetState(new Error("No repository is open"));

    await expect(backgroundRefreshPromise).resolves.toBeUndefined();

    // Give any leftover microtask/macrotask a chance to surface as an unhandled rejection before
    // asserting none did.
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    process.off("unhandledRejection", onUnhandledRejection);
    expect(unhandled).toEqual([]);
    expect(result.current.status).toBe("idle");
  });

  it("still surfaces a console diagnostic (but never throws) for a genuine failure that is NOT a stale/closed-repo race", async () => {
    const { api, result } = await openReadyRepo();

    vi.mocked(api.getState).mockRejectedValueOnce(new Error("boom: transient git failure"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    await act(async () => {
      await expect(result.current.refreshRefsAndRowsInBackground()).resolves.toBeUndefined();
    });

    expect(consoleError).toHaveBeenCalledWith("GitHydra: background refresh failed", expect.any(Error));
    consoleError.mockRestore();
  });
});
