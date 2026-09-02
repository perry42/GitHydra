import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
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
  // specs/cherry-pick.md: every CommitGraph render now also needs these — a no-op/false default
  // here since most of these tests exercise selection/keyboard-nav behavior, not cherry-pick
  // itself (see the dedicated "cherry-pick" describe block below for that coverage).
  onCherryPick: () => {},
  cherryPickBusy: false,
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

  // specs/cherry-pick.md FR-111 through FR-115.
  describe("multi-select and cherry-pick (specs/cherry-pick.md)", () => {
    function renderThreeCommits(onCherryPick = vi.fn(), onSelectCommit = vi.fn()) {
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
          onSelectCommit={onSelectCommit}
          onSelectCheckpoint={() => {}}
          theme="dark"
          {...noopBranchHandlers}
          onCherryPick={onCherryPick}
        />,
      );
      return { onCherryPick, onSelectCommit };
    }

    it("FR-111: ctrl+click toggles a row into the multi-selection without calling onSelectCommit", async () => {
      const { onSelectCommit } = renderThreeCommits();
      fireEvent.click(screen.getByText("Third commit"), { ctrlKey: true });
      expect(onSelectCommit).not.toHaveBeenCalled();
      const row = screen.getByText("Third commit").closest('[role="option"]')!;
      expect(row).toHaveAttribute("aria-selected", "true");
      expect(row).toHaveClass("gh-commit-row--multi-selected");

      // ctrl+click again toggles it back out.
      fireEvent.click(screen.getByText("Third commit"), { ctrlKey: true });
      expect(row).toHaveAttribute("aria-selected", "false");
      expect(row).not.toHaveClass("gh-commit-row--multi-selected");
    });

    it("FR-111: shift+click selects the contiguous range between the last-clicked row and the target", async () => {
      renderThreeCommits();
      // Anchor on "Third commit" (a plain click), then shift+click "First commit" — the range
      // should cover all three rows.
      await userEvent.click(screen.getByText("Third commit"));
      fireEvent.click(screen.getByText("First commit"), { shiftKey: true });

      for (const subject of ["Third commit", "Second commit", "First commit"]) {
        const row = screen.getByText(subject).closest('[role="option"]')!;
        expect(row).toHaveClass("gh-commit-row--multi-selected");
      }
    });

    it("FR-111/AC17: a plain click after a multi-selection clears it and opens that single commit's DetailPanel exactly as before", async () => {
      const { onSelectCommit } = renderThreeCommits();
      fireEvent.click(screen.getByText("Third commit"), { ctrlKey: true });
      fireEvent.click(screen.getByText("Second commit"), { ctrlKey: true });
      expect(screen.getByText("Third commit").closest('[role="option"]')).toHaveClass(
        "gh-commit-row--multi-selected",
      );

      onSelectCommit.mockClear();
      await userEvent.click(screen.getByText("First commit"));
      expect(onSelectCommit).toHaveBeenCalledWith("c1");
      expect(screen.getByText("Third commit").closest('[role="option"]')).not.toHaveClass(
        "gh-commit-row--multi-selected",
      );
      expect(screen.getByText("Second commit").closest('[role="option"]')).not.toHaveClass(
        "gh-commit-row--multi-selected",
      );
    });

    it("FR-112/FR-114: right-clicking within a 2+ multi-selection offers 'Cherry-pick N commits', issued in graph (oldest-first) order regardless of click order", async () => {
      const { onCherryPick } = renderThreeCommits();
      // Click order: c1 (oldest) first, then c3 (newest) — graph order should still be c1, c2, c3.
      fireEvent.click(screen.getByText("First commit"), { ctrlKey: true });
      fireEvent.click(screen.getByText("Third commit"), { ctrlKey: true });
      fireEvent.click(screen.getByText("Second commit"), { ctrlKey: true });

      fireContextMenu(screen.getByText("Second commit"));
      const item = await screen.findByRole("menuitem", { name: /cherry-pick 3 commits/i });
      await userEvent.click(item);
      expect(onCherryPick).toHaveBeenCalledWith(["c1", "c2", "c3"]);
    });

    it("FR-112: right-clicking a row outside the current multi-selection collapses selection to that row first, showing the singular label", async () => {
      const { onCherryPick } = renderThreeCommits();
      fireEvent.click(screen.getByText("First commit"), { ctrlKey: true });
      fireEvent.click(screen.getByText("Second commit"), { ctrlKey: true });

      // Right-click a row NOT part of the multi-selection.
      fireContextMenu(screen.getByText("Third commit"));
      expect(screen.queryByRole("menuitem", { name: /cherry-pick \d+ commits/i })).not.toBeInTheDocument();
      const item = await screen.findByRole("menuitem", { name: /^cherry-pick$/i });
      await userEvent.click(item);
      expect(onCherryPick).toHaveBeenCalledWith(["c3"]);

      // The previous multi-selection is gone.
      expect(screen.getByText("First commit").closest('[role="option"]')).not.toHaveClass(
        "gh-commit-row--multi-selected",
      );
    });

    it("FR-113: right-clicking a single (non-multi-selected) row's enabled Cherry-pick issues that one commit", async () => {
      const { onCherryPick } = renderThreeCommits();
      fireContextMenu(screen.getByText("Second commit"));
      const item = await screen.findByRole("menuitem", { name: /^cherry-pick$/i });
      await userEvent.click(item);
      expect(onCherryPick).toHaveBeenCalledWith(["c2"]);
    });

    it("FR-115/AC9: a merge commit anywhere in the selection disables the whole action with a reason, and no git call is made if clicked regardless", async () => {
      const onCherryPick = vi.fn();
      const rows = makeDisplayRows([
        makeCommit("m1", ["p1", "p2"], { subject: "Merge commit" }),
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
          onCherryPick={onCherryPick}
        />,
      );
      fireEvent.click(screen.getByText("Merge commit"), { ctrlKey: true });
      fireEvent.click(screen.getByText("First commit"), { ctrlKey: true });
      fireContextMenu(screen.getByText("First commit"));
      const item = await screen.findByRole("menuitem", { name: /cherry-pick 2 commits/i });
      expect(item).toBeDisabled();
      expect(item).toHaveAttribute("title", expect.stringMatching(/merge commit/i));
      await userEvent.click(item);
      expect(onCherryPick).not.toHaveBeenCalled();
    });

    it("FR-115: disabled with an explicit reason when an operation is already in progress, and disabled while cherryPickBusy", async () => {
      const rows = makeDisplayRows([makeCommit("c1", [], { subject: "Only commit" })]);
      const { rerender } = render(
        <CommitGraph
          displayRows={rows}
          maxLaneIndexSeen={0}
          hasMore={false}
          isLoadingMore={false}
          onLoadMore={() => {}}
          visibleRefNames={new Set(["HEAD"])}
          repoState={makeRepoState({ inProgressOperation: "merge" })}
          selectedSha={null}
          onSelectCommit={() => {}}
          onSelectCheckpoint={() => {}}
          theme="dark"
          {...noopBranchHandlers}
        />,
      );
      fireContextMenu(screen.getByText("Only commit"));
      let item = await screen.findByRole("menuitem", { name: /^cherry-pick$/i });
      expect(item).toBeDisabled();
      expect(item).toHaveAttribute("title", expect.stringMatching(/already in progress/i));

      rerender(
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
          cherryPickBusy={true}
        />,
      );
      fireContextMenu(screen.getByText("Only commit"));
      item = await screen.findByRole("menuitem", { name: /^cherry-pick$/i });
      expect(item).toBeDisabled();
      expect(item).toHaveAttribute("title", expect.stringMatching(/already running/i));
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
