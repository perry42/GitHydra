import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { RefInfo, RepositoryState } from "@githydra/git-core";
import type { GitHydraApi, IpcResult } from "../../shared/ipcContract";
import { useRepositoryGraph } from "./useRepositoryGraph";
import { makeMockGitHydra } from "../test/mockGitHydra";
import { makeCommit, makeLocalBranch } from "../test/fixtures";

/**
 * specs/self-write-refresh-suppression.md — proves FR-6a (state-comparison, not "any watcher fire
 * means external") and FR-6b (a real in-flight gate tied to the operation's own lifecycle, not a
 * guessed timeout) directly against the hook, independent of which UI surface (BranchesPanel row,
 * graph context menu) eventually drives `beginMutation`/`refreshRefs` in production.
 *
 * AC5 fix (test-agent finding): the confirming read used to blindly trust its *entire* fresh
 * ref/HEAD read as self-caused, so a concurrent external write that landed before that read fired
 * got silently folded into the new baseline — no banner, ever. The fix (see `selfWriteGate.ts`)
 * diffs the fresh read against the operation's pre-mutation baseline and its *actual* known outcome
 * (`ExpectedRefOutcome`, threaded through `refreshRefs`); anything beyond that is still flagged.
 * The dedicated AC5 test below deliberately does NOT use a `mockResolvedValueOnce` FIFO chain —
 * those are consumed in guaranteed order and structurally cannot reproduce two independent actors
 * racing to land on disk before a read fires. Instead it uses a real `setTimeout`-driven write
 * against a live, shared, mutable array the mock reads from directly, so the "external write"'s
 * timing relative to our own operation's confirming read is genuinely uncontrolled by test
 * bookkeeping — the closest a hook-only (non-multi-process) test can get to the real race
 * test-agent reproduced with two OS processes.
 */

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

function externalRef(targetCommitSha: string): RefInfo {
  return {
    fullName: "refs/heads/someone-elses-branch",
    shortName: "someone-elses-branch",
    type: "local-branch",
    targetCommitSha,
    isAnnotatedTag: false,
    isSymbolic: false,
  };
}

/** Flushes real microtask + macrotask queues so fire-and-forget async work started deep inside a
 * synchronous callback has a chance to actually finish before the test asserts on its result — a
 * plain `await Promise.resolve()` isn't reliably enough hops for a chain of `Promise.all`s. */
async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/** Mirrors what `useBranchActions.switchTo` actually does: issue the real mutating call and read
 * back its own real returned sha, rather than a value the test guesses/hardcodes — the whole point
 * of the AC5 fix is that the expected outcome always comes from the operation's own return value. */
async function switchBranchAndGetSha(api: GitHydraApi, branchName: string): Promise<string> {
  const r = await api.switchBranch(branchName);
  if (!r.ok) throw new Error("mock switchBranch unexpectedly failed");
  return r.data.sha;
}

/** Grabs the listener the hook most recently registered via `api.onRefsChanged` — simulates the
 * fs watcher firing, exactly as `repoSession.ts`/`watcher.ts` would forward a real fs event. */
function fireWatcher(api: GitHydraApi): void {
  const calls = vi.mocked(api.onRefsChanged).mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  const listener = calls[calls.length - 1]![0];
  act(() => listener());
}

afterEach(() => {
  // @ts-expect-error test cleanup of the global bridge
  delete window.gitHydra;
  vi.restoreAllMocks();
});

