// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { CommitPairRelationship } from "@githydra/git-core";
import { CommitGraph, type CommitGraphProps } from "./CommitGraph";
import { makeCommit, makeDisplayRows, makeRepoState } from "../../test/fixtures";

/**
 * Ref-chip drag-to-merge: a local-branch chip is its own drag source and drop target; dropping chip
 * A on chip B opens a single "Merge A into B" menu. The row-level commit drag is covered in
 * `CommitGraph.dragCommitMenu.test.tsx` and must keep working when pressing on the row body.
 */
const noopHandlers = {
  onCheckoutCommit: () => {},
  onCreateBranchAt: () => {},
  onSwitchBranch: () => {},
  onDeleteBranch: () => {},
  onCherryPick: () => {},
  cherryPickBusy: false,
  onCompare: () => {},
  onResetToHere: () => {},
};

afterEach(() => {
  vi.restoreAllMocks();
  document.body.style.cursor = "";
  document.body.style.userSelect = "";
});

function renderGraph(overrides: Partial<CommitGraphProps> = {}) {
  const rows = makeDisplayRows([
    makeCommit("c3", ["c2"], {
      refs: [{ name: "feature", fullName: "refs/heads/feature", type: "local-branch" }],
    }),
    makeCommit("c2", ["c1"], {
      refs: [{ name: "main", fullName: "refs/heads/main", type: "local-branch" }],
    }),
    makeCommit("c1", [], {
      refs: [
        { name: "old", fullName: "refs/heads/old", type: "local-branch" },
        { name: "v1.0", fullName: "refs/tags/v1.0", type: "tag" },
      ],
    }),
  ]);
  const onSelectCommit = vi.fn();
  const props = {
    displayRows: rows,
    maxLaneIndexSeen: 0,
    hasMore: false,
    isLoadingMore: false,
    onLoadMore: () => {},
    visibleRefNames: new Set(["refs/heads/feature", "refs/heads/main", "refs/heads/old", "refs/tags/v1.0"]),
    repoState: makeRepoState(),
    selectedSha: null,
    followSignal: 0,
    onSelectCommit,
    onSelectCheckpoint: () => {},
    theme: "dark" as const,
    ...noopHandlers,
    onComputeCommitPairRelationship: vi.fn<(a: string, b: string) => Promise<CommitPairRelationship>>(
      async () => "diverged",
    ),
    onDragCherryPick: vi.fn(),
    onDragMerge: vi.fn(),
    onDragRebase: vi.fn(),
    dragActionBusy: false,
    ...overrides,
  };
  const utils = render(<CommitGraph {...(props as CommitGraphProps)} />);
  return { ...utils, props };
}

function chip(container: HTMLElement, branch: string): HTMLElement {
  const el = container.querySelector(`[data-ref-branch="${branch}"]`);
  if (!el) throw new Error(`no chip for ${branch}`);
  return el as HTMLElement;
}

function dragChip(container: HTMLElement, from: string, hit: Element | null) {
  const source = chip(container, from);
  document.elementFromPoint = vi.fn(() => hit);
  fireEvent.pointerDown(source, { button: 0, pointerId: 1, clientX: 0, clientY: 0 });
  fireEvent.pointerMove(window, { pointerId: 1, clientX: 20, clientY: 20 });
  fireEvent.pointerUp(window, { pointerId: 1, clientX: 20, clientY: 20 });
}

