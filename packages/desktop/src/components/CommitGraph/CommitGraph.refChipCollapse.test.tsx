// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CommitGraph, type CommitGraphProps } from "./CommitGraph";
import { makeCommit, makeDisplayRows, makeRepoState } from "../../test/fixtures";

/**
 * specs/ref-chip-gutter-legibility.md FR-410/FR-411: the "+N" collapse affix's own reused
 * `ContextMenu` instance, owned by `CommitGraph` (the same lift-up pattern `refChipMenu`/
 * `contextMenu`/`dropMenu` already established — see CommitGraph.tsx's own doc comments).
 * `CommitRow.test.tsx` already covers the collapse decision itself (which chip stays visible,
 * which collapse) at the row level; this file's job is the popover wiring the row can't reach on
 * its own: does clicking "+N" actually open a real `ContextMenu` with the right rows, and does it
 * inherit that component's viewport-clamping/dismissal behavior.
 */
const noopBranchHandlers = {
  onCheckoutCommit: () => {},
  onCreateBranchAt: () => {},
  onSwitchBranch: () => {},
  onDeleteBranch: () => {},
  onCherryPick: () => {},
  cherryPickBusy: false,
  onCompare: () => {},
  onResetToHere: () => {},
};

function renderGraph(overrides: Partial<CommitGraphProps> = {}) {
  const rows = makeDisplayRows([
    makeCommit("c3", ["c2"], {
      subject: "Third commit",
      refs: [
        { name: "alpha", fullName: "refs/heads/alpha", type: "local-branch" },
        { name: "beta", fullName: "refs/heads/beta", type: "local-branch" },
        { name: "v1.0", fullName: "refs/tags/v1.0", type: "tag" },
      ],
    }),
    makeCommit("c2", ["c1"], { subject: "Second commit" }),
    makeCommit("c1", [], { subject: "First commit" }),
  ]);
  const props: CommitGraphProps = {
    displayRows: rows,
    maxLaneIndexSeen: 0,
    hasMore: false,
    isLoadingMore: false,
    onLoadMore: () => {},
    visibleRefNames: new Set(["refs/heads/alpha", "refs/heads/beta", "refs/tags/v1.0"]),
    repoState: makeRepoState(),
    selectedSha: null,
    followSignal: 0,
    onSelectCommit: () => {},
    onSelectCheckpoint: () => {},
    theme: "dark",
    ...noopBranchHandlers,
    ...overrides,
  };
  return render(<CommitGraph {...props} />);
}

function thirdCommitRow(container: HTMLElement): HTMLElement {
  return container.querySelector('[data-commit-sha="c3"]') as HTMLElement;
}

describe("CommitGraph — ref-chip collapse popover (specs/ref-chip-gutter-legibility.md FR-410/411)", () => {
  it("AC5/AC6: clicking +N opens a ContextMenu listing every collapsed ref's full, untruncated accessible label as an inert row", async () => {
    const { container } = renderGraph();
    const row = thirdCommitRow(container);
    const moreButton = within(row).getByRole("button", { name: /2 more refs on this commit/i });

    await userEvent.click(moreButton);

    const menu = await screen.findByRole("menu", { name: /more refs on this commit/i });
    expect(menu).toHaveClass("gh-context-menu");
    const items = within(menu).getAllByRole("menuitem");
    expect(items).toHaveLength(2);
    // Same order as `chips` (alpha is the visible chip since it's chips[0] here — none filled,
    // none detached-HEAD): beta, then v1.0, are what collapsed.
    expect(items.map((i) => i.textContent)).toEqual(["local branch: beta", "tag: v1.0"]);
    for (const item of items) {
      expect(item).toBeDisabled();
    }

    // AC6: every row is genuinely inert — a disabled <button> never dispatches a real click event
    // at all (browsers/jsdom both suppress it), so the popover doesn't even close, let alone
    // trigger a checkout/navigation/any other side effect.
    fireEvent.click(items[0]!);
    expect(screen.getByRole("menu")).toBeInTheDocument();
  });

  it("AC5: Escape closes the popover without side effects", async () => {
    const { container } = renderGraph();
    const row = thirdCommitRow(container);
    await userEvent.click(within(row).getByRole("button", { name: /more refs on this commit/i }));
    await screen.findByRole("menu");

    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("AC5: an outside click closes the popover", async () => {
    const { container } = renderGraph();
    const row = thirdCommitRow(container);
    await userEvent.click(within(row).getByRole("button", { name: /more refs on this commit/i }));
    await screen.findByRole("menu");

    await userEvent.click(document.body);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("AC5: scrolling the commit graph closes the popover (inherited ContextMenu behavior)", async () => {
    const { container } = renderGraph();
    const row = thirdCommitRow(container);
    await userEvent.click(within(row).getByRole("button", { name: /more refs on this commit/i }));
    await screen.findByRole("menu");

    const scroller = screen.getByRole("listbox", { name: /commit graph/i });
    fireEvent.scroll(scroller);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("reports the popover as an open context menu via onContextMenuOpenChange, same fold-in as the other three ContextMenu instances", async () => {
    const onContextMenuOpenChange = vi.fn();
    const { container } = renderGraph({ onContextMenuOpenChange });
    onContextMenuOpenChange.mockClear();
    const row = thirdCommitRow(container);
    await userEvent.click(within(row).getByRole("button", { name: /more refs on this commit/i }));
    expect(onContextMenuOpenChange).toHaveBeenLastCalledWith(true);

    await userEvent.keyboard("{Escape}");
    expect(onContextMenuOpenChange).toHaveBeenLastCalledWith(false);
  });
});
