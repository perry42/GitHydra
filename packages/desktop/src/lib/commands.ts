// SPDX-License-Identifier: GPL-3.0-or-later
import type { RepoTab } from "../hooks/useRepoTabs";
import { repoTabLabel } from "./repoLabel";
import type { KeyCombo } from "./platform";

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
}

export interface Command {
  id: string;
  label: string;
  /** FR-226/FR-227: present only for the two registry commands a direct global keybinding also
   * covers ("Refresh commit graph", "Commit staged changes") — read by both the palette (as a
   * shortcut hint) and `useGlobalKeybindings` (to decide which command a keypress maps to). */
  keybinding?: KeyCombo;
  /** FR-225: governs both whether this command appears in the palette at all (hidden, never
   * shown-disabled, when `false`) and whether its `keybinding` (if any) fires. */
  isAvailable: (ctx: CommandContext) => boolean;
  run: (ctx: CommandContext) => void;
}

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
      isAvailable: () => true,
      run: (c) => c.openNewTab(),
    },
    {
      id: "close-current-tab",
      label: "Close current tab",
      isAvailable: (c) => c.activeTabId !== null,
      run: (c) => c.closeActiveTab(),
    },
    ...ctx.tabs.map(
      (tab): Command => ({
        id: `switch-to-tab:${tab.id}`,
        label: `Switch to tab: ${repoTabLabel(tab.repoPath)}`,
        isAvailable: () => true,
        run: (c) => c.activateTab(tab.id),
      }),
    ),
    {
      id: "refresh-commit-graph",
      label: "Refresh commit graph",
      keybinding: { key: "r", mod: true },
      isAvailable: (c) => c.canRefresh && !c.isRefreshing,
      run: (c) => c.refreshEverything(),
    },
    {
      id: "toggle-theme",
      label: "Toggle theme (light / dark)",
      isAvailable: () => true,
      run: (c) => c.toggleTheme(),
    },
    {
      id: "toggle-branches-sidebar",
      label: "Toggle Branches sidebar",
      isAvailable: (c) => c.showBranchesToggle,
      run: (c) => c.toggleBranchesSidebar(),
    },
    {
      id: "toggle-changes-panel",
      label: "Toggle Changes panel",
      isAvailable: (c) => c.showChangesToggle,
      run: (c) => c.toggleChangesPanel(),
    },
    {
      id: "toggle-stashes-panel",
      label: "Toggle Stashes panel",
      isAvailable: (c) => c.showStashToggle && c.stashDisabledReason === null,
      run: (c) => c.toggleStashPanel(),
    },
    {
      id: "new-branch",
      label: "New branch…",
      isAvailable: (c) => c.repoOpen,
      run: (c) => c.openNewBranchDialog(),
    },
    {
      id: "new-stash",
      label: "New stash…",
      isAvailable: (c) => c.repoOpen,
      run: (c) => c.openNewStashDialog(),
    },
    {
      id: "commit-staged-changes",
      label: "Commit staged changes",
      keybinding: { key: "Enter", mod: true },
      isAvailable: (c) => c.changesPanelOpen && c.canCommit,
      run: (c) => c.commitStagedChanges(),
    },
  ];
}
