// SPDX-License-Identifier: GPL-3.0-or-later
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { configure, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "./App";
import { createRealGitHydraApi, type RealGitHydraHandle } from "./test/realGitHydraApi";
import { cleanup, commitAll, git, makeTempDir, writeFile } from "./test/gitFixture";

// Real git underneath every waitFor, like the other e2e suites in this folder.
configure({ asyncUtilTimeout: 20000 });

/**
 * specs/worktrees.md slice 2: the real <App/> against a real RepoSession and real `git worktree`. Each test makes its own
 * parent folder holding the repo `acme`, so the sibling `acme.worktrees` folder the default path creates is removed with it.
 */
const handles: RealGitHydraHandle[] = [];
const dirs: string[] = [];

afterEach(async () => {
  // @ts-expect-error test cleanup of the global bridge
  delete window.gitHydra;
  window.localStorage.clear();
  await new Promise((resolve) => setTimeout(resolve, 350));
  while (handles.length) handles.pop()!.dispose();
  while (dirs.length) await cleanup(dirs.pop()!);
});

async function makeRepo(): Promise<{ parent: string; repo: string }> {
  const parent = await makeTempDir("wt-ui-");
  dirs.push(parent);
  const repo = path.join(parent, "acme");
  await fs.mkdir(repo);
  await git(repo, ["init", "-q", "--initial-branch=main"]);
  await writeFile(repo, "a.txt", "base\n");
  await commitAll(repo, "base");
  await git(repo, ["branch", "feature"]);
  return { parent, repo };
}

async function openAppOn(dir: string): Promise<RealGitHydraHandle> {
  const handle = createRealGitHydraApi();
  handles.push(handle);
  handle.setDialogPath(dir);
  window.localStorage.setItem("githydra:layout:worktreesCollapsed", "0");
  window.gitHydra = handle.api;
  render(<App />);
  await userEvent.click(screen.getByRole("button", { name: "Open a repository" }));
  await screen.findByRole("button", { name: /stashes/i }, { timeout: 10000 });
  return handle;
}

const exists = (p: string) => fs.stat(p).then(() => true, () => false);

async function createFromBranchMenu(branch: string): Promise<void> {
  const card = await screen.findByRole("button", { name: new RegExp(`Jump to ${branch}`) });
  fireEvent.contextMenu(card, { clientX: 40, clientY: 40 });
  const menu = await screen.findByRole("menu", { name: `Actions for branch ${branch}` });
  await userEvent.click(within(menu).getByRole("menuitem", { name: /Create worktree/ }));
}

describe("worktrees end to end (real App, real git)", () => {
  it(
    "creates a worktree from a branch, lists it, opens it as a tab, then removes it (keeping the branch)",
    async () => {
      const { parent, repo } = await makeRepo();
      await openAppOn(repo);

      await createFromBranchMenu("feature");
      const dialog = await screen.findByRole("dialog", { name: "Create worktree" });
      const folder = within(dialog).getByLabelText("Folder") as HTMLInputElement;
      await waitFor(() => expect(folder.value).toContain("acme.worktrees"));
      const target = folder.value;
      expect(path.resolve(target)).toBe(path.join(parent, "acme.worktrees", "feature"));
      await userEvent.click(within(dialog).getByRole("button", { name: "Create worktree" }));

      // Banner, new tab, list.
      await screen.findByText('Created worktree "feature".');
      expect(await exists(target)).toBe(true);
      expect((await git(repo, ["worktree", "list", "--porcelain"])).stdout).toContain("branch refs/heads/feature");
      await waitFor(() => expect(screen.getAllByRole("tab")).toHaveLength(2));
      const featureTab = screen.getAllByRole("tab").find((t) => /feature/.test(t.textContent ?? ""))!;
      expect(featureTab).toHaveAttribute("aria-selected", "true");
      expect(featureTab).toHaveAttribute("title", expect.stringContaining("feature"));
      await waitFor(() => expect(screen.getByRole("heading", { name: /Worktrees \(2\)/ })).toBeInTheDocument());
      // No external-change alert for our own write.
      expect(screen.queryByText(/history changed outside/i)).toBeNull();

      // Remove it from its own tab: the tab closes first, the folder goes, the branch stays.
      const row = await screen.findByRole("listitem", { name: /Worktree feature, linked/ });
      fireEvent.contextMenu(row, { clientX: 30, clientY: 30 });
      await userEvent.click(within(await screen.findByRole("menu")).getByRole("menuitem", { name: "Remove this worktree" }));
      const confirm = await screen.findByRole("alertdialog");
      expect(within(confirm).getByRole("button", { name: "Cancel" })).toHaveFocus();
      await waitFor(() => expect(within(confirm).getByRole("button", { name: "Remove worktree" })).toBeEnabled());
      expect(confirm).toHaveTextContent(`ignored files such as node_modules and build output in ${target}`);
      await userEvent.click(within(confirm).getByRole("button", { name: "Remove worktree" }));

      await screen.findByText("Worktree removed.");
      await waitFor(async () => expect(await exists(target)).toBe(false));
      await waitFor(() => expect(screen.getAllByRole("tab")).toHaveLength(1));
      expect((await git(repo, ["branch", "--list", "feature"])).stdout).toContain("feature");
      expect((await git(repo, ["worktree", "list", "--porcelain"])).stdout).not.toContain("refs/heads/feature");
    },
    90000,
  );

  it(
    "a dirty worktree with 21 files needs the typed count; 'delete branch' on an unmerged branch is downgraded and keeps it",
    async () => {
      const { parent, repo } = await makeRepo();
      const wt = path.join(parent, "acme.worktrees", "wip");
      await git(repo, ["worktree", "add", "-q", "-b", "wip", wt]);
      await writeFile(wt, "new.txt", "unmerged work\n");
      await commitAll(wt, "unmerged commit");
      for (let i = 0; i < 21; i++) await writeFile(wt, `scratch/f${i}.txt`, "x\n");
      await openAppOn(repo);

      const row = await screen.findByRole("listitem", { name: /Worktree wip, linked/ });
      fireEvent.contextMenu(row, { clientX: 30, clientY: 30 });
      await userEvent.click(within(await screen.findByRole("menu")).getByRole("menuitem", { name: "Remove worktree and delete branch" }));
      const dialog = await screen.findByRole("alertdialog");
      const typed = await within(dialog).findByLabelText(/Type 21 to confirm \(more than 20 files\)/);
      expect(dialog).toHaveTextContent("21 uncommitted files");
      // Downgraded: the branch has a commit that is not merged anywhere.
      expect(within(dialog).getByRole("heading", { name: "Remove worktree?" })).toBeInTheDocument();
      expect(dialog).toHaveTextContent("Branch wip has 1 commit that is not merged into main or its upstream, so it will be kept.");
      const button = within(dialog).getByRole("button", { name: "Remove worktree" });
      expect(button).toBeDisabled();
      await userEvent.type(typed, "21{Enter}");
      expect(await exists(wt)).toBe(true); // Enter never confirms
      await userEvent.click(button);

      await screen.findByText(/The branch wip was kept because it has commits that are not merged into main or its upstream/);
      expect(screen.getByRole("button", { name: "Open Branches" })).toBeInTheDocument();
      await waitFor(async () => expect(await exists(wt)).toBe(false));
      expect((await git(repo, ["branch", "--list", "wip"])).stdout).toContain("wip");
    },
    90000,
  );

  it(
    "a merged branch is removed together with the worktree; a locked worktree cannot be removed and says why",
    async () => {
      const { parent, repo } = await makeRepo();
      const wt = path.join(parent, "acme.worktrees", "done");
      await git(repo, ["worktree", "add", "-q", "-b", "done", wt]);
      const locked = path.join(parent, "acme.worktrees", "held");
      await git(repo, ["worktree", "add", "-q", "-b", "held", locked]);
      await git(repo, ["worktree", "lock", "--reason", "on a usb stick", locked]);
      await openAppOn(repo);

      const lockedRow = await screen.findByRole("listitem", { name: /Worktree held, linked, locked/ });
      fireEvent.contextMenu(lockedRow, { clientX: 30, clientY: 30 });
      const lockMenu = await screen.findByRole("menu");
      expect(within(lockMenu).getByRole("menuitem", { name: "Remove this worktree" })).toBeDisabled();
      expect(lockMenu).toHaveTextContent("Locked: on a usb stick. Unlock it with git worktree unlock before removing.");
      await userEvent.keyboard("{Escape}");

      const row = await screen.findByRole("listitem", { name: /Worktree done, linked/ });
      fireEvent.contextMenu(row, { clientX: 30, clientY: 30 });
      await userEvent.click(within(await screen.findByRole("menu")).getByRole("menuitem", { name: "Remove worktree and delete branch" }));
      const dialog = await screen.findByRole("alertdialog");
      await within(dialog).findByRole("heading", { name: "Remove worktree and delete branch?" });
      await userEvent.click(within(dialog).getByRole("button", { name: "Remove and delete branch" }));
      await screen.findByText("Worktree and branch removed.");
      expect((await git(repo, ["branch", "--list", "done"])).stdout).toBe("");
      expect(await exists(wt)).toBe(false);
    },
    90000,
  );

  it(
    "the Worktree: Remove... palette picker lists the main and locked entries disabled with their reasons",
    async () => {
      const { parent, repo } = await makeRepo();
      const locked = path.join(parent, "acme.worktrees", "held");
      await git(repo, ["worktree", "add", "-q", "-b", "held", locked]);
      await git(repo, ["worktree", "lock", "--reason", "usb", locked]);
      await openAppOn(repo);
      await screen.findByRole("listitem", { name: /Worktree held/ });

      await userEvent.keyboard("{Control>}k{/Control}");
      const input = await screen.findByRole("combobox", { name: /command palette/i });
      await userEvent.type(input, "Worktree: Remove");
      await userEvent.keyboard("{Enter}");
      const picker = await screen.findByRole("dialog");
      const options = within(picker).getAllByRole("option");
      expect(options).toHaveLength(2);
      expect(options.every((o) => o.getAttribute("aria-disabled") === "true")).toBe(true);
      expect(picker).toHaveTextContent("The main worktree cannot be removed.");
      expect(picker).toHaveTextContent("Locked: usb. Unlock it with git worktree unlock before removing.");
    },
    60000,
  );
});
