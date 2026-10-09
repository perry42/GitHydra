// SPDX-License-Identifier: GPL-3.0-or-later
import type { RepoTab } from "../hooks/useRepoTabs";
import { repoTabLabel } from "./repoLabel";
import { isMac, type KeyCombo } from "./platform";
import { NO_DRAFTS_REASON, type EditCommandReasons } from "./editFile";
import type { SelectionCommandReasons } from "./selectionCommands";

/**
 * specs/keyboard-shortcuts-command-palette.md FR-223/FR-224/FR-230: everything a command's
 * `isAvailable`/`run` needs — a plain snapshot of state/handlers `App.tsx` already owns (every
 * field here is a direct pass-through, never new business logic). Rebuilt fresh by `App.tsx` on
 * every render and handed to both the palette (FR-222, `CommandPalette.tsx`) and the global
 * keybinding layer (FR-226, `useGlobalKeybindings.ts`).
 */
export interface CommandContext {
  tabs: RepoTab[];
  activeTabId: string | null;
  /** `repoTabs.openNewTab` verbatim. */
  openNewTab: () => void;
  /** `repoTabs.closeTab` verbatim, pre-bound to the current `activeTabId`. */
  closeActiveTab: () => void;
  /** `repoTabs.activateTab` verbatim. */
  activateTab: (id: string) => void;

  /** `graph.status === "ready"` — a repo is open (FR-224's "only when a repo is open" gate shared
   * by New branch/New stash). */
  repoOpen: boolean;
  /** Toolbar's own `canRefresh` (`graph.status === "ready"`). */
  canRefresh: boolean;
  isRefreshing: boolean;
  /** `refreshEverything` verbatim. */
  refreshEverything: () => void;

  /** `toggleTheme` verbatim. */
  toggleTheme: () => void;

  /** Toolbar's own `showBranchesToggle`. */
  showBranchesToggle: boolean;
  /** `toggleSidebar` verbatim (Toolbar's "Branches" toggle — expands/collapses the sidebar). */
  toggleBranchesSidebar: () => void;

  /** Toolbar's own `showChangesToggle`. */
  showChangesToggle: boolean;
  /** `rightPanel === "changes"` — needed by the "Commit staged changes" gate below. */
  changesPanelOpen: boolean;
  /** `toggleChangesPanel` verbatim. */
  toggleChangesPanel: () => void;

  /** Toolbar's own `showStashToggle`. */
  showStashToggle: boolean;
  /** Toolbar's own stash-toggle disabled reason (`null` means eligible). */
  stashDisabledReason: string | null;
  /** `toggleStashPanel` verbatim. */
  toggleStashPanel: () => void;

  /** Opens the existing `NewBranchDialog` (`setNewBranchRequest({})`) verbatim. */
  openNewBranchDialog: () => void;
  /** Opens the existing `CreateStashDialog` (`setShowCreateStashDialog(true)`) verbatim. */
  openNewStashDialog: () => void;

  /** The Changes panel composer's own `canCommit` (non-empty message + the panel's existing
   * staged-file/amend rules) — `false` whenever the Changes panel isn't even open. */
  canCommit: boolean;
  /** Invokes the Changes panel composer's existing `submitCommit` verbatim. */
  commitStagedChanges: () => void;

  /** specs/hunk-line-staging.md FR-483: an eligible checkbox diff is open in the Changes panel and a hunk has
   * the cursor (the panel reports it; it survives the diff losing DOM focus when the palette opens). */
  canToggleCurrentHunk: boolean;
  /** Same hunk's checkbox action: stage it unless it is fully staged, then unstage it. */
  toggleCurrentHunk: () => void;
  /** As above, and that hunk also has unstaged changed lines to discard (FR-478). */
  canDiscardCurrentHunk: boolean;
  /** Opens the FR-455 discard confirmation for that hunk - never discards without it. */
  discardCurrentHunk: () => void;

