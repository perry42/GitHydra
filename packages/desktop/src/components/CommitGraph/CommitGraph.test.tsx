import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
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

  it("FR-54: the commit context menu's Checkout/Create-branch-here actions call the real handlers with the commit's sha", async () => {
    const rows = makeDisplayRows([makeCommit("c1", [], { subject: "Only commit" })]);
    const onCheckoutCommit = vi.fn();
    const onCreateBranchAt = vi.fn();
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
        onCheckoutCommit={onCheckoutCommit}
        onCreateBranchAt={onCreateBranchAt}
      />,
    );

    fireContextMenu(screen.getByText("Only commit"));
    await userEvent.click(await screen.findByRole("menuitem", { name: /checkout commit/i }));
    expect(onCheckoutCommit).toHaveBeenCalledWith("c1");

    fireContextMenu(screen.getByText("Only commit"));
    await userEvent.click(await screen.findByRole("menuitem", { name: /create branch here/i }));
    expect(onCreateBranchAt).toHaveBeenCalledWith("c1", expect.stringContaining("c1"));
  });

  it("FR-55: right-clicking a local-branch ref chip's Checkout item routes to the same handler the Branches panel uses", async () => {
    const onSwitchBranch = vi.fn();
    render(<GraphWithBranchChip onSwitchBranch={onSwitchBranch} />);

    fireContextMenu(screen.getByText("feature-x"));
    const menu = await screen.findByRole("menu", { name: /actions for branch feature-x/i });
    await userEvent.click(within(menu).getByRole("menuitem", { name: /^checkout$/i }));
    expect(onSwitchBranch).toHaveBeenCalledWith("feature-x");
  });

  it("FR-55: right-clicking a local-branch ref chip's Delete item routes to the same handler the Branches panel uses", async () => {
    const onDeleteBranch = vi.fn();
    render(<GraphWithBranchChip onDeleteBranch={onDeleteBranch} />);

    fireContextMenu(screen.getByText("feature-x"));
    const menu = await screen.findByRole("menu", { name: /actions for branch feature-x/i });
    await userEvent.click(within(menu).getByRole("menuitem", { name: /delete/i }));
    expect(onDeleteBranch).toHaveBeenCalledWith("feature-x");
  });

  it("FR-55 regression: right-clicking a ref chip opens only the branch menu, not also the commit's menu underneath it (caught in manual testing against the real app)", async () => {
    render(<GraphWithBranchChip />);
    fireContextMenu(screen.getByText("feature-x"));
    await screen.findByRole("menu", { name: /actions for branch feature-x/i });
    expect(screen.queryByRole("menu", { name: /actions for commit/i })).not.toBeInTheDocument();
    expect(screen.getAllByRole("menu")).toHaveLength(1);
  });
});

/** Shared fixture for the FR-55 ref-chip-menu tests above: a single commit whose only ref
 * decoration is a local branch named "feature-x". */
function GraphWithBranchChip({
  onSwitchBranch = () => {},
  onDeleteBranch = () => {},
}: {
  onSwitchBranch?: (name: string) => void;
  onDeleteBranch?: (name: string) => void;
}) {
  const rows = makeDisplayRows([
    makeCommit("c1", [], {
      subject: "Only commit",
      refs: [{ name: "feature-x", fullName: "refs/heads/feature-x", type: "local-branch" }],
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
      onSelectCommit={() => {}}
      onSelectCheckpoint={() => {}}
      theme="dark"
      {...noopBranchHandlers}
      onSwitchBranch={onSwitchBranch}
      onDeleteBranch={onDeleteBranch}
    />
  );
}

/** jsdom doesn't synthesize a real "contextmenu" event from userEvent yet — fire it directly. */
function fireContextMenu(target: Element) {
  target.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
}
