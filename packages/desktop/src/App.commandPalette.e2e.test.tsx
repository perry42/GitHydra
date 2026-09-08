// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "./App";
import { makeMockGitHydra } from "./test/mockGitHydra";
import { makeCommit, makeLocalBranch, makeRepoState } from "./test/fixtures";

/**
 * specs/keyboard-shortcuts-command-palette.md: App-level integration coverage for the acceptance
 * criteria that need the real App tree (dialog suppression, the real ChangesPanel composer, real
 * Toolbar refresh wiring, real tab bar) rather than the hook-/component-level tests already
 * covering the command registry (`commands.test.ts`), the global keybinding layer
 * (`useGlobalKeybindings.test.ts`), and the palette UI itself (`CommandPalette.test.tsx`) in
 * isolation.
 */

afterEach(() => {
  // @ts-expect-error test cleanup of the global bridge
  delete window.gitHydra;
  window.localStorage.clear();
});

/** userEvent.keyboard's "special key" syntax requires curly braces (`{Enter}`, `{Tab}`) — a bare
 * single printable character is typed literally instead. Handles both so callers can just say
 * `pressCtrl("k")` or `pressCtrl("Enter")`. */
async function pressCtrl(key: string, opts: { shift?: boolean } = {}) {
  const keySpec = key.length === 1 ? key : `{${key}}`;
  const shiftOpen = opts.shift ? "{Shift>}" : "";
  const shiftClose = opts.shift ? "{/Shift}" : "";
  await userEvent.keyboard(`{Control>}${shiftOpen}${keySpec}${shiftClose}{/Control}`);
}