  /**
   * specs/ignore-and-multiselect.md FR-504: what each Changes-list selection command can do now (null = can run, a string =
   * why it cannot). `NO_SELECTION_COMMANDS` while the Changes panel is closed.
   */
  selectionCommands: SelectionCommandReasons;
  /** Pass-throughs to `ChangesPanelHandle` (each is a no-op when its reason above is non-null). */
  stageSelected: () => void;
  unstageSelected: () => void;
  discardSelected: () => void;
  discardAll: () => void;
  ignoreSelected: () => void;
  selectAllInSection: () => void;

  /**
   * specs/edit-in-diff.md FR-533: what Edit file / Save / Save and stage can do now (null = can run, string = why not), reported
   * by the Changes panel. `NO_EDIT_COMMANDS` while the panel is closed. The pass-throughs below go to `ChangesPanelHandle`.
   */
  editCommands: EditCommandReasons;
  editFile: () => void;
  saveEdit: () => void;
  saveAndStageEdit: () => void;
  /** specs/edit-in-diff.md FR-562: the conflict block editor's navigation; reasons live in `editCommands`. */
  nextConflict: () => void;
  prevConflict: () => void;

  /** specs/keyboard-shortcuts-reference.md FR-231: opens the App-owned `KeyboardShortcutsScreen`
   * (`setShortcutsOpen(true)` verbatim) — the same lift-up pattern as `openNewBranchDialog`/
   * `openNewStashDialog` above. */
  openKeyboardShortcuts: () => void;

  /** specs/find-commits-overlay.md FR-258: the exact gate the retired `FilterBar` rendered under
   * (`graph.status === "ready" && graph.repoState && !graph.repoState.isEmpty &&
   * !graph.repoState.isUnbornHead`) — distinct from `showChangesToggle`/`showBranchesToggle`
   * (which don't exclude an empty/unborn-HEAD repo), so it gets its own field rather than reusing
   * one of those. */
  showFindCommitsToggle: boolean;
  /** FR-259/FR-268: opens the Find Commits overlay (`setFindCommitsOpen(true)` verbatim). The
   * toolbar button's own `onClick` handles the "re-click while already open closes it" leg itself
   * (see `Toolbar`'s own prop doc comment) — this command's `run` only ever opens, matching the
   * spec's own literal text, since the overlay can't be reached via the palette/this keybinding
   * while it's already open (the global keybinding layer is suspended the whole time it's mounted
   * — FR-266). */
  openFindCommits: () => void;

  /** specs/find-commits-overlay.md FR-267/268: expands the Branches sidebar if collapsed, then
   * moves focus into its existing search box (bumping `focusSearchToken`) — both steps in one call
   * so `BranchesPanel` reliably has its search input in the DOM by the time it reacts to the token
   * bump, regardless of whether the sidebar was already expanded. */
  focusBranchesSearch: () => void;

  /** specs/online-sync-fetch.md FR-327: whether the Fetch command is shown at all — a repo must
   * be open (mirrors `repoOpen` above; deliberately not gated on remote count, since a zero-remote
   * repo's fetch is a real, valid, empty-result no-op per FR-321, not something to hide). */
  showFetchToggle: boolean;
  /** FR-322: true while a fetch is already in flight — the command is unavailable (not just
   * disabled-with-reason) while running, matching "Refresh commit graph"'s own
   * `!c.isRefreshing` gate immediately below. */
  isFetching: boolean;
  /** FR-327: triggers `fetchAllRemotes()` for the active tab's repo — `useFetchAction.runFetch`
   * verbatim. */
  runFetch: () => void;

  /** specs/online-sync-pull.md FR-343: whether the Pull command is available right now —
   * `pullDisabledReason === null` (mirrors `stashDisabledReason`'s own gate immediately above).
   * Unlike Fetch, Pull genuinely can be ineligible for reasons beyond "already running" (no
   * upstream, a bare repo, an unborn HEAD), so this folds `pullDisabledReason` in directly rather
   * than exposing it as a separate field only the Toolbar reads — the palette convention (FR-225)
   * is to hide an unavailable command entirely, never show it disabled-with-reason. */
  pullDisabledReason: string | null;
  /** FR-339: triggers `pull()` for the active tab's repo using the currently-selected strategy —
   * `usePullAction.runPull` verbatim. */
  runPull: () => void;

