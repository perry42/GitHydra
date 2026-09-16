// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { CommitPairRelationship } from "@githydra/git-core";
import { CommitGraph, type CommitGraphProps } from "./CommitGraph";
import { makeCommit, makeDisplayRows, makeRepoState } from "../../test/fixtures";

/**
 * specs/drag-commit-menu.md FR-301 through FR-319: the drag-node-onto-another-node contextual
 * action menu. `noopHandlers` mirrors `CommitGraph.test.tsx`'s own convention (every prop every
 * render needs, no-op unless a specific test cares about it).
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
});

function renderGraph(overrides: Partial<CommitGraphProps> = {}) {
  const rows = makeDisplayRows([
    makeCommit("c3", ["c2"], {
      subject: "Third commit",
      refs: [{ name: "feature", fullName: "refs/heads/feature", type: "local-branch" }],
    }),
    makeCommit("c2", ["c1"], { subject: "Second commit" }),
    makeCommit("c1", [], {
      subject: "First commit",
      refs: [{ name: "v1.0", fullName: "refs/tags/v1.0", type: "tag" }],
    }),
  ]);
  const onComputeCommitPairRelationship = vi.fn<(a: string, b: string) => Promise<CommitPairRelationship>>(
    () => new Promise(() => {}), // never resolves unless a test wires its own
  );
  const props = {
    displayRows: rows,
    maxLaneIndexSeen: 0,
    hasMore: false,
    isLoadingMore: false,
    onLoadMore: () => {},
    visibleRefNames: new Set(["refs/heads/feature", "refs/tags/v1.0"]),
    repoState: makeRepoState(),
    selectedSha: null,
    followSignal: 0,
    onSelectCommit: () => {},
    onSelectCheckpoint: () => {},
    theme: "dark" as const,
    ...noopHandlers,
    onComputeCommitPairRelationship,
    onDragCherryPick: vi.fn(),
    onDragMerge: vi.fn(),
    onDragRebase: vi.fn(),
    dragActionBusy: false,
    ...overrides,
  };
  const utils = render(<CommitGraph {...(props as CommitGraphProps)} />);
  return { ...utils, props };
}

function rowFor(container: HTMLElement, sha: string): HTMLElement {
  const el = container.querySelector(`[data-commit-sha="${sha}"]`);
  if (!el) throw new Error(`no row rendered for ${sha}`);
  return el as HTMLElement;
}

/** Drags from `fromSha` to `toSha` — `document.elementFromPoint` is stubbed (unimplemented in
 * jsdom) to resolve to `toSha`'s row for every move/up after the initial press, mirroring the real
 * hit-testing `CommitGraph`'s drag handler relies on. Stops right after pointerup (the caller
 * awaits whatever settles next, e.g. the menu appearing). */
function drag(container: HTMLElement, fromSha: string, toSha: string) {
  const source = rowFor(container, fromSha);
  const target = rowFor(container, toSha);
  document.elementFromPoint = vi.fn(() => target);
  fireEvent.pointerDown(source, { button: 0, pointerId: 1, clientX: 0, clientY: 0 });
  // Past DRAG_THRESHOLD_PX (6) — starts the drag.
  fireEvent.pointerMove(window, { pointerId: 1, clientX: 20, clientY: 20 });
  fireEvent.pointerUp(window, { pointerId: 1, clientX: 20, clientY: 20 });
}

