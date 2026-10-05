// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { RefInfo } from "@githydra/git-core";
import { useRepositoryGraph } from "./useRepositoryGraph";
import { createIdleGate } from "./useIdleGate";
import { makeMockGitHydra } from "../test/mockGitHydra";
import { makeCommit, makeRepoState } from "../test/fixtures";

/**
 * specs/live-refresh.md AC5-AC9, AC12, AC13 against the hook, with the watcher driven through the listener captured
 * from `api.onRefsChanged` exactly as `repoSession.ts` would fire it.
 */

const ok = <T,>(data: T) => ({ ok: true as const, data });
const branch = (name: string, sha: string): RefInfo => ({
  fullName: `refs/heads/${name}`,
  shortName: name,
  type: "local-branch",
  targetCommitSha: sha,
  isAnnotatedTag: false,
  isSymbolic: false,
});
const remote = (sha: string): RefInfo => ({ ...branch("main", sha), fullName: "refs/remotes/origin/main", shortName: "origin/main", type: "remote-branch" });

afterEach(() => {
  // @ts-expect-error test cleanup of the global bridge
  delete window.gitHydra;
  vi.restoreAllMocks();
});

async function setup(opts: { busy?: boolean } = {}) {
  const api = makeMockGitHydra({
    commits: [makeCommit("c3", ["c2"]), makeCommit("c2", ["c1"]), makeCommit("c1")],
    refs: [branch("main", "c2"), remote("c1")],
    repoState: makeRepoState({ headSha: "c2", currentBranch: "main" }),
  });
  let refsListener: (() => void) | null = null;
  let treeListener: (() => void) | null = null;
  vi.mocked(api.onRefsChanged).mockImplementation((l) => {
    refsListener = l;
    return () => {
      refsListener = null;
    };
  });
  vi.mocked(api.onWorktreeChanged!).mockImplementation((l) => {
    treeListener = l;
    return () => {
      treeListener = null;
    };
  });
  window.gitHydra = api;
  const idleGate = createIdleGate();
  if (opts.busy) idleGate.setBusy("test", true);
  const { result } = renderHook(() => useRepositoryGraph({ idleGate }));
  await act(async () => {
    await result.current.openRepo("/repo");
  });
  await waitFor(() => expect(result.current.status).toBe("ready"));
  const fire = async () => {
    await act(async () => {
      refsListener!();
      await new Promise((r) => setTimeout(r, 0));
    });
  };
  const settle = () => act(async () => void (await new Promise((r) => setTimeout(r, 20))));
  return { api, result, idleGate, fire, settle, fireTree: () => treeListener!() };
}

describe("useRepositoryGraph live refresh: dropped evaluation safety net", () => {
  it("a watcher evaluation dropped because a concurrent one re-baselined is re-checked and the change still applies", async () => {
    const { api, result, fire, settle } = await setup();
    const newState = ok(makeRepoState({ headSha: "c3", currentBranch: "main" }));
    const oldState = ok(makeRepoState({ headSha: "c2", currentBranch: "main" }));
    let releaseSlow!: () => void;
    // Evaluation A reads the new state slowly; B (second event) reads the old one fast and re-baselines first.
    vi.mocked(api.getState)
      .mockImplementationOnce(() => new Promise((res) => (releaseSlow = () => res(newState))))
      .mockResolvedValueOnce(oldState)
      .mockResolvedValue(newState);
    const newRefs = ok([branch("main", "c3"), remote("c1")]);
    let releaseSlowRefs!: () => void;
    vi.mocked(api.getRefs)
      .mockImplementationOnce(() => new Promise((res) => (releaseSlowRefs = () => res(newRefs))))
      .mockResolvedValueOnce(ok([branch("main", "c2"), remote("c1")]))
      .mockResolvedValue(newRefs);
    await fire();
    await fire();
    await settle();
    releaseSlow();
    releaseSlowRefs();
    await settle();
    await waitFor(() => expect(result.current.repoState?.headSha).toBe("c3"), { timeout: 5000 });
    expect(result.current.hasExternalChanges).toBe(false);
  });
});

