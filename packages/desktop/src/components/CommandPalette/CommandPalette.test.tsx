// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CommandPalette } from "./CommandPalette";
import type { CommandContext } from "../../lib/commands";
import type { RepoTab } from "../../hooks/useRepoTabs";

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
    repoOpen: true,
    canRefresh: true,
    isRefreshing: false,
    refreshEverything: vi.fn(),
    toggleTheme: vi.fn(),
    showBranchesToggle: true,
    toggleBranchesSidebar: vi.fn(),
    showChangesToggle: true,
    changesPanelOpen: false,
    toggleChangesPanel: vi.fn(),
    showStashToggle: true,
    stashDisabledReason: null,
    toggleStashPanel: vi.fn(),
    openNewBranchDialog: vi.fn(),
    openNewStashDialog: vi.fn(),
    canCommit: false,
    commitStagedChanges: vi.fn(),
    openKeyboardShortcuts: vi.fn(),
    ...overrides,
  };
}

describe("CommandPalette", () => {
  it("AC1: opens with its filter input focused and the full available command list visible, unfiltered", () => {
    const ctx = baseContext();
    render(<CommandPalette ctx={ctx} onClose={() => {}} />);
    const input = screen.getByRole("combobox", { name: /command palette/i });
    expect(input).toHaveFocus();
    expect(screen.getByRole("option", { name: /refresh commit graph/i })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /toggle theme/i })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /new branch/i })).toBeInTheDocument();
  });

  it("AC5/FR-225: an unavailable command (e.g. New branch with no repo open) is hidden entirely, not shown-disabled", () => {
    const ctx = baseContext({ repoOpen: false, canRefresh: false, showBranchesToggle: false, showChangesToggle: false, showStashToggle: false });
    render(<CommandPalette ctx={ctx} onClose={() => {}} />);
    expect(screen.queryByRole("option", { name: /new branch/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /refresh commit graph/i })).not.toBeInTheDocument();
    expect(screen.getByRole("option", { name: /new tab \/ open repository/i })).toBeInTheDocument();
  });

  it("AC2: typing narrows the list to matching labels, and shows an explicit empty state for no matches", async () => {
    const ctx = baseContext();
    render(<CommandPalette ctx={ctx} onClose={() => {}} />);
    await userEvent.type(screen.getByRole("combobox"), "theme");
    expect(screen.getByRole("option", { name: /toggle theme/i })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /refresh commit graph/i })).not.toBeInTheDocument();

    await userEvent.clear(screen.getByRole("combobox"));
    await userEvent.type(screen.getByRole("combobox"), "zzzznothingmatches");
    expect(screen.getByText(/no matching commands/i)).toBeInTheDocument();
    expect(screen.queryAllByRole("option")).toHaveLength(0);
  });

  it("AC3: Down/Up wraps the highlighted selection at either end, Enter runs the highlighted command and closes", async () => {
    const toggleTheme = vi.fn();
    const onClose = vi.fn();
    const ctx = baseContext({ toggleTheme });
    render(<CommandPalette ctx={ctx} onClose={onClose} />);
    await userEvent.type(screen.getByRole("combobox"), "theme");

    // Exactly one match ("Toggle theme") — Up from it wraps back to itself; Down likewise.
    await userEvent.keyboard("{ArrowUp}");
    expect(screen.getByRole("option", { name: /toggle theme/i })).toHaveAttribute("aria-selected", "true");
    await userEvent.keyboard("{ArrowDown}");
    expect(screen.getByRole("option", { name: /toggle theme/i })).toHaveAttribute("aria-selected", "true");

    await userEvent.keyboard("{Enter}");
    expect(toggleTheme).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("Escape closes with no action taken", async () => {
    const refreshEverything = vi.fn();
    const onClose = vi.fn();
    const ctx = baseContext({ refreshEverything });
    render(<CommandPalette ctx={ctx} onClose={onClose} />);
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(refreshEverything).not.toHaveBeenCalled();
  });

  it("clicking the backdrop closes the palette (FR-228's click-outside-to-close convention)", async () => {
    const onClose = vi.fn();
    render(<CommandPalette ctx={baseContext()} onClose={onClose} />);
    // The overlay is the outer element; clicking it directly (not a descendant) triggers close.
    // eslint-disable-next-line testing-library/no-node-access
    const overlay = document.querySelector(".gh-command-palette__overlay") as HTMLElement;
    await userEvent.click(overlay);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("clicking a command row runs it and closes the palette", async () => {
    const toggleTheme = vi.fn();
    const onClose = vi.fn();
    render(<CommandPalette ctx={baseContext({ toggleTheme })} onClose={onClose} />);
    await userEvent.click(screen.getByRole("option", { name: /toggle theme/i }));
    expect(toggleTheme).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("AC4: lists one 'Switch to tab' entry per open tab, labeled with the repo name, and selecting one activates it", async () => {
    const activateTab = vi.fn();
    const ctx = baseContext({ tabs: [makeTab("t1", "/repos/alpha"), makeTab("t2", "/repos/beta")], activeTabId: "t1", activateTab });
    const onClose = vi.fn();
    render(<CommandPalette ctx={ctx} onClose={onClose} />);
    expect(screen.getByRole("option", { name: /switch to tab: alpha/i })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("option", { name: /switch to tab: beta/i }));
    expect(activateTab).toHaveBeenCalledWith("t2");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("specs/keyboard-shortcuts-reference.md FR-231: lists 'Keyboard shortcuts' (always available) and running it opens the reference screen and closes the palette", async () => {
    const openKeyboardShortcuts = vi.fn();
    const onClose = vi.fn();
    render(<CommandPalette ctx={baseContext({ openKeyboardShortcuts })} onClose={onClose} />);
    await userEvent.click(screen.getByRole("option", { name: /keyboard shortcuts/i }));
    expect(openKeyboardShortcuts).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("shows a shortcut hint for commands that carry a direct keybinding", () => {
    render(<CommandPalette ctx={baseContext()} onClose={() => {}} />);
    const row = screen.getByRole("option", { name: /refresh commit graph/i });
    expect(row).toHaveTextContent(/ctrl\+r/i);
  });
});
