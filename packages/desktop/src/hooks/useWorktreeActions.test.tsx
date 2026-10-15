// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { WorktreeEntry, WorktreeList } from "@githydra/git-core";
import type { GitHydraApi } from "../../shared/ipcContract";
import { makeMockGitHydra, mockWorktreeEntry } from "../test/mockGitHydra";
import { createDirtyLeaveRegistry } from "./useDirtyLeaveGuard";
import type { RepoTab } from "./useRepoTabs";
import { planRemoval } from "../lib/worktreeRemove";
import { useWorktreeActions, type UseWorktreeActionsOptions } from "./useWorktreeActions";

const tab = (id: string, repoPath: string): RepoTab => ({
  id,
  repoPath,
  remembered: { selectedSha: null, filter: {}, showAllRefs: false, rightPanel: "none", selectedFile: null },
});

const main = mockWorktreeEntry({ id: null, isMain: true, path: "/w/repo", branch: "main" });
const feature = mockWorktreeEntry({ id: "f", path: "/w/repo.worktrees/feature", branch: "feature" });
const listOf = (entries: WorktreeEntry[]): WorktreeList => ({
  entries,
  untrusted: false,
  untrustedReason: null,
  commonDir: "/w/repo/.git",
  mainPath: "/w/repo",
  format: "nul",
  mainPathIsGitDir: false,
});

function setup(over: Partial<UseWorktreeActionsOptions> = {}, api: GitHydraApi = makeMockGitHydra({ repoPath: "/w/repo" })) {
  const calls: string[] = [];
  const dirtyGuard = createDirtyLeaveRegistry();
  // Live active tab id, like the app's ref: activating a tab really changes it unless a test says otherwise.
  const live = { active: over.activeTabId === undefined ? "t1" : over.activeTabId, switching: false, activateLands: true };
  const opts: UseWorktreeActionsOptions = {
    api,
    worktrees: { status: "ready", list: listOf([main, feature]), errorMessage: null, index: { byBranch: new Map(), byHead: new Map() }, reload: vi.fn() },
    tabs: [tab("t1", "/w/repo")],
    activeTabId: "t1",
    openInNewTab: vi.fn(async (p: string) => {
      calls.push(`open:${p}`);
      live.active = "new-main";
      return "opened" as const;
    }),
    focusTab: vi.fn((id: string) => void calls.push(`focus:${id}`)),
    closeTab: vi.fn((id: string) => void calls.push(`close:${id}`)),
    activateTab: vi.fn(async (id: string) => {
      calls.push(`activate:${id}`);
      if (live.activateLands) live.active = id;
      return live.activateLands;
    }),
    isSwitching: () => live.switching,
    getActiveTabId: () => live.active,
    dirtyGuard,
    beginMutation: vi.fn(() => void calls.push("begin")),
    refreshRefs: vi.fn(async () => void calls.push("refreshRefs")),
    refreshRefsAndRowsInBackground: vi.fn(async () => void calls.push("refreshBg")),
    onBranchesChanged: vi.fn(),
    onOpenBranches: vi.fn(),
    currentBranchLabel: "main",
    ...over,
  };
  vi.mocked(api.removeWorktree).mockImplementation(async (req) => {
    calls.push("removeWorktree");
    return { ok: true, data: { ok: true, id: req.id, path: req.confirmedPath, branch: null, linksUnlinked: 0 } };
  });
  const hook = renderHook(() => useWorktreeActions(opts));
  return { hook, opts, calls, api, dirtyGuard, live };
}

const plan = (over: Partial<Parameters<typeof planRemoval>[0]> = {}) =>
  planRemoval({ entry: feature, state: { ok: true, count: 0, submodules: [], dirtySubmodules: [] }, merge: null, wantsDeleteBranch: false, openAsTab: false, currentBranch: "main", ...over });