describe("useRepositoryGraph — self-write refresh suppression (specs/self-write-refresh-suppression.md)", () => {
  it("AC1/AC2: a self-caused checkout never sets hasExternalChanges, even once refreshRefs has resolved and the watcher fires after it", async () => {
    const api = makeMockGitHydra({ commits: [makeCommit("c1")], refs: [mainRef("c1")] });
    window.gitHydra = api;
    const { result } = renderHook(() => useRepositoryGraph());
    await act(async () => {
      await result.current.openRepo("/repo");
    });
    expect(result.current.status).toBe("ready");

    // Mirrors useBranchActions.switchTo: gate opens before the mutating call, the mutating call
    // runs, then the app's own confirming read (refreshRefs) resolves with the operation's actual
    // known outcome (mirroring what switchTo derives from SwitchResult + the branch it targeted).
    act(() => result.current.beginMutation());
    let sha = "";
    await act(async () => {
      sha = await switchBranchAndGetSha(api, "feature");
    });
    await act(async () => {
      await result.current.refreshRefs({ sha, currentBranch: "feature" });
    });
    expect(result.current.hasExternalChanges).toBe(false);

    // The watcher's own debounced fs event for that exact same write arrives afterward.
    fireWatcher(api);
    await flush();
    expect(result.current.hasExternalChanges).toBe(false);
  });

  it("AC1: never shows the false positive across 5+ consecutive self-caused checkouts in one session", async () => {
    const api = makeMockGitHydra({ commits: [makeCommit("c1")], refs: [mainRef("c1")] });
    window.gitHydra = api;
    const { result } = renderHook(() => useRepositoryGraph());
    await act(async () => {
      await result.current.openRepo("/repo");
    });

    const branches = ["a", "b", "c", "d", "e"];
    for (const branch of branches) {
      act(() => result.current.beginMutation());
      let sha = "";
      await act(async () => {
        sha = await switchBranchAndGetSha(api, branch);
      });
      await act(async () => {
        await result.current.refreshRefs({ sha, currentBranch: branch });
      });
      fireWatcher(api);
      await flush();
      expect(result.current.hasExternalChanges).toBe(false);
    }
  });

  it("AC3: still correctly no-ops for a self-caused write even when the watcher's fs event is artificially delayed 2.5s past the operation — proves state comparison, not a longer timer in disguise", async () => {
    const api = makeMockGitHydra({ commits: [makeCommit("c1")], refs: [mainRef("c1")] });
    window.gitHydra = api;
    const { result } = renderHook(() => useRepositoryGraph());
    await act(async () => {
      await result.current.openRepo("/repo");
    });

    act(() => result.current.beginMutation());
    let sha = "";
    await act(async () => {
      sha = await switchBranchAndGetSha(api, "feature");
    });
    await act(async () => {
      await result.current.refreshRefs({ sha, currentBranch: "feature" });
    });
    expect(result.current.hasExternalChanges).toBe(false);

    // Any fixed-window suppression (500ms, 1s, whatever) would have long since expired by here —
    // if the mechanism were secretly timer-based, this delayed fire would flip the flag. It
    // doesn't, because nothing about `evaluateWatcherEvent` depends on elapsed time at all.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 2500));
    });
    fireWatcher(api);
    await flush();
    expect(result.current.hasExternalChanges).toBe(false);
  }, 10000);

  it("AC4/AC7: a genuine external change while idle (no operation in flight) still sets hasExternalChanges, unchanged from today", async () => {
    const api = makeMockGitHydra({ commits: [makeCommit("c1")], refs: [mainRef("c1")] });
    window.gitHydra = api;
    const { result } = renderHook(() => useRepositoryGraph());
    await act(async () => {
      await result.current.openRepo("/repo");
    });
    expect(result.current.hasExternalChanges).toBe(false);

    // A teammate/hook/other terminal changes HEAD — nothing GitHydra itself confirmed.
    const externalState: RepositoryState = {
      gitDir: "/repo/.git",
      commonGitDir: "/repo/.git",
      workdir: "/repo",
      isBare: false,
      isShallow: false,
      isWorktree: false,
      isEmpty: false,
      isUnbornHead: false,
      isDetachedHead: false,
      currentBranch: "external-branch",
      headSha: "c1",
      inProgressOperation: null,
      inProgressOperationDetail: null,
    };
    vi.mocked(api.getState).mockResolvedValueOnce(ok(externalState));
    vi.mocked(api.getRefs).mockResolvedValueOnce(ok([mainRef("c1")]));

    fireWatcher(api);
    await flush();
    expect(result.current.hasExternalChanges).toBe(true);
  });

  it("AC5 (real race, not a mocked FIFO chain): an external ref write that lands on disk during an app-initiated operation's in-flight window is still surfaced once the gate closes, not silently folded into the confirming read's baseline", async () => {
    // A live, shared, mutable array — the mock's `getRefs()` reads straight from it (see
    // `mockGitHydra.ts`'s `buildRecord`, which stores this exact reference, not a clone) — so
    // mutating it from a real timer callback genuinely changes what the *next* `getRefs()` call
    // observes, independent of any mock call-order bookkeeping.
    const refsOnDisk: RefInfo[] = [mainRef("c1"), featureRef("c1")];
    const api = makeMockGitHydra({
      commits: [makeCommit("c1")],
      refs: refsOnDisk,
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

    // Our own checkout begins — captures the pre-mutation baseline (2 refs, HEAD on main).
    act(() => result.current.beginMutation());

    // A second, independent actor (standing in for a real second OS process/teammate terminal)
    // writes a brand new branch ref straight onto the same "disk" on a real timer — racing against
    // our own operation's timeline with genuinely uncontrolled interleaving. Scheduled *before* we
    // even await our own mutating call, so it has every opportunity to land before our confirming
    // read fires, exactly like test-agent's reproduction (external write landing 5-250ms in).
    let externalWriteLanded = false;
    const externalWrite = new Promise<void>((resolve) => {
      setTimeout(() => {
        refsOnDisk.push(externalRef("c1"));
        externalWriteLanded = true;
        resolve();
      }, 30);
    });

    const switchResult = await act(async () => {
      const r = await api.switchBranch("feature");
      if (!r.ok) throw new Error("mock switchBranch unexpectedly failed");
      return r.data;
    });

    // Don't artificially serialize anything further — just make sure the external write has truly
    // landed (real elapsed time, not a mock queue position) before our own confirming read fires,
    // reproducing the failure window test-agent found (external write before the confirming read).
    await externalWrite;
    expect(externalWriteLanded).toBe(true);

    await act(async () => {
      await result.current.refreshRefs({ sha: switchResult.sha, currentBranch: "feature" });
    });

    // Before the fix: the confirming read's fresh snapshot (2 self-caused ref state + 1 external
    // ref, all read at once) was trusted wholesale as "GitHydra's own", silently absorbing the
    // extra ref into the new baseline — no banner, ever. After the fix: the diff against this
    // operation's actual expected outcome (HEAD -> feature, nothing else) catches the extra ref.
    expect(result.current.hasExternalChanges).toBe(true);
  });

  it("AC5b: an external HEAD/branch change during the in-flight window (not just an extra ref) is also caught, not just extra refs", async () => {
    // Same real-timer-race approach, this time racing a currentBranch mismatch instead of an
    // extra ref: simulates a teammate switching HEAD in a second worktree/terminal to a branch we
    // never targeted, landing mid-flight.
    const api = makeMockGitHydra({ commits: [makeCommit("c1")], refs: [mainRef("c1"), featureRef("c1")] });
    window.gitHydra = api;
    const { result } = renderHook(() => useRepositoryGraph());
    await act(async () => {
      await result.current.openRepo("/repo");
    });

    act(() => result.current.beginMutation());

    // Our own operation intends to land on "feature", but by the time the confirming read fires,
    // something else has *also* touched HEAD — the fresh read reports "someone-elses-branch",
    // never what we expected.
    let landed = false;
    const raceLanding = new Promise<void>((resolve) => {
      setTimeout(() => {
        landed = true;
        resolve();
      }, 25);
    });
    await raceLanding;
    expect(landed).toBe(true);

    vi.mocked(api.getState).mockResolvedValueOnce(
      ok({
        gitDir: "/repo/.git",
        commonGitDir: "/repo/.git",
        workdir: "/repo",
        isBare: false,
        isShallow: false,
        isWorktree: false,
        isEmpty: false,
        isUnbornHead: false,
        isDetachedHead: false,
        currentBranch: "someone-elses-branch",
        headSha: "c1",
        inProgressOperation: null,
        inProgressOperationDetail: null,
      }),
    );

    await act(async () => {
      // We *expected* to land on "feature" — the actual fresh read disagrees.
      await result.current.refreshRefs({ sha: "c1", currentBranch: "feature" });
    });

    expect(result.current.hasExternalChanges).toBe(true);
  });

  it("AC6: manual refresh continues to clear hasExternalChanges and reload, exactly as today", async () => {
    const api = makeMockGitHydra({ commits: [makeCommit("c1")], refs: [mainRef("c1")] });
    window.gitHydra = api;
    const { result } = renderHook(() => useRepositoryGraph());
    await act(async () => {
      await result.current.openRepo("/repo");
    });

    vi.mocked(api.getState).mockResolvedValueOnce(
      ok({
        gitDir: "/repo/.git",
        commonGitDir: "/repo/.git",
        workdir: "/repo",
        isBare: false,
        isShallow: false,
        isWorktree: false,
        isEmpty: false,
        isUnbornHead: false,
        isDetachedHead: false,
        currentBranch: "external-branch",
        headSha: "c1",
        inProgressOperation: null,
        inProgressOperationDetail: null,
      }),
    );
    vi.mocked(api.getRefs).mockResolvedValueOnce(ok([mainRef("c1")]));
    fireWatcher(api);
    await flush();
    expect(result.current.hasExternalChanges).toBe(true);

    await act(async () => {
      await result.current.refresh();
    });
    expect(result.current.hasExternalChanges).toBe(false);
    expect(result.current.status).toBe("ready");
  });

  it("ignores a watcher event that fires while a mutation gate is open — the gate-closing refreshRefs call is the decisive check, not a separate re-evaluation", async () => {
    const api = makeMockGitHydra({ commits: [makeCommit("c1")], refs: [mainRef("c1")] });
    window.gitHydra = api;
    const { result } = renderHook(() => useRepositoryGraph());
    await act(async () => {
      await result.current.openRepo("/repo");
    });

    act(() => result.current.beginMutation());
    let sha = "";
    await act(async () => {
      sha = await switchBranchAndGetSha(api, "feature");
    });
    // A watcher event fires while the gate is still open — must be a pure no-op (no extra reads,
    // no state change) rather than deferring to a since-removed recheck mechanism.
    fireWatcher(api);
    await flush();
    expect(result.current.hasExternalChanges).toBe(false);

    await act(async () => {
      await result.current.refreshRefs({ sha, currentBranch: "feature" });
    });
    expect(result.current.hasExternalChanges).toBe(false);

    // Now idle again — a fresh external change must still be caught normally.
    vi.mocked(api.getState).mockResolvedValueOnce(
      ok({
        gitDir: "/repo/.git",
        commonGitDir: "/repo/.git",
        workdir: "/repo",
        isBare: false,
        isShallow: false,
        isWorktree: false,
        isEmpty: false,
        isUnbornHead: false,
        isDetachedHead: false,
        currentBranch: "yet-another-external-branch",
        headSha: "c1",
        inProgressOperation: null,
        inProgressOperationDetail: null,
      }),
    );
    vi.mocked(api.getRefs).mockResolvedValueOnce(ok([mainRef("c1")]));
    fireWatcher(api);
    await flush();
    expect(result.current.hasExternalChanges).toBe(true);
  });

  it("a failed mutation's gate-close (no known expected outcome) still catches an external change that raced in, treating 'nothing should have changed' as the expectation", async () => {
    const api = makeMockGitHydra({ commits: [makeCommit("c1")], refs: [mainRef("c1")] });
    window.gitHydra = api;
    const { result } = renderHook(() => useRepositoryGraph());
    await act(async () => {
      await result.current.openRepo("/repo");
    });

    // Mirrors useBranchActions' failure path: onMutationStart opens the gate, the mutating call
    // rejects, and onMutationSettled closes the gate via a bare `refreshRefs()` call with no known
    // outcome (nothing was supposed to change).
    act(() => result.current.beginMutation());
    vi.mocked(api.getState).mockResolvedValueOnce(
      ok({
        gitDir: "/repo/.git",
        commonGitDir: "/repo/.git",
        workdir: "/repo",
        isBare: false,
        isShallow: false,
        isWorktree: false,
        isEmpty: false,
        isUnbornHead: false,
        isDetachedHead: false,
        currentBranch: "raced-in-during-the-failed-attempt",
        headSha: "c1",
        inProgressOperation: null,
        inProgressOperationDetail: null,
      }),
    );
    vi.mocked(api.getRefs).mockResolvedValueOnce(ok([mainRef("c1")]));

    await act(async () => {
      await result.current.refreshRefs(); // no `expected` — the failure path.
    });

    expect(result.current.hasExternalChanges).toBe(true);
  });
});
