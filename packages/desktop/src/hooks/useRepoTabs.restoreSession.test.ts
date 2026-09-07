// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useRepositoryGraph } from "./useRepositoryGraph";
import { SESSION_TABS_KEY, useRepoTabs } from "./useRepoTabs";
import { makeMockGitHydra } from "../test/mockGitHydra";
import { makeCommit } from "../test/fixtures";

/**
 * specs/restore-tabs-on-relaunch.md: hook-level coverage for FR-208 through FR-212 — direct
 * `useRepoTabs`/`useRepositoryGraph` wiring (no `<App/>`), mirroring
 * `useRepoTabs.recentSwitchGuard.test.ts`'s own harness style. App-level integration coverage
 * (the full 10 acceptance criteria against real UI) lives in `App.restoreTabs.test.tsx` and
 * `App.restoreTabs.e2e.test.tsx`.
 */

afterEach(() => {
  // @ts-expect-error test cleanup of the global bridge
  delete window.gitHydra;
  window.localStorage.clear();
});

function renderTabs(api: ReturnType<typeof makeMockGitHydra>) {
  window.gitHydra = api;
  return renderHook(() => {
    const graph = useRepositoryGraph();
    const tabs = useRepoTabs({
      graph,
      rightPanel: "none",
      setRightPanel: () => {},
      getSeedRightPanel: () => "none",
    });
    return { graph, tabs };
  });
}

describe("useRepoTabs — session persistence (FR-208)", () => {
  it("opening tabs persists their repoPath order and the active one to localStorage", async () => {
    const api = makeMockGitHydra({
      repoPath: "/repoA",
      commits: [makeCommit("a1", [], { subject: "A" })],
      reposByPath: { "/repoB": { commits: [makeCommit("b1", [], { subject: "B" })] } },
    });
    const { result } = renderTabs(api);

    await act(async () => {
      await result.current.tabs.openNewTab();
    });
    vi.mocked(api.openRepoDialog).mockResolvedValueOnce({ ok: true, data: "/repoB" });
    await act(async () => {
      await result.current.tabs.openNewTab();
    });

    const raw = window.localStorage.getItem(SESSION_TABS_KEY);
    expect(raw).not.toBeNull();
    const persisted = JSON.parse(raw!);
    expect(persisted.tabs.map((t: { repoPath: string }) => t.repoPath)).toEqual(["/repoA", "/repoB"]);
    expect(persisted.activeRepoPath).toBe("/repoB");
  });

  it("closing a tab re-persists the remaining order", async () => {
    const api = makeMockGitHydra({
      repoPath: "/repoA",
      commits: [makeCommit("a1", [], { subject: "A" })],
      reposByPath: { "/repoB": { commits: [makeCommit("b1", [], { subject: "B" })] } },
    });
    const { result } = renderTabs(api);
    await act(async () => {
      await result.current.tabs.openNewTab();
    });
    vi.mocked(api.openRepoDialog).mockResolvedValueOnce({ ok: true, data: "/repoB" });
    await act(async () => {
      await result.current.tabs.openNewTab();
    });
    const tabA = result.current.tabs.tabs[0]!;
    act(() => result.current.tabs.closeTab(tabA.id));
    // The close-triggered reactivation of the adjacent tab is async — let it settle.
    await act(async () => {
      await Promise.resolve();
    });

    const persisted = JSON.parse(window.localStorage.getItem(SESSION_TABS_KEY)!);
    expect(persisted.tabs.map((t: { repoPath: string }) => t.repoPath)).toEqual(["/repoB"]);
  });

  it("AC7: deactivating to the blank '+ New tab' landing screen persists a null active path while keeping the tabs", async () => {
    const api = makeMockGitHydra({ repoPath: "/repoA", commits: [makeCommit("a1", [], { subject: "A" })] });
    const { result } = renderTabs(api);
    await act(async () => {
      await result.current.tabs.openNewTab();
    });
    await act(async () => {
      await result.current.tabs.newTab();
    });

    const persisted = JSON.parse(window.localStorage.getItem(SESSION_TABS_KEY)!);
    expect(persisted.tabs.map((t: { repoPath: string }) => t.repoPath)).toEqual(["/repoA"]);
    expect(persisted.activeRepoPath).toBeNull();
  });
});