describe("create (FR-602, FR-606, FR-632, FR-633, FR-644)", () => {
  it("opens the self-write gate before the write, sends only destination and source, and refreshes in the Background variant", async () => {
    const { hook, api, calls, opts } = setup();
    let failure: unknown = "unset";
    await act(async () => {
      failure = await hook.result.current.submitCreate({ destination: "/w/repo.worktrees/x", source: { kind: "branch", branch: "x" }, openAfter: false });
    });
    expect(failure).toBeNull();
    expect(calls[0]).toBe("begin");
    expect(calls).toContain("refreshBg");
    expect(calls).not.toContain("refreshRefs");
    expect(vi.mocked(api.addWorktree).mock.calls[0]![0]).toEqual({ destination: "/w/repo.worktrees/x", source: { kind: "branch", branch: "x" } });
    expect(opts.onBranchesChanged).toHaveBeenCalled();
    expect(opts.worktrees.reload).toHaveBeenCalled();
    expect(hook.result.current.notices[0]).toMatchObject({ tone: "success", text: 'Created worktree "x".' });
  });

  it("a typed refusal closes the gate with a plain refresh and returns the in-field failure", async () => {
    const api = makeMockGitHydra({ repoPath: "/w/repo" });
    vi.mocked(api.addWorktree).mockResolvedValueOnce({ ok: true, data: { ok: false, reason: "branchCheckedOut", message: "raw", worktreePath: "/w/repo" } });
    const { hook, calls } = setup({}, api);
    let failure: { field?: string; message?: string; link?: unknown } | null = null;
    await act(async () => {
      failure = await hook.result.current.submitCreate({ destination: "/d", source: { kind: "branch", branch: "main" }, openAfter: true });
    });
    expect(failure).toMatchObject({ field: "branch", link: { label: "Open that worktree", path: "/w/repo" } });
    expect(calls).toContain("refreshRefs");
    expect(calls).not.toContain("refreshBg");
    expect(hook.result.current.notices).toHaveLength(0);
  });

  it("Open after create opens the new worktree as a tab", async () => {
    const api = makeMockGitHydra({ repoPath: "/w/repo", worktrees: [{ id: "x", path: "/w/repo.worktrees/x", branch: "x" }] });
    vi.mocked(api.addWorktree).mockResolvedValueOnce({
      ok: true,
      data: { ok: true, path: "/w/repo.worktrees/x", entry: mockWorktreeEntry({ id: "x", path: "/w/repo.worktrees/x", branch: "x" }), branch: "x", head: "abc1234", createdBranch: false, warning: null },
    });
    const { hook, calls } = setup({}, api);
    await act(async () => {
      await hook.result.current.submitCreate({ destination: "/w/repo.worktrees/x", source: { kind: "branch", branch: "x" }, openAfter: true });
    });
    expect(calls).toContain("open:/w/repo.worktrees/x");
  });

  it("a dependency manifest yields the reminder with a FIXED command; GitHydra never runs it", async () => {
    const api = makeMockGitHydra({ repoPath: "/w/repo" });
    vi.mocked(api.addWorktree).mockResolvedValueOnce({
      ok: true,
      data: { ok: true, path: "/p", entry: mockWorktreeEntry({ id: "x", path: "/p", branch: "x" }), branch: "x", head: "abc1234", createdBranch: false, warning: null },
    });
    vi.mocked(api.getWorktreeSetupHints).mockResolvedValueOnce({ ok: true, data: { dependency: { kind: "pnpm", manifest: "package.json" }, hasSubmodules: false } });
    const { hook } = setup({}, api);
    await act(async () => {
      await hook.result.current.submitCreate({ destination: "/p", source: { kind: "branch", branch: "x" }, openAfter: false });
    });
    const dep = hook.result.current.notices.find((n) => n.text.startsWith("package.json found"));
    expect(dep?.text).toBe("package.json found - dependencies are not installed in this worktree.");
    expect(dep?.actions).toEqual([{ kind: "copy", label: "Copy command", text: "pnpm install --frozen-lockfile" }]);
  });

  it("submodules: a banner with a DISABLED Initialize button and the Copy command fallback; no git submodule call exists", async () => {
    const api = makeMockGitHydra({ repoPath: "/w/repo" });
    vi.mocked(api.addWorktree).mockResolvedValueOnce({
      ok: true,
      data: { ok: true, path: "/p", entry: mockWorktreeEntry({ id: "x", path: "/p", branch: "x" }), branch: "x", head: "abc1234", createdBranch: false, warning: null },
    });
    vi.mocked(api.getWorktreeSetupHints).mockResolvedValueOnce({ ok: true, data: { dependency: null, hasSubmodules: true } });
    const { hook } = setup({}, api);
    await act(async () => {
      await hook.result.current.submitCreate({ destination: "/p", source: { kind: "branch", branch: "x" }, openAfter: false });
    });
    const sub = hook.result.current.notices.find((n) => n.text.startsWith(".gitmodules found"));
    expect(sub?.actions.map((a) => a.kind)).toEqual(["disabled", "copy"]);
    expect(sub?.detail).toMatch(/Update git to enable this button/);
  });

  it("a post-checkout hook is detected, NOT run, and reported by a persistent banner", async () => {
    const api = makeMockGitHydra({ repoPath: "/w/repo" });
    vi.mocked(api.detectPostCheckoutHook).mockResolvedValueOnce({ ok: true, data: { present: true } });
    const { hook } = setup({}, api);
    await act(async () => {
      await hook.result.current.submitCreate({ destination: "/p", source: { kind: "branch", branch: "x" }, openAfter: false });
    });
    expect(hook.result.current.notices.map((n) => n.text)).toContain(
      "A post-checkout hook in this repository was not run. Running hooks needs your confirmation, which is coming in a later update.",
    );
    const arg = vi.mocked(api.addWorktree).mock.calls[0]![0] as unknown as Record<string, unknown>;
    expect(Object.keys(arg).sort()).toEqual(["destination", "source"]);
  });
});