describe("App — Command Palette / global keybindings (specs/keyboard-shortcuts-command-palette.md)", () => {
  it("AC1: Ctrl+K opens the palette with a repo open, listing available commands", async () => {
    const commits = [makeCommit("c1", [], { subject: "Only commit" })];
    window.gitHydra = makeMockGitHydra({ commits });
    render(<App />);
    await userEvent.click(screen.getByRole("button", { name: "Open a repository" }));
    await waitFor(() => expect(screen.getByText("Only commit")).toBeInTheDocument());

    await pressCtrl("k");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByRole("combobox")).toHaveFocus();
    expect(screen.getByRole("option", { name: /refresh commit graph/i })).toBeInTheDocument();
  });

  it("AC5: with no repository open, Ctrl+K opens the palette with only non-repo-scoped commands available", async () => {
    window.gitHydra = makeMockGitHydra();
    render(<App />);

    await pressCtrl("k");
    expect(screen.getByRole("option", { name: /new tab \/ open repository/i })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /refresh commit graph/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /commit staged changes/i })).not.toBeInTheDocument();
  });

  describe("AC6: Ctrl/Cmd+Enter commits staged changes", () => {
    async function setUpWithStagedChange() {
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
      await userEvent.click(screen.getByRole("button", { name: /changes, 1 pending/i }));
      await screen.findByRole("complementary", { name: "Changes" });
      return api;
    }

    it("commits using the composer's current message, identically to clicking the Commit button", async () => {
      const api = await setUpWithStagedChange();
      await userEvent.type(screen.getByLabelText(/subject/i), "Fix the thing");

      await pressCtrl("Enter");

      await waitFor(() => expect(vi.mocked(api.createCommit)).toHaveBeenCalledWith({ subject: "Fix the thing", body: undefined }));
      // Same post-commit effect the real button produces: composer resets.
      await waitFor(() => expect(screen.getByLabelText(/subject/i)).toHaveValue(""));
    });

    it("is a silent no-op when the composer's own Commit-button conditions aren't met (empty message)", async () => {
      const api = await setUpWithStagedChange();
      // Subject left empty — the real Commit button would be disabled here too.
      await pressCtrl("Enter");
      await new Promise((r) => setTimeout(r, 20));
      expect(vi.mocked(api.createCommit)).not.toHaveBeenCalled();
    });

    it("is a silent no-op when the Changes panel isn't open at all", async () => {
      const commits = [makeCommit("c1", [], { subject: "Only commit" })];
      const api = makeMockGitHydra({ commits });
      window.gitHydra = api;
      render(<App />);
      await userEvent.click(screen.getByRole("button", { name: "Open a repository" }));
      await waitFor(() => expect(screen.getByText("Only commit")).toBeInTheDocument());

      await pressCtrl("Enter");
      await new Promise((r) => setTimeout(r, 20));
      expect(vi.mocked(api.createCommit)).not.toHaveBeenCalled();
    });

    // security-reviewer finding (High): Ctrl/Cmd+Enter must stay suspended while ChangesPanel's
    // own locally-rendered "Amend a possibly-shared commit?" ConfirmDialog is open — see
    // App.tsx's `changesPanelDialogOpen`/`onDialogOpenChange` doc comment for the concrete race
    // this closes (useChangesPanel's amend flow flips `canCommit` back to `true` the moment the
    // warning is shown, since `setIsCommitting(false)` runs alongside `setPendingAmendWarning(true)`
    // — without this fix, the keybinding re-invokes `submitCommit()` and races the exact amend
    // attempt the warning exists to gate, without the user ever clicking "Amend Anyway").
    it("regression: Ctrl/Cmd+Enter does NOT fire a commit while the amend-warning ConfirmDialog is open", async () => {
      const headSha = "c1";
      const api = makeMockGitHydra({
        commits: [makeCommit(headSha, [], { subject: "Original subject", body: "" })],
        workingDirectoryChanges: {
          staged: [{ path: "a.ts", status: "modified", category: "staged" }],
          unstaged: [],
          untracked: [],
          conflicted: [],
        },
        workingDirStatus: { hasChanges: true, staged: 1, unstaged: 0, untracked: 0, conflicted: 0 },
        // AC6/FR-158's "potentially shared" condition (a present, non-gone upstream with nothing
        // of HEAD unpushed yet) — see ChangesPanel.test.tsx's own AC6 test for the same setup.
        localBranches: [makeLocalBranch("main", { upstreamName: "origin/main", upstreamGone: false, ahead: 0 })],
      });
      window.gitHydra = api;
      render(<App />);
      await userEvent.click(screen.getByRole("button", { name: "Open a repository" }));
      await waitFor(() => expect(screen.getByText("Original subject")).toBeInTheDocument());
      await userEvent.click(screen.getByRole("button", { name: /changes, 1 pending/i }));
      await screen.findByRole("complementary", { name: "Changes" });

      await userEvent.click(screen.getByRole("checkbox", { name: /amend last commit/i }));
      await waitFor(() => expect(screen.getByLabelText(/subject/i)).toHaveValue("Original subject"));

      // Triggers the amend flow via the ordinary Commit button — same as a real user — which
      // shows the warning dialog instead of amending immediately.
      await userEvent.click(screen.getByRole("button", { name: /^amend commit$/i }));
      const dialog = await screen.findByRole("alertdialog", { name: /amend a possibly-shared commit/i });
      expect(vi.mocked(api.amendCommit)).not.toHaveBeenCalled();
      const listBranchesCallsWhileDialogOpen = vi.mocked(api.listBranches).mock.calls.length;

      // The bug: `canCommit` flips back to `true` the instant this dialog appears, so without the
      // fix, this keybinding would re-invoke `submitCommit()` — which, since the composer is still
      // in `amend` mode, restarts the exact "is this potentially shared?" check (a fresh
      // `listBranches()` call) the warning already answered, racing the pending confirmation
      // instead of staying a silent no-op like every other dialog-open case. That extra call is
      // the concrete, observable signature of the race — asserting on `amendCommit`'s call count
      // alone wouldn't catch it here, since a second `submitCommit()` call while still
      // `potentiallyShared` just re-shows the same warning rather than calling `amendCommit`
      // directly.
      await pressCtrl("Enter");
      await new Promise((r) => setTimeout(r, 20));
      expect(vi.mocked(api.listBranches).mock.calls.length).toBe(listBranchesCallsWhileDialogOpen);
      expect(vi.mocked(api.amendCommit)).not.toHaveBeenCalled();
      // The dialog is still up — Ctrl+Enter didn't silently dismiss/resolve it either.
      expect(dialog).toBeInTheDocument();

      // The only way through is still the explicit "Amend Anyway" click.
      await userEvent.click(within(dialog).getByRole("button", { name: /amend anyway/i }));
      await waitFor(() => expect(vi.mocked(api.amendCommit)).toHaveBeenCalledTimes(1));
    });
  });

  it("AC7/AC12: Ctrl+R triggers the same refresh as the Toolbar button (same getState call), with no double-refresh from a second press mid-refresh", async () => {
    const commits = [makeCommit("c1", [], { subject: "Only commit" })];
    const api = makeMockGitHydra({ commits });
    window.gitHydra = api;
    render(<App />);
    await userEvent.click(screen.getByRole("button", { name: "Open a repository" }));
    await waitFor(() => expect(screen.getByText("Only commit")).toBeInTheDocument());

    const getStateCallsAfterOpen = vi.mocked(api.getState).mock.calls.length;

    let resolveGetState!: (value: Awaited<ReturnType<typeof api.getState>>) => void;
    const stalled = new Promise<Awaited<ReturnType<typeof api.getState>>>((resolve) => {
      resolveGetState = resolve;
    });
    vi.mocked(api.getState).mockReturnValueOnce(stalled);

    await pressCtrl("r");
    await waitFor(() => expect(screen.getByRole("button", { name: /refreshing commit graph/i })).toBeDisabled());

    // A second Ctrl+R while already refreshing must not queue up a second refresh.
    await pressCtrl("r");

    resolveGetState({ ok: true, data: makeRepoState({ headSha: "c1" }) });

    await waitFor(() => expect(screen.getByRole("button", { name: /^refresh commit graph$/i })).toBeEnabled());
    // Exactly one more getState call than right after open — not two.
    expect(vi.mocked(api.getState).mock.calls.length).toBe(getStateCallsAfterOpen + 1);
  });

  it("AC8: Ctrl+Tab / Ctrl+Shift+Tab cycles to the next/previous open tab, wrapping, and has no effect with a single tab open", async () => {
    const api = makeMockGitHydra({
      repoPath: "/repoA",
      commits: [makeCommit("a1", [], { subject: "Repo A commit" })],
      reposByPath: {
        "/repoB": { commits: [makeCommit("b1", [], { subject: "Repo B commit" })] },
      },
    });
    window.gitHydra = api;
    render(<App />);

    await userEvent.click(screen.getByRole("button", { name: "Open a repository" }));
    await waitFor(() => expect(screen.getByText("Repo A commit")).toBeInTheDocument());

    // A single tab open — Ctrl+Tab must have no effect.
    await pressCtrl("Tab");
    expect(screen.getByText("Repo A commit")).toBeInTheDocument();

    vi.mocked(api.openRepoDialog).mockResolvedValueOnce({ ok: true, data: "/repoB" });
    await userEvent.click(screen.getByRole("button", { name: /open a repository in a new tab/i }));
    await userEvent.click(screen.getByRole("button", { name: "Open a repository" }));
    await waitFor(() => expect(screen.getByText("Repo B commit")).toBeInTheDocument());

    // Two tabs, B active — Ctrl+Tab wraps forward to A.
    await pressCtrl("Tab");
    await waitFor(() => expect(screen.getByText("Repo A commit")).toBeInTheDocument());

    // Ctrl+Shift+Tab from A wraps backward to B.
    await pressCtrl("Tab", { shift: true });
    await waitFor(() => expect(screen.getByText("Repo B commit")).toBeInTheDocument());
  });

  it("AC9: while the palette's filter input is focused, Ctrl+R does not also refresh the commit graph", async () => {
    const commits = [makeCommit("c1", [], { subject: "Only commit" })];
    const api = makeMockGitHydra({ commits });
    window.gitHydra = api;
    render(<App />);
    await userEvent.click(screen.getByRole("button", { name: "Open a repository" }));
    await waitFor(() => expect(screen.getByText("Only commit")).toBeInTheDocument());

    const getStateCallsBefore = vi.mocked(api.getState).mock.calls.length;
    await pressCtrl("k");
    expect(screen.getByRole("combobox")).toHaveFocus();

    await pressCtrl("r");
    await new Promise((r) => setTimeout(r, 20));

    // Still open (Ctrl+R didn't close it), and no extra refresh happened underneath it.
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(vi.mocked(api.getState).mock.calls.length).toBe(getStateCallsBefore);
  });

  it("AC10: opening the New Branch dialog suppresses the Command Palette — Ctrl+K does not also open it underneath", async () => {
    const commits = [makeCommit("c1", [], { subject: "Only commit" })];
    window.gitHydra = makeMockGitHydra({ commits });
    render(<App />);
    await userEvent.click(screen.getByRole("button", { name: "Open a repository" }));
    await waitFor(() => expect(screen.getByText("Only commit")).toBeInTheDocument());

    await userEvent.click(within(screen.getByRole("complementary", { name: "Branches" })).getByRole("button", { name: /^new branch$/i }));
    expect(await screen.findByRole("dialog", { name: /new branch/i })).toBeInTheDocument();

    await pressCtrl("k");
    // Only the New Branch dialog is present — no second, palette dialog stacked on top.
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(screen.queryByRole("combobox", { name: /command palette/i })).not.toBeInTheDocument();
  });

  it("running 'Toggle theme' from the palette has the same effect as clicking the Toolbar toggle", async () => {
    const commits = [makeCommit("c1", [], { subject: "Only commit" })];
    window.gitHydra = makeMockGitHydra({ commits });
    render(<App />);
    await userEvent.click(screen.getByRole("button", { name: "Open a repository" }));
    await waitFor(() => expect(screen.getByText("Only commit")).toBeInTheDocument());

    const themeBefore = document.documentElement.dataset.theme;
    await pressCtrl("k");
    await userEvent.type(screen.getByRole("combobox"), "Toggle theme");
    await userEvent.keyboard("{Enter}");

    expect(document.documentElement.dataset.theme).not.toBe(themeBefore);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
