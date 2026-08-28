import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CommitGraph } from "./CommitGraph";
import { makeCommit, makeDisplayRows, makeRepoState } from "../../test/fixtures";

// FR-54/FR-55: every CommitGraph render needs these branch-op handlers now that "Checkout"/
// "Create branch here" and the ref-chip menu are wired up — no-ops here since these tests only
// exercise selection/keyboard-nav behavior, not the branch mutations themselves.
const noopBranchHandlers = {
  onCheckoutCommit: () => {},
  onCreateBranchAt: () => {},
  onSwitchBranch: () => {},
  onDeleteBranch: () => {},
};

describe("CommitGraph", () => {
  it("renders visible commit rows with an accessible listbox/option structure", () => {
    const rows = makeDisplayRows([
      makeCommit("c3", ["c2"], { subject: "Third commit" }),
      makeCommit("c2", ["c1"], { subject: "Second commit" }),
      makeCommit("c1", [], { subject: "First commit" }),
    ]);
    render(
      <CommitGraph
        displayRows={rows}
        maxLaneIndexSeen={0}
        hasMore={false}
        isLoadingMore={false}
        onLoadMore={() => {}}
        visibleRefNames={new Set(["HEAD"])}
        repoState={makeRepoState()}
        selectedSha={null}
        onSelectCommit={() => {}}
        onSelectCheckpoint={() => {}}
        theme="dark"
        {...noopBranchHandlers}
      />,
    );
    expect(screen.getByRole("listbox", { name: /commit graph/i })).toBeInTheDocument();
    expect(screen.getByText("Third commit")).toBeInTheDocument();
    expect(screen.getAllByRole("option")).toHaveLength(3);
  });

  it("selects a commit on click", async () => {
    const rows = makeDisplayRows([makeCommit("c1", [], { subject: "Only commit" })]);
    const onSelect = vi.fn();
    render(
      <CommitGraph
        displayRows={rows}
        maxLaneIndexSeen={0}
        hasMore={false}
        isLoadingMore={false}
        onLoadMore={() => {}}
        visibleRefNames={new Set(["HEAD"])}
        repoState={makeRepoState()}
        selectedSha={null}
        onSelectCommit={onSelect}
        onSelectCheckpoint={() => {}}
        theme="dark"
        {...noopBranchHandlers}
      />,
    );
    await userEvent.click(screen.getByText("Only commit"));
    expect(onSelect).toHaveBeenCalledWith("c1");
  });

  it("supports keyboard selection via Enter after arrow-key navigation", async () => {
    const rows = makeDisplayRows([
      makeCommit("c2", ["c1"], { subject: "Newer" }),
      makeCommit("c1", [], { subject: "Older" }),
    ]);
    const onSelect = vi.fn();
    render(
      <CommitGraph
        displayRows={rows}
        maxLaneIndexSeen={0}
        hasMore={false}
        isLoadingMore={false}
        onLoadMore={() => {}}
        visibleRefNames={new Set(["HEAD"])}
        repoState={makeRepoState()}
        selectedSha={null}
        onSelectCommit={onSelect}
        onSelectCheckpoint={() => {}}
        theme="dark"
        {...noopBranchHandlers}
      />,
    );
    const listbox = screen.getByRole("listbox", { name: /commit graph/i });
    listbox.focus();
    await userEvent.keyboard("{ArrowDown}{Enter}");
    expect(onSelect).toHaveBeenCalledWith("c1");
  });

  it("renders the uncommitted-changes pseudo-node as a distinct (never commit-selected) option (FR-18)", () => {
    const commitRows = makeDisplayRows([makeCommit("c1", [], { subject: "Only commit" })]);
    const rows = [
      {
        kind: "uncommitted" as const,
        lane: 0,
        colorSlot: 0,
        connectsDown: true,
        status: { hasChanges: true, staged: 1, unstaged: 0, untracked: 2, conflicted: 0 },
      },
      ...commitRows,
    ];
    const onSelectCommit = vi.fn();
    render(
      <CommitGraph
        displayRows={rows}
        maxLaneIndexSeen={0}
        hasMore={false}
        isLoadingMore={false}
        onLoadMore={() => {}}
        visibleRefNames={new Set(["HEAD"])}
        repoState={makeRepoState()}
        selectedSha={null}
        onSelectCommit={onSelectCommit}
        onSelectCheckpoint={() => {}}
        theme="dark"
        {...noopBranchHandlers}
      />,
    );
    const pseudoOption = screen.getByText(/uncommitted changes/i).closest('[role="option"]');
    // It's a real, clickable option now (Must-have #2) — but clicking it never resolves to a
    // commit sha the way a real commit row's click does.
    expect(pseudoOption).toHaveAttribute("aria-selected", "false");
    expect(onSelectCommit).not.toHaveBeenCalled();
  });

  it("clicking the checkpoint pseudo-node calls onSelectCheckpoint, not onSelectCommit (Must-have #2, specs/detailpanel-auto-diff.md)", async () => {
    const commitRows = makeDisplayRows([makeCommit("c1", [], { subject: "Only commit" })]);
    const rows = [
      {
        kind: "uncommitted" as const,
        lane: 0,
        colorSlot: 0,
        connectsDown: true,
        status: { hasChanges: true, staged: 1, unstaged: 0, untracked: 0, conflicted: 0 },
      },
      ...commitRows,
    ];
    const onSelectCommit = vi.fn();
    const onSelectCheckpoint = vi.fn();
    render(
      <CommitGraph
        displayRows={rows}
        maxLaneIndexSeen={0}
        hasMore={false}
        isLoadingMore={false}
        onLoadMore={() => {}}
        visibleRefNames={new Set(["HEAD"])}
        repoState={makeRepoState()}
        selectedSha={null}
        onSelectCommit={onSelectCommit}
        onSelectCheckpoint={onSelectCheckpoint}
        theme="dark"
        {...noopBranchHandlers}
      />,
    );
    await userEvent.click(screen.getByText(/uncommitted changes/i));
    expect(onSelectCheckpoint).toHaveBeenCalledTimes(1);
    expect(onSelectCommit).not.toHaveBeenCalled();
  });

  it("activating the checkpoint pseudo-node via the keyboard (arrow + Enter) calls onSelectCheckpoint", async () => {
    const commitRows = makeDisplayRows([makeCommit("c1", [], { subject: "Only commit" })]);
    const rows = [
      {
        kind: "uncommitted" as const,
        lane: 0,
        colorSlot: 0,
        connectsDown: true,
        status: { hasChanges: true, staged: 0, unstaged: 1, untracked: 0, conflicted: 0 },
      },
      ...commitRows,
    ];
    const onSelectCheckpoint = vi.fn();
    render(
      <CommitGraph
        displayRows={rows}
        maxLaneIndexSeen={0}
        hasMore={false}
        isLoadingMore={false}
        onLoadMore={() => {}}
        visibleRefNames={new Set(["HEAD"])}
        repoState={makeRepoState()}
        selectedSha={null}
        onSelectCommit={() => {}}
        onSelectCheckpoint={onSelectCheckpoint}
        theme="dark"
        {...noopBranchHandlers}
      />,
    );
    const listbox = screen.getByRole("listbox", { name: /commit graph/i });
    listbox.focus();
    // The checkpoint row is the first (index 0) row — no ArrowDown needed to reach it.
    await userEvent.keyboard("{Enter}");
    expect(onSelectCheckpoint).toHaveBeenCalledTimes(1);
  });
});
