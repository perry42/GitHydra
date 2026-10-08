// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useRepositoryGraph } from "./useRepositoryGraph";
import { useRepoTabs } from "./useRepoTabs";
import { createDirtyLeaveRegistry } from "./useDirtyLeaveGuard";
import { makeMockGitHydra } from "../test/mockGitHydra";
import { makeCommit } from "../test/fixtures";

// specs/edit-in-diff.md FR-535: the repo-opening paths this hook starts itself (picker, recents, clone) ask the dirty guard.

afterEach(() => {
  // @ts-expect-error test cleanup of the global bridge
  delete window.gitHydra;
  window.localStorage.clear();
});

function setup(answer: boolean) {
  const api = makeMockGitHydra({
    repoPath: "/repoA",
    commits: [makeCommit("a1", [], { subject: "A" })],
    reposByPath: { "/repoB": { commits: [makeCommit("b1", [], { subject: "B" })] } },
  });
  window.gitHydra = api;
  const guard = createDirtyLeaveRegistry();
  const requestLeave = vi.fn(() => Promise.resolve(answer));
  let dirty = false;
  guard.register({ isDirty: () => dirty, requestLeave });
  const view = renderHook(() => {
    const graph = useRepositoryGraph();
    const tabs = useRepoTabs({ graph, rightPanel: "none", setRightPanel: () => {}, getSeedRightPanel: () => "none", dirtyGuard: guard });
    return { graph, tabs };
  });
  return { api, view, requestLeave, setDirty: (d: boolean) => (dirty = d) };
}

describe("useRepoTabs dirty guard", () => {
  it("openRecentInNewTab asks first and opens nothing when the user cancels", async () => {
    const { view, requestLeave, setDirty } = setup(false);
    await act(async () => {
      await view.result.current.tabs.openNewTab();
    });
    setDirty(true);
    let outcome: string | undefined;
    await act(async () => {
      outcome = await view.result.current.tabs.openRecentInNewTab("/repoB");
    });
    expect(requestLeave).toHaveBeenCalledTimes(1);
    expect(outcome).toBe("cancelled");
    expect(view.result.current.tabs.tabs).toHaveLength(1);
    expect(view.result.current.tabs.switching).toBe(false);
  });

  it("openRecentInNewTab proceeds after the user allows it", async () => {
    const { view, requestLeave, setDirty } = setup(true);
    await act(async () => {
      await view.result.current.tabs.openNewTab();
    });
    setDirty(true);
    await act(async () => {
      await view.result.current.tabs.openRecentInNewTab("/repoB");
    });
    expect(requestLeave).toHaveBeenCalledTimes(1);
    expect(view.result.current.tabs.tabs).toHaveLength(2);
  });

  it("openNewTab asks after the path is picked, and Cancel leaves the tabs alone", async () => {
    const { api, view, requestLeave, setDirty } = setup(false);
    await act(async () => {
      await view.result.current.tabs.openNewTab();
    });
    setDirty(true);
    vi.mocked(api.openRepoDialog).mockResolvedValueOnce({ ok: true, data: "/repoB" });
    await act(async () => {
      await view.result.current.tabs.openNewTab();
    });
    expect(api.openRepoDialog).toHaveBeenCalledTimes(2);
    expect(requestLeave).toHaveBeenCalledTimes(1);
    expect(view.result.current.tabs.tabs).toHaveLength(1);
  });

  it("opening the already-active repo again never asks", async () => {
    const { view, requestLeave, setDirty } = setup(false);
    await act(async () => {
      await view.result.current.tabs.openNewTab();
    });
    setDirty(true);
    await act(async () => {
      await view.result.current.tabs.openNewTab();
    });
    expect(requestLeave).not.toHaveBeenCalled();
  });

  it("a clean app never asks", async () => {
    const { view, requestLeave } = setup(false);
    await act(async () => {
      await view.result.current.tabs.openNewTab();
    });
    await act(async () => {
      await view.result.current.tabs.openRecentInNewTab("/repoB");
    });
    expect(requestLeave).not.toHaveBeenCalled();
    expect(view.result.current.tabs.tabs).toHaveLength(2);
  });
});
