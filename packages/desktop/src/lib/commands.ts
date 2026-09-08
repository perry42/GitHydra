// SPDX-License-Identifier: GPL-3.0-or-later
import type { RepoTab } from "../hooks/useRepoTabs";
import { repoTabLabel } from "./repoLabel";
import { isMac, type KeyCombo } from "./platform";

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

  /** specs/keyboard-shortcuts-reference.md FR-231: opens the App-owned `KeyboardShortcutsScreen`
   * (`setShortcutsOpen(true)` verbatim) — the same lift-up pattern as `openNewBranchDialog`/
   * `openNewStashDialog` above. */
  openKeyboardShortcuts: () => void;
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
    {
      id: "commit-staged-changes",
      label: "Commit staged changes",
      category: "git",
      keybindings: [{ key: "Enter", mod: true }],
      isAvailable: (c) => c.changesPanelOpen && c.canCommit,
      run: (c) => c.commitStagedChanges(),
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