describe("CommitGraph ref-chip drag-to-merge", () => {
  it("marks local-branch chips draggable (not tags) and pressing one does not start the row drag", () => {
    const { container } = renderGraph();
    expect(chip(container, "feature")).toHaveClass("gh-refchip--draggable");
    expect(container.querySelector('[data-ref-branch="v1.0"]')).toBeNull();
    document.elementFromPoint = vi.fn(() => null);
    fireEvent.pointerDown(chip(container, "feature"), { button: 0, pointerId: 1, clientX: 0, clientY: 0 });
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 20, clientY: 20 });
    // Chip ghost (only the branch name), never the row ghost.
    expect(document.querySelector(".gh-drag-ghost--chip")).toHaveTextContent("feature");
    expect(document.querySelector(".gh-commit-row--drag-source")).not.toBeInTheDocument();
    fireEvent.pointerUp(window, { pointerId: 1, clientX: 20, clientY: 20 });
    expect(document.body.style.userSelect).toBe("");
  });

  it("dropping chip A on chip B opens a single 'Merge A into B' menu that merges into B's branch", async () => {
    const { container, props } = renderGraph();
    dragChip(container, "feature", chip(container, "main"));
    const menu = await screen.findByRole("menu");
    expect(within(menu).getAllByRole("menuitem")).toHaveLength(1);
    const item = within(menu).getByRole("menuitem", { name: "Merge feature into main" });
    await waitFor(() => expect(item).not.toBeDisabled());
    await userEvent.click(item);
    expect(props.onDragMerge).toHaveBeenCalledWith("c3", "c2", "main");
  });

  it("highlights the hovered target chip and shows not-allowed on the source chip itself", () => {
    const { container } = renderGraph();
    const source = chip(container, "feature");
    document.elementFromPoint = vi.fn(() => chip(container, "main"));
    fireEvent.pointerDown(source, { button: 0, pointerId: 1, clientX: 0, clientY: 0 });
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 20, clientY: 20 });
    expect(chip(container, "main")).toHaveClass("gh-refchip--drag-target");
    expect(source).toHaveClass("gh-refchip--drag-source");
    document.elementFromPoint = vi.fn(() => source);
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 22, clientY: 22 });
    expect(source).toHaveClass("gh-refchip--drag-reject");
    expect(document.body.style.cursor).toBe("not-allowed");
    fireEvent.pointerUp(window, { pointerId: 1, clientX: 22, clientY: 22 });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("dropping a chip on a plain row (not a chip) opens no menu", () => {
    const { container } = renderGraph();
    dragChip(container, "feature", container.querySelector('[data-commit-sha="c2"]'));
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("shows Merge disabled with 'Already up to date' when the pair is already merged", async () => {
    const { container, props } = renderGraph();
    vi.mocked(props.onComputeCommitPairRelationship).mockResolvedValue("a-ancestor-of-b");
    dragChip(container, "feature", chip(container, "main"));
    const item = await screen.findByRole("menuitem", { name: "Merge feature into main" });
    await waitFor(() => expect(item).toBeDisabled());
    expect(item).toHaveAttribute("title", "Already up to date");
  });

  it("a plain press-release on a chip still bubbles a click to select the row", () => {
    const { container, props } = renderGraph();
    const el = chip(container, "feature");
    fireEvent.pointerDown(el, { button: 0, pointerId: 1, clientX: 0, clientY: 0 });
    fireEvent.pointerUp(window, { pointerId: 1, clientX: 0, clientY: 0 });
    fireEvent.click(el);
    expect(props.onSelectCommit).toHaveBeenCalledWith("c3");
  });

  it("the row body still starts the original row drag; pressing '+N' starts none", () => {
    const { container } = renderGraph();
    document.elementFromPoint = vi.fn(() => null);
    fireEvent.pointerDown(container.querySelector('[data-commit-sha="c2"]')!, {
      button: 0,
      pointerId: 1,
      clientX: 0,
      clientY: 0,
    });
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 20, clientY: 20 });
    expect(document.querySelector(".gh-drag-ghost:not(.gh-drag-ghost--chip)")).toBeInTheDocument();
    fireEvent.pointerUp(window, { pointerId: 1, clientX: 20, clientY: 20 });

    const more = container.querySelector(".gh-commit-row__refgutter-more")!;
    fireEvent.pointerDown(more, { button: 0, pointerId: 1, clientX: 0, clientY: 0 });
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 20, clientY: 20 });
    expect(document.querySelector(".gh-drag-ghost")).not.toBeInTheDocument();
    fireEvent.pointerUp(window, { pointerId: 1, clientX: 20, clientY: 20 });
  });
});