describe("useRepoTabs — session restoration (FR-209/FR-210/FR-211)", () => {
  it("AC1/AC2: a fresh hook instance rebuilds tabs (in order) and the active tab on the very first render, then eagerly opens only that one", async () => {
    window.localStorage.setItem(
      SESSION_TABS_KEY,
      JSON.stringify({
        tabs: [
          { repoPath: "/repoA", remembered: { selectedSha: null, filter: {}, showAllRefs: false, rightPanel: "none" } },
          { repoPath: "/repoB", remembered: { selectedSha: "b1", filter: {}, showAllRefs: true, rightPanel: "changes" } },
        ],
        activeRepoPath: "/repoB",
      }),
    );
    const api = makeMockGitHydra({
      repoPath: "/repoA",
      commits: [makeCommit("a1", [], { subject: "A" })],
      reposByPath: { "/repoB": { commits: [makeCommit("b1", [], { subject: "B" })] } },
    });

    const { result } = renderTabs(api);

    // AC1: rebuilt immediately — the very first render already has both tabs, in order.
    expect(result.current.tabs.tabs.map((t) => t.repoPath)).toEqual(["/repoA", "/repoB"]);
    expect(result.current.tabs.activeTabId).toBe(result.current.tabs.tabs[1]!.id);

    // AC2: the active tab's graph loads automatically, no interaction needed.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(api.openRepoCancellable).toHaveBeenCalledTimes(1);
    expect(vi.mocked(api.openRepoCancellable).mock.calls[0]![0]).toBe("/repoB");
    expect(result.current.graph.repoPath).toBe("/repoB");
    // FR-211: repoB's remembered state was replayed.
    expect(result.current.graph.showAllRefs).toBe(true);
  });

  it("AC3/AC8: the other restored (inactive) tabs make zero git/network calls at launch", async () => {
    window.localStorage.setItem(
      SESSION_TABS_KEY,
      JSON.stringify({
        tabs: [
          { repoPath: "/repoA", remembered: { selectedSha: null, filter: {}, showAllRefs: false, rightPanel: "none" } },
          { repoPath: "/repoB", remembered: { selectedSha: null, filter: {}, showAllRefs: false, rightPanel: "none" } },
          { repoPath: "/repoC", remembered: { selectedSha: null, filter: {}, showAllRefs: false, rightPanel: "none" } },
        ],
        activeRepoPath: "/repoC",
      }),
    );
    const api = makeMockGitHydra({
      repoPath: "/repoA",
      commits: [makeCommit("a1", [], { subject: "A" })],
      reposByPath: {
        "/repoB": { commits: [makeCommit("b1", [], { subject: "B" })] },
        "/repoC": { commits: [makeCommit("c1", [], { subject: "C" })] },
      },
    });

    renderTabs(api);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    // Exactly one call total (for /repoC, the active tab) — /repoA and /repoB never touched.
    expect(api.openRepoCancellable).toHaveBeenCalledTimes(1);
    const calledPaths = vi.mocked(api.openRepoCancellable).mock.calls.map((c) => c[0]);
    expect(calledPaths).toEqual(["/repoC"]);
  });

  it("AC4: clicking an inactive restored tab lazily activates it through the ordinary activateTab path, replaying its remembered state", async () => {
    window.localStorage.setItem(
      SESSION_TABS_KEY,
      JSON.stringify({
        tabs: [
          { repoPath: "/repoA", remembered: { selectedSha: "a1", filter: { author: "ada" }, showAllRefs: true, rightPanel: "commit" } },
          { repoPath: "/repoB", remembered: { selectedSha: null, filter: {}, showAllRefs: false, rightPanel: "none" } },
        ],
        activeRepoPath: "/repoB",
      }),
    );
    const api = makeMockGitHydra({
      repoPath: "/repoB",
      commits: [makeCommit("b1", [], { subject: "B" })],
      reposByPath: {
        "/repoA": { commits: [makeCommit("a1", [], { subject: "A", authorName: "Ada" })] },
      },
    });

    const { result } = renderTabs(api);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(api.openRepoCancellable).toHaveBeenCalledTimes(1); // just repoB so far

    const tabA = result.current.tabs.tabs[0]!;
    await act(async () => {
      await result.current.tabs.activateTab(tabA.id);
    });

    expect(api.openRepoCancellable).toHaveBeenCalledTimes(2);
    expect(result.current.graph.repoPath).toBe("/repoA");
    expect(result.current.graph.showAllRefs).toBe(true);
    expect(result.current.graph.selectedSha).toBe("a1");
  });

  it("AC6: an empty persisted session (or none at all) restores the idle landing screen with zero tabs", async () => {
    const api = makeMockGitHydra();
    const { result } = renderTabs(api);
    expect(result.current.tabs.tabs).toEqual([]);
    expect(result.current.tabs.activeTabId).toBeNull();
    await act(async () => {
      await Promise.resolve();
    });
    expect(api.openRepoCancellable).not.toHaveBeenCalled();
  });

  it("AC7: a null persisted active path restores the tabs unfocused, landing on the idle screen with no eager open", async () => {
    window.localStorage.setItem(
      SESSION_TABS_KEY,
      JSON.stringify({
        tabs: [
          { repoPath: "/repoA", remembered: { selectedSha: null, filter: {}, showAllRefs: false, rightPanel: "none" } },
          { repoPath: "/repoB", remembered: { selectedSha: null, filter: {}, showAllRefs: false, rightPanel: "none" } },
        ],
        activeRepoPath: null,
      }),
    );
    const api = makeMockGitHydra({
      repoPath: "/repoA",
      reposByPath: { "/repoB": {} },
    });
    const { result } = renderTabs(api);

    expect(result.current.tabs.tabs.map((t) => t.repoPath)).toEqual(["/repoA", "/repoB"]);
    expect(result.current.tabs.activeTabId).toBeNull();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(api.openRepoCancellable).not.toHaveBeenCalled();
    expect(result.current.graph.status).toBe("idle");
  });

  it("AC10: corrupt persisted session JSON degrades to no session (never throws)", () => {
    window.localStorage.setItem(SESSION_TABS_KEY, "{not valid json");
    const api = makeMockGitHydra();
    expect(() => renderTabs(api)).not.toThrow();
    const { result } = renderTabs(api);
    expect(result.current.tabs.tabs).toEqual([]);
  });

  it("AC10: a fully unavailable localStorage (getItem throws) degrades to no session (never throws, never crashes the app)", () => {
    // jsdom's `localStorage` doesn't let a plain `window.localStorage.getItem = fn` reassignment
    // actually take effect (its `getItem`/`setItem` are routed through the Storage interface
    // regardless of own-property overrides) — replacing the whole `window.localStorage` property
    // is what genuinely simulates "unavailable" here, mirroring how a real private/sandboxed
    // browsing context throws on `localStorage` access at all.
    const original = window.localStorage;
    const throwing = {
      getItem: () => {
        throw new Error("storage unavailable");
      },
      setItem: () => {
        throw new Error("storage unavailable");
      },
    };
    Object.defineProperty(window, "localStorage", { value: throwing, configurable: true, writable: true });
    try {
      const api = makeMockGitHydra();
      expect(() => renderTabs(api)).not.toThrow();
    } finally {
      Object.defineProperty(window, "localStorage", { value: original, configurable: true, writable: true });
    }
  });
});