describe("hook detection failure (LOW-6)", () => {
  it("still shows a banner saying no hook was run when the check itself failed", async () => {
    const api = makeMockGitHydra({ repoPath: "/w/repo" });
    vi.mocked(api.detectPostCheckoutHook).mockResolvedValueOnce({ ok: false, error: { name: "Error", message: "boom" } });
    const { hook } = setup({}, api);
    await act(async () => {
      await hook.result.current.submitCreate({ destination: "/p", source: { kind: "branch", branch: "x" }, openAfter: false });
    });
    expect(hook.result.current.notices.map((n) => n.text)).toContain("We could not check for a post-checkout hook; none was run.");
    expect(vi.mocked(api.addWorktree).mock.calls[0]![0]).toEqual({ destination: "/p", source: { kind: "branch", branch: "x" } });
  });
});

describe("open as a tab (FR-611, FR-640)", () => {
  it("verifies a linked worktree first and opens it in a NEW tab", async () => {
    const { hook, calls, api } = setup();
    vi.mocked(api.verifyWorktree).mockResolvedValueOnce({ ok: true, data: { trusted: true, id: "f", path: feature.path, realPath: feature.path } });
    await act(async () => {
      await hook.result.current.openWorktree(feature);
    });
    expect(api.verifyWorktree).toHaveBeenCalledWith("f");
    expect(calls).toEqual([`open:${feature.path}`]);
  });

  it("an untrusted worktree is never opened: 'Not a worktree of this repository'", async () => {
    const { hook, calls, api } = setup();
    vi.mocked(api.verifyWorktree).mockResolvedValueOnce({ ok: true, data: { trusted: false, reason: "backlink-mismatch" } });
    await act(async () => {
      await hook.result.current.openWorktree(feature);
    });
    expect(calls).toEqual([]);
    expect(hook.result.current.notices[0]).toMatchObject({ tone: "error", text: "Not a worktree of this repository." });
  });

  it("an already-open worktree focuses its tab instead of opening a duplicate (also one open as a plain repo tab)", async () => {
    const { hook, calls } = setup({ tabs: [tab("t1", "/w/repo"), tab("t2", "/w/repo.worktrees/feature/")], activeTabId: "t1" });
    await act(async () => {
      await hook.result.current.openWorktree(feature);
    });
    expect(calls).toEqual(["focus:t2"]);
  });

  it("the main worktree maps to the repo's own tab, and a bare entry is not openable", async () => {
    const { hook, calls, api } = setup({ tabs: [tab("t1", "/w/repo"), tab("t2", "/w/repo.worktrees/feature")], activeTabId: "t2" });
    await act(async () => {
      await hook.result.current.openWorktree(main);
      await hook.result.current.openWorktree(mockWorktreeEntry({ id: null, isMain: true, isBare: true, path: "/w/bare.git" }));
    });
    expect(calls).toEqual(["focus:t1"]);
    expect(api.verifyWorktree).not.toHaveBeenCalled();
  });
});

