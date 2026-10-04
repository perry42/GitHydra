// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CommitRow } from "./CommitRow";
import { REF_GUTTER_WIDTH } from "./graphGeometry";
import { makeCommit, makeRepoState } from "../../test/fixtures";
import { LaneAssigner } from "../../lib/laneAssignment";
import type { RefChipSpec } from "../../lib/refChips";

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
          headRowIndex: null,
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

  // specs/ref-chip-gutter-legibility.md FR-408 superseded this test's original assumption (both
  // chips rendered inline, squeezing each other's names into illegible fragments) — 2+ chips on
  // one row now collapse behind a "+N" affix instead (see the dedicated "ref-chip gutter collapse"
  // describe block below for that feature's own full coverage). This test now just confirms a
  // multi-chip row still surfaces BOTH refs somewhere accessible: one rendered chip, one inside the
  // affix's own accessible name/collapsed-chip count.
  it("a multi-chip row keeps every ref identifiable — one rendered chip, the rest reflected in the +N affix", () => {
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
    expect(
      within(gutter as HTMLElement).getByRole("button", { name: "1 more refs on this commit — view all" }),
    ).toBeInTheDocument();
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

  // specs/ref-chip-gutter-redesign.md Addendum (FR-417): every real commit row's chip gets this
  // row's own `laid.colorSlot`, tinting its background with that same lane color — superseding the
  // prior "chip carries no color at all" assertion this test used to make.
  it("threads this row's own laid.colorSlot into every ref chip, tinting the background with that lane's color", () => {
    const row = rowWithRefs([{ name: "main", fullName: "refs/heads/main", type: "local-branch" }]);
    const { container } = renderCommitRow({
      row,
      visibleRefNames: new Set(["refs/heads/main"]),
      repoState: makeRepoState({ currentBranch: "main" }),
    });
    const gutter = container.querySelector(".gh-commit-row__refgutter")!;
    const chip = within(gutter as HTMLElement).getByRole("img", { name: /local branch: main/i });
    expect(chip.className).toContain("gh-refchip--tinted");
    const style = chip.getAttribute("style") ?? "";
    expect(style).toContain("color-mix(in srgb");
    // This fixture's single-commit row lays out on lane 0 -> colorSlot 0 -> --gh-lane-1 (the
    // codebase-wide 0-indexed-slot -> 1-indexed-token mapping `laneColorVar`/`laneColorHex` use).
    expect(style).toContain("--gh-lane-1");
    // The text/icon ink itself is still never set inline — only the background is per-row-dynamic.
    expect(style).not.toMatch(/(^|;)\s*color:/);
  });

  // The synthetic HEAD marker (`showHeadMarker`) is a different `<RefChip>` instance than the real
  // ref chips above, rendered separately in CommitRow.tsx — this pins that it ALSO gets the row's
  // own colorSlot, not just the real chips.
  it("also threads laid.colorSlot into the synthetic HEAD marker badge", () => {
    const row = rowWithRefs([]);
    const { container } = renderCommitRow({ row, isCurrent: true });
    const gutter = container.querySelector(".gh-commit-row__refgutter")!;
    const headBadge = within(gutter as HTMLElement).getByRole("img", { name: /^HEAD: HEAD$/i });
    expect(headBadge.className).toContain("gh-refchip--tinted");
    expect(headBadge.getAttribute("style") ?? "").toContain("color-mix(in srgb");
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

// specs/drag-commit-menu.md FR-301/302: the per-row drag-state plumbing `CommitGraph`'s pointer
// handler relies on — `CommitGraph.dragCommitMenu.test.tsx` covers the actual drag gesture
// end-to-end; this file covers the row's own presentational contract in isolation.
describe("CommitRow — drag-commit-menu plumbing (specs/drag-commit-menu.md)", () => {
  it("carries data-commit-sha so CommitGraph's pointermove hit-test can resolve this row as a drop target", () => {
    const { container } = renderCommitRow();
    expect(container.querySelector(".gh-commit-row")).toHaveAttribute("data-commit-sha", "c1");
  });

  it("forwards a primary-button pointerdown to onDragPointerDown with this row's sha", () => {
    const onDragPointerDown = vi.fn();
    const { container } = renderCommitRow({ onDragPointerDown });
    const row = container.querySelector(".gh-commit-row")!;
    row.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerId: 1 }));
    expect(onDragPointerDown).toHaveBeenCalledWith(expect.anything(), "c1");
  });

  it("dims the row while it's the drag source", () => {
    const { container } = renderCommitRow({ isDragSource: true });
    expect(container.querySelector(".gh-commit-row")).toHaveClass("gh-commit-row--drag-source");
  });

  it('shows the accent drop-target highlight for "valid", never the reject highlight', () => {
    const { container } = renderCommitRow({ dragHoverState: "valid" });
    const row = container.querySelector(".gh-commit-row")!;
    expect(row).toHaveClass("gh-commit-row--drag-over");
    expect(row).not.toHaveClass("gh-commit-row--drag-reject");
  });

  it('FR-302: shows the critical-toned reject highlight for "reject", never the ordinary drop-target one', () => {
    const { container } = renderCommitRow({ dragHoverState: "reject" });
    const row = container.querySelector(".gh-commit-row")!;
    expect(row).toHaveClass("gh-commit-row--drag-reject");
    expect(row).not.toHaveClass("gh-commit-row--drag-over");
  });

  it('applies neither drag highlight class by default ("none")', () => {
    const { container } = renderCommitRow();
    const row = container.querySelector(".gh-commit-row")!;
    expect(row).not.toHaveClass("gh-commit-row--drag-over");
    expect(row).not.toHaveClass("gh-commit-row--drag-reject");
    expect(row).not.toHaveClass("gh-commit-row--drag-source");
  });
});

// specs/ref-chip-gutter-legibility.md FR-407-FR-411: 2+ real ref chips on one row collapse behind
// a "+N" affix instead of squeezing each other into illegible fragments.
describe("CommitRow — ref-chip gutter collapse (specs/ref-chip-gutter-legibility.md)", () => {
  it("AC1: a row with exactly one ref chip never shows a +N affix — the chip renders in full, unchanged", () => {
    const row = rowWithRefs([{ name: "feature-x", fullName: "refs/heads/feature-x", type: "local-branch" }]);
    const { container } = renderCommitRow({ row, visibleRefNames: new Set(["refs/heads/feature-x"]) });
    const gutter = container.querySelector(".gh-commit-row__refgutter")!;
    expect(within(gutter as HTMLElement).getByRole("img", { name: /local branch: feature-x/i })).toBeInTheDocument();
    expect(within(gutter as HTMLElement).queryByRole("button")).not.toBeInTheDocument();
  });

  it("AC2/FR-408/FR-409 priority 3: two chips, neither checked out, show chips[0] in full plus a +1 button — the other chip's name is not rendered inline anywhere", () => {
    const row = rowWithRefs([
      { name: "alpha", fullName: "refs/heads/alpha", type: "local-branch" },
      { name: "beta", fullName: "refs/heads/beta", type: "local-branch" },
    ]);
    const { container } = renderCommitRow({
      row,
      visibleRefNames: new Set(["refs/heads/alpha", "refs/heads/beta"]),
    });
    const gutter = container.querySelector(".gh-commit-row__refgutter")!;
    expect(within(gutter as HTMLElement).getByRole("img", { name: /local branch: alpha/i })).toBeInTheDocument();
    expect(within(gutter as HTMLElement).queryByRole("img", { name: /local branch: beta/i })).not.toBeInTheDocument();
    const moreButton = within(gutter as HTMLElement).getByRole("button", {
      name: "1 more refs on this commit — view all",
    });
    expect(moreButton).toHaveTextContent("+1");
    expect(moreButton).toHaveAttribute("type", "button");
  });

  it("AC3/FR-407/FR-409 priority 1: on the checked-out commit's row, the HEAD badge stays uncollapsed and the current branch's own chip (not the other ref) is the one visible", () => {
    // Mirrors real `git log --decorate`'s shape for a checked-out branch tip: an explicit "HEAD"
    // decoration alongside the branch's own — `buildRefChips`'s `hasHeadHere`/`filled` computation
    // (refChips.ts) depends on that explicit head decoration being present, exactly like the real
    // for-each-ref-backed data `App.branchTagGutter.e2e.test.tsx` exercises end-to-end.
    const row = rowWithRefs([
      { name: "HEAD", fullName: null, type: "head" },
      { name: "main", fullName: "refs/heads/main", type: "local-branch" },
      { name: "v1.0", fullName: "refs/tags/v1.0", type: "tag" },
    ]);
    const { container } = renderCommitRow({
      row,
      visibleRefNames: new Set(["HEAD", "refs/heads/main", "refs/tags/v1.0"]),
      repoState: makeRepoState({ currentBranch: "main" }),
      isCurrent: true,
    });
    const gutter = container.querySelector(".gh-commit-row__refgutter")!;
    // The always-on synthetic HEAD badge (`showHeadMarker`) stays visible, entirely uncollapsed.
    const headBadge = within(gutter as HTMLElement).getByRole("img", { name: /^HEAD: HEAD$/i });
    expect(headBadge).toBeInTheDocument();
    // Follow-up to specs/ref-chip-gutter-legibility.md: this row also has a real ref collapsing
    // behind "+N" — the exact crowded case that squeezed both this badge's and the branch chip's
    // text down to one illegible character in a real screenshot. The badge now drops its own
    // visible "HEAD" text (icon-only) so the branch chip gets the width instead; the accessible
    // name above is unaffected.
    expect(headBadge.className).toContain("gh-refchip--icon-only");
    expect(headBadge.querySelector(".gh-refchip__label")).not.toBeInTheDocument();
    // The current branch's own chip — not the tag — is the one visible chip, and stays filled,
    // with its label text still rendered in full (not icon-only).
    const mainChip = within(gutter as HTMLElement).getByRole("img", { name: /local branch: main/i });
    expect(mainChip.className).toContain("gh-refchip--filled");
    expect(mainChip.className).not.toContain("gh-refchip--icon-only");
    expect(mainChip.querySelector(".gh-refchip__label")).toHaveTextContent("main");
    expect(within(gutter as HTMLElement).queryByRole("img", { name: /tag: v1\.0/i })).not.toBeInTheDocument();
    expect(
      within(gutter as HTMLElement).getByRole("button", { name: /1 more refs on this commit/i }),
    ).toBeInTheDocument();
  });

  it("AC4/FR-407/FR-408: a real ref chip plus the synthetic HEAD marker (chips.length === 1) never triggers collapse", () => {
    const row = rowWithRefs([{ name: "main", fullName: "refs/heads/main", type: "local-branch" }]);
    const { container } = renderCommitRow({
      row,
      visibleRefNames: new Set(["refs/heads/main"]),
      repoState: makeRepoState({ currentBranch: "main" }),
      isCurrent: true,
    });
    const gutter = container.querySelector(".gh-commit-row__refgutter")!;
    expect(within(gutter as HTMLElement).queryByRole("button")).not.toBeInTheDocument();
    const headBadge = within(gutter as HTMLElement).getByRole("img", { name: /^HEAD: HEAD$/i });
    expect(headBadge).toBeInTheDocument();
    // The plain (uncrowded) case is untouched — the badge still shows its "HEAD" text in full.
    expect(headBadge.className).not.toContain("gh-refchip--icon-only");
    expect(headBadge.querySelector(".gh-refchip__label")).toHaveTextContent("HEAD");
    expect(within(gutter as HTMLElement).getByRole("img", { name: /local branch: main/i })).toBeInTheDocument();
  });

  it("FR-409 priority 2: a detached-HEAD chip is preferred over chips[0] when no chip is filled", () => {
    const row = rowWithRefs([
      { name: "HEAD", fullName: null, type: "head" },
      { name: "v1.0", fullName: "refs/tags/v1.0", type: "tag" },
    ]);
    const { container } = renderCommitRow({
      row,
      visibleRefNames: new Set(["HEAD", "refs/tags/v1.0"]),
      repoState: makeRepoState({ isDetachedHead: true }),
    });
    const gutter = container.querySelector(".gh-commit-row__refgutter")!;
    expect(within(gutter as HTMLElement).getByRole("img", { name: /HEAD \(detached\)/i })).toBeInTheDocument();
    expect(within(gutter as HTMLElement).queryByRole("img", { name: /tag: v1\.0/i })).not.toBeInTheDocument();
  });

  it("FR-409 priority 3: falls back to chips[0] (existing array order) when neither a filled chip nor a detached-HEAD chip exists", () => {
    const row = rowWithRefs([
      { name: "origin/release", fullName: "refs/remotes/origin/release", type: "remote-branch" },
      { name: "v2.0", fullName: "refs/tags/v2.0", type: "tag" },
    ]);
    const { container } = renderCommitRow({
      row,
      visibleRefNames: new Set(["refs/remotes/origin/release", "refs/tags/v2.0"]),
    });
    const gutter = container.querySelector(".gh-commit-row__refgutter")!;
    expect(
      within(gutter as HTMLElement).getByRole("img", { name: /remote branch: origin\/release/i }),
    ).toBeInTheDocument();
    expect(within(gutter as HTMLElement).queryByRole("img", { name: /tag: v2\.0/i })).not.toBeInTheDocument();
  });

  it("AC7/FR-412: the one visible chip still ellipsizes + carries its own title tooltip when its name alone exceeds the gutter", () => {
    const longName = "feature/merge-rebase-conflict-resolution";
    const row = rowWithRefs([
      { name: longName, fullName: `refs/heads/${longName}`, type: "local-branch" },
      { name: "v1.0", fullName: "refs/tags/v1.0", type: "tag" },
    ]);
    const { container } = renderCommitRow({
      row,
      visibleRefNames: new Set([`refs/heads/${longName}`, "refs/tags/v1.0"]),
    });
    const gutter = container.querySelector(".gh-commit-row__refgutter")!;
    const chip = within(gutter as HTMLElement).getByRole("img", { name: new RegExp(longName.replace(/\//g, "\\/")) });
    expect(chip).toHaveAttribute("title", expect.stringContaining(longName));
  });

  it("FR-410/411: clicking the +N affix forwards the button's own anchor point plus the collapsed chips, in chips' own order", () => {
    const row = rowWithRefs([
      { name: "alpha", fullName: "refs/heads/alpha", type: "local-branch" },
      { name: "beta", fullName: "refs/heads/beta", type: "local-branch" },
      { name: "v1.0", fullName: "refs/tags/v1.0", type: "tag" },
    ]);
    const onRefChipsMoreClick = vi.fn();
    renderCommitRow({
      row,
      visibleRefNames: new Set(["refs/heads/alpha", "refs/heads/beta", "refs/tags/v1.0"]),
      onRefChipsMoreClick,
    });
    const moreButton = screen.getByRole("button", { name: /2 more refs on this commit/i });
    fireEvent.click(moreButton);

    expect(onRefChipsMoreClick).toHaveBeenCalledTimes(1);
    const [x, y, collapsed] = onRefChipsMoreClick.mock.calls[0] as [number, number, RefChipSpec[]];
    expect(typeof x).toBe("number");
    expect(typeof y).toBe("number");
    expect(collapsed.map((c) => c.decoration.name)).toEqual(["beta", "v1.0"]);
  });

  it("the +N affix click does not also select the row (stopPropagation, mirroring the ref-chip context-menu handler)", () => {
    const row = rowWithRefs([
      { name: "alpha", fullName: "refs/heads/alpha", type: "local-branch" },
      { name: "beta", fullName: "refs/heads/beta", type: "local-branch" },
    ]);
    const onSelect = vi.fn();
    const onRefChipsMoreClick = vi.fn();
    renderCommitRow({
      row,
      visibleRefNames: new Set(["refs/heads/alpha", "refs/heads/beta"]),
      onSelect,
      onRefChipsMoreClick,
    });
    fireEvent.click(screen.getByRole("button", { name: /1 more refs on this commit/i }));
    expect(onRefChipsMoreClick).toHaveBeenCalledTimes(1);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("AC10: the +N affix is a real, keyboard-focusable/operable <button> — Tab reaches it and Enter activates it", async () => {
    const user = userEvent.setup();
    const row = rowWithRefs([
      { name: "alpha", fullName: "refs/heads/alpha", type: "local-branch" },
      { name: "beta", fullName: "refs/heads/beta", type: "local-branch" },
    ]);
    const onRefChipsMoreClick = vi.fn();
    renderCommitRow({
      row,
      visibleRefNames: new Set(["refs/heads/alpha", "refs/heads/beta"]),
      onRefChipsMoreClick,
    });
    const moreButton = screen.getByRole("button", { name: /1 more refs on this commit/i });
    await user.tab();
    expect(moreButton).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(onRefChipsMoreClick).toHaveBeenCalledTimes(1);
  });
});

// specs/ref-chip-synced-upstream-merge.md: end-to-end wiring from CommitRow's own
// `syncedUpstreamByBranch` prop through `buildRefChips` into a single merged chip — the unit-level
// merge logic is already covered by refChips.test.ts; this file's job is confirming CommitRow
// actually threads the prop through, same division of labor as the collapse-decision tests above.
describe("CommitRow — synced-upstream merge (specs/ref-chip-synced-upstream-merge.md)", () => {
  it("renders a local branch + its exactly-synced upstream as ONE chip, not two, and never triggers +N collapse for the pair alone", () => {
    const row = rowWithRefs([
      { name: "main", fullName: "refs/heads/main", type: "local-branch" },
      { name: "origin/main", fullName: "refs/remotes/origin/main", type: "remote-branch" },
    ]);
    const { container } = renderCommitRow({
      row,
      visibleRefNames: new Set(["refs/heads/main", "refs/remotes/origin/main"]),
      syncedUpstreamByBranch: new Map([["main", "origin/main"]]),
    });
    const gutter = container.querySelector(".gh-commit-row__refgutter")!;
    expect(within(gutter as HTMLElement).queryByRole("button")).not.toBeInTheDocument();
    const chip = within(gutter as HTMLElement).getByRole("img", {
      name: "local branch: main (synced with origin/main)",
    });
    expect(chip.className).toContain("gh-refchip--synced-upstream");
  });

  it("without syncedUpstreamByBranch, the same pair renders as two ordinary chips (pre-existing behavior unchanged)", () => {
    const row = rowWithRefs([
      { name: "main", fullName: "refs/heads/main", type: "local-branch" },
      { name: "origin/main", fullName: "refs/remotes/origin/main", type: "remote-branch" },
    ]);
    const { container } = renderCommitRow({
      row,
      visibleRefNames: new Set(["refs/heads/main", "refs/remotes/origin/main"]),
    });
    const gutter = container.querySelector(".gh-commit-row__refgutter")!;
    expect(
      within(gutter as HTMLElement).getByRole("img", { name: "local branch: main" }),
    ).toBeInTheDocument();
    expect(within(gutter as HTMLElement).getByRole("button", { name: /1 more refs/i })).toBeInTheDocument();
  });

  // Follow-up found via a real screenshot: the merged chip's second icon widens it enough that even
  // the simplest checked-out-row case (HEAD badge + one merged chip, no "+N" at all) squeezed both
  // down to illegible fragments — same class of bug as the original HEAD-badge crowding fix, just a
  // new trigger for it.
  it("the synthetic HEAD badge goes icon-only when its row's one chip is a merged synced-upstream pair, even with no +N present", () => {
    const row = rowWithRefs([
      { name: "HEAD", fullName: null, type: "head" },
      { name: "main", fullName: "refs/heads/main", type: "local-branch" },
      { name: "origin/main", fullName: "refs/remotes/origin/main", type: "remote-branch" },
    ]);
    const { container } = renderCommitRow({
      row,
      visibleRefNames: new Set(["HEAD", "refs/heads/main", "refs/remotes/origin/main"]),
      repoState: makeRepoState({ currentBranch: "main" }),
      isCurrent: true,
      syncedUpstreamByBranch: new Map([["main", "origin/main"]]),
    });
    const gutter = container.querySelector(".gh-commit-row__refgutter")!;
    // Still just one merged chip, no "+N" — the widening is real even without collapse.
    expect(within(gutter as HTMLElement).queryByRole("button")).not.toBeInTheDocument();
    const headBadge = within(gutter as HTMLElement).getByRole("img", { name: /^HEAD: HEAD$/i });
    expect(headBadge.className).toContain("gh-refchip--icon-only");
    expect(headBadge.querySelector(".gh-refchip__label")).not.toBeInTheDocument();
    const mergedChip = within(gutter as HTMLElement).getByRole("img", {
      name: "local branch: main (synced with origin/main)",
    });
    expect(mergedChip.className).toContain("gh-refchip--synced-upstream");
  });

  it("the HEAD badge keeps its full text when the row's one chip is an ORDINARY (non-merged) chip — the widening trigger doesn't over-fire", () => {
    const row = rowWithRefs([{ name: "main", fullName: "refs/heads/main", type: "local-branch" }]);
    const { container } = renderCommitRow({
      row,
      visibleRefNames: new Set(["refs/heads/main"]),
      repoState: makeRepoState({ currentBranch: "main" }),
      isCurrent: true,
    });
    const gutter = container.querySelector(".gh-commit-row__refgutter")!;
    const headBadge = within(gutter as HTMLElement).getByRole("img", { name: /^HEAD: HEAD$/i });
    expect(headBadge.className).not.toContain("gh-refchip--icon-only");
    expect(headBadge.querySelector(".gh-refchip__label")).toHaveTextContent("HEAD");
  });
});