  /** specs/online-sync-push.md FR-349: whether the Push command is available right now —
   * `pushDisabledReason === null` (mirrors `pullDisabledReason`'s own gate immediately above). Same
   * "hide entirely, never disabled-with-reason in the palette" convention FR-225 already
   * establishes for Pull. */
  pushDisabledReason: string | null;
  /** FR-344/FR-345: triggers a push for the active tab's repo's current branch to whichever remote
   * the Toolbar's own picker currently has selected — `usePushAction.requestPush` pre-bound to
   * that remote/branch/behind-count, verbatim. */
  runPush: () => void;

  /** specs/git-identity-profiles.md: opens the Git Identity Profiles dialog
   * (`setIdentityProfilesOpen(true)` verbatim) — no repo gating (FR-329's profile library is fully
   * usable with no repo open at all; only per-repo apply/remove, handled inside the dialog itself,
   * requires one), matching "Toggle theme"'s own always-available shape. */
  openIdentityProfiles: () => void;

  /** specs/online-sync-clone.md FR-351: opens `CloneDialog` (`setCloneDialogOpen(true)` verbatim)
   * — no repo gating, matching `openIdentityProfiles`'s own always-available shape immediately
   * above (cloning is reachable with no repo open at all, from the landing screen, and just as
   * usefully while a repo IS already open — it always creates a brand-new tab). */
  openCloneDialog: () => void;

  /** specs/branch-panel-drag-merge.md FR-437: opens the App-owned `MergeBranchPicker`
   * (`setMergeBranchPickerOpen(true)` verbatim). Availability is just "a repo is open" - the
   * palette hides unavailable commands entirely (FR-225), so the spec's "disabled with a reason in
   * a bare repo / during an in-progress operation" lives inside the picker itself, which shows the
   * FR-308 reason inline instead of the command vanishing without explanation. */
  openMergeBranchPicker: () => void;
  /** specs/branch-panel-drag-merge.md FR-430: true only when HEAD is detached (nothing to save
   * otherwise), so "Create branch at detached HEAD" only appears then. */
  isDetachedHead: boolean;
  /** Opens the name-entry dialog that saves the current detached HEAD on a new branch
   * (`createBranchAtCommit`, never switches). */
  openCreateBranchAtHead: () => void;

  /** specs/edit-recovery-draft.md FR-552: the active repo has at least one stored recovery draft. */
  hasRecoverableDrafts: boolean;
  /** Re-runs the restore offer chain for the active repo. */
  restoreUnsavedEdits: () => void;
}

/**
 * specs/keyboard-shortcuts-reference.md FR-234: which of the reference screen's four fixed
 * headings a command belongs under — assigned once per command below, the single source of truth
 * the reference screen groups by (never a second, independently-maintained grouping map).
 */
export type CommandCategory = "tabs" | "view" | "git" | "general";

export interface Command {
  id: string;
  label: string;
  /** FR-226/FR-227: present only for the registry commands a direct global keybinding also covers
   * ("Refresh commit graph", "Commit staged changes") — read by both the palette (as shortcut
   * hints) and `useGlobalKeybindings` (to decide which command a keypress maps to). A command may
   * have more than one combo bound to it (e.g. "Refresh" accepts both `Ctrl/Cmd+R` and, on
   * Windows/Linux, the platform-native `F5`) — any one of them fires the command. */
  keybindings?: KeyCombo[];
  /** FR-225: governs both whether this command appears in the palette at all (hidden, never
   * shown-disabled, when `false`) and whether its `keybindings` (if any) fire. Deliberately
   * IGNORED by the reference screen (specs/keyboard-shortcuts-reference.md FR-233) — that screen
   * shows every command regardless of `isAvailable`, the opposite philosophy from the palette. */
  isAvailable: (ctx: CommandContext) => boolean;
  /**
   * specs/ignore-and-multiselect.md FR-504: for an available command that cannot run right now, the reason. The palette then
   * shows it disabled with that reason instead of hiding it (FR-225's hiding stays the default for every other command).
   */
  disabledReason?: (ctx: CommandContext) => string | null;
  /** specs/keyboard-shortcuts-reference.md FR-234: which of the reference screen's four fixed
   * headings this command is grouped under. */
  category: CommandCategory;
  run: (ctx: CommandContext) => void;
}

