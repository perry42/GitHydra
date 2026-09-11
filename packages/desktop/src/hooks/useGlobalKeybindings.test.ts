// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useGlobalKeybindings } from "./useGlobalKeybindings";
import type { CommandContext } from "../lib/commands";
import type { RepoTab } from "./useRepoTabs";

function makeTab(id: string, repoPath: string): RepoTab {
  return { id, repoPath, remembered: { selectedSha: null, filter: {}, showAllRefs: false, rightPanel: "none", selectedFile: null } };
}

function baseContext(overrides: Partial<CommandContext> = {}): CommandContext {
  return {
    tabs: [],
    activeTabId: null,
    openNewTab: vi.fn(),
    closeActiveTab: vi.fn(),
    activateTab: vi.fn(),
    repoOpen: false,
    canRefresh: false,
    isRefreshing: false,
    refreshEverything: vi.fn(),
    toggleTheme: vi.fn(),
    showBranchesToggle: false,
    toggleBranchesSidebar: vi.fn(),
    showChangesToggle: false,
    changesPanelOpen: false,
    toggleChangesPanel: vi.fn(),
    showStashToggle: false,
    stashDisabledReason: null,
    toggleStashPanel: vi.fn(),
    openNewBranchDialog: vi.fn(),
    openNewStashDialog: vi.fn(),
    canCommit: false,
    commitStagedChanges: vi.fn(),
    openKeyboardShortcuts: vi.fn(),
    showFindCommitsToggle: false,
    openFindCommits: vi.fn(),
    focusBranchesSearch: vi.fn(),
    ...overrides,
  };
}

function fireKey(init: { key: string; ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean }) {
  act(() => {
    document.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: init.key,
        ctrlKey: init.ctrlKey ?? false,
        metaKey: init.metaKey ?? false,
        shiftKey: init.shiftKey ?? false,
        bubbles: true,
        cancelable: true,
      }),
    );
  });
}

