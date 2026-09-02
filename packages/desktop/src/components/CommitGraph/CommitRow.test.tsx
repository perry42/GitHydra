import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { CommitRow } from "./CommitRow";
import { REF_GUTTER_WIDTH } from "./graphGeometry";
import { makeCommit, makeRepoState } from "../../test/fixtures";
import { LaneAssigner } from "../../lib/laneAssignment";

const GRAPH_WIDTH = 50;

/** A commit row carrying no refs, laid out through the real `LaneAssigner` (matching how
 * `CommitGraph` actually produces rows) rather than hand-rolling a `LaidOutRow` shape. */
function defaultRow() {
  return rowWithRefs([]);
}

/** Builds a row for a commit carrying the given ref decorations. */
function rowWithRefs(refs: import("@githydra/git-core").RefDecoration[]) {
  const commit = makeCommit("c1", [], { subject: "A commit", refs });
  const laid = new LaneAssigner().next(commit);
  return { kind: "commit" as const, laid };
}

function renderCommitRow(overrides: Partial<Parameters<typeof CommitRow>[0]> = {}) {
  const defaultProps = {
    id: "row-0",
    row: defaultRow(),
    graphWidth: GRAPH_WIDTH,
    visibleRefNames: new Set<string>(["HEAD"]),
    repoState: makeRepoState(),
    isSelected: false,
    isActive: false,
    isCurrent: false,
    isMultiSelected: false,
    style: {},
    onSelect: vi.fn(),
    onSelectCheckpoint: vi.fn(),
    onContextMenu: vi.fn(),
  };
  return render(<CommitRow {...defaultProps} {...overrides} />);
}

describe("CommitRow — branch/tag gutter (DESIGN.md 'Ref chip' gutter revision)", () => {
  it("reserves the gutter column on a commit with no refs — present as empty space, not a placeholder element", () => {
    const { container } = renderCommitRow();
    const gutter = container.querySelector(".gh-commit-row__refgutter");
    expect(gutter).not.toBeNull();
    expect((gutter as HTMLElement).style.width).toBe(`${REF_GUTTER_WIDTH}px`);
    // Empty means genuinely no child content, not a hidden/dummy element standing in for one.
    expect(gutter!.children.length).toBe(0);
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });

  it("renders the gutter for the uncommitted-changes pseudo-row too, at the same reserved width, so subject columns stay aligned", () => {
    const { container } = render(
      <CommitRow
        id="row-0"
        row={{
          kind: "uncommitted",
          lane: 0,
          colorSlot: 0,
          connectsDown: false,
          status: { hasChanges: true, staged: 0, unstaged: 1, untracked: 0, conflicted: 0 },
        }}
        graphWidth={GRAPH_WIDTH}
        visibleRefNames={new Set()}
        repoState={makeRepoState()}
        isSelected={false}
        isActive={false}
        isCurrent={false}
        isMultiSelected={false}
        style={{}}
        onSelect={vi.fn()}
        onSelectCheckpoint={vi.fn()}
        onContextMenu={vi.fn()}
      />,
    );
    const gutter = container.querySelector(".gh-commit-row__refgutter");
    expect(gutter).not.toBeNull();
    expect((gutter as HTMLElement).style.width).toBe(`${REF_GUTTER_WIDTH}px`);
    const row = container.querySelector(".gh-commit-row")!;
    expect((row as HTMLElement).style.paddingLeft).toBe(`${REF_GUTTER_WIDTH + GRAPH_WIDTH}px`);
  });

  it("puts a commit's ref chips inside the gutter column, and the row's content offset accounts for both the gutter and the graph width", () => {
    const row = rowWithRefs([{ name: "feature-x", fullName: "refs/heads/feature-x", type: "local-branch" }]);
    const { container } = renderCommitRow({
      row,
      visibleRefNames: new Set(["refs/heads/feature-x"]),
    });
    const gutter = container.querySelector(".gh-commit-row__refgutter")!;
    expect(within(gutter as HTMLElement).getByRole("img", { name: /local branch: feature-x/i })).toBeInTheDocument();
    const rowEl = container.querySelector(".gh-commit-row")!;
    expect((rowEl as HTMLElement).style.paddingLeft).toBe(`${REF_GUTTER_WIDTH + GRAPH_WIDTH}px`);
  });

  it("renders multiple chips on one row inside the same gutter column, each still individually identifiable", () => {
    const row = rowWithRefs([
      { name: "feature-x", fullName: "refs/heads/feature-x", type: "local-branch" },
      { name: "v1.0", fullName: "refs/tags/v1.0", type: "tag" },
    ]);
    const { container } = renderCommitRow({
      row,
      visibleRefNames: new Set(["refs/heads/feature-x", "refs/tags/v1.0"]),
    });
    const gutter = container.querySelector(".gh-commit-row__refgutter")!;
    expect(within(gutter as HTMLElement).getByRole("img", { name: /local branch: feature-x/i })).toBeInTheDocument();
    expect(within(gutter as HTMLElement).getByRole("img", { name: /tag: v1\.0/i })).toBeInTheDocument();
  });

  it("keeps the full long branch name accessible (title/aria-label) even though the column truncates visually", () => {
    const longName = "feature/merge-rebase-conflict-resolution";
    const row = rowWithRefs([{ name: longName, fullName: `refs/heads/${longName}`, type: "local-branch" }]);
    const { container } = renderCommitRow({
      row,
      visibleRefNames: new Set([`refs/heads/${longName}`]),
    });
    const gutter = container.querySelector(".gh-commit-row__refgutter")!;
    const chip = within(gutter as HTMLElement).getByRole("img", { name: new RegExp(longName) });
    expect(chip).toHaveAttribute("title", expect.stringContaining(longName));
  });

  it("never renders a colored inline style on a ref chip — color stays on the graph's lanes only", () => {
    const row = rowWithRefs([{ name: "main", fullName: "refs/heads/main", type: "local-branch" }]);
    const { container } = renderCommitRow({
      row,
      visibleRefNames: new Set(["refs/heads/main"]),
      repoState: makeRepoState({ currentBranch: "main" }),
    });
    const gutter = container.querySelector(".gh-commit-row__refgutter")!;
    const chip = within(gutter as HTMLElement).getByRole("img", { name: /local branch: main/i });
    expect(chip.getAttribute("style")).toBeNull();
  });

  it("marks the attached-HEAD row's synthetic HEAD marker inside the gutter too (FR-17 shown at all times)", () => {
    const row = rowWithRefs([]);
    const { container } = renderCommitRow({ row, isCurrent: true });
    const gutter = container.querySelector(".gh-commit-row__refgutter")!;
    expect(within(gutter as HTMLElement).getByRole("img", { name: /^HEAD: HEAD$/i })).toBeInTheDocument();
  });

  it("FR-55: right-clicking a local-branch chip still opens the ref-chip menu (not the row's own commit menu) after the gutter move", () => {
    const row = rowWithRefs([{ name: "feature-x", fullName: "refs/heads/feature-x", type: "local-branch" }]);
    const onRefChipContextMenu = vi.fn();
    const onContextMenu = vi.fn();
    renderCommitRow({
      row,
      visibleRefNames: new Set(["refs/heads/feature-x"]),
      onRefChipContextMenu,
      onContextMenu,
    });
    const chip = screen.getByRole("img", { name: /local branch: feature-x/i });
    chip.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    expect(onRefChipContextMenu).toHaveBeenCalledWith(expect.anything(), "feature-x");
    expect(onContextMenu).not.toHaveBeenCalled();
  });
});