describe("useRepositoryGraph live refresh: refs (FR-463, FR-492)", () => {
  it("AC5: an idle external fetch applies silently, keeping selection, row count and rows in one commit", async () => {
    const { api, result, fire, settle } = await setup();
    act(() => result.current.restoreSelection("c2"));
    const followBefore = result.current.followSignal;
    const rowCount = result.current.displayRows.length;
    vi.mocked(api.getRefs).mockResolvedValue(ok([branch("main", "c2"), remote("c3")]));

    await fire();
    await settle();

    expect(result.current.hasExternalChanges).toBe(false);
    expect(result.current.refs.find((r) => r.shortName === "origin/main")?.targetCommitSha).toBe("c3");
    expect(result.current.selectedSha).toBe("c2");
    expect(result.current.followSignal).toBe(followBefore);
    expect(result.current.displayRows.length).toBe(rowCount);
  });

  it("AC6: an idle external HEAD move follows silently through followSignal onto the new HEAD", async () => {
    const { api, result, fire, settle } = await setup();
    const followBefore = result.current.followSignal;
    vi.mocked(api.getState).mockResolvedValue(ok(makeRepoState({ headSha: "c3", currentBranch: "main" })));
    vi.mocked(api.getRefs).mockResolvedValue(ok([branch("main", "c3"), remote("c1")]));

    await fire();
    await settle();

    expect(result.current.hasExternalChanges).toBe(false);
    expect(result.current.repoState?.headSha).toBe("c3");
    expect(result.current.selectedSha).toBe("c3");
    expect(result.current.followSignal).toBe(followBefore + 1);
    await waitFor(() => expect(result.current.commitDetail.status).toBe("ready"));
  });

  it("AC6: a detached checkout follows too", async () => {
    const { api, result, fire, settle } = await setup();
    vi.mocked(api.getState).mockResolvedValue(
      ok(makeRepoState({ headSha: "c1", currentBranch: null, isDetachedHead: true })),
    );
    await fire();
    await settle();
    expect(result.current.selectedSha).toBe("c1");
    expect(result.current.hasExternalChanges).toBe(false);
  });

  it("AC7: while not idle the same HEAD move shows the banner and changes nothing, then applies and follows once idle", async () => {
    const { api, result, fire, settle, idleGate } = await setup({ busy: true });
    act(() => result.current.restoreSelection("c2"));
    vi.mocked(api.getState).mockResolvedValue(ok(makeRepoState({ headSha: "c3", currentBranch: "main" })));
    vi.mocked(api.getRefs).mockResolvedValue(ok([branch("main", "c3"), remote("c1")]));

    await fire();
    await settle();
    expect(result.current.hasExternalChanges).toBe(true);
    expect(result.current.repoState?.headSha).toBe("c2");
    expect(result.current.selectedSha).toBe("c2");

    act(() => idleGate.setBusy("test", false));
    await waitFor(() => expect(result.current.selectedSha).toBe("c3"));
    expect(result.current.hasExternalChanges).toBe(false);
    expect(result.current.repoState?.headSha).toBe("c3");
  });

  it("AC7: manual Refresh applies the deferred move immediately, including the follow", async () => {
    const { api, result, fire, settle } = await setup({ busy: true });
    vi.mocked(api.getState).mockResolvedValue(ok(makeRepoState({ headSha: "c3", currentBranch: "main" })));
    vi.mocked(api.getRefs).mockResolvedValue(ok([branch("main", "c3"), remote("c1")]));
    await fire();
    await settle();
    expect(result.current.hasExternalChanges).toBe(true);

    await act(async () => {
      await result.current.refresh();
    });
    expect(result.current.hasExternalChanges).toBe(false);
    expect(result.current.repoState?.headSha).toBe("c3");
    expect(result.current.selectedSha).toBe("c3");
  });

  it("a deferred apply is never dropped by a second event while still busy", async () => {
    const { api, result, fire, settle, idleGate } = await setup({ busy: true });
    vi.mocked(api.getRefs).mockResolvedValue(ok([branch("main", "c2"), remote("c2")]));
    await fire();
    vi.mocked(api.getRefs).mockResolvedValue(ok([branch("main", "c2"), remote("c3")]));
    await fire();
    await settle();
    act(() => idleGate.setBusy("test", false));
    await waitFor(() => expect(result.current.refs.find((r) => r.shortName === "origin/main")?.targetCommitSha).toBe("c3"));
    expect(result.current.hasExternalChanges).toBe(false);
  });

  it("AC8: an external operation start alerts, is never idle-applied, and its HEAD moves do not follow", async () => {
    const { api, result, fire, settle } = await setup();
    const followBefore = result.current.followSignal;
    vi.mocked(api.getState).mockResolvedValue(
      ok(
        makeRepoState({
          headSha: "c3",
          currentBranch: null,
          isDetachedHead: true,
          inProgressOperation: "rebase",
          inProgressOperationDetail: null,
        }),
      ),
    );
    await fire();
    await settle();
    expect(result.current.operationStateAlert).toEqual({ operation: "rebase" });
    expect(result.current.repoState?.headSha).toBe("c2");
    expect(result.current.followSignal).toBe(followBefore);

    // Rebase keeps moving HEAD while the alert is unacknowledged: still no apply, no follow.
    vi.mocked(api.getState).mockResolvedValue(
      ok(makeRepoState({ headSha: "c1", currentBranch: null, isDetachedHead: true, inProgressOperation: "rebase", inProgressOperationDetail: null })),
    );
    await fire();
    await settle();
    expect(result.current.repoState?.headSha).toBe("c2");
    expect(result.current.followSignal).toBe(followBefore);
  });

  it("AC9: an app mutation with its own settle shows no banner and triggers no follow from the watcher", async () => {
    const { api, result, fire, settle } = await setup();
    const followBefore = result.current.followSignal;
    act(() => result.current.beginMutation());
    vi.mocked(api.getRefs).mockResolvedValue(ok([branch("main", "c2"), branch("feature", "c2")]));
    await fire();
    await act(async () => {
      await result.current.refreshRefs({ sha: "c2", currentBranch: "main" });
    });
    expect(result.current.hasExternalChanges).toBe(false);
    await fire();
    await settle();
    expect(result.current.followSignal).toBe(followBefore);
  });
});

