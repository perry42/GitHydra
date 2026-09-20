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
 * test-agent finding (independent verification of fix/roadmap-code-review-cleanup, 2026-09-20):
 * a real full-suite `npm run test --workspace=packages/desktop` run surfaced exactly this shape of
 * unhandled rejection live, from `App.push.e2e.test.tsx`'s run:
 *
 *   GitCommandError: git rev-parse --show-toplevel exited with code 128: fatal: failed to stat
 *   '.../.tmp-test-repos/githydra-desktop-e2e-...': No such file or directory
 *     at unwrap src/hooks/gitHydraClient.ts:24:25
 *     at src/hooks/useRepositoryGraph.ts:1649:26   <- inside refreshRefs, at `unwrap(stateResult)`
 *
 * This is the SAME bug class already fixed twice in this codebase for its siblings
 * (`refreshRefsAndRows` -> `refreshRefsAndRowsInBackground`, CLAUDE.md's documented pitfall; and
 * `refreshWorkingDirStatus` -> `refreshWorkingDirStatusInBackground`, this same branch's own fix)
 * but `refreshRefs` itself has never gotten the same treatment, despite being invoked
 * fire-and-forget from MANY call sites in `App.tsx` (`void graph.refreshRefs(expected)` directly,
 * and as an unawaited `onMutationSettled: graph.refreshRefs` callback in at least half a dozen
 * mutation hooks) exactly like its two already-fixed siblings were. `refreshRefs` still
 * `unwrap()`s its `getState`/`getRefs`/`getUpstreamBranch` results (line ~1649), which throws on
 * any failure — including the generation check at the line above NOT catching every real-world
 * "the repo this call was reading is gone" case (e.g. the backing directory disappearing from disk
 * without `closeRepo()`/`openRepo()` ever bumping `generationRef`, as happens here and in any real
 * external deletion).
 *
 * Confirmed via `git diff main...fix/roadmap-code-review-cleanup` that no call site of
 * `refreshRefs` was touched by this branch — this is a pre-existing gap, not a regression
 * introduced by it. Left here as a red regression test for whichever engineer picks up the
 * `refreshRefsInBackground()` fix (same shape as its two siblings) and switches `App.tsx`'s
 * fire-and-forget call sites over to it.
 */
describe("useRepositoryGraph — refreshRefs is invoked fire-and-forget throughout App.tsx but has no *InBackground safe variant (unlike its two siblings)", () => {
  it("[currently RED — see file doc comment] should not let a stale/closed-repo refreshRefs failure escape as an unhandled rejection when called fire-and-forget", async () => {
    const { api, result } = await openReadyRepo();

    // Control point: `getState` is the first read `refreshRefs` awaits (via `Promise.all`) — held
    // pending here to stand in for a main-process read that's still mid-flight at the exact moment
    // the repo closes (or its backing directory disappears) out from under it.
    let rejectGetState!: (err: unknown) => void;
    const stalled = new Promise<IpcResult<RepositoryState>>((_resolve, reject) => {
      rejectGetState = reject;
    });
    vi.mocked(api.getState).mockReturnValueOnce(stalled);

    const unhandled: unknown[] = [];
    const onUnhandledRejection = (err: unknown) => unhandled.push(err);
    process.on("unhandledRejection", onUnhandledRejection);

    act(() => {
      // Mirrors App.tsx's real call sites (e.g. `refreshAfterBranchOp`): fire-and-forget, nothing
      // here awaits or catches it.
      void result.current.refreshRefs();
    });

    await act(async () => {
      await result.current.closeRepo();
    });

    // The stale read now finally settles, with the exact failure shape a torn-down/deleted repo
    // produces.
    rejectGetState(new Error("No repository is open"));

    // Give the rejection a chance to surface as unhandled before asserting.
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    process.off("unhandledRejection", onUnhandledRejection);
    // This is the assertion that currently FAILS: `refreshRefs`'s throw escapes as a real
    // unhandled rejection because nothing fire-and-forget-safe wraps it, unlike
    // `refreshRefsAndRowsInBackground`/`refreshWorkingDirStatusInBackground`.
    expect(unhandled).toEqual([]);
  });
});
