// SPDX-License-Identifier: GPL-3.0-or-later
import { createRef } from "react";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { WorktreeEntry } from "@githydra/git-core";
import { BranchesPanel, type BranchesPanelWorktrees } from "./BranchesPanel";
import { useBranchActions } from "../../hooks/useBranchActions";
import { indexWorktrees } from "../../lib/worktrees";
import { makeLocalBranch, makeRemoteBranch, makeRepoState } from "../../test/fixtures";
import { makeMockGitHydra, mockWorktreeEntry } from "../../test/mockGitHydra";

function wt(entries: WorktreeEntry[], over: Partial<BranchesPanelWorktrees> = {}): BranchesPanelWorktrees {
  return {
    state: {
      status: "ready",
      list: { entries, untrusted: false, untrustedReason: null, commonDir: "/w/repo/.git", mainPath: "/w/repo", format: "nul", mainPathIsGitDir: false },
      errorMessage: null,
      index: indexWorktrees(entries),
      reload: () => {},
    },
    isOpenAsTab: () => false,
    notices: [],
    onDismissNotice: vi.fn(),
    onOpenBranches: vi.fn(),
    onOpen: vi.fn(),
    onRemove: vi.fn(),
    onCleanUp: vi.fn(),
    onCreateNew: vi.fn(),
    onCreateForBranch: vi.fn(),
    onCreateForRemote: vi.fn(),
    headingRef: createRef<HTMLHeadingElement>(),
    onMenuOpenChange: vi.fn(),
    ...over,
  };
}

function Harness({ api, worktrees }: { api: ReturnType<typeof makeMockGitHydra>; worktrees: BranchesPanelWorktrees }) {
  const actions = useBranchActions({ api, onChanged: () => {} });
  return (
    <BranchesPanel
      api={api}
      repoState={makeRepoState()}
      actions={actions}
      onRequestNewBranch={() => {}}
      collapsed={false}
      onToggleCollapsed={() => {}}
      onLocateBranch={() => {}}
      lastFetchedAt={null}
      worktrees={worktrees}
    />
  );
}

const main = mockWorktreeEntry({ id: null, isMain: true, path: "/w/repo", branch: "main" });
const feature = mockWorktreeEntry({ id: "f", path: "/w/repo.worktrees/feature", branch: "feature" });

const worktreeItems = (menu: HTMLElement) => within(menu).queryAllByRole("menuitem").filter((i) => /worktree/i.test(i.getAttribute("aria-label") ?? i.textContent ?? ""));