/**
 * specs/keyboard-shortcuts-reference.md FR-236: the two direct global keybindings that structurally
 * can't be registry commands at all (see this file's own doc comment below, and
 * `useGlobalKeybindings.ts`'s hardcoded handling of these exact two bindings) — defined here, once,
 * purely as reference-screen display data. Must stay in sync with `useGlobalKeybindings.ts`'s
 * hardcoded Ctrl/Cmd+K and Ctrl+Tab/Ctrl+Shift+Tab handling if either binding ever changes — the
 * one piece of unavoidable duplication this feature's spec calls out explicitly.
 */
export interface StaticShortcutRow {
  label: string;
  category: CommandCategory;
  keybindings: KeyCombo[];
}

export const STATIC_SHORTCUT_ROWS: StaticShortcutRow[] = [
  { label: "Open Command Palette", category: "general", keybindings: [{ key: "k", mod: true }] },
  {
    label: "Next / previous tab",
    category: "tabs",
    keybindings: [
      { key: "Tab", mod: true },
      { key: "Tab", mod: true, shift: true },
    ],
  },
];

/**
 * FR-223/FR-224: the single v1 command registry, computed fresh from `ctx` on every call so the
 * "Switch to tab" entries (one per currently open tab) always reflect the live tab list — not a
 * static array module-level constant.
 *
 * Deliberately does NOT include "Open the Command Palette" or "Cycle to next/previous tab" as
 * entries here, even though both are direct FR-226 global keybindings: opening the palette is
 * palette UI state, not an app action a command can itself invoke from inside the palette, and tab
 * cycling has no single fixed target (it depends on whichever tab is currently active) — see
 * `useGlobalKeybindings.ts`'s own doc comment for where those two are actually handled.
 */