describe("CommitGraph drag-commit menu (specs/drag-commit-menu.md)", () => {
  it("AC1: releasing a drag onto a different commit opens a menu styled with the shared ContextMenu chrome, computing then settling", async () => {
    const { container, props } = renderGraph();
    let resolve!: (v: CommitPairRelationship) => void;
    vi.mocked(props.onComputeCommitPairRelationship).mockReturnValueOnce(
      new Promise((r) => {
        resolve = r;
      }),
    );

    drag(container, "c1", "c3");

    const menu = await screen.findByRole("menu", { name: /dragged v1\.0 onto feature/i });
    expect(menu).toHaveClass("gh-context-menu");
    // Computing state: every item disabled with the same "Computing…" reason (AC1).
    for (const item of within(menu).getAllByRole("menuitem")) {
      if (item.textContent?.startsWith("Compare")) continue; // Compare is content-checked below.
      expect(item).toBeDisabled();
    }

    resolve!("diverged");
    await waitFor(() => expect(within(menu).getByRole("menuitem", { name: /^merge/i })).not.toBeDisabled());
  });

  it("FR-307 fifth state: a genuinely failed ancestry read (the promise rejects, not just an ambiguous git exit code) disables Merge/Rebase with their own distinct reason, leaving Compare/Cherry-pick enabled", async () => {
    const { container, props } = renderGraph();
    vi.mocked(props.onComputeCommitPairRelationship).mockRejectedValueOnce(new Error("spawn failed"));

    drag(container, "c1", "c3");

    const menu = await screen.findByRole("menu", { name: /dragged v1\.0 onto feature/i });
    await waitFor(() =>
      expect(within(menu).getByRole("menuitem", { name: /^merge/i })).toHaveAttribute(
        "title",
        "Could not determine commit history — try again.",
      ),
    );
    expect(within(menu).getByRole("menuitem", { name: /^merge/i })).toBeDisabled();
    const rebase = within(menu).getByRole("menuitem", { name: /^rebase/i });
    expect(rebase).toBeDisabled();
    expect(rebase).toHaveAttribute("title", "Could not determine commit history — try again.");
    // Compare/Cherry-pick never depended on the ancestry read at all — unaffected by its failure.
    expect(within(menu).getByRole("menuitem", { name: /^compare/i })).not.toBeDisabled();
    expect(within(menu).getByRole("menuitem", { name: /^cherry-pick/i })).not.toBeDisabled();
  });

  it("AC2/FR-302: dragging a commit onto itself never opens a menu — shows the reject highlight and blocked cursor instead", () => {
    const { container, props } = renderGraph();
    const source = rowFor(container, "c2");
    document.elementFromPoint = vi.fn(() => source);

    fireEvent.pointerDown(source, { button: 0, pointerId: 1, clientX: 0, clientY: 0 });
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 20, clientY: 20 });
    expect(source).toHaveClass("gh-commit-row--drag-reject");
    expect(document.body.style.cursor).toBe("not-allowed");

    fireEvent.pointerUp(window, { pointerId: 1, clientX: 20, clientY: 20 });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(props.onComputeCommitPairRelationship).not.toHaveBeenCalled();
  });

  it("AC16: no ancestry read (or any drag-related git call) happens while the drag is merely in progress — only after release", () => {
    const { container, props } = renderGraph();
    const source = rowFor(container, "c1");
    const target = rowFor(container, "c3");
    document.elementFromPoint = vi.fn(() => target);

    fireEvent.pointerDown(source, { button: 0, pointerId: 1, clientX: 0, clientY: 0 });
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 20, clientY: 20 });
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 25, clientY: 25 });
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 30, clientY: 30 });
    expect(props.onComputeCommitPairRelationship).not.toHaveBeenCalled();

    fireEvent.pointerUp(window, { pointerId: 1, clientX: 30, clientY: 30 });
    expect(props.onComputeCommitPairRelationship).toHaveBeenCalledTimes(1);
  });

  it("a release with no real drag (never past the move threshold) behaves as an ordinary click, no menu", async () => {
    const onSelectCommit = vi.fn();
    const { container } = renderGraph({ onSelectCommit });
    const source = rowFor(container, "c1");
    fireEvent.pointerDown(source, { button: 0, pointerId: 1, clientX: 0, clientY: 0 });
    fireEvent.pointerUp(window, { pointerId: 1, clientX: 1, clientY: 1 }); // well under the threshold
    await userEvent.click(screen.getByText("First commit"));
    expect(onSelectCommit).toHaveBeenCalledWith("c1");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("AC3: the header resolves each commit's label — local branch, else tag, else abbreviated SHA", async () => {
    const { container } = renderGraph();
    drag(container, "c2", "c3"); // c2 has no ref at all; c3 has a local branch.
    await screen.findByRole("menu", { name: /dragged c2 onto feature/i });
  });

  it("AC3: falls back to a tag name when the commit has no local/remote branch", async () => {
    const { container } = renderGraph();
    drag(container, "c1", "c2"); // c1 has only a tag; c2 has no ref.
    await screen.findByRole("menu", { name: /dragged v1\.0 onto c2/i });
  });

  it("FR-306: renders exactly the four fixed-order items with the exact approved copy, including Rebase's flipped subject", async () => {
    const { container, props } = renderGraph();
    vi.mocked(props.onComputeCommitPairRelationship).mockResolvedValueOnce("diverged");
    drag(container, "c1", "c3");
    const menu = await screen.findByRole("menu", { name: /dragged v1\.0 onto feature/i });
    await waitFor(() => expect(within(menu).getByRole("menuitem", { name: /^merge/i })).not.toBeDisabled());

    const items = within(menu).getAllByRole("menuitem");
    expect(items.map((i) => i.textContent)).toEqual([
      "Compare v1.0 with feature",
      "Cherry-pick v1.0 onto feature",
      "Merge v1.0 into feature",
      "Rebase feature onto v1.0",
    ]);
  });

  it("AC4: A ancestor of B — Merge/Rebase disabled with the exact reasons, Compare/Cherry-pick enabled", async () => {
    const { container, props } = renderGraph();
    vi.mocked(props.onComputeCommitPairRelationship).mockResolvedValueOnce("a-ancestor-of-b");
    drag(container, "c1", "c3");
    const menu = await screen.findByRole("menu");
    await waitFor(() => expect(within(menu).getByRole("menuitem", { name: /^merge/i })).toBeDisabled());

    expect(within(menu).getByRole("menuitem", { name: /^compare/i })).not.toBeDisabled();
    expect(within(menu).getByRole("menuitem", { name: /^cherry-pick/i })).not.toBeDisabled();
    const merge = within(menu).getByRole("menuitem", { name: /^merge/i });
    const rebase = within(menu).getByRole("menuitem", { name: /^rebase/i });
    expect(merge).toHaveAttribute("title", "Already up to date");
    expect(rebase).toBeDisabled();
    expect(rebase).toHaveAttribute("title", "Nothing to replay");
  });

  it("AC4: B ancestor of A (fast-forward) — Merge/Rebase both enabled", async () => {
    const { container, props } = renderGraph();
    vi.mocked(props.onComputeCommitPairRelationship).mockResolvedValueOnce("b-ancestor-of-a");
    drag(container, "c1", "c3");
    const menu = await screen.findByRole("menu");
    await waitFor(() => expect(within(menu).getByRole("menuitem", { name: /^merge/i })).not.toBeDisabled());
    expect(within(menu).getByRole("menuitem", { name: /^rebase/i })).not.toBeDisabled();
  });

  it("AC4: no common ancestor — Merge/Rebase disabled with the shared-history reason, Compare/Cherry-pick still enabled", async () => {
    const { container, props } = renderGraph();
    vi.mocked(props.onComputeCommitPairRelationship).mockResolvedValueOnce("no-common-ancestor");
    drag(container, "c1", "c3");
    const menu = await screen.findByRole("menu");
    await waitFor(() =>
      expect(within(menu).getByRole("menuitem", { name: /^merge/i })).toHaveAttribute(
        "title",
        "No shared history between these commits",
      ),
    );
    expect(within(menu).getByRole("menuitem", { name: /^rebase/i })).toHaveAttribute(
      "title",
      "No shared history between these commits",
    );
    expect(within(menu).getByRole("menuitem", { name: /^compare/i })).not.toBeDisabled();
    expect(within(menu).getByRole("menuitem", { name: /^cherry-pick/i })).not.toBeDisabled();
  });

  it("AC4: diverged with real shared history — all four enabled", async () => {
    const { container, props } = renderGraph();
    vi.mocked(props.onComputeCommitPairRelationship).mockResolvedValueOnce("diverged");
    drag(container, "c1", "c3");
    const menu = await screen.findByRole("menu");
    await waitFor(() => {
      for (const item of within(menu).getAllByRole("menuitem")) expect(item).not.toBeDisabled();
    });
  });

  it("FR-310: Compare invokes onCompare with the graph-order [base, target], independent of drag direction", async () => {
    const onCompare = vi.fn();
    const { container, props } = renderGraph({ onCompare });
    vi.mocked(props.onComputeCommitPairRelationship).mockResolvedValueOnce("diverged");
    // Dragged newest (c3) onto oldest (c1) — graph order base/target must still be [c1, c3].
    drag(container, "c3", "c1");
    const menu = await screen.findByRole("menu");
    await userEvent.click(within(menu).getByRole("menuitem", { name: /^compare/i }));
    expect(onCompare).toHaveBeenCalledWith("c1", "c3");
  });

  it("FR-311/312/313: Cherry-pick/Merge/Rebase call their handlers with (aSha, bSha) in drag order — {A} dragged, {B} dropped-on", async () => {
    const onDragCherryPick = vi.fn();
    const onDragMerge = vi.fn();
    const onDragRebase = vi.fn();
    const { container, props } = renderGraph({ onDragCherryPick, onDragMerge, onDragRebase });
    vi.mocked(props.onComputeCommitPairRelationship).mockResolvedValue("diverged");

    drag(container, "c1", "c3");
    let menu = await screen.findByRole("menu");
    await waitFor(() => expect(within(menu).getByRole("menuitem", { name: /^merge/i })).not.toBeDisabled());
    await userEvent.click(within(menu).getByRole("menuitem", { name: /^cherry-pick/i }));
    expect(onDragCherryPick).toHaveBeenCalledWith("c1", "c3");

    drag(container, "c1", "c3");
    menu = await screen.findByRole("menu");
    await waitFor(() => expect(within(menu).getByRole("menuitem", { name: /^merge/i })).not.toBeDisabled());
    await userEvent.click(within(menu).getByRole("menuitem", { name: /^merge/i }));
    expect(onDragMerge).toHaveBeenCalledWith("c1", "c3");

    drag(container, "c1", "c3");
    menu = await screen.findByRole("menu");
    await waitFor(() => expect(within(menu).getByRole("menuitem", { name: /^rebase/i })).not.toBeDisabled());
    await userEvent.click(within(menu).getByRole("menuitem", { name: /^rebase/i }));
    expect(onDragRebase).toHaveBeenCalledWith("c1", "c3");
  });

  it("FR-308: Cherry-pick/Merge/Rebase disabled on a bare repo, with the existing bare-repo reason; Compare stays enabled (AC17)", async () => {
    const { container, props } = renderGraph({ repoState: makeRepoState({ isBare: true, workdir: null }) });
    vi.mocked(props.onComputeCommitPairRelationship).mockResolvedValueOnce("diverged");
    drag(container, "c1", "c3");
    const menu = await screen.findByRole("menu");
    await waitFor(() => expect(within(menu).getByRole("menuitem", { name: /^merge/i })).toBeDisabled());

    expect(within(menu).getByRole("menuitem", { name: /^compare/i })).not.toBeDisabled();
    expect(within(menu).getByRole("menuitem", { name: /^cherry-pick/i })).toBeDisabled();
    expect(within(menu).getByRole("menuitem", { name: /^cherry-pick/i })).toHaveAttribute(
      "title",
      expect.stringMatching(/bare repository/i),
    );
    expect(within(menu).getByRole("menuitem", { name: /^merge/i })).toHaveAttribute(
      "title",
      expect.stringMatching(/bare repository/i),
    );
    expect(within(menu).getByRole("menuitem", { name: /^rebase/i })).toHaveAttribute(
      "title",
      expect.stringMatching(/bare repository/i),
    );
  });

  it("FR-308: Cherry-pick additionally disabled when {A} is a merge commit, matching cherry-pick.md FR-115", async () => {
    const rows = makeDisplayRows([
      makeCommit("m1", ["p1", "p2"], { subject: "Merge commit" }),
      makeCommit("c1", [], { subject: "First commit" }),
    ]);
    const onComputeCommitPairRelationship = vi.fn().mockResolvedValue("diverged");
    const { container } = render(
      <CommitGraph
        displayRows={rows}
        maxLaneIndexSeen={0}
        hasMore={false}
        isLoadingMore={false}
        onLoadMore={() => {}}
        visibleRefNames={new Set()}
        repoState={makeRepoState()}
        selectedSha={null}
        followSignal={0}
        onSelectCommit={() => {}}
        onSelectCheckpoint={() => {}}
        theme="dark"
        {...noopHandlers}
        onComputeCommitPairRelationship={onComputeCommitPairRelationship}
        onDragCherryPick={() => {}}
        onDragMerge={() => {}}
        onDragRebase={() => {}}
      />,
    );
    drag(container, "m1", "c1");
    const menu = await screen.findByRole("menu");
    await waitFor(() => expect(within(menu).getByRole("menuitem", { name: /^cherry-pick/i })).toBeDisabled());
    expect(within(menu).getByRole("menuitem", { name: /^cherry-pick/i })).toHaveAttribute(
      "title",
      expect.stringMatching(/merge commit/i),
    );
  });

  it("FR-316: Escape closes the drop menu", async () => {
    const { container, props } = renderGraph();
    vi.mocked(props.onComputeCommitPairRelationship).mockResolvedValueOnce("diverged");
    drag(container, "c1", "c3");
    await screen.findByRole("menu");
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("FR-316: an outside click closes the drop menu", async () => {
    const { container, props } = renderGraph();
    vi.mocked(props.onComputeCommitPairRelationship).mockResolvedValueOnce("diverged");
    drag(container, "c1", "c3");
    await screen.findByRole("menu");
    await userEvent.click(document.body);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("FR-316: scrolling the graph closes the drop menu", async () => {
    const { container, props } = renderGraph();
    vi.mocked(props.onComputeCommitPairRelationship).mockResolvedValueOnce("diverged");
    drag(container, "c1", "c3");
    await screen.findByRole("menu");
    const scroller = screen.getByRole("listbox", { name: /commit graph/i });
    fireEvent.scroll(scroller);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("dropping outside any commit row opens no menu and makes no git call", () => {
    const { container, props } = renderGraph();
    const source = rowFor(container, "c1");
    fireEvent.pointerDown(source, { button: 0, pointerId: 1, clientX: 0, clientY: 0 });
    document.elementFromPoint = vi.fn(() => null);
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 20, clientY: 20 });
    fireEvent.pointerUp(window, { pointerId: 1, clientX: 20, clientY: 20 });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(props.onComputeCommitPairRelationship).not.toHaveBeenCalled();
  });

  it("FR-319: the existing multi-select ctrl/shift-click behavior is unaffected by this feature's presence", async () => {
    const { container } = renderGraph();
    fireEvent.click(rowFor(container, "c1"), { ctrlKey: true });
    fireEvent.click(rowFor(container, "c3"), { ctrlKey: true });
    expect(rowFor(container, "c1")).toHaveClass("gh-commit-row--multi-selected");
    expect(rowFor(container, "c3")).toHaveClass("gh-commit-row--multi-selected");
  });

  // specs/drag-commit-menu.md AC15/FR-301: "No modifier key (Ctrl/Alt/Shift/Cmd) changes this
  // interaction in v1 — plain drag-and-release always opens the menu below; nothing else is
  // bound. This is a final decision, not a placeholder for later modifier behavior." Verified
  // directly (not just by code inspection) since a subtly different guard in the drag handler
  // (e.g. treating a held Ctrl as the start of a copy-drag, or swallowing the gesture as a
  // would-be multi-select modifier) would silently break this without any other test noticing —
  // every other drag test in this file drags with no modifier held at all.
  describe.each([
    ["Ctrl", { ctrlKey: true }],
    ["Alt", { altKey: true }],
    ["Shift", { shiftKey: true }],
    ["Cmd/Meta", { metaKey: true }],
  ] as const)("AC15: holding %s throughout the drag", (_name, modifier) => {
    it("still opens the drop menu with the identical header/items a plain drag would", async () => {
      const { container, props } = renderGraph();
      vi.mocked(props.onComputeCommitPairRelationship).mockResolvedValueOnce("diverged");

      const source = rowFor(container, "c1");
      const target = rowFor(container, "c3");
      document.elementFromPoint = vi.fn(() => target);
      fireEvent.pointerDown(source, { button: 0, pointerId: 1, clientX: 0, clientY: 0, ...modifier });
      fireEvent.pointerMove(window, { pointerId: 1, clientX: 20, clientY: 20, ...modifier });
      fireEvent.pointerUp(window, { pointerId: 1, clientX: 20, clientY: 20, ...modifier });

      const menu = await screen.findByRole("menu", { name: /dragged v1\.0 onto feature/i });
      await waitFor(() => expect(within(menu).getByRole("menuitem", { name: /^merge/i })).not.toBeDisabled());
      const items = within(menu).getAllByRole("menuitem");
      expect(items.map((i) => i.textContent)).toEqual([
        "Compare v1.0 with feature",
        "Cherry-pick v1.0 onto feature",
        "Merge v1.0 into feature",
        "Rebase feature onto v1.0",
      ]);
      expect(props.onComputeCommitPairRelationship).toHaveBeenCalledTimes(1);
      expect(props.onComputeCommitPairRelationship).toHaveBeenCalledWith("c1", "c3");
    });

    it("never triggers a self-drop rejection or any other alternate behavior when released on the same row it started on", () => {
      const { container, props } = renderGraph();
      const source = rowFor(container, "c2");
      document.elementFromPoint = vi.fn(() => source);

      fireEvent.pointerDown(source, { button: 0, pointerId: 1, clientX: 0, clientY: 0, ...modifier });
      fireEvent.pointerMove(window, { pointerId: 1, clientX: 20, clientY: 20, ...modifier });
      expect(source).toHaveClass("gh-commit-row--drag-reject"); // same self-drop rejection as FR-302 unmodified.
      fireEvent.pointerUp(window, { pointerId: 1, clientX: 20, clientY: 20, ...modifier });

      expect(screen.queryByRole("menu")).not.toBeInTheDocument();
      expect(props.onComputeCommitPairRelationship).not.toHaveBeenCalled();
    });
  });

  // specs/drag-commit-menu.md Addendum 1 (FR-322-325, AC18-22): the cursor-following drag ghost.
  describe("Addendum 1: cursor-following drag ghost", () => {
    it("AC18/Addendum2-AC24: renders during a drag with a no-ref commit's abbreviated SHA visible, and tracks pointer position", () => {
      const { container } = renderGraph();
      const source = rowFor(container, "c2"); // no ref at all — resolves to abbreviated SHA "c2".
      const target = rowFor(container, "c3");
      document.elementFromPoint = vi.fn(() => target);

      expect(document.querySelector(".gh-drag-ghost")).not.toBeInTheDocument();

      fireEvent.pointerDown(source, { button: 0, pointerId: 1, clientX: 0, clientY: 0 });
      fireEvent.pointerMove(window, { pointerId: 1, clientX: 20, clientY: 20 });

      const ghost = document.querySelector(".gh-drag-ghost") as HTMLElement;
      expect(ghost).toBeInTheDocument();
      expect(within(ghost).getByText("c2")).toHaveClass("gh-mono");
      expect(ghost.style.left).toBe(`${20 + 16}px`);
      expect(ghost.style.top).toBe(`${20 + 16}px`);

      fireEvent.pointerMove(window, { pointerId: 1, clientX: 55, clientY: 40 });
      expect(ghost.style.left).toBe(`${55 + 16}px`);
      expect(ghost.style.top).toBe(`${40 + 16}px`);

      fireEvent.pointerUp(window, { pointerId: 1, clientX: 55, clientY: 40 });
    });

    it("Addendum 2 AC23: dragging a ref'd commit shows its resolved name on the ghost, matching the drop menu's label for the same commit", async () => {
      const { container, props } = renderGraph();
      vi.mocked(props.onComputeCommitPairRelationship).mockResolvedValueOnce("diverged");
      const source = rowFor(container, "c3"); // local branch "feature".
      const target = rowFor(container, "c1"); // tag "v1.0".
      document.elementFromPoint = vi.fn(() => target);

      fireEvent.pointerDown(source, { button: 0, pointerId: 1, clientX: 0, clientY: 0 });
      fireEvent.pointerMove(window, { pointerId: 1, clientX: 20, clientY: 20 });

      const ghost = document.querySelector(".gh-drag-ghost") as HTMLElement;
      expect(within(ghost).getByText("feature")).toHaveClass("gh-mono");
      expect(within(ghost).queryByText("c3")).not.toBeInTheDocument();

      fireEvent.pointerUp(window, { pointerId: 1, clientX: 20, clientY: 20 });

      // The drop menu resolves the same commit to the same "feature" label as {A} — no mismatch
      // between what the ghost showed in transit and what the menu shows on release.
      const menu = await screen.findByRole("menu", { name: /dragged feature onto v1\.0/i });
      expect(menu).toBeInTheDocument();
    });

    it("AC19/FR-323: the ghost is pointer-events:none, so it can never itself be the elementFromPoint hit — dropping succeeds even though the ghost visually overlaps the target row", async () => {
      const { container, props } = renderGraph();
      vi.mocked(props.onComputeCommitPairRelationship).mockResolvedValueOnce("diverged");
      const source = rowFor(container, "c2"); // no ref at all — resolves to abbreviated SHA "c2".
      const target = rowFor(container, "c3");
      // Mirrors real-browser hit-testing skipping a pointer-events:none overlay: elementFromPoint
      // resolves to the real row underneath regardless of where the (pointer-events:none) ghost
      // is currently rendered.
      document.elementFromPoint = vi.fn(() => target);

      fireEvent.pointerDown(source, { button: 0, pointerId: 1, clientX: 0, clientY: 0 });
      fireEvent.pointerMove(window, { pointerId: 1, clientX: 20, clientY: 20 });
      const ghost = document.querySelector(".gh-drag-ghost") as HTMLElement;
      expect(getComputedStyle(ghost).pointerEvents).toBe("none");
      // The ghost's own rendered position lands directly on top of the target row's coordinates —
      // the drop still resolves to the real row, not the ghost.
      fireEvent.pointerUp(window, { pointerId: 1, clientX: 20, clientY: 20 });

      const menu = await screen.findByRole("menu", { name: /dragged c2 onto feature/i });
      expect(menu).toBeInTheDocument();
    });

    it("AC20: hovering back over the source commit's own row recolors the ghost to the critical/reject treatment", () => {
      const { container } = renderGraph();
      const source = rowFor(container, "c2");
      document.elementFromPoint = vi.fn(() => source);

      fireEvent.pointerDown(source, { button: 0, pointerId: 1, clientX: 0, clientY: 0 });
      fireEvent.pointerMove(window, { pointerId: 1, clientX: 20, clientY: 20 });

      const ghost = document.querySelector(".gh-drag-ghost") as HTMLElement;
      expect(ghost).toHaveClass("gh-drag-ghost--reject");
      const dot = ghost.querySelector(".gh-drag-ghost__dot") as HTMLElement;
      expect(dot.style.background).toBe("var(--gh-status-critical)");

      fireEvent.pointerUp(window, { pointerId: 1, clientX: 20, clientY: 20 });
    });

    it("AC21: disappears immediately on pointerup", () => {
      const { container } = renderGraph();
      const source = rowFor(container, "c1");
      document.elementFromPoint = vi.fn(() => null);
      fireEvent.pointerDown(source, { button: 0, pointerId: 1, clientX: 0, clientY: 0 });
      fireEvent.pointerMove(window, { pointerId: 1, clientX: 20, clientY: 20 });
      expect(document.querySelector(".gh-drag-ghost")).toBeInTheDocument();

      fireEvent.pointerUp(window, { pointerId: 1, clientX: 20, clientY: 20 });
      expect(document.querySelector(".gh-drag-ghost")).not.toBeInTheDocument();
    });

    it("AC21: disappears immediately on pointercancel", () => {
      const { container } = renderGraph();
      const source = rowFor(container, "c1");
      document.elementFromPoint = vi.fn(() => null);
      fireEvent.pointerDown(source, { button: 0, pointerId: 1, clientX: 0, clientY: 0 });
      fireEvent.pointerMove(window, { pointerId: 1, clientX: 20, clientY: 20 });
      expect(document.querySelector(".gh-drag-ghost")).toBeInTheDocument();

      fireEvent.pointerCancel(window, { pointerId: 1 });
      expect(document.querySelector(".gh-drag-ghost")).not.toBeInTheDocument();
    });

    it("no ghost renders for an ordinary click that never crosses the drag threshold", () => {
      const { container } = renderGraph();
      const source = rowFor(container, "c1");
      fireEvent.pointerDown(source, { button: 0, pointerId: 1, clientX: 0, clientY: 0 });
      fireEvent.pointerUp(window, { pointerId: 1, clientX: 1, clientY: 1 }); // well under DRAG_THRESHOLD_PX
      expect(document.querySelector(".gh-drag-ghost")).not.toBeInTheDocument();
    });
  });
});
