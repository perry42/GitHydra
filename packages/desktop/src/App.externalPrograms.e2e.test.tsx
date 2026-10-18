// SPDX-License-Identifier: GPL-3.0-or-later
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup as unmountAll, configure, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "./App";
import { createRealGitHydraApi, type RealGitHydraHandle } from "./test/realGitHydraApi";
import { cleanup, commitAll, git, makeTempDir, writeFile } from "./test/gitFixture";

configure({ asyncUtilTimeout: 20000 });

/**
 * specs/external-programs.md AC8: the real <App/> against a real RepoSession and the real program service (in-memory records, a
 * recording spawn, no process started). `process.execPath` stands in for an editor: a real executable outside any repository.
 */
const handles: RealGitHydraHandle[] = [];
const dirs: string[] = [];

afterEach(async () => {
  // @ts-expect-error test cleanup of the global bridge
  delete window.gitHydra;
  window.localStorage.clear();
  // Unmount first so no watcher callback or timer of the App can reach a disposed session: no fixed sleep, nothing to race.
  unmountAll();
  while (handles.length) handles.pop()!.dispose();
  while (dirs.length) await cleanup(dirs.pop()!);
});

async function makeRepo(withFeatureWorktree = false): Promise<{ parent: string; repo: string; worktree: string }> {
  const parent = await makeTempDir("ext-prog-");
  dirs.push(parent);
  const repo = path.join(parent, "acme");
  await fs.mkdir(repo);
  await git(repo, ["init", "-q", "--initial-branch=main"]);
  await writeFile(repo, "a.txt", "base\n");
  await commitAll(repo, "base");
  await git(repo, ["branch", "feature"]);
  const worktree = path.join(parent, "acme.worktrees", "feature");
  if (withFeatureWorktree) await git(repo, ["worktree", "add", "-q", worktree, "feature"]);
  return { parent, repo, worktree };
}

async function openAppOn(dir: string): Promise<RealGitHydraHandle> {
  const handle = createRealGitHydraApi();
  handles.push(handle);
  handle.setDialogPath(dir);
  handle.setProgramPickPath(EDITOR_PATH);
  window.localStorage.setItem("githydra:layout:worktreesCollapsed", "0");
  window.gitHydra = handle.api;
  render(<App />);
  await userEvent.click(screen.getByRole("button", { name: "Open a repository" }));
  await screen.findByRole("button", { name: /stashes/i }, { timeout: 10000 });
  return handle;
}

// node itself sits in a user-writable toolcache on CI runners, which counts as a risky location and needs a confirmation.
const EDITOR_PATH = process.platform === "win32" ? path.join(process.env.SystemRoot ?? "C:/Windows", "System32", "notepad.exe") : "/usr/bin/true";
const EDITOR_NAME = path.basename(EDITOR_PATH).replace(/\.exe$/i, "");

async function addEditorThroughDialog(): Promise<void> {
  await userEvent.keyboard("{Control>}k{/Control}");
  await userEvent.keyboard("Manage external programs");
  await userEvent.keyboard("{Enter}");
  const dialog = await screen.findByRole("dialog", { name: "Programs" });
  await userEvent.click(within(dialog).getByRole("button", { name: "Add program…" }));
  await within(dialog).findByText(`Added ${EDITOR_NAME}.`);
  await userEvent.click(within(dialog).getByRole("button", { name: "Done" }));
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Programs" })).toBeNull());
}