describe("useGlobalKeybindings (specs/keyboard-shortcuts-command-palette.md FR-221/226/227/229)", () => {
  const originalPlatform = window.navigator.platform;
  beforeEach(() => {
    Object.defineProperty(window.navigator, "platform", { value: "Win32", configurable: true });
  });
  afterEach(() => {
    Object.defineProperty(window.navigator, "platform", { value: originalPlatform, configurable: true });
  });

  it("AC1: Ctrl+K opens the palette", () => {
    const ctx = baseContext();
    const { result } = renderHook(() => useGlobalKeybindings({ ctx, dialogOpen: false }));
    expect(result.current.paletteOpen).toBe(false);
    fireKey({ key: "k", ctrlKey: true });
    expect(result.current.paletteOpen).toBe(true);
  });

  it("FR-221/AC10: Ctrl+K does nothing while an App-tracked modal dialog is open", () => {
    const ctx = baseContext();
    const { result } = renderHook(() => useGlobalKeybindings({ ctx, dialogOpen: true }));
    fireKey({ key: "k", ctrlKey: true });
    expect(result.current.paletteOpen).toBe(false);
  });

  it("FR-229: once the palette is open, none of the other direct keybindings (e.g. Ctrl+R) additionally fire, and a second Ctrl+K is also inert", () => {
    const refreshEverything = vi.fn();
    const ctx = baseContext({ canRefresh: true, refreshEverything });
    const { result } = renderHook(() => useGlobalKeybindings({ ctx, dialogOpen: false }));
    fireKey({ key: "k", ctrlKey: true });
    expect(result.current.paletteOpen).toBe(true);

    fireKey({ key: "r", ctrlKey: true });
    expect(refreshEverything).not.toHaveBeenCalled();
    fireKey({ key: "k", ctrlKey: true });
    expect(result.current.paletteOpen).toBe(true); // unchanged, not toggled/reopened
  });

  it("AC7: Ctrl+R refreshes when available, and is a silent no-op when not (mid-refresh or repo not ready)", () => {
    const refreshEverything = vi.fn();
    let ctx = baseContext({ canRefresh: false, isRefreshing: false, refreshEverything });
    const { rerender } = renderHook(({ c }) => useGlobalKeybindings({ ctx: c, dialogOpen: false }), { initialProps: { c: ctx } });

    fireKey({ key: "r", ctrlKey: true });
    expect(refreshEverything).not.toHaveBeenCalled();

    ctx = baseContext({ canRefresh: true, isRefreshing: true, refreshEverything });
    rerender({ c: ctx });
    fireKey({ key: "r", ctrlKey: true });
    expect(refreshEverything).not.toHaveBeenCalled();

    ctx = baseContext({ canRefresh: true, isRefreshing: false, refreshEverything });
    rerender({ c: ctx });
    fireKey({ key: "r", ctrlKey: true });
    expect(refreshEverything).toHaveBeenCalledTimes(1);
  });

  it("bare F5 also refreshes on Windows/Linux (a second trigger for the same Refresh command, no modifier needed)", () => {
    const refreshEverything = vi.fn();
    const ctx = baseContext({ canRefresh: true, isRefreshing: false, refreshEverything });
    renderHook(() => useGlobalKeybindings({ ctx, dialogOpen: false }));
    fireKey({ key: "F5" });
    expect(refreshEverything).toHaveBeenCalledTimes(1);
  });

  it("F5 does NOT refresh on macOS (Cmd+R is the platform's own refresh convention there)", () => {
    Object.defineProperty(window.navigator, "platform", { value: "MacIntel", configurable: true });
    const refreshEverything = vi.fn();
    const ctx = baseContext({ canRefresh: true, isRefreshing: false, refreshEverything });
    renderHook(() => useGlobalKeybindings({ ctx, dialogOpen: false }));
    fireKey({ key: "F5" });
    expect(refreshEverything).not.toHaveBeenCalled();
    fireKey({ key: "r", metaKey: true });
    expect(refreshEverything).toHaveBeenCalledTimes(1);
  });

  it("AC6: Ctrl+Enter commits when available, and is a silent no-op when not", () => {
    const commitStagedChanges = vi.fn();
    let ctx = baseContext({ changesPanelOpen: false, canCommit: true, commitStagedChanges });
    const { rerender } = renderHook(({ c }) => useGlobalKeybindings({ ctx: c, dialogOpen: false }), { initialProps: { c: ctx } });

    fireKey({ key: "Enter", ctrlKey: true });
    expect(commitStagedChanges).not.toHaveBeenCalled();

    ctx = baseContext({ changesPanelOpen: true, canCommit: true, commitStagedChanges });
    rerender({ c: ctx });
    fireKey({ key: "Enter", ctrlKey: true });
    expect(commitStagedChanges).toHaveBeenCalledTimes(1);
  });

  it("AC8: Ctrl+Tab / Ctrl+Shift+Tab cycles to the next/previous tab, wrapping, and has no effect with a single tab", () => {
    const activateTab = vi.fn();
    let ctx = baseContext({ tabs: [makeTab("t1", "/a")], activeTabId: "t1", activateTab });
    const { rerender } = renderHook(({ c }) => useGlobalKeybindings({ ctx: c, dialogOpen: false }), { initialProps: { c: ctx } });

    fireKey({ key: "Tab", ctrlKey: true });
    expect(activateTab).not.toHaveBeenCalled();

    ctx = baseContext({
      tabs: [makeTab("t1", "/a"), makeTab("t2", "/b"), makeTab("t3", "/c")],
      activeTabId: "t3",
      activateTab,
    });
    rerender({ c: ctx });
    fireKey({ key: "Tab", ctrlKey: true }); // wraps past the last tab
    expect(activateTab).toHaveBeenCalledWith("t1");

    activateTab.mockClear();
    ctx = baseContext({
      tabs: [makeTab("t1", "/a"), makeTab("t2", "/b"), makeTab("t3", "/c")],
      activeTabId: "t1",
      activateTab,
    });
    rerender({ c: ctx });
    fireKey({ key: "Tab", ctrlKey: true, shiftKey: true }); // wraps to the previous (last) tab
    expect(activateTab).toHaveBeenCalledWith("t3");
  });

  it("specs/keyboard-shortcuts-reference.md FR-231: Ctrl+/ opens the keyboard shortcuts screen via the registry, with zero new dispatch code, and is a no-op while a dialog is open", () => {
    const openKeyboardShortcuts = vi.fn();
    const ctx = baseContext({ openKeyboardShortcuts });
    const { rerender } = renderHook(({ dialogOpen }) => useGlobalKeybindings({ ctx, dialogOpen }), {
      initialProps: { dialogOpen: true },
    });
    fireKey({ key: "/", ctrlKey: true });
    expect(openKeyboardShortcuts).not.toHaveBeenCalled();

    rerender({ dialogOpen: false });
    fireKey({ key: "/", ctrlKey: true });
    expect(openKeyboardShortcuts).toHaveBeenCalledTimes(1);
  });

  it("specs/find-commits-overlay.md AC3/AC10: Ctrl+Shift+F opens Find commits when available, and is a silent no-op while a dialog (e.g. the overlay itself, folded into anyModalDialogOpen) is already open", () => {
    const openFindCommits = vi.fn();
    let ctx = baseContext({ showFindCommitsToggle: true, openFindCommits });
    const { rerender } = renderHook(({ dialogOpen }) => useGlobalKeybindings({ ctx, dialogOpen }), {
      initialProps: { dialogOpen: true },
    });
    fireKey({ key: "f", ctrlKey: true, shiftKey: true });
    expect(openFindCommits).not.toHaveBeenCalled();

    rerender({ dialogOpen: false });
    fireKey({ key: "f", ctrlKey: true, shiftKey: true });
    expect(openFindCommits).toHaveBeenCalledTimes(1);

    ctx = baseContext({ showFindCommitsToggle: false, openFindCommits });
    rerender({ dialogOpen: false });
    fireKey({ key: "f", ctrlKey: true, shiftKey: true });
    expect(openFindCommits).toHaveBeenCalledTimes(1); // unchanged — silent no-op when unavailable
  });

  it("specs/find-commits-overlay.md AC11: Ctrl+F (no Shift) focuses the branches search, distinct from Ctrl+Shift+F", () => {
    const focusBranchesSearch = vi.fn();
    const openFindCommits = vi.fn();
    const ctx = baseContext({ showBranchesToggle: true, focusBranchesSearch, showFindCommitsToggle: true, openFindCommits });
    renderHook(() => useGlobalKeybindings({ ctx, dialogOpen: false }));
    fireKey({ key: "f", ctrlKey: true });
    expect(focusBranchesSearch).toHaveBeenCalledTimes(1);
    expect(openFindCommits).not.toHaveBeenCalled();
  });

  it("closePalette closes it", () => {
    const ctx = baseContext();
    const { result } = renderHook(() => useGlobalKeybindings({ ctx, dialogOpen: false }));
    fireKey({ key: "k", ctrlKey: true });
    expect(result.current.paletteOpen).toBe(true);
    act(() => result.current.closePalette());
    expect(result.current.paletteOpen).toBe(false);
  });
});
