// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from "vitest";
import { getCommands, STATIC_SHORTCUT_ROWS, type CommandCategory, type CommandContext } from "./commands";
import type { RepoTab } from "../hooks/useRepoTabs";

/** Refresh's `keybindings` array depends on `isMac()` (F5 is Windows/Linux-only — see
 * `commands.ts`) — pin the platform explicitly per-test rather than relying on whatever host this
 * suite happens to run on, same convention as `platform.test.ts`'s own `setPlatform` helper. */
const originalPlatform = window.navigator.platform;
function setPlatform(platform: string): void {
  Object.defineProperty(window.navigator, "platform", { value: platform, configurable: true });
}
afterEach(() => {
  Object.defineProperty(window.navigator, "platform", { value: originalPlatform, configurable: true });
});

function makeTab(id: string, repoPath: string): RepoTab {
  return { id, repoPath, remembered: { selectedSha: null, filter: {}, showAllRefs: false, rightPanel: "none", selectedFile: null } };
}

/** A context with every gate at its most-open, "no repo" state — individual tests flip only the
 * fields relevant to what they're asserting (specs/keyboard-shortcuts-command-palette.md FR-224). */
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

function availableIds(ctx: CommandContext): string[] {
  return getCommands(ctx)
    .filter((c) => c.isAvailable(ctx))
    .map((c) => c.id);
}