describe("CommitGraph ref-chip drag onto a chip inside the '+N' popover", () => {
  // c1 carries `old` (visible) and `stable` (collapsed behind "+1", with the tag).
  function renderTwoOnOne() {
    const rows = makeDisplayRows([
      makeCommit("c2", ["c1"], {
        refs: [{ name: "feature", fullName: "refs/heads/feature", type: "local-branch" }],
      }),
      makeCommit("c1", [], {
        refs: [
          { name: "old", fullName: "refs/heads/old", type: "local-branch" },
          { name: "stable", fullName: "refs/heads/stable", type: "local-branch" },
        ],
      }),
    ]);
    return renderGraph({
      displayRows: rows,
      visibleRefNames: new Set(["refs/heads/feature", "refs/heads/old", "refs/heads/stable"]),
    });
  }

  it("popover rows render as real chips (not plain text) and local ones are drop targets", async () => {
    const { container } = renderTwoOnOne();
    await userEvent.click(container.querySelector(".gh-commit-row__refgutter-more")!);
    const menu = await screen.findByRole("menu");
    const chipEl = menu.querySelector(".gh-refchip");
    expect(chipEl).toBeInTheDocument();
    expect(chipEl?.querySelector("[data-ref-icon='local-branch']")).toBeInTheDocument();
    expect(menu.querySelector("[data-ref-branch]")).toHaveAttribute("data-ref-sha", "c1");
    // The whole row button is the target, not the chip nested inside it.
    expect(menu.querySelector("[data-ref-branch]")?.tagName).toBe("BUTTON");
  });

  it("hovering '+N' while dragging a chip auto-opens the popover; dropping on the collapsed branch offers Merge, disabled 'Already up to date' when it is on the same commit", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const { container, props } = renderTwoOnOne();
      vi.mocked(props.onComputeCommitPairRelationship).mockResolvedValue("a-ancestor-of-b");
      const more = container.querySelector(".gh-commit-row__refgutter-more")!;
      const oldChip = chip(container, "old");
      document.elementFromPoint = vi.fn(() => more);
      fireEvent.pointerDown(oldChip, { button: 0, pointerId: 1, clientX: 0, clientY: 0 });
      fireEvent.pointerMove(window, { pointerId: 1, clientX: 20, clientY: 20 });
      expect(screen.queryByRole("menu")).not.toBeInTheDocument();
      await act(async () => {
        vi.advanceTimersByTime(450);
      });
      const popoverChip = (await screen.findByRole("menu")).querySelector<HTMLElement>('[data-ref-branch="stable"]')!;
      document.elementFromPoint = vi.fn(() => popoverChip);
      fireEvent.pointerMove(window, { pointerId: 1, clientX: 30, clientY: 40 });
      expect(popoverChip).toHaveClass("gh-context-menu__item--drop-active");
      fireEvent.pointerUp(window, { pointerId: 1, clientX: 30, clientY: 40 });
      const item = await screen.findByRole("menuitem", { name: "Merge old into stable" });
      await waitFor(() => expect(item).toBeDisabled());
      expect(item).toHaveAttribute("title", "Already up to date");
      // The auto-opened popover is gone; only the drop menu remains.
      expect(screen.getAllByRole("menu")).toHaveLength(1);
      // Same commit: no git read is needed.
      expect(props.onComputeCommitPairRelationship).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("a descendant dropped on a collapsed ancestor branch offers an ENABLED fast-forward 'Merge feature into stable' (never 'Already up to date'); popover rows are aria-disabled, not disabled", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const { container, props } = renderTwoOnOne();
      // feature (c2, dragged = A) descends from stable (c1, target = B): B is an ancestor of A.
      vi.mocked(props.onComputeCommitPairRelationship).mockResolvedValue("b-ancestor-of-a");
      const more = container.querySelector(".gh-commit-row__refgutter-more")!;
      document.elementFromPoint = vi.fn(() => more);
      fireEvent.pointerDown(chip(container, "feature"), { button: 0, pointerId: 1, clientX: 0, clientY: 0 });
      fireEvent.pointerMove(window, { pointerId: 1, clientX: 20, clientY: 20 });
      await act(async () => {
        vi.advanceTimersByTime(450);
      });
      const menu = await screen.findByRole("menu");
      const row = within(menu).getByRole("menuitem", { name: /stable/ });
      expect(row).not.toBeDisabled();
      expect(row).toHaveAttribute("aria-disabled", "true");
      const popoverChip = menu.querySelector<HTMLElement>('[data-ref-branch="stable"]')!;
      document.elementFromPoint = vi.fn(() => popoverChip);
      fireEvent.pointerMove(window, { pointerId: 1, clientX: 30, clientY: 40 });
      fireEvent.pointerUp(window, { pointerId: 1, clientX: 30, clientY: 40 });
      const item = await screen.findByRole("menuitem", { name: "Merge feature into stable" });
      await waitFor(() => expect(item).not.toBeDisabled());
      await userEvent.click(item);
      expect(props.onDragMerge).toHaveBeenCalledWith("c2", "c1", "stable");
    } finally {
      vi.useRealTimers();
    }
  });
});
