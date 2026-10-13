// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CommitGraph } from "./CommitGraph";
import { makeCommit, makeDisplayRows, makeRepoState } from "../../test/fixtures";
import { mockWorktreeEntry } from "../../test/mockGitHydra";
import { indexWorktrees } from "../../lib/worktrees";

const noop = {
  onCheckoutCommit: () => {},
  onCreateBranchAt: () => {},
  onSwitchBranch: () => {},
  onDeleteBranch: () => {},
  onCherryPick: () => {},
  cherryPickBusy: false,
  onCompare: () => {},
  onResetToHere: () => {},
};

const SHA = "1234567890abcdef1234567890abcdef12345678";

function Graph({ worktreeMenu, withBranch = true }: { worktreeMenu: React.ComponentProps<typeof CommitGraph>["worktreeMenu"]; withBranch?: boolean }) {
  const rows = makeDisplayRows([
    makeCommit(SHA, [], {
      subject: "Only commit",
      refs: withBranch ? [{ name: "feature-x", fullName: "refs/heads/feature-x", type: "local-branch" }] : [],
    }),
  ]);
  return (
    <CommitGraph
      displayRows={rows}
      maxLaneIndexSeen={0}
      hasMore={false}
      isLoadingMore={false}
      onLoadMore={() => {}}
      visibleRefNames={new Set(["refs/heads/feature-x"])}
      repoState={makeRepoState()}
      selectedSha={null}
      followSignal={0}
      onSelectCommit={() => {}}
      onSelectCheckpoint={() => {}}
      theme="dark"
      {...noop}
      worktreeMenu={worktreeMenu}
    />
  );
}

const contextMenu = (el: Element) => el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
const worktreeItems = (menu: HTMLElement) => within(menu).queryAllByRole("menuitem").filter((i) => /worktree/i.test(i.getAttribute("aria-label") ?? i.textContent ?? ""));

describe("graph menus: exactly one worktree item (FR-607, AC12)", () => {
  const handlers = () => ({ onCreateForBranch: vi.fn(), onCreateFromCommit: vi.fn(), onOpen: vi.fn() });

  it("a branch chip without a worktree offers only 'Create worktree…'", async () => {
    const h = handlers();
    render(<Graph worktreeMenu={{ index: indexWorktrees([]), available: true, ...h }} />);
    contextMenu(screen.getByText("feature-x"));
    const menu = await screen.findByRole("menu", { name: /actions for branch feature-x/i });
    const items = worktreeItems(menu);
    expect(items).toHaveLength(1);
    expect(items[0]).toHaveTextContent("Create worktree…");
    await userEvent.click(items[0]!);
    expect(h.onCreateForBranch).toHaveBeenCalledWith("feature-x");
  });

  it("a branch chip with a worktree offers only 'Open worktree' with 'Checked out at <path>', never a disabled twin", async () => {
    const h = handlers();
    const entry = mockWorktreeEntry({ path: "/w/repo.worktrees/feature-x", branch: "feature-x" });
    render(<Graph worktreeMenu={{ index: indexWorktrees([entry]), available: true, ...h }} />);
    contextMenu(screen.getByText("feature-x"));
    const menu = await screen.findByRole("menu", { name: /actions for branch feature-x/i });
    const items = worktreeItems(menu);
    expect(items).toHaveLength(1);
    expect(items[0]).toHaveAttribute("aria-label", "Open worktree");
    expect(items[0]).toBeEnabled();
    expect(menu).toHaveTextContent("Checked out at /w/repo.worktrees/feature-x");
    expect(within(menu).queryByText(/Create worktree/)).toBeNull();
    await userEvent.click(items[0]!);
    expect(h.onOpen).toHaveBeenCalledWith(entry);
  });

  it("a commit without a worktree offers 'Create worktree from commit <sha>…'; with a worktree at it, only 'Open worktree'", async () => {
    const h = handlers();
    const { unmount } = render(<Graph withBranch={false} worktreeMenu={{ index: indexWorktrees([]), available: true, ...h }} />);
    contextMenu(screen.getByText("Only commit"));
    let menu = await screen.findByRole("menu", { name: /actions for commit/i });
    let items = worktreeItems(menu);
    expect(items).toHaveLength(1);
    expect(items[0]).toHaveTextContent("Create worktree from commit 1234567…");
    await userEvent.click(items[0]!);
    expect(h.onCreateFromCommit).toHaveBeenCalledWith(SHA, "commit 1234567");
    unmount();

    render(<Graph withBranch={false} worktreeMenu={{ index: indexWorktrees([mockWorktreeEntry({ head: SHA, branch: null })]), available: true, ...h }} />);
    contextMenu(screen.getByText("Only commit"));
    menu = await screen.findByRole("menu", { name: /actions for commit/i });
    items = worktreeItems(menu);
    expect(items).toHaveLength(1);
    expect(items[0]).toHaveAttribute("aria-label", "Open worktree");
  });

  it("offers no worktree item at all when worktree info is unavailable", async () => {
    render(<Graph worktreeMenu={{ index: indexWorktrees([]), available: false, ...handlers() }} />);
    contextMenu(screen.getByText("feature-x"));
    const menu = await screen.findByRole("menu", { name: /actions for branch feature-x/i });
    expect(worktreeItems(menu)).toHaveLength(0);
  });
});