describe("useRepoTabs — restored-tab-not-found handling (FR-212/AC5)", () => {
  it("the previously-active tab failing to reopen at launch sets notFoundTabId and resets the graph to idle, without touching the other restored tabs", async () => {
    window.localStorage.setItem(
      SESSION_TABS_KEY,
      JSON.stringify({
        tabs: [
          { repoPath: "/repoGone", remembered: { selectedSha: null, filter: {}, showAllRefs: false, rightPanel: "none" } },
          { repoPath: "/repoB", remembered: { selectedSha: null, filter: {}, showAllRefs: false, rightPanel: "none" } },
        ],
        activeRepoPath: "/repoGone",
      }),
    );
    const api = makeMockGitHydra({
      repoPath: "/repoGone",
      reposByPath: { "/repoB": { commits: [makeCommit("b1", [], { subject: "B" })] } },
    });
    vi.mocked(api.openRepoCancellable).mockResolvedValueOnce({
      outcome: "settled",
      result: { ok: false, error: { name: "NotAGitRepositoryError", message: "no longer a valid git repository" } },
    });

    const { result } = renderTabs(api);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    const goneTab = result.current.tabs.tabs.find((t) => t.repoPath === "/repoGone")!;
    expect(result.current.tabs.notFoundTabId).toBe(goneTab.id);
    // Still selected/focused (AC5: not a crash, doesn't abort the rest of the session) — never
    // left on the app-wide `"error"` status.
    expect(result.current.tabs.activeTabId).toBe(goneTab.id);
    expect(result.current.graph.status).toBe("idle");
    // The sibling restored tab is completely unaffected.
    expect(result.current.tabs.tabs).toHaveLength(2);

    // Retrying (the same id, since a not-found tab stays "active") succeeds once the path is
    // valid again — the default mock behavior for the next call.
    await act(async () => {
      await result.current.tabs.activateTab(goneTab.id);
    });
    expect(result.current.tabs.notFoundTabId).toBeNull();
    expect(result.current.graph.status).toBe("ready");
    expect(result.current.graph.repoPath).toBe("/repoGone");
  });

  it("removing a not-found tab clears notFoundTabId and drops it from the persisted session", async () => {
    window.localStorage.setItem(
      SESSION_TABS_KEY,
      JSON.stringify({
        tabs: [{ repoPath: "/repoGone", remembered: { selectedSha: null, filter: {}, showAllRefs: false, rightPanel: "none" } }],
        activeRepoPath: "/repoGone",
      }),
    );
    const api = makeMockGitHydra({ repoPath: "/repoGone" });
    vi.mocked(api.openRepoCancellable).mockResolvedValueOnce({
      outcome: "settled",
      result: { ok: false, error: { name: "NotAGitRepositoryError", message: "gone" } },
    });

    const { result } = renderTabs(api);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    const goneTab = result.current.tabs.tabs[0]!;
    expect(result.current.tabs.notFoundTabId).toBe(goneTab.id);

    act(() => result.current.tabs.closeTab(goneTab.id));
    expect(result.current.tabs.notFoundTabId).toBeNull();
    expect(result.current.tabs.tabs).toEqual([]);
    const persisted = JSON.parse(window.localStorage.getItem(SESSION_TABS_KEY)!);
    expect(persisted.tabs).toEqual([]);
  });
});