describe("commands registry", () => {
  it("AC5/AC13: with no repo open, only non-repo-scoped commands (New tab/Open repository, Toggle theme, Keyboard shortcuts) are available — every repo-scoped command is absent, not disabled", () => {
    const ctx = baseContext();
    expect(availableIds(ctx)).toEqual(["open-repository", "toggle-theme", "view-keyboard-shortcuts"]);
  });

  it("FR-224/AC4: lists one 'Switch to tab' entry per open tab, labeled with that tab's repo name, and running it activates that tab", () => {
    const activateTab = vi.fn();
    const ctx = baseContext({
      tabs: [makeTab("t1", "/repos/alpha"), makeTab("t2", "/repos/beta"), makeTab("t3", "C:\\repos\\gamma")],
      activeTabId: "t1",
      activateTab,
    });
    const commands = getCommands(ctx);
    const switchers = commands.filter((c) => c.id.startsWith("switch-to-tab:"));
    expect(switchers.map((c) => c.label)).toEqual([
      "Switch to tab: alpha",
      "Switch to tab: beta",
      "Switch to tab: gamma",
    ]);
    switchers[2]!.run(ctx);
    expect(activateTab).toHaveBeenCalledWith("t3");
  });

  it("'Close current tab' is only available when a tab is active, and closes exactly that tab", () => {
    const closeActiveTab = vi.fn();
    const closed = baseContext({ activeTabId: null, closeActiveTab });
    expect(availableIds(closed)).not.toContain("close-current-tab");

    const open = baseContext({ tabs: [makeTab("t1", "/repo")], activeTabId: "t1", closeActiveTab });
    expect(availableIds(open)).toContain("close-current-tab");
    getCommands(open)
      .find((c) => c.id === "close-current-tab")!
      .run(open);
    expect(closeActiveTab).toHaveBeenCalledTimes(1);
  });

  it("'Refresh commit graph' is only available when canRefresh is true and not already refreshing (AC7), and carries the Ctrl/Cmd+R keybinding", () => {
    const refreshEverything = vi.fn();
    const notReady = baseContext({ canRefresh: false, refreshEverything });
    expect(availableIds(notReady)).not.toContain("refresh-commit-graph");

    const midRefresh = baseContext({ canRefresh: true, isRefreshing: true, refreshEverything });
    expect(availableIds(midRefresh)).not.toContain("refresh-commit-graph");

    const ready = baseContext({ canRefresh: true, isRefreshing: false, refreshEverything });
    const command = getCommands(ready).find((c) => c.id === "refresh-commit-graph")!;
    expect(availableIds(ready)).toContain("refresh-commit-graph");
    expect(command.keybindings).toContainEqual({ key: "r", mod: true });
    command.run(ready);
    expect(refreshEverything).toHaveBeenCalledTimes(1);
  });

  it("'Refresh commit graph' also binds bare F5 on Windows/Linux, but not on macOS (Cmd+R is the platform's own convention there)", () => {
    const ready = baseContext({ canRefresh: true, isRefreshing: false });

    setPlatform("Win32");
    expect(getCommands(ready).find((c) => c.id === "refresh-commit-graph")!.keybindings).toContainEqual({ key: "F5" });

    setPlatform("MacIntel");
    expect(getCommands(ready).find((c) => c.id === "refresh-commit-graph")!.keybindings).not.toContainEqual({ key: "F5" });
  });

  it("'Toggle Branches/Changes/Stashes panel' commands are gated on their own Toolbar show-flags (and stash's disabled reason)", () => {
    const hidden = baseContext({ showBranchesToggle: false, showChangesToggle: false, showStashToggle: false });
    expect(availableIds(hidden)).not.toEqual(expect.arrayContaining(["toggle-branches-sidebar", "toggle-changes-panel", "toggle-stashes-panel"]));

    const shownButStashDisabled = baseContext({
      showBranchesToggle: true,
      showChangesToggle: true,
      showStashToggle: true,
      stashDisabledReason: "This is a bare repository.",
    });
    const ids = availableIds(shownButStashDisabled);
    expect(ids).toContain("toggle-branches-sidebar");
    expect(ids).toContain("toggle-changes-panel");
    expect(ids).not.toContain("toggle-stashes-panel");

    const allShown = baseContext({ showBranchesToggle: true, showChangesToggle: true, showStashToggle: true, stashDisabledReason: null });
    expect(availableIds(allShown)).toEqual(
      expect.arrayContaining(["toggle-branches-sidebar", "toggle-changes-panel", "toggle-stashes-panel"]),
    );
  });

  it("'New branch'/'New stash' are only available when a repo is open, and invoke the existing dialog openers verbatim", () => {
    const openNewBranchDialog = vi.fn();
    const openNewStashDialog = vi.fn();
    const closedRepo = baseContext({ repoOpen: false, openNewBranchDialog, openNewStashDialog });
    expect(availableIds(closedRepo)).not.toEqual(expect.arrayContaining(["new-branch", "new-stash"]));

    const openRepo = baseContext({ repoOpen: true, openNewBranchDialog, openNewStashDialog });
    const commands = getCommands(openRepo);
    commands.find((c) => c.id === "new-branch")!.run(openRepo);
    commands.find((c) => c.id === "new-stash")!.run(openRepo);
    expect(openNewBranchDialog).toHaveBeenCalledTimes(1);
    expect(openNewStashDialog).toHaveBeenCalledTimes(1);
  });

  it("AC6: 'Commit staged changes' is only available when the Changes panel is open AND its own canCommit is true, and carries the Ctrl/Cmd+Enter keybinding", () => {
    const commitStagedChanges = vi.fn();
    const panelClosed = baseContext({ changesPanelOpen: false, canCommit: true, commitStagedChanges });
    expect(availableIds(panelClosed)).not.toContain("commit-staged-changes");

    const notEligible = baseContext({ changesPanelOpen: true, canCommit: false, commitStagedChanges });
    expect(availableIds(notEligible)).not.toContain("commit-staged-changes");

    const eligible = baseContext({ changesPanelOpen: true, canCommit: true, commitStagedChanges });
    const command = getCommands(eligible).find((c) => c.id === "commit-staged-changes")!;
    expect(availableIds(eligible)).toContain("commit-staged-changes");
    expect(command.keybindings).toEqual([{ key: "Enter", mod: true }]);
    command.run(eligible);
    expect(commitStagedChanges).toHaveBeenCalledTimes(1);
  });

  it("'Toggle theme' and 'New tab / Open repository' are always available, independent of repo state", () => {
    expect(availableIds(baseContext({ repoOpen: false }))).toEqual(expect.arrayContaining(["toggle-theme", "open-repository"]));
    expect(availableIds(baseContext({ repoOpen: true }))).toEqual(expect.arrayContaining(["toggle-theme", "open-repository"]));
  });

  it("specs/keyboard-shortcuts-reference.md FR-231: 'Keyboard shortcuts' is always available (repo open or not), carries the Ctrl/Cmd+/ keybinding, and invokes openKeyboardShortcuts verbatim", () => {
    const openKeyboardShortcuts = vi.fn();
    const noRepo = baseContext({ repoOpen: false, openKeyboardShortcuts });
    expect(availableIds(noRepo)).toContain("view-keyboard-shortcuts");
    const withRepo = baseContext({ repoOpen: true, openKeyboardShortcuts });
    const command = getCommands(withRepo).find((c) => c.id === "view-keyboard-shortcuts")!;
    expect(availableIds(withRepo)).toContain("view-keyboard-shortcuts");
    expect(command.keybindings).toEqual([{ key: "/", mod: true }]);
    expect(command.category).toBe("general");
    command.run(withRepo);
    expect(openKeyboardShortcuts).toHaveBeenCalledTimes(1);
  });

  it("FR-234: every registry command carries a category, one of the four fixed headings", () => {
    const ctx = baseContext({ tabs: [makeTab("t1", "/repo")], activeTabId: "t1" });
    const validCategories: CommandCategory[] = ["tabs", "view", "git", "general"];
    for (const command of getCommands(ctx)) {
      expect(validCategories).toContain(command.category);
    }
  });

  it("FR-236: STATIC_SHORTCUT_ROWS carries exactly the two non-registry rows (Open Command Palette / Next-previous tab), rendered via keyComboLabel-compatible KeyCombo data", () => {
    expect(STATIC_SHORTCUT_ROWS).toHaveLength(2);
    expect(STATIC_SHORTCUT_ROWS.map((r) => r.label)).toEqual(["Open Command Palette", "Next / previous tab"]);
    expect(STATIC_SHORTCUT_ROWS[0]!.category).toBe("general");
    expect(STATIC_SHORTCUT_ROWS[0]!.keybindings).toEqual([{ key: "k", mod: true }]);
    expect(STATIC_SHORTCUT_ROWS[1]!.category).toBe("tabs");
    expect(STATIC_SHORTCUT_ROWS[1]!.keybindings).toEqual([
      { key: "Tab", mod: true },
      { key: "Tab", mod: true, shift: true },
    ]);
  });

  it("specs/find-commits-overlay.md FR-268: 'Find commits…' is gated on showFindCommitsToggle, carries the Ctrl/Cmd+Shift+F keybinding, is categorized 'view', and invokes openFindCommits verbatim", () => {
    const openFindCommits = vi.fn();
    const hidden = baseContext({ showFindCommitsToggle: false, openFindCommits });
    expect(availableIds(hidden)).not.toContain("find-commits");

    const shown = baseContext({ showFindCommitsToggle: true, openFindCommits });
    const command = getCommands(shown).find((c) => c.id === "find-commits")!;
    expect(availableIds(shown)).toContain("find-commits");
    expect(command.label).toBe("Find commits…");
    expect(command.category).toBe("view");
    expect(command.keybindings).toEqual([{ key: "f", mod: true, shift: true }]);
    command.run(shown);
    expect(openFindCommits).toHaveBeenCalledTimes(1);
  });

  it("specs/find-commits-overlay.md FR-268: 'Focus branches search' is gated on showBranchesToggle, carries the Ctrl/Cmd+F keybinding, is categorized 'view', and invokes focusBranchesSearch verbatim", () => {
    const focusBranchesSearch = vi.fn();
    const hidden = baseContext({ showBranchesToggle: false, focusBranchesSearch });
    expect(availableIds(hidden)).not.toContain("focus-branches-search");

    const shown = baseContext({ showBranchesToggle: true, focusBranchesSearch });
    const command = getCommands(shown).find((c) => c.id === "focus-branches-search")!;
    expect(availableIds(shown)).toContain("focus-branches-search");
    expect(command.category).toBe("view");
    expect(command.keybindings).toEqual([{ key: "f", mod: true }]);
    command.run(shown);
    expect(focusBranchesSearch).toHaveBeenCalledTimes(1);
  });

  it("does not register 'open the palette' or 'cycle tabs' as registry commands — those are direct-keybinding-only (FR-226), handled outside this registry", () => {
    const ids = getCommands(baseContext({ tabs: [makeTab("t1", "/repo")] })).map((c) => c.id);
    expect(ids.some((id) => /palette/i.test(id))).toBe(false);
    expect(ids.some((id) => /cycle/i.test(id))).toBe(false);
  });
});
