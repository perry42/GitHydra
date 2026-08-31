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

  // specs/graph-head-indicator-and-refresh-alerting.md Problem 1.
  describe("HEAD position indicator (graph-head-indicator-and-refresh-alerting.md Problem 1)", () => {
    it("marks the HEAD commit with a distinct, row-anchored badge separate from the ref-chip list (AC1)", () => {
      const rows = makeDisplayRows([
        makeCommit("c2", ["c1"], { subject: "Newer" }),
        makeCommit("c1", [], { subject: "Older" }),
      ]);
      render(
        <CommitGraph
          displayRows={rows}
          maxLaneIndexSeen={0}
          hasMore={false}
          isLoadingMore={false}
          onLoadMore={() => {}}
          visibleRefNames={new Set(["HEAD"])}
          repoState={makeRepoState({ headSha: "c2" })}
          selectedSha={null}
          onSelectCommit={() => {}}
          onSelectCheckpoint={() => {}}
          theme="dark"
          {...noopBranchHandlers}
        />,
      );

      const headBadge = screen.getByRole("img", { name: /^HEAD: HEAD$/i });
      const headRow = screen.getByText("Newer").closest('[role="option"]')!;
      const olderRow = screen.getByText("Older").closest('[role="option"]')!;
      expect(headRow).toContainElement(headBadge);
      expect(olderRow).not.toContainElement(headBadge);
    });

    it("keeps the HEAD badge on the HEAD row after a different commit is selected — both remain visible and distinguishable at once (AC5 regression against commit-graph.md FR-17)", async () => {
      const rows = makeDisplayRows([
        makeCommit("c2", ["c1"], { subject: "Newer" }),
        makeCommit("c1", [], { subject: "Older" }),
      ]);
      const onSelect = vi.fn();
      const { rerender } = render(
        <CommitGraph
          displayRows={rows}
          maxLaneIndexSeen={0}
          hasMore={false}
          isLoadingMore={false}
          onLoadMore={() => {}}
          visibleRefNames={new Set(["HEAD"])}
          repoState={makeRepoState({ headSha: "c2" })}
          selectedSha={"c2"}
          onSelectCommit={onSelect}
          onSelectCheckpoint={() => {}}
          theme="dark"
          {...noopBranchHandlers}
        />,
      );

      await userEvent.click(screen.getByText("Older"));
      expect(onSelect).toHaveBeenCalledWith("c1");

      // Simulate the parent applying the resulting selection change (as `App` does on click).
      rerender(
        <CommitGraph
          displayRows={rows}
          maxLaneIndexSeen={0}
          hasMore={false}
          isLoadingMore={false}
          onLoadMore={() => {}}
          visibleRefNames={new Set(["HEAD"])}
          repoState={makeRepoState({ headSha: "c2" })}
          selectedSha={"c1"}
          onSelectCommit={onSelect}
          onSelectCheckpoint={() => {}}
          theme="dark"
          {...noopBranchHandlers}
        />,
      );

      const headBadge = screen.getByRole("img", { name: /^HEAD: HEAD$/i });
      const headRow = screen.getByText("Newer").closest('[role="option"]')!;
      const selectedRow = screen.getByText("Older").closest('[role="option"]')!;
      // HEAD badge stayed on the HEAD row, not the newly-selected one...
      expect(headRow).toContainElement(headBadge);
      // ...while the selection ring/highlight moved to the clicked row.
      expect(selectedRow).toHaveClass("gh-commit-row--selected");
      expect(headRow).not.toHaveClass("gh-commit-row--selected");
    });

    it("scrolls a newly app-selected HEAD commit into view without requiring a click (AC2/AC3/AC6)", () => {
      // Enough rows that row 80 starts out scrolled out of the (jsdom-default, effectively
      // zero-height) viewport — `computeVisibleRange`'s overscan alone wouldn't reach it.
      const commits = Array.from({ length: 100 }, (_, i) => makeCommit(`c${100 - i}`, i < 99 ? [`c${99 - i}`] : [], {
        subject: `Commit ${100 - i}`,
      }));
      const rows = makeDisplayRows(commits);
      const { rerender } = render(
        <CommitGraph
          displayRows={rows}
          maxLaneIndexSeen={0}
          hasMore={false}
          isLoadingMore={false}
          onLoadMore={() => {}}
          visibleRefNames={new Set(["HEAD"])}
          repoState={makeRepoState({ headSha: "c100" })}
          selectedSha={null}
          onSelectCommit={() => {}}
          onSelectCheckpoint={() => {}}
          theme="dark"
          {...noopBranchHandlers}
        />,
      );

      const scroller = screen.getByRole("listbox", { name: /commit graph/i });
      // A commit far down the list — well outside the default (unscrolled) visible window.
      const targetSha = "c20";
      scroller.scrollTop = 0;

      rerender(
        <CommitGraph
          displayRows={rows}
          maxLaneIndexSeen={0}
          hasMore={false}
          isLoadingMore={false}
          onLoadMore={() => {}}
          visibleRefNames={new Set(["HEAD"])}
          repoState={makeRepoState({ headSha: "c100" })}
          selectedSha={targetSha}
          onSelectCommit={() => {}}
          onSelectCheckpoint={() => {}}
          theme="dark"
          {...noopBranchHandlers}
        />,
      );

      // Row index of c20 in this descending-order list is 80 (0-indexed) — scrollTop should have
      // moved to bring it into view (aligned to the bottom edge, per `scrollIndexIntoView`).
      expect(scroller.scrollTop).toBeGreaterThan(0);
    });
  });

  // specs/graph-head-indicator-and-refresh-alerting.md Addendum 2, Problem 1b.
  describe("auto-follow when the target row isn't loaded (Addendum 2, Problem 1b)", () => {
    it("shows an inline affordance instead of silently no-opping once the bounded auto-load chase is exhausted (AC1)", () => {
      // Only ~150 of a much larger history loaded — mirrors the addendum's own repro (a 300-commit
      // fixture with ~150 rows loaded), except `hasMore` never resolves to a page containing the
      // target here, so the chase runs out and the affordance must appear rather than staying silent.
      const commits = Array.from({ length: 150 }, (_, i) => makeCommit(`c${150 - i}`, i < 149 ? [`c${149 - i}`] : [], {
        subject: `Commit ${150 - i}`,
      }));
      const rows = makeDisplayRows(commits);
      const onLoadMore = vi.fn();
      const { rerender } = render(
        <CommitGraph
          displayRows={rows}
          maxLaneIndexSeen={0}
          hasMore={true}
          isLoadingMore={false}
          onLoadMore={onLoadMore}
          visibleRefNames={new Set(["HEAD"])}
          repoState={makeRepoState({ headSha: "c1" })}
          selectedSha={null}
          onSelectCommit={() => {}}
          onSelectCheckpoint={() => {}}
          theme="dark"
          {...noopBranchHandlers}
        />,
      );

      // App-initiated selection of a commit far outside the loaded page (e.g. a branch tip 294
      // commits deep) — never actually present in `rows` for this test, simulating "still not
      // found after the load cap".
      const targetSha = "c9999";
      rerender(
        <CommitGraph
          displayRows={rows}
          maxLaneIndexSeen={0}
          hasMore={true}
          isLoadingMore={false}
          onLoadMore={onLoadMore}
          visibleRefNames={new Set(["HEAD"])}
          repoState={makeRepoState({ headSha: "c1" })}
          selectedSha={targetSha}
          onSelectCommit={() => {}}
          onSelectCheckpoint={() => {}}
          theme="dark"
          {...noopBranchHandlers}
        />,
      );

      // The bounded chase calls onLoadMore once immediately, then (since `displayRows`/`hasMore`
      // never change in this test — nothing new ever "arrives") re-renders won't happen on their
      // own; re-render a few more times with the exact same props to let the capped chase run its
      // course, the same way real prop churn from repeated `loadMore` resolutions would.
      for (let i = 0; i < 5; i++) {
        rerender(
          <CommitGraph
            displayRows={rows}
            maxLaneIndexSeen={0}
            hasMore={true}
            isLoadingMore={false}
            onLoadMore={onLoadMore}
            visibleRefNames={new Set(["HEAD"])}
            repoState={makeRepoState({ headSha: "c1" })}
            selectedSha={targetSha}
            onSelectCommit={() => {}}
            onSelectCheckpoint={() => {}}
            theme="dark"
            {...noopBranchHandlers}
          />,
        );
      }

      // Bounded, not silent, and not unbounded: `onLoadMore` was actually called (visible chase),
      // but stopped once the cap was hit rather than looping forever.
      expect(onLoadMore.mock.calls.length).toBeGreaterThan(0);
      expect(onLoadMore.mock.calls.length).toBeLessThanOrEqual(4);
      expect(screen.getByRole("status")).toHaveTextContent(/jumped to a commit outside the loaded range/i);
      expect(screen.getByRole("button", { name: /click to load it/i })).toBeInTheDocument();
    });

    it("clicking the affordance requests another page (AC2)", async () => {
      const rows = makeDisplayRows([makeCommit("c1", [], { subject: "Only loaded commit" })]);
      const onLoadMore = vi.fn();
      const { rerender } = render(
        <CommitGraph
          displayRows={rows}
          maxLaneIndexSeen={0}
          hasMore={true}
          isLoadingMore={false}
          onLoadMore={onLoadMore}
          visibleRefNames={new Set(["HEAD"])}
          repoState={makeRepoState({ headSha: "c1" })}
          selectedSha={null}
          onSelectCommit={() => {}}
          onSelectCheckpoint={() => {}}
          theme="dark"
          {...noopBranchHandlers}
        />,
      );

      const targetSha = "deep-branch-tip";
      for (let i = 0; i < 6; i++) {
        rerender(
          <CommitGraph
            displayRows={rows}
            maxLaneIndexSeen={0}
            hasMore={true}
            isLoadingMore={false}
            onLoadMore={onLoadMore}
            visibleRefNames={new Set(["HEAD"])}
            repoState={makeRepoState({ headSha: "c1" })}
            selectedSha={targetSha}
            onSelectCommit={() => {}}
            onSelectCheckpoint={() => {}}
            theme="dark"
            {...noopBranchHandlers}
          />,
        );
      }

      const button = screen.getByRole("button", { name: /click to load it/i });
      const callsBeforeClick = onLoadMore.mock.calls.length;
      await userEvent.click(button);
      expect(onLoadMore.mock.calls.length).toBeGreaterThan(callsBeforeClick);
    });

    it("does not change behavior for the already-loaded case — no affordance appears (AC3)", () => {
      const rows = makeDisplayRows([
        makeCommit("c2", ["c1"], { subject: "Newer" }),
        makeCommit("c1", [], { subject: "Older" }),
      ]);
      const { rerender } = render(
        <CommitGraph
          displayRows={rows}
          maxLaneIndexSeen={0}
          hasMore={false}
          isLoadingMore={false}
          onLoadMore={() => {}}
          visibleRefNames={new Set(["HEAD"])}
          repoState={makeRepoState({ headSha: "c2" })}
          selectedSha={null}
          onSelectCommit={() => {}}
          onSelectCheckpoint={() => {}}
          theme="dark"
          {...noopBranchHandlers}
        />,
      );

      rerender(
        <CommitGraph
          displayRows={rows}
          maxLaneIndexSeen={0}
          hasMore={false}
          isLoadingMore={false}
          onLoadMore={() => {}}
          visibleRefNames={new Set(["HEAD"])}
          repoState={makeRepoState({ headSha: "c2" })}
          selectedSha={"c1"}
          onSelectCommit={() => {}}
          onSelectCheckpoint={() => {}}
          theme="dark"
          {...noopBranchHandlers}
        />,
      );

      expect(screen.queryByRole("status")).not.toBeInTheDocument();
    });
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
