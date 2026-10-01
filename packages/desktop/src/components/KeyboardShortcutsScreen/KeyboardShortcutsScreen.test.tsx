// SPDX-License-Identifier: GPL-3.0-or-later
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { KeyboardShortcutsScreen } from "./KeyboardShortcutsScreen";
import type { CommandContext } from "../../lib/commands";
import type { KeybindingOverrides } from "../../lib/keybindingOverrides";
import type { KeyCombo } from "../../lib/platform";
import { useKeybindingOverrides } from "../../hooks/useKeybindingOverrides";
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
    ...overrides,
  };
}

/**
 * specs/keyboard-shortcuts-visual-redesign.md FR-387: a shortcut combo like "Ctrl+R / F5" no
 * longer lives in one text node — it's a `KeyCap` chip per key, joined by `+`/`" / "` glyphs — so
 * `getByText`'s default matcher (which only inspects an element's own direct text-node children,
 * never descendants) can no longer find the combined string on any single node. This matches
 * against the *whole* `.gh-keyboard-shortcuts__shortcut` wrapper's `textContent` (which, unlike
 * `getNodeText`, does concatenate across descendants) instead — same behavioral assertion (does
 * this row show this shortcut text?), just adapted to the new nested-chip DOM shape.
 */
function shortcutText(regex: RegExp) {
  return (_content: string, element: Element | null) =>
    Boolean(element?.classList.contains("gh-keyboard-shortcuts__shortcut") && regex.test(element.textContent ?? ""));
}

/** Same rationale as `shortcutText` above, applied to FR-399's conflict message — it also
 * interleaves a `KeyCap` (nested chip spans) with plain text nodes ("... is already used by
 * "Pull"."), so the default `getByText` matcher (direct text-node children only) can't see it as
 * one string. */
function conflictText(regex: RegExp) {
  return (_content: string, element: Element | null) =>
    Boolean(element?.classList.contains("gh-shortcut-row__conflict-text") && regex.test(element.textContent ?? ""));
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
    // specs/find-commits-overlay.md AC13: both new commands appear here too, FR-233's
    // "every registered command regardless of isAvailable" applying to them just like every
    // other repo-scoped command already covered by this test.
    expect(screen.getByText("Find commits…")).toBeInTheDocument();
    expect(screen.getByText("Focus branches search")).toBeInTheDocument();
  });

  it("specs/find-commits-overlay.md AC13: 'Find commits…' and 'Focus branches search' appear under the View heading, with their Ctrl/Cmd+Shift+F and Ctrl/Cmd+F shortcuts", () => {
    Object.defineProperty(window.navigator, "platform", { value: "Win32", configurable: true });
    render(<KeyboardShortcutsScreen ctx={baseContext()} onClose={() => {}} />);
    const viewSection = screen.getByRole("heading", { name: "View" }).closest("section")!;
    const findRow = within(viewSection).getByText("Find commits…").closest("li")!;
    expect(within(findRow).getByText(shortcutText(/ctrl\+shift\+f/i))).toBeInTheDocument();
    const focusRow = within(viewSection).getByText("Focus branches search").closest("li")!;
    expect(within(focusRow).getByText(shortcutText(/^ctrl\+f$/i))).toBeInTheDocument();
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
    expect(within(refreshRow).getByText(shortcutText(/ctrl\+r.*f5/i))).toBeInTheDocument();
  });

  it("specs/keyboard-shortcuts-visual-redesign.md FR-387/389/390: renders one keycap chip per key (never one chip for the whole combo), keeping the ' / ' separator between the two combos as plain text", () => {
    Object.defineProperty(window.navigator, "platform", { value: "Win32", configurable: true });
    render(<KeyboardShortcutsScreen ctx={baseContext()} onClose={() => {}} />);
    const refreshRow = screen.getByText("Refresh commit graph").closest("li")!;
    // eslint-disable-next-line testing-library/no-node-access
    const chips = Array.from(refreshRow.querySelectorAll(".gh-keycap")).map((c) => c.textContent);
    expect(chips).toEqual(["Ctrl", "R", "F5"]);
    // eslint-disable-next-line testing-library/no-node-access
    const shortcutEl = refreshRow.querySelector(".gh-keyboard-shortcuts__shortcut")!;
    expect(shortcutEl.textContent).toBe("Ctrl+R / F5");
    expect(within(refreshRow).queryByText("Ctrl+R")).not.toBeInTheDocument();
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
    expect(within(generalSection).getByText(shortcutText(/ctrl\+k/i))).toBeInTheDocument();

    const tabsSection = screen.getByRole("heading", { name: "Tabs" }).closest("section")!;
    const cycleRow = within(tabsSection).getByText("Next / previous tab").closest("li")!;
    expect(within(cycleRow).getByText(shortcutText(/ctrl\+tab.*ctrl\+shift\+tab/i))).toBeInTheDocument();
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
    expect(within(generalSection).getByText(shortcutText(/cmd\+k/i))).toBeInTheDocument();
    expect(within(generalSection).queryByText(shortcutText(/ctrl\+k/i))).not.toBeInTheDocument();

    Object.defineProperty(window.navigator, "platform", { value: "Win32", configurable: true });
  });

  describe("static/synthetic rows never get an Edit affordance (FR-396)", () => {
    it("the two STATIC_SHORTCUT_ROWS rows have no Edit button", () => {
      render(<KeyboardShortcutsScreen ctx={baseContext()} onClose={() => {}} />);
      const openPaletteRow = screen.getByText("Open Command Palette").closest("li")!;
      expect(within(openPaletteRow).queryByRole("button", { name: /edit shortcut/i })).not.toBeInTheDocument();
      const cycleRow = screen.getByText("Next / previous tab").closest("li")!;
      expect(within(cycleRow).queryByRole("button", { name: /edit shortcut/i })).not.toBeInTheDocument();
    });

    it("the synthetic 'Switch to tab' summary row has no Edit button", () => {
      render(<KeyboardShortcutsScreen ctx={baseContext({ tabs: [makeTab("t1", "/a")] })} onClose={() => {}} />);
      const row = screen.getByText("Switch to tab").closest("li")!;
      expect(within(row).queryByRole("button", { name: /edit shortcut/i })).not.toBeInTheDocument();
    });
  });
});