describe("remove (FR-615, FR-616)", () => {
  it("closes a background tab through the dirty-leave guard, then removes", async () => {
    const { hook, calls, dirtyGuard } = setup({ tabs: [tab("t1", "/w/repo"), tab("t2", feature.path)], activeTabId: "t1" });
    const guardSpy = vi.spyOn(dirtyGuard, "guard");
    act(() => hook.result.current.requestRemove(feature, false));
    await act(async () => {
      await hook.result.current.confirmRemove(plan({ openAsTab: true }));
    });
    expect(guardSpy).toHaveBeenCalledTimes(1);
    expect(calls.indexOf("close:t2")).toBeGreaterThan(-1);
    // The tab goes only after the removal succeeded (security MED-2).
    expect(calls.indexOf("close:t2")).toBeGreaterThan(calls.indexOf("removeWorktree"));
    expect(hook.result.current.removeRequest).toBeNull();
  });

  it("an ACTIVE worktree tab is left for the main worktree's tab, removed, and only then closed", async () => {
    const { hook, calls } = setup({ tabs: [tab("t1", "/w/repo"), tab("t2", feature.path)], activeTabId: "t2" });
    act(() => hook.result.current.requestRemove(feature, false));
    await act(async () => {
      await hook.result.current.confirmRemove(plan({ openAsTab: true }));
    });
    expect(calls.slice(0, 2)).toEqual(["activate:t1", "begin"]);
    expect(calls.indexOf("close:t2")).toBeGreaterThan(calls.indexOf("removeWorktree"));
  });

  it("with no main tab open it opens one first so the removal runs against this repository", async () => {
    const { hook, calls } = setup({ tabs: [tab("t2", feature.path)], activeTabId: "t2" });
    act(() => hook.result.current.requestRemove(feature, false));
    await act(async () => {
      await hook.result.current.confirmRemove(plan({ openAsTab: true }));
    });
    expect(calls.slice(0, 2)).toEqual(["open:/w/repo", "begin"]);
    expect(calls).toContain("close:t2");
  });

  it("if the switch to the main tab does not land, nothing is removed and the tab stays (MED-2)", async () => {
    const { hook, calls, api, live } = setup({ tabs: [tab("t1", "/w/repo"), tab("t2", feature.path)], activeTabId: "t2" });
    live.active = "t2";
    live.activateLands = false;
    act(() => hook.result.current.requestRemove(feature, false));
    let outcome: { notice: string } | null = null;
    await act(async () => {
      outcome = await hook.result.current.confirmRemove(plan({ openAsTab: true }));
    });
    expect(outcome).toMatchObject({ notice: expect.stringContaining("could not switch") });
    expect(api.removeWorktree).not.toHaveBeenCalled();
    expect(calls).not.toContain("close:t2");
    expect(calls).not.toContain("begin");
  });

  it("the flow is refused while a tab switch is in flight (MED-2)", async () => {
    const { hook, api, calls, live } = setup({ tabs: [tab("t1", "/w/repo"), tab("t2", feature.path)], activeTabId: "t1" });
    live.switching = true;
    act(() => hook.result.current.requestRemove(feature, false));
    let outcome: { notice: string } | null = null;
    await act(async () => {
      outcome = await hook.result.current.confirmRemove(plan({ openAsTab: true }));
    });
    expect(outcome).toMatchObject({ notice: expect.stringContaining("still switching") });
    expect(api.removeWorktree).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  it("finds the worktree's tab by its verified real path when the tab is spelled differently (LOW-1)", async () => {
    const api = makeMockGitHydra({ repoPath: "/w/repo" });
    vi.mocked(api.verifyWorktree).mockResolvedValue({ ok: true, data: { trusted: true, id: "f", path: feature.path, realPath: "/real/feature" } });
    const { hook, calls } = setup({ tabs: [tab("t1", "/w/repo"), tab("t2", "/real/feature/")], activeTabId: "t1" }, api);
    act(() => hook.result.current.requestRemove(feature, false));
    await act(async () => {
      await hook.result.current.confirmRemove(plan({ openAsTab: true }));
    });
    expect(calls).toContain("close:t2");
  });

  it("when the guard refuses (unsaved editor) removeWorktree is NEVER called and the dialog says why", async () => {
    const { hook, calls, dirtyGuard, api } = setup({ tabs: [tab("t1", "/w/repo"), tab("t2", feature.path)], activeTabId: "t2" });
    dirtyGuard.register({ isDirty: () => true, requestLeave: () => Promise.resolve(false) });
    act(() => hook.result.current.requestRemove(feature, false));
    let outcome: { notice: string } | null = null;
    await act(async () => {
      outcome = await hook.result.current.confirmRemove(plan({ openAsTab: true }));
    });
    expect(outcome).toMatchObject({ notice: expect.stringContaining("unsaved edits") });
    expect(api.removeWorktree).not.toHaveBeenCalled();
    expect(api.removeWorktreeAndDeleteBranch).not.toHaveBeenCalled();
    expect(calls).not.toContain("close:t2");
    expect(hook.result.current.removeRequest).not.toBeNull();
  });

  it("sends the id, the confirmed path and the force the dialog showed", async () => {
    const { hook, api } = setup();
    act(() => hook.result.current.requestRemove(feature, false));
    await act(async () => {
      await hook.result.current.confirmRemove(plan({ state: { ok: true, count: 4, submodules: [], dirtySubmodules: [] } }));
    });
    expect(api.removeWorktree).toHaveBeenCalledWith({ id: "f", confirmedPath: feature.path, force: true, expectedCount: 4, expectedSubmodules: [] });
  });

  it("an unmerged branch keeps the branch and raises the persistent kept-branch banner with Open Branches", async () => {
    const { hook, api } = setup();
    act(() => hook.result.current.requestRemove(feature, true));
    await act(async () => {
      await hook.result.current.confirmRemove(plan({ wantsDeleteBranch: true, merge: { exists: true, merged: false, unmergedCommits: 2, reference: "HEAD" } }));
    });
    expect(api.removeWorktreeAndDeleteBranch).not.toHaveBeenCalled();
    const kept = hook.result.current.notices[0]!;
    expect(kept.text).toBe(
      "Worktree removed. The branch feature was kept because it has commits that are not merged into main or its upstream. Delete it anyway from the Branches panel if you are sure.",
    );
    expect(kept.actions).toEqual([{ kind: "openBranches", label: "Open Branches" }]);
  });

  it("a merged branch is removed and deleted ('Worktree and branch removed.')", async () => {
    const api = makeMockGitHydra({ repoPath: "/w/repo" });
    vi.mocked(api.removeWorktreeAndDeleteBranch).mockResolvedValueOnce({
      ok: true,
      data: {
        ok: true,
        removed: { ok: true, id: "f", path: feature.path, branch: "feature", linksUnlinked: 0 },
        branch: { status: "deleted", name: "feature" },
        outcomeDiffersFromPreview: false,
      },
    });
    const { hook } = setup({}, api);
    act(() => hook.result.current.requestRemove(feature, true));
    await act(async () => {
      await hook.result.current.confirmRemove(plan({ wantsDeleteBranch: true, merge: { exists: true, merged: true, unmergedCommits: 0, reference: "HEAD" } }));
    });
    expect(api.removeWorktreeAndDeleteBranch).toHaveBeenCalledWith({ id: "f", confirmedPath: feature.path, force: false, expectedMerged: true });
    expect(hook.result.current.notices[0]).toMatchObject({ tone: "success", text: "Worktree and branch removed." });
  });

  it("a locked refusal is shown in the dialog with its reason and nothing is reported as removed", async () => {
    const api = makeMockGitHydra({ repoPath: "/w/repo" });
    vi.mocked(api.removeWorktree).mockResolvedValueOnce({ ok: true, data: { ok: false, reason: "locked", lockReason: "usb", message: "raw" } });
    const { hook } = setup({}, api);
    act(() => hook.result.current.requestRemove(feature, false));
    let outcome: { notice: string } | null = null;
    await act(async () => {
      outcome = await hook.result.current.confirmRemove(plan());
    });
    expect(outcome).toMatchObject({ notice: "Locked: usb. Unlock it with git worktree unlock before removing." });
    expect(hook.result.current.notices).toHaveLength(0);
  });

  it("a force is never sent without the count and submodules the user was shown (MED-1)", async () => {
    const { hook, api } = setup();
    act(() => hook.result.current.requestRemove(feature, false));
    await act(async () => {
      await hook.result.current.confirmRemove(plan({ state: { ok: true, count: 0, submodules: ["libs/a"], dirtySubmodules: [] } }));
    });
    expect(api.removeWorktree).toHaveBeenLastCalledWith({ id: "f", confirmedPath: feature.path, force: true, expectedCount: 0, expectedSubmodules: ["libs/a"] });
    act(() => hook.result.current.requestRemove(feature, false));
    await act(async () => {
      await hook.result.current.confirmRemove(plan());
    });
    const clean = vi.mocked(api.removeWorktree).mock.calls.at(-1)![0];
    expect(clean).toEqual({ id: "f", confirmedPath: feature.path, force: false });
  });

  it("a changed count after a force attempt re-opens the confirm with fresh numbers and is NOT retried", async () => {
    const api = makeMockGitHydra({ repoPath: "/w/repo" });
    vi.mocked(api.removeWorktree).mockResolvedValueOnce({ ok: true, data: { ok: false, reason: "dirty", count: 9, dirtySubmodules: [], message: "raw" } });
    const { hook } = setup({}, api);
    act(() => hook.result.current.requestRemove(feature, false));
    let outcome: { notice: string; reload?: boolean } | null = null;
    await act(async () => {
      outcome = await hook.result.current.confirmRemove(plan({ state: { ok: true, count: 4, submodules: [], dirtySubmodules: [] } }));
    });
    expect(outcome).toEqual({ notice: "This worktree changed since you opened this. Review it again.", reload: true });
    expect(api.removeWorktree).toHaveBeenCalledTimes(1);
    expect(hook.result.current.removeRequest).not.toBeNull();
  });

  it("expectationRequired reads like an internal error and asks for a re-read", async () => {
    const api = makeMockGitHydra({ repoPath: "/w/repo" });
    vi.mocked(api.removeWorktree).mockResolvedValueOnce({ ok: true, data: { ok: false, reason: "expectationRequired", message: "raw" } });
    const { hook } = setup({}, api);
    act(() => hook.result.current.requestRemove(feature, false));
    let outcome: { notice: string; reload?: boolean } | null = null;
    await act(async () => {
      outcome = await hook.result.current.confirmRemove(plan());
    });
    expect(outcome).toMatchObject({ reload: true, notice: expect.stringContaining("Something went wrong") });
    expect(api.removeWorktree).toHaveBeenCalledTimes(1);
  });

  it("a dirty refusal asks the dialog to read the worktree again instead of forcing", async () => {
    const api = makeMockGitHydra({ repoPath: "/w/repo" });
    vi.mocked(api.removeWorktree).mockResolvedValueOnce({ ok: true, data: { ok: false, reason: "dirty", count: 7, dirtySubmodules: [], message: "raw" } });
    const { hook } = setup({}, api);
    act(() => hook.result.current.requestRemove(feature, false));
    let outcome: { reload?: boolean } | null = null;
    await act(async () => {
      outcome = await hook.result.current.confirmRemove(plan());
    });
    expect(outcome).toMatchObject({ reload: true });
    expect(api.removeWorktree).toHaveBeenCalledTimes(1);
  });

  it("focus moves to the Worktrees heading after confirming", async () => {
    const { hook } = setup();
    const heading = document.createElement("h3");
    heading.tabIndex = -1;
    document.body.appendChild(heading);
    (hook.result.current.headingRef as { current: HTMLHeadingElement | null }).current = heading;
    act(() => hook.result.current.requestRemove(feature, false));
    await act(async () => {
      await hook.result.current.confirmRemove(plan());
    });
    await waitFor(() => expect(heading).toHaveFocus());
    heading.remove();
  });
});

describe("clean up (FR-604)", () => {
  const missing = mockWorktreeEntry({ id: "m", path: "/gone", branch: "gone", prunable: true });

  it("asks for confirmation when other missing worktrees would also be forgotten, then sends only the ids the user saw", async () => {
    const api = makeMockGitHydra({ repoPath: "/w/repo" });
    vi.mocked(api.pruneWorktree).mockResolvedValueOnce({
      ok: true,
      data: { ok: false, reason: "confirmationRequired", message: "x", alsoForgotten: [{ id: "usb", reason: "gone", path: "/usb" }] },
    });
    const { hook } = setup({}, api);
    act(() => hook.result.current.requestCleanUp(missing));
    await act(async () => {
      await hook.result.current.confirmCleanUp();
    });
    expect(hook.result.current.cleanUp?.alsoForgotten).toEqual([{ id: "usb", reason: "gone", path: "/usb" }]);
    await act(async () => {
      await hook.result.current.confirmCleanUp();
    });
    expect(vi.mocked(api.pruneWorktree).mock.calls[1]).toEqual(["m", ["usb"]]);
    expect(hook.result.current.cleanUp).toBeNull();
    expect(hook.result.current.notices[0]!.text).toContain("No files were deleted.");
  });
});
