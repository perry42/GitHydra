// SPDX-License-Identifier: GPL-3.0-or-later
import { NO_EDIT_COMMANDS } from "./editFile";
import { NO_SELECTION_COMMANDS } from "./selectionCommands";
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
    canToggleCurrentHunk: false,
    toggleCurrentHunk: vi.fn(),
    canDiscardCurrentHunk: false,
    discardCurrentHunk: vi.fn(),
    openKeyboardShortcuts: vi.fn(),
    showFindCommitsToggle: false,
    openFindCommits: vi.fn(),
    focusBranchesSearch: vi.fn(),
    showFetchToggle: false,
    isFetching: false,
    runFetch: vi.fn(),
    pullDisabledReason: null,
    runPull: vi.fn(),
    pushDisabledReason: null,
    runPush: vi.fn(),
    openIdentityProfiles: vi.fn(),
    openCloneDialog: vi.fn(),
    openMergeBranchPicker: vi.fn(),
    isDetachedHead: false,
    openCreateBranchAtHead: vi.fn(),
    hasRecoverableDrafts: false,
    restoreUnsavedEdits: vi.fn(),
    selectionCommands: NO_SELECTION_COMMANDS,
    stageSelected: vi.fn(),
    unstageSelected: vi.fn(),
    discardSelected: vi.fn(),
    discardAll: vi.fn(),
    ignoreSelected: vi.fn(),
    selectAllInSection: vi.fn(),
    editCommands: NO_EDIT_COMMANDS,
    editFile: vi.fn(),
    saveEdit: vi.fn(),
    saveAndStageEdit: vi.fn(),
    nextConflict: vi.fn(),
    prevConflict: vi.fn(),
    markResolved: vi.fn(),
    nextConflictedFile: vi.fn(),
    continueOperation: vi.fn(),
    resolveInEditor: vi.fn(),
    ...overrides,
  };
}

function availableIds(ctx: CommandContext): string[] {
  return getCommands(ctx)
    .filter((c) => c.isAvailable(ctx))
    .map((c) => c.id);
}