describe("BranchesPanel worktrees (FR-607, FR-613)", () => {
  it("shows the Worktrees section with the registered worktrees", async () => {
    window.localStorage.setItem("githydra:layout:worktreesCollapsed", "0");
    const api = makeMockGitHydra({ localBranches: [makeLocalBranch("main", { isCurrent: true })] });
    render(<Harness api={api} worktrees={wt([main, feature])} />);
    await screen.findByText("Local (1)");
    expect(screen.getByRole("heading", { name: /Worktrees \(2\)/ })).toBeInTheDocument();
    expect(screen.getByRole("listitem", { name: /Worktree feature, linked/ })).toBeInTheDocument();
  });

  it("a card for a branch with a worktree shows the worktree glyph (path in tooltip and aria-label) instead of the 'Checked out elsewhere' text", async () => {
    const api = makeMockGitHydra({
      localBranches: [makeLocalBranch("main", { isCurrent: true }), makeLocalBranch("feature", { checkedOutInWorktree: "/w/repo.worktrees/feature" })],
    });
    render(<Harness api={api} worktrees={wt([main, feature])} />);
    await screen.findByText("Local (2)");
    expect(screen.queryByText("Checked out elsewhere")).toBeNull();
    const glyph = screen.getByRole("img", { name: "Checked out at /w/repo.worktrees/feature" });
    expect(glyph).toHaveAttribute("title", "Checked out at /w/repo.worktrees/feature");
    expect(glyph.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
  });

  it("a free branch's card menu has exactly one worktree item, 'Create worktree…'", async () => {
    const api = makeMockGitHydra({ localBranches: [makeLocalBranch("main", { isCurrent: true }), makeLocalBranch("free")] });
    const worktrees = wt([main]);
    render(<Harness api={api} worktrees={worktrees} />);
    await screen.findByText("Local (2)");
    fireEvent.contextMenu(screen.getByRole("button", { name: /Jump to free/ }), { clientX: 30, clientY: 30 });
    const menu = await screen.findByRole("menu", { name: "Actions for branch free" });
    const items = worktreeItems(menu);
    expect(items).toHaveLength(1);
    expect(items[0]).toHaveTextContent("Create worktree…");
    await userEvent.click(items[0]!);
    expect(worktrees.onCreateForBranch).toHaveBeenCalledWith("free");
  });

  it("the current branch (checked out in main) and a branch with a worktree get only 'Open worktree' with the path", async () => {
    const api = makeMockGitHydra({
      localBranches: [makeLocalBranch("main", { isCurrent: true }), makeLocalBranch("feature", { checkedOutInWorktree: feature.path })],
    });
    const worktrees = wt([main, feature]);
    render(<Harness api={api} worktrees={worktrees} />);
    await screen.findByText("Local (2)");
    for (const name of ["main", "feature"]) {
      fireEvent.contextMenu(screen.getByRole("button", { name: new RegExp(`Jump to ${name}`) }), { clientX: 30, clientY: 30 });
      const menu = await screen.findByRole("menu", { name: `Actions for branch ${name}` });
      const items = worktreeItems(menu);
      expect(items, name).toHaveLength(1);
      expect(items[0]).toHaveAttribute("aria-label", "Open worktree");
      expect(within(menu).queryByText(/Create worktree/)).toBeNull();
      await userEvent.keyboard("{Escape}");
    }
  });

  it("a remote-only branch's card menu offers 'Create worktree…' and creates from that remote", async () => {
    const api = makeMockGitHydra({
      localBranches: [makeLocalBranch("main", { isCurrent: true })],
      remoteBranches: [makeRemoteBranch("origin", "release")],
    });
    const worktrees = wt([main]);
    render(<Harness api={api} worktrees={worktrees} />);
    await screen.findByText("origin (1)");
    fireEvent.contextMenu(screen.getByRole("button", { name: /Jump to origin\/release/ }), { clientX: 30, clientY: 30 });
    const menu = await screen.findByRole("menu", { name: "Actions for branch origin/release" });
    const items = worktreeItems(menu);
    expect(items).toHaveLength(1);
    await userEvent.click(items[0]!);
    expect(worktrees.onCreateForRemote).toHaveBeenCalledWith("origin", "release");
  });

  it("when worktree info is unavailable there is no worktree item and the section says why in one line", async () => {
    window.localStorage.setItem("githydra:layout:worktreesCollapsed", "0");
    const api = makeMockGitHydra({ localBranches: [makeLocalBranch("main", { isCurrent: true }), makeLocalBranch("free", { worktreeInfoUnavailable: true })] });
    render(<Harness api={api} worktrees={wt([main])} />);
    await screen.findByText("Local (2)");
    expect(screen.getByText(/Worktree actions are unavailable/)).toBeInTheDocument();
    fireEvent.contextMenu(screen.getByRole("button", { name: /Jump to free/ }), { clientX: 30, clientY: 30 });
    const menu = await screen.findByRole("menu", { name: "Actions for branch free" });
    expect(worktreeItems(menu)).toHaveLength(0);
  });

  it("notices render at the top of the panel, above the lists", async () => {
    const api = makeMockGitHydra({ localBranches: [makeLocalBranch("main", { isCurrent: true })] });
    const worktrees = wt([main], { notices: [{ id: 1, tone: "success", text: 'Created worktree "x".', actions: [] }] });
    render(<Harness api={api} worktrees={worktrees} />);
    const notice = await screen.findByText('Created worktree "x".');
    await waitFor(() => expect(screen.getByText("Local (1)")).toBeInTheDocument());
    expect(notice.compareDocumentPosition(screen.getByText("Local (1)")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("the Branches panel keeps working without the worktree prop (no section, plain cards)", async () => {
    const api = makeMockGitHydra({ localBranches: [makeLocalBranch("main", { isCurrent: true })] });
    function Plain() {
      const actions = useBranchActions({ api, onChanged: () => {} });
      return (
        <BranchesPanel api={api} repoState={makeRepoState()} actions={actions} onRequestNewBranch={() => {}} collapsed={false} onToggleCollapsed={() => {}} onLocateBranch={() => {}} lastFetchedAt={null} />
      );
    }
    render(<Plain />);
    await screen.findByText("Local (1)");
    expect(screen.queryByRole("heading", { name: /Worktrees/ })).toBeNull();
  });
});
