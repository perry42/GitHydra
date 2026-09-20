// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useRepositoryGraph } from "./useRepositoryGraph";
import { makeMockGitHydra } from "../test/mockGitHydra";
import { makeCommit } from "../test/fixtures";
import type { IpcResult } from "../../shared/ipcContract";
import type { WorkingDirectoryChanges } from "@githydra/git-core";

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
 * Bug fix regression coverage (CLAUDE.md's "Known pitfalls" — the same bug class already fixed
 * once for `refreshRefsAndRows`/`refreshRefsAndRowsInBackground`, see that function's own test file
 * for the original write-up): every production call site of `refreshWorkingDirStatus`
 * (`App.tsx`'s `refreshAfterBranchOp`, `refreshAfterStashOp`, `selectCheckpoint`, and
 * `ChangesPanel`'s `onWorkingDirChanged`) invokes it fire-and-forget
 * (`void graph.refreshWorkingDirStatus()`), never awaiting or catching its result.
 * `refreshWorkingDirStatus` itself still `unwrap()`s its result, which throws on a genuine
 * failure — so the fix is `refreshWorkingDirStatusInBackground`, a wrapper that never rejects, for
 * exactly these fire-and-forget call sites to use instead (and which they've all been switched to).
 * This test reproduces the exact race directly against the hook's own public API, with no mocked
 * internals and no reaching into React internals.
 */
describe("useRepositoryGraph — refreshWorkingDirStatusInBackground never lets a stale-repo refresh escape as an unhandled rejection", () => {
  it("resolves cleanly (never throws, never triggers an unhandled rejection) when the repo closes while the underlying read is still in flight", async () => {
    const { api, result } = await openReadyRepo();

    // Control point: `getWorkingDirectoryChanges` is the read `refreshWorkingDirStatus` awaits —
    // held pending here to stand in for a main-process read that's still mid-flight at the exact
    // moment the repo closes out from under it (a tab close, "+ New tab").
    let rejectGetChanges!: (err: unknown) => void;
    const stalled = new Promise<IpcResult<WorkingDirectoryChanges | null>>((_resolve, reject) => {
      rejectGetChanges = reject;
    });
    vi.mocked(api.getWorkingDirectoryChanges).mockReturnValueOnce(stalled);

    const unhandled: unknown[] = [];
    const onUnhandledRejection = (err: unknown) => unhandled.push(err);
    process.on("unhandledRejection", onUnhandledRejection);

    let backgroundRefreshPromise!: Promise<void>;
    act(() => {
      // Mirrors App.tsx's real call sites: fire-and-forget, nothing here awaits or catches it.
      backgroundRefreshPromise = result.current.refreshWorkingDirStatusInBackground();
    });

    // The repo closes while the refresh above is still stuck at its very first await — this is
    // what bumps `generationRef.current` synchronously, exactly as it would in real usage
    // (`closeRepo`'s own implementation bumps it before its own first `await`).
    await act(async () => {
      await result.current.closeRepo();
    });

    // The stale read now finally settles, with the exact failure shape a torn-down session
    // produces (`RepoSession.getOpenRepo()`'s `"No repository is open"`).
    rejectGetChanges(new Error("No repository is open"));

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

    vi.mocked(api.getWorkingDirectoryChanges).mockRejectedValueOnce(new Error("boom: transient git failure"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    await act(async () => {
      await expect(result.current.refreshWorkingDirStatusInBackground()).resolves.toBeUndefined();
    });

    expect(consoleError).toHaveBeenCalledWith(
      "GitHydra: background working-directory status refresh failed",
      expect.any(Error),
    );
    consoleError.mockRestore();
  });
});