describe("useRepositoryGraph live refresh: working tree (FR-458..FR-460)", () => {
  const changesWith = (...paths: string[]) => ({
    staged: [],
    unstaged: paths.map((path) => ({ path, status: "modified" as const, category: "unstaged" as const })),
    untracked: [],
    conflicted: [],
  });

  it("an index-write event refreshes the list once after the debounce, with no idle gate", async () => {
    const { api, result, fire, idleGate } = await setup({ busy: true });
    void idleGate;
    const before = vi.mocked(api.getWorkingDirectoryChanges).mock.calls.length;
    vi.mocked(api.getWorkingDirectoryChanges).mockResolvedValue(ok(changesWith("a.txt")));
    await fire();
    await waitFor(() => expect(result.current.workingDirChanges?.unstaged.map((e) => e.path)).toEqual(["a.txt"]));
    expect(vi.mocked(api.getWorkingDirectoryChanges).mock.calls.length).toBe(before + 1);
  });

  it("window focus and the worktree channel both refresh the list", async () => {
    const { api, result, fireTree } = await setup();
    vi.mocked(api.getWorkingDirectoryChanges).mockResolvedValue(ok(changesWith("a.txt")));
    act(() => void window.dispatchEvent(new Event("focus")));
    await waitFor(() => expect(result.current.workingDirChanges?.unstaged).toHaveLength(1));

    vi.mocked(api.getWorkingDirectoryChanges).mockResolvedValue(ok(changesWith("a.txt", "b.txt")));
    act(() => fireTree());
    await waitFor(() => expect(result.current.workingDirChanges?.unstaged).toHaveLength(2));
  });

  it("an unchanged status keeps the same object (no re-render) but still bumps workingTreeRevision", async () => {
    const { api, result } = await setup();
    vi.mocked(api.getWorkingDirectoryChanges).mockResolvedValue(ok(changesWith("a.txt")));
    act(() => void window.dispatchEvent(new Event("focus")));
    await waitFor(() => expect(result.current.workingDirChanges?.unstaged).toHaveLength(1));
    const list = result.current.workingDirChanges;
    const revision = result.current.workingTreeRevision;

    act(() => void window.dispatchEvent(new Event("focus")));
    await waitFor(() => expect(result.current.workingTreeRevision).toBeGreaterThan(revision));
    expect(result.current.workingDirChanges).toBe(list);
  });

  it("AC10: idle produces zero reads", async () => {
    const { api } = await setup();
    const calls = () => vi.mocked(api.getWorkingDirectoryChanges).mock.calls.length + vi.mocked(api.getState).mock.calls.length;
    const before = calls();
    await act(async () => void (await new Promise((r) => setTimeout(r, 600))));
    expect(calls()).toBe(before);
  });
});