/** specs/keyboard-shortcut-rebinding.md FR-394..FR-405: the rebind/conflict/reset editing flows. */
describe("KeyboardShortcutsScreen — rebinding (specs/keyboard-shortcut-rebinding.md)", () => {
  const originalPlatform = window.navigator.platform;
  afterEach(() => {
    Object.defineProperty(window.navigator, "platform", { value: originalPlatform, configurable: true });
    window.localStorage.clear();
  });

  function setWindows() {
    Object.defineProperty(window.navigator, "platform", { value: "Win32", configurable: true });
  }

  /** A thin stateful wrapper mirroring exactly how `App.tsx` wires `useKeybindingOverrides()` into
   * this screen — lets these tests observe the FULL round trip (capture → save → re-render showing
   * the new binding), not just that a callback was invoked with the right arguments. */
  function Harness({
    ctx = baseContext(),
    initialOverrides = {},
    onClose = () => {},
  }: {
    ctx?: CommandContext;
    initialOverrides?: KeybindingOverrides;
    onClose?: () => void;
  }) {
    const [overrides, setOverrides] = useState<KeybindingOverrides>(initialOverrides);
    return (
      <KeyboardShortcutsScreen
        ctx={ctx}
        onClose={onClose}
        overrides={overrides}
        onSetOverride={(id, value) => setOverrides((prev) => ({ ...prev, [id]: value }))}
        onResetOverride={(id) =>
          setOverrides((prev) => {
            if (!(id in prev)) return prev;
            const next = { ...prev };
            delete next[id];
            return next;
          })
        }
        onResetAll={() => setOverrides({})}
      />
    );
  }

  /** A real, `localStorage`-backed instance (AC9's persistence-across-relaunch), rather than the
   * plain in-memory `Harness` above. */
  function PersistedHarness({ ctx = baseContext(), onClose = () => {} }: { ctx?: CommandContext; onClose?: () => void }) {
    const kb = useKeybindingOverrides();
    return (
      <KeyboardShortcutsScreen
        ctx={ctx}
        onClose={onClose}
        overrides={kb.overrides}
        onSetOverride={kb.setOverride}
        onResetOverride={kb.resetOverride}
        onResetAll={kb.resetAll}
      />
    );
  }

  function pressCombo(combo: { key: string; ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean }) {
    fireEvent.keyDown(document, {
      key: combo.key,
      ctrlKey: combo.ctrlKey ?? false,
      metaKey: combo.metaKey ?? false,
      shiftKey: combo.shiftKey ?? false,
    });
  }

  /** Clicking anywhere clearly outside the active row's own capture wrapper — the screen's own
   * `<h2>` title (not the "Keyboard shortcuts" command row, which shares the same text) is always
   * present and never inside a row. */
  async function clickOutsideRow() {
    await userEvent.click(screen.getByRole("heading", { name: "Keyboard shortcuts", level: 2 }));
  }

  it("AC1: 'New branch…' (no default) can be given Ctrl+Shift+B, which then renders as its keycap chips", async () => {
    setWindows();
    render(<Harness />);
    const row = screen.getByText("New branch…").closest("li")!;
    expect(within(row).getByText(/no shortcut/i)).toBeInTheDocument();

    await userEvent.click(within(row).getByRole("button", { name: /edit shortcut for new branch/i }));
    expect(within(row).getByText(/press a key combination/i)).toBeInTheDocument();

    pressCombo({ key: "B", ctrlKey: true, shiftKey: true });
    await clickOutsideRow();

    const updatedRow = screen.getByText("New branch…").closest("li")!;
    // eslint-disable-next-line testing-library/no-node-access
    const chips = Array.from(updatedRow.querySelectorAll(".gh-keycap")).map((c) => c.textContent);
    expect(chips).toEqual(["Ctrl", "Shift", "B"]);
    expect(within(updatedRow).getByRole("button", { name: /reset to default/i })).toBeInTheDocument();
  });

  it("AC2: rebinding 'Refresh commit graph' (two defaults) to one new combo replaces both", async () => {
    setWindows();
    render(<Harness />);
    const row = screen.getByText("Refresh commit graph").closest("li")!;
    // eslint-disable-next-line testing-library/no-node-access
    expect(Array.from(row.querySelectorAll(".gh-keycap")).map((c) => c.textContent)).toEqual(["Ctrl", "R", "F5"]);

    await userEvent.click(within(row).getByRole("button", { name: /edit shortcut/i }));
    pressCombo({ key: "j", ctrlKey: true });
    await clickOutsideRow();

    const updatedRow = screen.getByText("Refresh commit graph").closest("li")!;
    // eslint-disable-next-line testing-library/no-node-access
    expect(Array.from(updatedRow.querySelectorAll(".gh-keycap")).map((c) => c.textContent)).toEqual(["Ctrl", "J"]);
  });

  it("AC4: capturing bare B (no modifier) is rejected inline, nothing saved, row reverts to its previous display", async () => {
    setWindows();
    render(<Harness />);
    const row = screen.getByText("New branch…").closest("li")!;
    await userEvent.click(within(row).getByRole("button", { name: /edit shortcut/i }));
    pressCombo({ key: "b" });
    await clickOutsideRow();

    const updatedRow = screen.getByText("New branch…").closest("li")!;
    expect(within(updatedRow).getByText(/must include ctrl/i)).toBeInTheDocument();
    expect(within(updatedRow).getByText(/no shortcut/i)).toBeInTheDocument();
    expect(within(updatedRow).queryByRole("button", { name: /reset to default/i })).not.toBeInTheDocument();
  });

  it("AC4: capturing Shift+B alone (no modifier) is rejected the same way", async () => {
    setWindows();
    render(<Harness />);
    const row = screen.getByText("New branch…").closest("li")!;
    await userEvent.click(within(row).getByRole("button", { name: /edit shortcut/i }));
    pressCombo({ key: "b", shiftKey: true });
    await clickOutsideRow();
    expect(screen.getByText(/must include ctrl/i)).toBeInTheDocument();
  });

  it("AC5: capturing Ctrl+K is rejected as reserved (Command Palette), nothing saved", async () => {
    setWindows();
    render(<Harness />);
    const row = screen.getByText("New branch…").closest("li")!;
    await userEvent.click(within(row).getByRole("button", { name: /edit shortcut/i }));
    pressCombo({ key: "k", ctrlKey: true });
    await clickOutsideRow();
    expect(screen.getByText(/reserved.*command palette/i)).toBeInTheDocument();
    expect(within(screen.getByText("New branch…").closest("li")!).getByText(/no shortcut/i)).toBeInTheDocument();
  });

  it("AC5: capturing Ctrl+Tab and Ctrl+Shift+Tab are both rejected as reserved (switch tabs)", async () => {
    setWindows();
    render(<Harness />);
    const row = screen.getByText("New branch…").closest("li")!;
    await userEvent.click(within(row).getByRole("button", { name: /edit shortcut/i }));
    pressCombo({ key: "Tab", ctrlKey: true });
    await clickOutsideRow();
    expect(screen.getByText(/reserved.*switch tabs/i)).toBeInTheDocument();

    await userEvent.click(within(screen.getByText("New branch…").closest("li")!).getByRole("button", { name: /edit shortcut/i }));
    pressCombo({ key: "Tab", ctrlKey: true, shiftKey: true });
    await clickOutsideRow();
    expect(screen.getByText(/reserved.*switch tabs/i)).toBeInTheDocument();
  });

  it("AC3: rebinding 'Toggle theme' to Ctrl+P (already Pull's binding) shows a conflict naming Pull; Cancel leaves both unchanged and returns to capture state", async () => {
    setWindows();
    render(<Harness initialOverrides={{ pull: [{ key: "p", mod: true }] }} />);
    const row = screen.getByText("Toggle theme (light / dark)").closest("li")!;
    await userEvent.click(within(row).getByRole("button", { name: /edit shortcut/i }));
    pressCombo({ key: "p", ctrlKey: true });
    await clickOutsideRow();

    expect(screen.getByText(conflictText(/ctrl\+p is already used by "pull"/i))).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /^cancel$/i }));

    // Back in capture state for the SAME row — no combo saved for either command yet.
    expect(screen.getByText(/press a key combination/i)).toBeInTheDocument();
    await clickOutsideRow();
    expect(within(screen.getByText("Toggle theme (light / dark)").closest("li")!).getByText(/no shortcut/i)).toBeInTheDocument();
    // eslint-disable-next-line testing-library/no-node-access
    const pullRow = screen.getByText("Pull").closest("li")!;
    expect(Array.from(pullRow.querySelectorAll(".gh-keycap")).map((c) => c.textContent)).toEqual(["Ctrl", "P"]);
  });

  it("AC3: Reassign removes the combo from Pull (leaving it unbound) and assigns it to Toggle theme", async () => {
    setWindows();
    render(<Harness initialOverrides={{ pull: [{ key: "p", mod: true }] }} />);
    const row = screen.getByText("Toggle theme (light / dark)").closest("li")!;
    await userEvent.click(within(row).getByRole("button", { name: /edit shortcut/i }));
    pressCombo({ key: "p", ctrlKey: true });
    await clickOutsideRow();

    await userEvent.click(screen.getByRole("button", { name: /reassign/i }));

    const themeRow = screen.getByText("Toggle theme (light / dark)").closest("li")!;
    // eslint-disable-next-line testing-library/no-node-access
    expect(Array.from(themeRow.querySelectorAll(".gh-keycap")).map((c) => c.textContent)).toEqual(["Ctrl", "P"]);

    const pullRow = screen.getByText("Pull").closest("li")!;
    expect(within(pullRow).getByText(/no shortcut/i)).toBeInTheDocument();
    expect(within(pullRow).getByRole("button", { name: /reset to default/i })).toBeInTheDocument();
  });

  it("Escape while capturing cancels with no message and no save (distinct from a rejected capture)", async () => {
    setWindows();
    render(<Harness />);
    const row = screen.getByText("New branch…").closest("li")!;
    await userEvent.click(within(row).getByRole("button", { name: /edit shortcut/i }));
    pressCombo({ key: "b", ctrlKey: true, shiftKey: true });
    fireEvent.keyDown(document, { key: "Escape" });

    const updatedRow = screen.getByText("New branch…").closest("li")!;
    expect(within(updatedRow).getByText(/no shortcut/i)).toBeInTheDocument();
    expect(within(updatedRow).queryByText(/must include ctrl|reserved/i)).not.toBeInTheDocument();
  });

  it("clicking outside the row with nothing captured yet silently reverts (no message, nothing saved)", async () => {
    setWindows();
    render(<Harness />);
    const row = screen.getByText("New branch…").closest("li")!;
    await userEvent.click(within(row).getByRole("button", { name: /edit shortcut/i }));
    await clickOutsideRow();

    const updatedRow = screen.getByText("New branch…").closest("li")!;
    expect(within(updatedRow).getByText(/no shortcut/i)).toBeInTheDocument();
    expect(within(updatedRow).queryByText(/must include ctrl|reserved/i)).not.toBeInTheDocument();
  });

  it("while one row is being edited, every other row's Edit/Reset buttons are disabled", async () => {
    setWindows();
    render(<Harness initialOverrides={{ "toggle-theme": "unbound" }} />);
    const newBranchRow = screen.getByText("New branch…").closest("li")!;
    await userEvent.click(within(newBranchRow).getByRole("button", { name: /edit shortcut/i }));

    const themeRow = screen.getByText("Toggle theme (light / dark)").closest("li")!;
    expect(within(themeRow).getByRole("button", { name: /edit shortcut/i })).toBeDisabled();
    expect(within(themeRow).getByRole("button", { name: /reset to default/i })).toBeDisabled();
  });

  it("AC6: 'Reset to default' reverts a rebound command immediately, with no ConfirmDialog", async () => {
    setWindows();
    render(<Harness initialOverrides={{ "new-branch": [{ key: "b", mod: true, shift: true }] }} />);
    const row = screen.getByText("New branch…").closest("li")!;
    // eslint-disable-next-line testing-library/no-node-access
    expect(Array.from(row.querySelectorAll(".gh-keycap")).map((c) => c.textContent)).toEqual(["Ctrl", "Shift", "B"]);

    await userEvent.click(within(row).getByRole("button", { name: /reset to default/i }));

    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    const updatedRow = screen.getByText("New branch…").closest("li")!;
    expect(within(updatedRow).getByText(/no shortcut/i)).toBeInTheDocument();
    expect(within(updatedRow).queryByRole("button", { name: /reset to default/i })).not.toBeInTheDocument();
  });

  it("AC8: an explicitly unbound command shows no keycap chips, and remains resettable", () => {
    setWindows();
    render(<Harness initialOverrides={{ "toggle-theme": "unbound" }} />);
    const row = screen.getByText("Toggle theme (light / dark)").closest("li")!;
    // eslint-disable-next-line testing-library/no-node-access
    expect(row.querySelectorAll(".gh-keycap")).toHaveLength(0);
    expect(within(row).getByText(/no shortcut/i)).toBeInTheDocument();
    expect(within(row).getByRole("button", { name: /reset to default/i })).toBeInTheDocument();
  });

  it("AC7: 'Reset all shortcuts to default' opens ConfirmDialog; confirming clears every override across multiple rows at once", async () => {
    setWindows();
    render(
      <Harness
        initialOverrides={{
          "new-branch": [{ key: "b", mod: true, shift: true }],
          "refresh-commit-graph": [{ key: "j", mod: true }],
        }}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /reset all shortcuts to default/i }));
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /^reset all$/i }));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();

    const newBranchRow = screen.getByText("New branch…").closest("li")!;
    expect(within(newBranchRow).getByText(/no shortcut/i)).toBeInTheDocument();
    expect(within(newBranchRow).queryByRole("button", { name: /reset to default/i })).not.toBeInTheDocument();
    const refreshRow = screen.getByText("Refresh commit graph").closest("li")!;
    // eslint-disable-next-line testing-library/no-node-access
    expect(Array.from(refreshRow.querySelectorAll(".gh-keycap")).map((c) => c.textContent)).toEqual(["Ctrl", "R", "F5"]);
    expect(within(refreshRow).queryByRole("button", { name: /reset to default/i })).not.toBeInTheDocument();
  });

  it("AC7: cancelling the 'Reset all' confirmation leaves every override untouched", async () => {
    setWindows();
    render(<Harness initialOverrides={{ "new-branch": [{ key: "b", mod: true, shift: true }] }} />);
    await userEvent.click(screen.getByRole("button", { name: /reset all shortcuts to default/i }));
    await userEvent.click(screen.getByRole("button", { name: /^cancel$/i }));

    const row = screen.getByText("New branch…").closest("li")!;
    // eslint-disable-next-line testing-library/no-node-access
    expect(Array.from(row.querySelectorAll(".gh-keycap")).map((c) => c.textContent)).toEqual(["Ctrl", "Shift", "B"]);
  });

  it("Escape while the 'Reset all' ConfirmDialog is open dismisses only that dialog, not the whole screen", async () => {
    setWindows();
    const onClose = vi.fn();
    render(<Harness onClose={onClose} initialOverrides={{ "new-branch": [{ key: "b", mod: true, shift: true }] }} />);
    await userEvent.click(screen.getByRole("button", { name: /reset all shortcuts to default/i }));
    fireEvent.keyDown(document, { key: "Escape" });

    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    // The screen itself is still open and unaffected.
    expect(screen.getByRole("dialog", { name: /keyboard shortcuts/i })).toBeInTheDocument();
  });

  it("Escape while a row is capturing cancels only that row's capture, not the whole screen", async () => {
    setWindows();
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    const row = screen.getByText("New branch…").closest("li")!;
    await userEvent.click(within(row).getByRole("button", { name: /edit shortcut/i }));
    fireEvent.keyDown(document, { key: "Escape" });

    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: /keyboard shortcuts/i })).toBeInTheDocument();
  });

  it("AC9: a customization persists across a remount against the same localStorage", async () => {
    setWindows();
    const { unmount } = render(<PersistedHarness />);
    const row = screen.getByText("New branch…").closest("li")!;
    await userEvent.click(within(row).getByRole("button", { name: /edit shortcut/i }));
    pressCombo({ key: "b", ctrlKey: true, shiftKey: true });
    await clickOutsideRow();
    unmount();

    render(<PersistedHarness />);
    const reopenedRow = screen.getByText("New branch…").closest("li")!;
    // eslint-disable-next-line testing-library/no-node-access
    expect(Array.from(reopenedRow.querySelectorAll(".gh-keycap")).map((c) => c.textContent)).toEqual(["Ctrl", "Shift", "B"]);
  });

  it("AC10: editing/saving a rebind never touches any git-core-facing CommandContext callback", async () => {
    setWindows();
    const runFetch = vi.fn();
    const runPull = vi.fn();
    const runPush = vi.fn();
    const refreshEverything = vi.fn();
    const commitStagedChanges = vi.fn();
    const ctx = baseContext({ runFetch, runPull, runPush, refreshEverything, commitStagedChanges });
    render(<Harness ctx={ctx} />);
    const row = screen.getByText("New branch…").closest("li")!;
    await userEvent.click(within(row).getByRole("button", { name: /edit shortcut/i }));
    pressCombo({ key: "b", ctrlKey: true, shiftKey: true });
    await clickOutsideRow();

    expect(runFetch).not.toHaveBeenCalled();
    expect(runPull).not.toHaveBeenCalled();
    expect(runPush).not.toHaveBeenCalled();
    expect(refreshEverything).not.toHaveBeenCalled();
    expect(commitStagedChanges).not.toHaveBeenCalled();
  });

  it("AC11: behaves identically with no repo open (repoOpen: false) — 'New branch…' is still listed and rebindable", async () => {
    setWindows();
    render(<Harness ctx={baseContext({ repoOpen: false })} />);
    const row = screen.getByText("New branch…").closest("li")!;
    await userEvent.click(within(row).getByRole("button", { name: /edit shortcut/i }));
    pressCombo({ key: "b", ctrlKey: true, shiftKey: true });
    await clickOutsideRow();

    const updatedRow = screen.getByText("New branch…").closest("li")!;
    // eslint-disable-next-line testing-library/no-node-access
    expect(Array.from(updatedRow.querySelectorAll(".gh-keycap")).map((c) => c.textContent)).toEqual(["Ctrl", "Shift", "B"]);
  });
});
