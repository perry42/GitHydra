// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { KeyboardShortcutsScreen } from "./KeyboardShortcutsScreen";
import type { CommandContext } from "../../lib/commands";
import type { RepoTab } from "../../hooks/useRepoTabs";

function makeTab(id: string, repoPath: string): RepoTab {
  return { id, repoPath, remembered: { selectedSha: null, filter: {}, showAllRefs: false, rightPanel: "none", selectedFile: null } };
}

/** Every gate at its most-closed, "no repo" state — FR-233 means this component must still show
 * every repo-scoped row regardless. */
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
    ...overrides,
  };
}

describe("KeyboardShortcutsScreen (specs/keyboard-shortcuts-reference.md)", () => {
  it("FR-232: renders as a labeled modal dialog, focused on the close button (nothing to type)", () => {
    render(<KeyboardShortcutsScreen ctx={baseContext()} onClose={() => {}} />);
    const dialog = screen.getByRole("dialog", { name: /keyboard shortcuts/i });
    expect(dialog).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /close keyboard shortcuts/i })).toHaveFocus();
  });

  it("AC3/FR-233: with no repo open, still lists every repo-scoped command (ignoring isAvailable entirely)", () => {
    const ctx = baseContext({
      repoOpen: false,
      canRefresh: false,
      showBranchesToggle: false,
      showChangesToggle: false,
      showStashToggle: false,
      changesPanelOpen: false,
      canCommit: false,
    });
    render(<KeyboardShortcutsScreen ctx={ctx} onClose={() => {}} />);
    expect(screen.getByText("Commit staged changes")).toBeInTheDocument();
    expect(screen.getByText("New branch…")).toBeInTheDocument();
    expect(screen.getByText("New stash…")).toBeInTheDocument();
    expect(screen.getByText("Refresh commit graph")).toBeInTheDocument();
    expect(screen.getByText("Toggle Branches sidebar")).toBeInTheDocument();
    expect(screen.getByText("Toggle Changes panel")).toBeInTheDocument();
    expect(screen.getByText("Toggle Stashes panel")).toBeInTheDocument();
  });

  it("AC4: rows are grouped under exactly four headings, in order Tabs / View / Git actions / General", () => {
    render(<KeyboardShortcutsScreen ctx={baseContext()} onClose={() => {}} />);
    const headings = screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent);
    expect(headings).toEqual(["Tabs", "View", "Git actions", "General"]);
  });

  it("AC4: a row with no keybinding shows only its label; 'Refresh commit graph' shows both of its combos joined", () => {
    Object.defineProperty(window.navigator, "platform", { value: "Win32", configurable: true });
    render(<KeyboardShortcutsScreen ctx={baseContext()} onClose={() => {}} />);

    const openRepoRow = screen.getByText("New tab / Open repository…").closest("li")!;
    expect(within(openRepoRow).queryByText(/ctrl|cmd/i)).not.toBeInTheDocument();

    const refreshRow = screen.getByText("Refresh commit graph").closest("li")!;
    expect(within(refreshRow).getByText(/ctrl\+r.*f5/i)).toBeInTheDocument();
  });

  it("AC5: exactly one 'Switch to tab' row appears, regardless of whether 0, 1, or 5 tabs are open", () => {
    const { rerender } = render(<KeyboardShortcutsScreen ctx={baseContext({ tabs: [] })} onClose={() => {}} />);
    expect(screen.getAllByText("Switch to tab")).toHaveLength(1);

    rerender(<KeyboardShortcutsScreen ctx={baseContext({ tabs: [makeTab("t1", "/a")] })} onClose={() => {}} />);
    expect(screen.getAllByText("Switch to tab")).toHaveLength(1);

    const fiveTabs = Array.from({ length: 5 }, (_, i) => makeTab(`t${i}`, `/repo${i}`));
    rerender(<KeyboardShortcutsScreen ctx={baseContext({ tabs: fiveTabs })} onClose={() => {}} />);
    expect(screen.getAllByText("Switch to tab")).toHaveLength(1);
    // Never one row per open tab — none of the per-tab labels leak through.
    expect(screen.queryByText(/switch to tab: repo0/i)).not.toBeInTheDocument();
  });

  it("AC5: the 'Switch to tab' row shows no keybinding", () => {
    render(<KeyboardShortcutsScreen ctx={baseContext({ tabs: [makeTab("t1", "/a")] })} onClose={() => {}} />);
    const row = screen.getByText("Switch to tab").closest("li")!;
    expect(within(row).queryByText(/ctrl|cmd/i)).not.toBeInTheDocument();
  });

  it("AC6: shows the two non-registry static rows — 'Open Command Palette' under General, 'Next / previous tab' under Tabs", () => {
    Object.defineProperty(window.navigator, "platform", { value: "Win32", configurable: true });
    render(<KeyboardShortcutsScreen ctx={baseContext()} onClose={() => {}} />);

    const generalSection = screen.getByRole("heading", { name: "General" }).closest("section")!;
    expect(within(generalSection).getByText("Open Command Palette")).toBeInTheDocument();
    expect(within(generalSection).getByText(/ctrl\+k/i)).toBeInTheDocument();

    const tabsSection = screen.getByRole("heading", { name: "Tabs" }).closest("section")!;
    const cycleRow = within(tabsSection).getByText("Next / previous tab").closest("li")!;
    expect(within(cycleRow).getByText(/ctrl\+tab.*ctrl\+shift\+tab/i)).toBeInTheDocument();
  });

  it("Escape closes the screen", async () => {
    const onClose = vi.fn();
    render(<KeyboardShortcutsScreen ctx={baseContext()} onClose={onClose} />);
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("clicking the backdrop closes the screen (click-outside-to-close convention)", async () => {
    const onClose = vi.fn();
    render(<KeyboardShortcutsScreen ctx={baseContext()} onClose={onClose} />);
    // eslint-disable-next-line testing-library/no-node-access
    const overlay = document.querySelector(".gh-keyboard-shortcuts__overlay") as HTMLElement;
    await userEvent.click(overlay);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("clicking the close button closes the screen", async () => {
    const onClose = vi.fn();
    render(<KeyboardShortcutsScreen ctx={baseContext()} onClose={onClose} />);
    await userEvent.click(screen.getByRole("button", { name: /close keyboard shortcuts/i }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("AC8: keybinding labels render Cmd on macOS and Ctrl on Windows/Linux", () => {
    Object.defineProperty(window.navigator, "platform", { value: "MacIntel", configurable: true });
    render(<KeyboardShortcutsScreen ctx={baseContext()} onClose={() => {}} />);
    const generalSection = screen.getByRole("heading", { name: "General" }).closest("section")!;
    expect(within(generalSection).getByText(/cmd\+k/i)).toBeInTheDocument();
    expect(within(generalSection).queryByText(/ctrl\+k/i)).not.toBeInTheDocument();

    Object.defineProperty(window.navigator, "platform", { value: "Win32", configurable: true });
  });
});