describe("external programs end to end (real App, recording spawn)", () => {
  it(
    "the split button works on a repository with no worktrees: first run chooses, then it runs the default",
    async () => {
      const { repo } = await makeRepo();
      const handle = await openAppOn(repo);
      const real = await fs.realpath(repo);
      await addEditorThroughDialog();

      const group = screen.getByRole("group", { name: "Open folder in editor" });
      const main = within(group).getByRole("button", { name: "Open folder in editor" });
      expect(main).not.toHaveAttribute("aria-disabled");
      // First run: no default yet, so the click opens the list instead of launching.
      await userEvent.click(main);
      const menu = await screen.findByRole("menu", { name: "Open folder in editor" });
      expect(handle.spawnCalls).toHaveLength(0);
      await userEvent.click(within(menu).getByRole("menuitem", { name: new RegExp(EDITOR_NAME) }));
      await waitFor(() => expect(handle.spawnCalls).toHaveLength(1));
      expect(handle.spawnCalls[0]!.command).toBe(EDITOR_PATH);
      expect(handle.spawnCalls[0]!.args).toEqual([real]);
      expect(handle.spawnCalls[0]!.options).toMatchObject({ shell: false, detached: true, stdio: "ignore" });
      expect(await screen.findByText(`Opened in ${EDITOR_NAME}. ${EDITOR_NAME} is now your default.`)).toBeInTheDocument();

      // Second click: runs the default directly, says nothing new.
      await userEvent.click(within(screen.getByRole("group", { name: "Open folder in editor" })).getByRole("button", { name: "Open folder in editor" }));
      await waitFor(() => expect(handle.spawnCalls).toHaveLength(2));
      expect(screen.queryByRole("menu")).toBeNull();
    },
    90000,
  );

  it(
    "the palette entries exist with the exact titles and work keyboard-only (Ctrl+K, type, Enter, no clicks)",
    async () => {
      const { repo } = await makeRepo();
      const handle = await openAppOn(repo);
      const real = await fs.realpath(repo);

      // Manage external programs
      await userEvent.keyboard("{Control>}k{/Control}");
      await userEvent.keyboard("Manage external programs");
      expect(await screen.findByRole("option", { name: /Manage external programs/ })).toBeInTheDocument();
      await userEvent.keyboard("{Enter}");
      await screen.findByRole("dialog", { name: "Programs" });
      await userEvent.keyboard("{Escape}");
      await waitFor(() => expect(screen.queryByRole("dialog", { name: "Programs" })).toBeNull());

      // Open repository in external program: nothing is added yet, so the chooser lists "No programs found" and Manage programs.
      await addEditorThroughDialog();
      await userEvent.keyboard("{Control>}k{/Control}");
      await userEvent.keyboard("Open repository in external program");
      expect(await screen.findByRole("option", { name: /Open repository in external program/ })).toBeInTheDocument();
      await userEvent.keyboard("{Enter}");
      const menu = await screen.findByRole("menu", { name: "Open repository in external program" });
      expect(within(menu).getByRole("menuitem", { name: new RegExp(EDITOR_NAME) })).toHaveFocus();
      await userEvent.keyboard("{Enter}");
      await waitFor(() => expect(handle.spawnCalls).toHaveLength(1));
      expect(handle.spawnCalls[0]!.args).toEqual([real]);
    },
    90000,
  );

  it(
    "'Open worktree' in the branch menu is the accordion: Right arrow chooses a program, the GitHydra tab keeps opening a tab",
    async () => {
      const { repo, worktree } = await makeRepo(true);
      const handle = await openAppOn(repo);
      await addEditorThroughDialog();

      const card = await screen.findByRole("button", { name: /Jump to feature/ });
      fireEvent.contextMenu(card, { clientX: 40, clientY: 40 });
      let menu = await screen.findByRole("menu", { name: "Actions for branch feature" });
      const open = within(menu).getByRole("menuitem", { name: "Open worktree" });
      expect(open).toHaveAttribute("aria-haspopup", "menu");
      expect(open).toHaveAttribute("aria-expanded", "false");
      expect(menu).toHaveTextContent(`In worktree ${worktree.split(/[\/]/).pop()}`);
      expect(within(menu).getAllByRole("menuitem", { name: /worktree/i })).toHaveLength(1);
      open.focus();
      await userEvent.keyboard("{ArrowRight}");
      expect(open).toHaveAttribute("aria-expanded", "true");
      await userEvent.click(within(menu).getByRole("menuitem", { name: new RegExp(EDITOR_NAME) }));
      await waitFor(() => expect(handle.spawnCalls).toHaveLength(1));
      expect(handle.spawnCalls[0]!.args).toEqual([await fs.realpath(worktree)]);
      expect(await screen.findByText(`Opened in ${EDITOR_NAME}. ${EDITOR_NAME} is now your default.`)).toBeInTheDocument();
      expect(screen.getAllByRole("tab")).toHaveLength(1);

      // Now the body click runs the default; the GitHydra tab is still one expand away and opens the tab as before.
      fireEvent.contextMenu(await screen.findByRole("button", { name: /Jump to feature/ }), { clientX: 40, clientY: 40 });
      menu = await screen.findByRole("menu", { name: "Actions for branch feature" });
      expect(within(menu).getByText(`Opens in ${EDITOR_NAME}`)).toBeInTheDocument();
      await userEvent.click(within(menu).getByRole("menuitem", { name: "Open worktree" }).querySelector(".gh-context-menu__chevron")!);
      await userEvent.click(within(menu).getByRole("menuitem", { name: "GitHydra tab" }));
      await waitFor(() => expect(screen.getAllByRole("tab")).toHaveLength(2));
      expect(handle.spawnCalls).toHaveLength(1);
      expect(await screen.findByText("Opened in GitHydra tab. GitHydra tab is now your default.")).toBeInTheDocument();
    },
    120000,
  );
});