export function getCommands(ctx: CommandContext): Command[] {
  return [
    {
      id: "open-repository",
      label: "New tab / Open repository…",
      category: "tabs",
      isAvailable: () => true,
      run: (c) => c.openNewTab(),
    },
    {
      id: "close-current-tab",
      label: "Close current tab",
      category: "tabs",
      isAvailable: (c) => c.activeTabId !== null,
      run: (c) => c.closeActiveTab(),
    },
    ...ctx.tabs.map(
      (tab): Command => ({
        id: `switch-to-tab:${tab.id}`,
        label: `Switch to tab: ${repoTabLabel(tab.repoPath)}`,
        category: "tabs",
        isAvailable: () => true,
        run: (c) => c.activateTab(tab.id),
      }),
    ),
    // specs/keyboard-shortcuts-reference.md FR-234: the "view" category's registration order
    // (Branches, Changes, Stashes, theme) is exactly the reference screen's displayed order —
    // grouped there in this same order, no separate sort.
    {
      id: "toggle-branches-sidebar",
      label: "Toggle Branches sidebar",
      category: "view",
      isAvailable: (c) => c.showBranchesToggle,
      run: (c) => c.toggleBranchesSidebar(),
    },
    {
      id: "toggle-changes-panel",
      label: "Toggle Changes panel",
      category: "view",
      isAvailable: (c) => c.showChangesToggle,
      run: (c) => c.toggleChangesPanel(),
    },
    {
      id: "toggle-stashes-panel",
      label: "Toggle Stashes panel",
      category: "view",
      isAvailable: (c) => c.showStashToggle && c.stashDisabledReason === null,
      run: (c) => c.toggleStashPanel(),
    },
    {
      id: "toggle-theme",
      label: "Toggle theme (light / dark)",
      category: "view",
      isAvailable: () => true,
      run: (c) => c.toggleTheme(),
    },
    // specs/find-commits-overlay.md FR-268: categorized "view" (grouped with the sidebar/panel-
    // visibility commands above) rather than "git" — neither of these two new commands mutates
    // repository state, matching "view"'s existing membership. Product-manager call, not
    // explicitly confirmed by the user — flagged in this feature's own spec as worth a second look
    // once built; having built it, "view" still reads right: both are pure UI-focus/visibility
    // actions, same as every other command already in this category.
    {
      id: "find-commits",
      label: "Find commits…",
      category: "view",
      keybindings: [{ key: "f", mod: true, shift: true }],
      isAvailable: (c) => c.showFindCommitsToggle,
      run: (c) => c.openFindCommits(),
    },
    {
      id: "focus-branches-search",
      label: "Focus branches search",
      category: "view",
      keybindings: [{ key: "f", mod: true }],
      isAvailable: (c) => c.showBranchesToggle,
      run: (c) => c.focusBranchesSearch(),
    },
    // specs/keyboard-shortcuts-reference.md FR-234: the "git" category's registration order (New
    // branch, New stash, Commit staged changes, Refresh commit graph) is exactly the reference
    // screen's displayed order — grouped there in this same order, no separate sort.
    {
      id: "new-branch",
      label: "New branch…",
      category: "git",
      isAvailable: (c) => c.repoOpen,
      run: (c) => c.openNewBranchDialog(),
    },
    {
      id: "new-stash",
      label: "New stash…",
      category: "git",
      isAvailable: (c) => c.repoOpen,
      run: (c) => c.openNewStashDialog(),
    },
    // specs/branch-panel-drag-merge.md FR-437: the keyboard alternative to dragging a branch chip/
    // card onto the current branch. No default keybinding (a merge is a history-changing action).
    {
      id: "merge-branch-into-current",
      label: "Merge branch into current branch…",
      category: "git",
      isAvailable: (c) => c.repoOpen,
      run: (c) => c.openMergeBranchPicker(),
    },
    // specs/branch-panel-drag-merge.md FR-430: the discoverable way to save a detached HEAD's
    // commits BEFORE leaving it (the checkout guard's dialog and post-leave banner offer the same).
    {
      id: "create-branch-at-detached-head",
      label: "Create branch at detached HEAD",
      category: "git",
      isAvailable: (c) => c.repoOpen && c.isDetachedHead,
      run: (c) => c.openCreateBranchAtHead(),
    },
    {
      id: "commit-staged-changes",
      label: "Commit staged changes",
      category: "git",
      keybindings: [{ key: "Enter", mod: true }],
      isAvailable: (c) => c.changesPanelOpen && c.canCommit,
      run: (c) => c.commitStagedChanges(),
    },
    // specs/hunk-line-staging.md FR-483: no default keybindings - the diff's own Space/arrow keys are the fast
    // path. Hidden unless an eligible checkbox diff has a hunk under the cursor (FR-225).
    {
      id: "toggle-current-hunk",
      label: "Stage/Unstage current hunk",
      category: "git",
      isAvailable: (c) => c.changesPanelOpen && c.canToggleCurrentHunk,
      run: (c) => c.toggleCurrentHunk(),
    },
    {
      id: "discard-current-hunk",
      label: "Discard hunk",
      category: "git",
      isAvailable: (c) => c.changesPanelOpen && c.canDiscardCurrentHunk,
      run: (c) => c.discardCurrentHunk(),
    },
    // specs/ignore-and-multiselect.md FR-504: shown disabled with a reason when nothing applies; no default keybindings
    // (a destructive or file-writing action should not sit one stray keypress away).
    {
      id: "select-all-in-section",
      label: "Select all in section",
      category: "git",
      isAvailable: (c) => c.repoOpen,
      disabledReason: (c) => c.selectionCommands.selectAll,
      run: (c) => c.selectAllInSection(),
    },
    {
      id: "stage-selected",
      label: "Stage selected",
      category: "git",
      isAvailable: (c) => c.repoOpen,
      disabledReason: (c) => c.selectionCommands.stage,
      run: (c) => c.stageSelected(),
    },
    {
      id: "unstage-selected",
      label: "Unstage selected",
      category: "git",
      isAvailable: (c) => c.repoOpen,
      disabledReason: (c) => c.selectionCommands.unstage,
      run: (c) => c.unstageSelected(),
    },
    {
      id: "discard-selected",
      label: "Discard selected…",
      category: "git",
      isAvailable: (c) => c.repoOpen,
      disabledReason: (c) => c.selectionCommands.discard,
      run: (c) => c.discardSelected(),
    },
    {
      id: "discard-all-changes",
      label: "Discard all changes…",
      category: "git",
      isAvailable: (c) => c.repoOpen,
      disabledReason: (c) => c.selectionCommands.discardAll,
      run: (c) => c.discardAll(),
    },
    {
      id: "ignore-selected",
      label: "Ignore selected file(s)…",
      category: "git",
      isAvailable: (c) => c.repoOpen,
      disabledReason: (c) => c.selectionCommands.ignore,
      run: (c) => c.ignoreSelected(),
    },
    // specs/edit-in-diff.md FR-533: shown disabled with the reason, never hidden. No keybindings here: the letter shortcuts
    // (E, Ctrl/Cmd+S, Ctrl/Cmd+Shift+S) live in the diff pane and editor handlers (FR-527).
    {
      id: "edit-file",
      label: "Edit file",
      category: "git",
      isAvailable: (c) => c.repoOpen,
      disabledReason: (c) => c.editCommands.edit,
      run: (c) => c.editFile(),
    },
    {
      id: "save-edit",
      label: "Save",
      category: "git",
      isAvailable: (c) => c.repoOpen,
      disabledReason: (c) => c.editCommands.save,
      run: (c) => c.saveEdit(),
    },
    {
      id: "save-and-stage-edit",
      label: ctx.editCommands.conflict ? "Save and mark resolved" : ctx.editCommands.stagedContent ? "Save and stage whole file" : "Save and stage",
      category: "git",
      isAvailable: (c) => c.repoOpen,
      disabledReason: (c) => c.editCommands.saveAndStage,
      run: (c) => c.saveAndStageEdit(),
    },
    // specs/edit-in-diff.md FR-562: F3 / Shift+F3 and Alt+Down / Alt+Up are handled inside the editor (physical key codes), not here.
    {
      id: "next-conflict",
      label: "Next conflict",
      category: "git",
      isAvailable: (c) => c.repoOpen,
      disabledReason: (c) => c.editCommands.nextConflict,
      run: (c) => c.nextConflict(),
    },
    {
      id: "previous-conflict",
      label: "Previous conflict",
      category: "git",
      isAvailable: (c) => c.repoOpen,
      disabledReason: (c) => c.editCommands.prevConflict,
      run: (c) => c.prevConflict(),
    },
    // specs/edit-recovery-draft.md FR-552: shown disabled with the reason (never hidden) so the feature stays discoverable.
    {
      id: "restore-unsaved-edits",
      label: "Restore unsaved edits",
      category: "git",
      isAvailable: (c) => c.repoOpen,
      disabledReason: (c) => (c.hasRecoverableDrafts ? null : NO_DRAFTS_REASON),
      run: (c) => c.restoreUnsavedEdits(),
    },
    // specs/online-sync-fetch.md FR-327: registered here per CLAUDE.md's "new user-facing actions
    // get a commands.ts entry" convention — the ONE command-palette/keybinding entry point for
    // triggering a fetch, alongside the Toolbar button (both call the same `runFetch`).
    // Deliberately no keybinding: this is this app's first network call, and the spec's own
    // "every fetch is an explicit user action" guarantee reads more safely without a shortcut a
    // user could trigger by muscle memory before consciously choosing to make a network request.
    {
      id: "fetch-all-remotes",
      label: "Fetch all remotes",
      category: "git",
      isAvailable: (c) => c.showFetchToggle && !c.isFetching,
      run: (c) => c.runFetch(),
    },
    // specs/online-sync-pull.md FR-343: registered here per CLAUDE.md's "new user-facing actions
    // get a commands.ts entry" convention — the ONE command-palette/keybinding entry point for
    // triggering a pull, alongside the Toolbar's Pull button (both call the same `runPull`, using
    // whatever strategy override is currently selected there). Deliberately no keybinding, same
    // reasoning as "Fetch all remotes" immediately above (this app's other network-touching
    // action) — a pull can also move the current branch/create a real commit, an even stronger
    // reason not to bind it to muscle memory.
    {
      id: "pull",
      label: "Pull",
      category: "git",
      isAvailable: (c) => c.repoOpen && c.pullDisabledReason === null,
      run: (c) => c.runPull(),
    },
    // specs/online-sync-push.md FR-349: registered here per CLAUDE.md's "new user-facing actions
    // get a commands.ts entry" convention — the ONE command-palette/keybinding entry point for
    // triggering a push, alongside the Toolbar's Push button (both call the same `runPush`, using
    // whichever remote the Toolbar's own picker currently has selected). Deliberately no
    // keybinding, same reasoning as "Pull" immediately above (this is the one primitive that
    // mutates the shared remote — an even stronger reason not to bind it to muscle memory).
    {
      id: "push",
      label: "Push",
      category: "git",
      isAvailable: (c) => c.repoOpen && c.pushDisabledReason === null,
      run: (c) => c.runPush(),
    },
    {
      id: "refresh-commit-graph",
      label: "Refresh commit graph",
      category: "git",
      // F5 has no clean macOS equivalent (Cmd+R is the platform's own refresh convention there),
      // so it's only bound on Windows/Linux, alongside the cross-platform Ctrl/Cmd+R every
      // platform gets.
      keybindings: isMac() ? [{ key: "r", mod: true }] : [{ key: "r", mod: true }, { key: "F5" }],
      isAvailable: (c) => c.canRefresh && !c.isRefreshing,
      run: (c) => c.refreshEverything(),
    },
    // specs/git-identity-profiles.md: registered per CLAUDE.md's "new user-facing actions get a
    // commands.ts entry" convention. Categorized "git" (a git-config feature) even though, unlike
    // every other command in that category, it's always available regardless of repo state —
    // availability and category are independent axes in this registry (see "Toggle theme"'s own
    // always-available "view" placement for the same pattern).
    {
      id: "manage-identity-profiles",
      label: "Manage git identity profiles…",
      category: "git",
      isAvailable: () => true,
      run: (c) => c.openIdentityProfiles(),
    },
    // specs/online-sync-clone.md FR-351: registered per CLAUDE.md's "new user-facing actions get a
    // commands.ts entry" convention — the one command-palette/keybinding entry point for opening
    // the Clone dialog, alongside the landing screen's own "Clone a repository" button (both open
    // the same `CloneDialog`). Always available, same reasoning as "Manage git identity
    // profiles…" immediately above — this doesn't need (and isn't limited to) a repo already being
    // open. Deliberately no keybinding, same reasoning `commandContext`'s Fetch/Pull/Push entries
    // already give for this app's other network-touching actions.
    {
      id: "clone-repository",
      label: "Clone a repository…",
      category: "git",
      isAvailable: () => true,
      run: (c) => c.openCloneDialog(),
    },
    {
      id: "view-keyboard-shortcuts",
      label: "Keyboard shortcuts",
      category: "general",
      // specs/keyboard-shortcuts-reference.md FR-231: always present, repo open or not — this
      // reference screen's own availability is never gated (see FR-233).
      keybindings: [{ key: "/", mod: true }],
      isAvailable: () => true,
      run: (c) => c.openKeyboardShortcuts(),
    },
  ];
}