describe("commands registry", () => {
  it("AC5/AC13: with no repo open, only non-repo-scoped commands (New tab/Open repository, Toggle theme, Manage identity profiles, Clone a repository, Keyboard shortcuts) are available — every repo-scoped command is absent, not disabled", () => {
    const ctx = baseContext();
    expect(availableIds(ctx)).toEqual([
      "open-repository",
      "toggle-theme",
      "manage-identity-profiles",
      "clone-repository",
      "view-keyboard-shortcuts",
    ]);
  });

  it("specs/git-identity-profiles.md: 'Manage git identity profiles…' is always available (repo open or not), categorized 'git', and invokes openIdentityProfiles verbatim", () => {
    const openIdentityProfiles = vi.fn();
    const noRepo = baseContext({ repoOpen: false, openIdentityProfiles });
    expect(availableIds(noRepo)).toContain("manage-identity-profiles");
    const withRepo = baseContext({ repoOpen: true, openIdentityProfiles });
    const command = getCommands(withRepo).find((c) => c.id === "manage-identity-profiles")!;
    expect(availableIds(withRepo)).toContain("manage-identity-profiles");
    expect(command.category).toBe("git");
    command.run(withRepo);
    expect(openIdentityProfiles).toHaveBeenCalledTimes(1);
  });

  it("specs/online-sync-clone.md FR-351: 'Clone a repository…' is always available (repo open or not), categorized 'git', has no keybinding, and invokes openCloneDialog verbatim", () => {
    const openCloneDialog = vi.fn();
    const noRepo = baseContext({ repoOpen: false, openCloneDialog });
    expect(availableIds(noRepo)).toContain("clone-repository");
    const withRepo = baseContext({ repoOpen: true, openCloneDialog });
    const command = getCommands(withRepo).find((c) => c.id === "clone-repository")!;
    expect(availableIds(withRepo)).toContain("clone-repository");
    expect(command.category).toBe("git");
    expect(command.keybindings ?? []).toEqual([]);
    command.run(withRepo);
    expect(openCloneDialog).toHaveBeenCalledTimes(1);
  });

  it("specs/branch-panel-drag-merge.md FR-437: 'Merge branch into current branch…' is available when a repo is open, categorized 'git', has no keybinding, and invokes openMergeBranchPicker", () => {
    const openMergeBranchPicker = vi.fn();
    expect(availableIds(baseContext({ repoOpen: false }))).not.toContain("merge-branch-into-current");
    const ctx = baseContext({ repoOpen: true, openMergeBranchPicker });
    const command = getCommands(ctx).find((c) => c.id === "merge-branch-into-current")!;
    expect(availableIds(ctx)).toContain("merge-branch-into-current");
    expect(command.label).toBe("Merge branch into current branch…");
    expect(command.category).toBe("git");
    expect(command.keybindings ?? []).toEqual([]);
    command.run(ctx);
    expect(openMergeBranchPicker).toHaveBeenCalledTimes(1);
  });

  it("FR-430: 'Create branch at detached HEAD' only appears with a repo open AND a detached HEAD, and invokes openCreateBranchAtHead", () => {
    const openCreateBranchAtHead = vi.fn();
    expect(availableIds(baseContext({ repoOpen: true, isDetachedHead: false }))).not.toContain("create-branch-at-detached-head");
    expect(availableIds(baseContext({ repoOpen: false, isDetachedHead: true }))).not.toContain("create-branch-at-detached-head");
    const ctx = baseContext({ repoOpen: true, isDetachedHead: true, openCreateBranchAtHead });
    const command = getCommands(ctx).find((c) => c.id === "create-branch-at-detached-head")!;
    expect(availableIds(ctx)).toContain("create-branch-at-detached-head");
    expect(command.label).toBe("Create branch at detached HEAD");
    command.run(ctx);
    expect(openCreateBranchAtHead).toHaveBeenCalledTimes(1);
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

  it("specs/hunk-line-staging.md FR-483: the hunk commands appear only with the Changes panel open AND an eligible hunk under the cursor; Discard needs discardable lines; neither has a keybinding", () => {
    const toggleCurrentHunk = vi.fn();
    const discardCurrentHunk = vi.fn();
    const none = baseContext({ changesPanelOpen: true, canToggleCurrentHunk: false, canDiscardCurrentHunk: false });
    expect(availableIds(none)).not.toContain("toggle-current-hunk");
    expect(availableIds(none)).not.toContain("discard-current-hunk");

    const closed = baseContext({ changesPanelOpen: false, canToggleCurrentHunk: true, canDiscardCurrentHunk: true });
    expect(availableIds(closed)).not.toContain("toggle-current-hunk");

    const onlyToggle = baseContext({ changesPanelOpen: true, canToggleCurrentHunk: true, canDiscardCurrentHunk: false });
    expect(availableIds(onlyToggle)).toContain("toggle-current-hunk");
    expect(availableIds(onlyToggle)).not.toContain("discard-current-hunk");

    const both = baseContext({
      changesPanelOpen: true,
      canToggleCurrentHunk: true,
      canDiscardCurrentHunk: true,
      toggleCurrentHunk,
      discardCurrentHunk,
    });
    const commands = getCommands(both);
    const toggle = commands.find((c) => c.id === "toggle-current-hunk")!;
    const discard = commands.find((c) => c.id === "discard-current-hunk")!;
    expect(toggle.label).toBe("Stage/Unstage current hunk");
    expect(discard.label).toBe("Discard hunk");
    expect(toggle.category).toBe("git");
    expect(toggle.keybindings ?? []).toEqual([]);
    expect(discard.keybindings ?? []).toEqual([]);
    toggle.run(both);
    discard.run(both);
    expect(toggleCurrentHunk).toHaveBeenCalledTimes(1);
    expect(discardCurrentHunk).toHaveBeenCalledTimes(1);
  });

  it("specs/online-sync-pull.md FR-343: 'Pull' is only available when a repo is open AND pullDisabledReason is null, categorized 'git', carries no keybinding, and invokes runPull verbatim", () => {
    const runPull = vi.fn();
    const noRepo = baseContext({ repoOpen: false, pullDisabledReason: null, runPull });
    expect(availableIds(noRepo)).not.toContain("pull");

    const disabled = baseContext({ repoOpen: true, pullDisabledReason: "No upstream configured", runPull });
    expect(availableIds(disabled)).not.toContain("pull");

    const eligible = baseContext({ repoOpen: true, pullDisabledReason: null, runPull });
    const command = getCommands(eligible).find((c) => c.id === "pull")!;
    expect(availableIds(eligible)).toContain("pull");
    expect(command.category).toBe("git");
    expect(command.keybindings ?? []).toEqual([]);
    command.run(eligible);
    expect(runPull).toHaveBeenCalledTimes(1);
  });

  it("specs/online-sync-push.md FR-349: 'Push' is only available when a repo is open AND pushDisabledReason is null, categorized 'git', carries no keybinding, and invokes runPush verbatim", () => {
    const runPush = vi.fn();
    const noRepo = baseContext({ repoOpen: false, pushDisabledReason: null, runPush });
    expect(availableIds(noRepo)).not.toContain("push");

    const disabled = baseContext({ repoOpen: true, pushDisabledReason: "No remotes configured", runPush });
    expect(availableIds(disabled)).not.toContain("push");

    const eligible = baseContext({ repoOpen: true, pushDisabledReason: null, runPush });
    const command = getCommands(eligible).find((c) => c.id === "push")!;
    expect(availableIds(eligible)).toContain("push");
    expect(command.category).toBe("git");
    expect(command.keybindings ?? []).toEqual([]);
    command.run(eligible);
    expect(runPush).toHaveBeenCalledTimes(1);
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

  it("FR-236: STATIC_SHORTCUT_ROWS carries the non-registry rows (Open Command Palette / Next-previous tab, plus the editor's keys), rendered via keyComboLabel-compatible KeyCombo data", () => {
    const labels = STATIC_SHORTCUT_ROWS.map((r) => r.label);
    expect(labels).toContain("Open Command Palette");
    expect(labels).toContain("Next / previous tab");
    expect(labels).toContain("Next conflict (in the editor)");
    const byLabel = (l: string) => STATIC_SHORTCUT_ROWS.find((r) => r.label === l)!;
    expect(byLabel("Next conflict (in the editor)").keybindings).toEqual([{ key: "F3" }, { key: "ArrowDown", alt: true }]);
    expect(byLabel("Previous conflict (in the editor)").keybindings).toEqual([{ key: "F3", shift: true }, { key: "ArrowUp", alt: true }]);
    expect(byLabel("Save and stage, or Mark as resolved (in the editor)").keybindings).toEqual([{ key: "S", mod: true, shift: true }]);
    expect(byLabel("Open Command Palette").category).toBe("general");
    expect(byLabel("Open Command Palette").keybindings).toEqual([{ key: "k", mod: true }]);
    expect(byLabel("Next / previous tab").category).toBe("tabs");
    expect(byLabel("Next / previous tab").keybindings).toEqual([
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

describe("specs/ignore-and-multiselect.md FR-504: selection commands", () => {
  const ids = [
    ["select-all-in-section", "Select all in section", "selectAllInSection", "selectAll"],
    ["stage-selected", "Stage selected", "stageSelected", "stage"],
    ["unstage-selected", "Unstage selected", "unstageSelected", "unstage"],
    ["discard-selected", "Discard selected…", "discardSelected", "discard"],
    ["discard-all-changes", "Discard all changes…", "discardAll", "discardAll"],
    ["ignore-selected", "Ignore selected file(s)…", "ignoreSelected", "ignore"],
  ] as const;

  it.each(ids)("%s is registered with its label, is hidden with no repo open, and carries no keybinding", (id, label) => {
    const command = getCommands(baseContext({ repoOpen: true })).find((c) => c.id === id)!;
    expect(command.label).toBe(label);
    expect(command.keybindings).toBeUndefined();
    expect(command.isAvailable(baseContext({ repoOpen: false }))).toBe(false);
    expect(command.isAvailable(baseContext({ repoOpen: true }))).toBe(true);
  });

  it.each(ids)("%s reports the panel's reason while it cannot run, and runs the matching handler", (id, _label, handler, reasonKey) => {
    const run = vi.fn();
    const blocked = baseContext({
      repoOpen: true,
      selectionCommands: { ...NO_SELECTION_COMMANDS, [reasonKey]: "Select files in the Changes list first." },
      [handler]: run,
    });
    const command = getCommands(blocked).find((c) => c.id === id)!;
    expect(command.disabledReason!(blocked)).toBe("Select files in the Changes list first.");
    const ready = baseContext({ repoOpen: true, selectionCommands: { ...NO_SELECTION_COMMANDS, [reasonKey]: null }, [handler]: run });
    expect(command.disabledReason!(ready)).toBeNull();
    command.run(ready);
    expect(run).toHaveBeenCalledTimes(1);
  });
});

// specs/edit-in-diff.md FR-533: Edit file / Save / Save and stage (shown disabled with the reason, never hidden).
describe("edit-in-diff commands (FR-533)", () => {
  const find = (ctx: CommandContext, id: string) => getCommands(ctx).find((c) => c.id === id)!;
  const reasons = (over: Partial<CommandContext["editCommands"]>): CommandContext["editCommands"] => ({ ...NO_EDIT_COMMANDS, ...over });

  it.each([
    ["edit-file", "Edit file"],
    ["save-edit", "Save"],
    ["save-and-stage-edit", "Save and stage"],
  ])("%s is registered as '%s', needs an open repo, and has no global keybinding (FR-527)", (id, label) => {
    const c = find(baseContext({ repoOpen: true }), id);
    expect(c.label).toBe(label);
    expect(c.keybindings).toBeUndefined();
    expect(c.isAvailable(baseContext({ repoOpen: false }))).toBe(false);
    expect(c.isAvailable(baseContext({ repoOpen: true }))).toBe(true);
  });

  it("Edit file reports the panel's reason, and runs editFile once it can", () => {
    const editFile = vi.fn();
    const blocked = baseContext({ repoOpen: true, editFile, editCommands: reasons({ edit: "File too large to edit here" }) });
    const c = find(blocked, "edit-file");
    expect(c.disabledReason!(blocked)).toBe("File too large to edit here");
    const ready = baseContext({ repoOpen: true, editFile, editCommands: reasons({ edit: null }) });
    expect(c.disabledReason!(ready)).toBeNull();
    c.run(ready);
    expect(editFile).toHaveBeenCalledTimes(1);
  });

  it("Save and Save and stage are disabled with a reason unless the editor is open, and run their handlers", () => {
    const saveEdit = vi.fn();
    const saveAndStageEdit = vi.fn();
    const closed = baseContext({ repoOpen: true });
    expect(find(closed, "save-edit").disabledReason!(closed)).toBe("Open a file for editing first.");
    expect(find(closed, "save-and-stage-edit").disabledReason!(closed)).toBe("Open a file for editing first.");
    const open = baseContext({ repoOpen: true, saveEdit, saveAndStageEdit, editCommands: reasons({ edit: "Already editing this file.", save: null, saveAndStage: null }) });
    expect(find(open, "save-edit").disabledReason!(open)).toBeNull();
    find(open, "save-edit").run(open);
    find(open, "save-and-stage-edit").run(open);
    expect(saveEdit).toHaveBeenCalledTimes(1);
    expect(saveAndStageEdit).toHaveBeenCalledTimes(1);
  });

  it("relabels Save and stage as 'Save and stage whole file' when the file has staged content", () => {
    expect(find(baseContext({ repoOpen: true, editCommands: reasons({ stagedContent: true }) }), "save-and-stage-edit").label).toBe(
      "Save and stage whole file",
    );
    expect(find(baseContext({ repoOpen: true, editCommands: reasons({ stagedContent: false }) }), "save-and-stage-edit").label).toBe(
      "Save and stage",
    );
  });
  it("FR-572: conflict flow commands are registered with one label each, show their reason, and Save and stage steps aside in a conflict", () => {
    const ids = ["mark-resolved", "next-conflicted-file", "resolve-in-editor", "continue-operation"];
    const labels = ["Mark as resolved", "Next conflicted file", "Resolve in editor", "Continue merge / rebase / cherry-pick"];
    ids.forEach((id, i) => {
      const c = find(baseContext({ repoOpen: true }), id);
      expect(c.label).toBe(labels[i]);
      expect(c.keybindings).toBeUndefined();
      expect(c.isAvailable(baseContext({ repoOpen: false }))).toBe(false);
    });
    const run = vi.fn();
    const ctx = baseContext({ repoOpen: true, markResolved: run, nextConflictedFile: run, resolveInEditor: run, continueOperation: run, editCommands: reasons({ markResolved: null, nextConflictedFile: null, resolveInEditor: null, continueOperation: "2 conflicted files still unresolved." }) });
    ids.forEach((id) => find(ctx, id).run(ctx));
    expect(run).toHaveBeenCalledTimes(4);
    expect(find(ctx, "continue-operation").disabledReason!(ctx)).toBe("2 conflicted files still unresolved.");
    expect(find(baseContext({ repoOpen: true }), "mark-resolved").disabledReason!(baseContext({ repoOpen: true }))).toBe("Open a conflicted file in the editor first.");
    const inConflict = baseContext({ repoOpen: true, editCommands: reasons({ conflict: true }) });
    expect(find(inConflict, "save-and-stage-edit").isAvailable(inConflict)).toBe(false);
  });

  it("FR-552: 'Restore unsaved edits' is disabled with a reason without drafts, enabled with them, and re-runs the offer", () => {
    const restoreUnsavedEdits = vi.fn();
    const none = baseContext({ repoOpen: true, hasRecoverableDrafts: false, restoreUnsavedEdits });
    const cmd = getCommands(none).find((c) => c.id === "restore-unsaved-edits")!;
    expect(cmd.label).toBe("Restore unsaved edits");
    expect(cmd.isAvailable(none)).toBe(true);
    expect(cmd.disabledReason?.(none)).toBe("No unsaved edits to restore");
    const some = baseContext({ repoOpen: true, hasRecoverableDrafts: true, restoreUnsavedEdits });
    expect(cmd.disabledReason?.(some)).toBeNull();
    cmd.run(some);
    expect(restoreUnsavedEdits).toHaveBeenCalledTimes(1);
    expect(availableIds(baseContext({ repoOpen: false }))).not.toContain("restore-unsaved-edits");
  });
});
