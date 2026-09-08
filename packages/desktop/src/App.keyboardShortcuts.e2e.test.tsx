// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "./App";
import { makeMockGitHydra } from "./test/mockGitHydra";
import { makeCommit } from "./test/fixtures";

/**
 * specs/keyboard-shortcuts-reference.md: App-level integration coverage for the acceptance
 * criteria that need the real App tree (dialog suppression across every real dialog/menu, the real
 * palette, a real "no repo open" empty state) rather than the component-level coverage already in
 * `KeyboardShortcutsScreen.test.tsx` and the registry-level coverage already in `commands.test.ts`/
 * `useGlobalKeybindings.test.ts`.
 */

afterEach(() => {
  // @ts-expect-error test cleanup of the global bridge
  delete window.gitHydra;
  window.localStorage.clear();
});

async function pressCtrl(key: string, opts: { shift?: boolean } = {}) {
  const keySpec = key.length === 1 ? key : `{${key}}`;
  const shiftOpen = opts.shift ? "{Shift>}" : "";
  const shiftClose = opts.shift ? "{/Shift}" : "";
  await userEvent.keyboard(`{Control>}${shiftOpen}${keySpec}${shiftClose}{/Control}`);
}

describe("App — Keyboard shortcuts reference screen (specs/keyboard-shortcuts-reference.md)", () => {
  it("AC1: Ctrl+/ opens the reference screen as a centered overlay; Escape closes it with no other effect", async () => {
    const commits = [makeCommit("c1", [], { subject: "Only commit" })];
    const api = makeMockGitHydra({ commits });
    window.gitHydra = api;
    render(<App />);
    await userEvent.click(screen.getByRole("button", { name: "Open a repository" }));
    await waitFor(() => expect(screen.getByText("Only commit")).toBeInTheDocument());

    const getStateCallsBefore = vi.mocked(api.getState).mock.calls.length;

    await pressCtrl("/");
    const dialog = screen.getByRole("dialog", { name: /keyboard shortcuts/i });
    expect(dialog).toBeInTheDocument();

    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: /keyboard shortcuts/i })).not.toBeInTheDocument();
    // No git process spawn / IPC call from opening or closing this screen (FR-238/AC9).
    expect(vi.mocked(api.getState).mock.calls.length).toBe(getStateCallsBefore);
  });

  it("clicking outside the overlay closes it", async () => {
    window.gitHydra = makeMockGitHydra();
    render(<App />);
    await pressCtrl("/");
    expect(screen.getByRole("dialog", { name: /keyboard shortcuts/i })).toBeInTheDocument();

    // eslint-disable-next-line testing-library/no-node-access
    const overlay = document.querySelector(".gh-keyboard-shortcuts__overlay") as HTMLElement;
    await userEvent.click(overlay);
    expect(screen.queryByRole("dialog", { name: /keyboard shortcuts/i })).not.toBeInTheDocument();
  });

  it("AC2: filtering the palette down to 'Keyboard shortcuts' and pressing Enter closes the palette and opens the reference screen", async () => {
    window.gitHydra = makeMockGitHydra();
    render(<App />);

    await pressCtrl("k");
    expect(screen.getByRole("combobox")).toHaveFocus();
    await userEvent.type(screen.getByRole("combobox"), "Keyboard shortcuts");
    await userEvent.keyboard("{Enter}");

    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: /keyboard shortcuts/i })).toBeInTheDocument();
  });

  it("AC3: with no repo open, the reference screen still lists every repo-scoped command — none hidden", async () => {
    window.gitHydra = makeMockGitHydra();
    render(<App />);
    await pressCtrl("/");

    expect(screen.getByText("Commit staged changes")).toBeInTheDocument();
    expect(screen.getByText("New branch…")).toBeInTheDocument();
    expect(screen.getByText("New stash…")).toBeInTheDocument();
    expect(screen.getByText("Refresh commit graph")).toBeInTheDocument();
  });

  it("AC7: while the New Branch dialog is open, Ctrl+/ does not open the reference screen on top of it", async () => {
    const commits = [makeCommit("c1", [], { subject: "Only commit" })];
    window.gitHydra = makeMockGitHydra({ commits });
    render(<App />);
    await userEvent.click(screen.getByRole("button", { name: "Open a repository" }));
    await waitFor(() => expect(screen.getByText("Only commit")).toBeInTheDocument());

    await userEvent.click(within(screen.getByRole("complementary", { name: "Branches" })).getByRole("button", { name: /^new branch$/i }));
    expect(await screen.findByRole("dialog", { name: /new branch/i })).toBeInTheDocument();

    await pressCtrl("/");
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(screen.queryByRole("dialog", { name: /keyboard shortcuts/i })).not.toBeInTheDocument();
  });

  it("AC7: while the Command Palette is open, Ctrl+/ does not open the reference screen on top of it", async () => {
    window.gitHydra = makeMockGitHydra();
    render(<App />);
    await pressCtrl("k");
    expect(screen.getByRole("combobox")).toHaveFocus();

    await pressCtrl("/");
    expect(screen.getByRole("combobox")).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: /keyboard shortcuts/i })).not.toBeInTheDocument();
  });

  it("AC7: while the reference screen is open, Ctrl+K / Ctrl+R / Ctrl+Enter / Ctrl+Tab are all silent no-ops", async () => {
    const commits = [makeCommit("c1", [], { subject: "Only commit" })];
    const api = makeMockGitHydra({
      commits,
      workingDirectoryChanges: {
        staged: [{ path: "a.ts", status: "modified", category: "staged" }],
        unstaged: [],
        untracked: [],
        conflicted: [],
      },
      workingDirStatus: { hasChanges: true, staged: 1, unstaged: 0, untracked: 0, conflicted: 0 },
    });
    window.gitHydra = api;
    render(<App />);
    await userEvent.click(screen.getByRole("button", { name: "Open a repository" }));
    await waitFor(() => expect(screen.getByText("Only commit")).toBeInTheDocument());

    await pressCtrl("/");
    expect(screen.getByRole("dialog", { name: /keyboard shortcuts/i })).toBeInTheDocument();

    const getStateCallsWhileOpen = vi.mocked(api.getState).mock.calls.length;

    await pressCtrl("k");
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();

    await pressCtrl("r");
    await new Promise((r) => setTimeout(r, 20));
    expect(vi.mocked(api.getState).mock.calls.length).toBe(getStateCallsWhileOpen);

    await pressCtrl("Enter");
    await new Promise((r) => setTimeout(r, 20));
    expect(vi.mocked(api.createCommit)).not.toHaveBeenCalled();

    await pressCtrl("Tab");

    // Still just the one reference-screen dialog the whole time.
    expect(screen.getByRole("dialog", { name: /keyboard shortcuts/i })).toBeInTheDocument();
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
  });

  it("a right-click commit ContextMenu suppresses Ctrl+/ from opening the reference screen on top of it", async () => {
    const commits = [makeCommit("c1", [], { subject: "Only commit" })];
    window.gitHydra = makeMockGitHydra({ commits });
    render(<App />);
    await userEvent.click(screen.getByRole("button", { name: "Open a repository" }));
    await waitFor(() => expect(screen.getByText("Only commit")).toBeInTheDocument());

    screen.getByText("Only commit").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    expect(await screen.findByRole("menu")).toBeInTheDocument();

    await pressCtrl("/");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("menu")).toBeInTheDocument();
  });
});
