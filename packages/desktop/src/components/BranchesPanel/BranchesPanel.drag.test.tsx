// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { CommitPairRelationship } from "@githydra/git-core";
import { BranchesPanel } from "./BranchesPanel";
import { useBranchActions } from "../../hooks/useBranchActions";
import { BranchDragContext, useBranchDragSession } from "../../hooks/useBranchDragSession";
import { makeLocalBranch, makeRemoteBranch, makeRepoState } from "../../test/fixtures";
import { makeMockGitHydra } from "../../test/mockGitHydra";

/**
 * specs/branch-panel-drag-merge.md FR-418..439: Branches panel local cards are drag sources and
 * drop targets on the SHARED branch-drag session (the same hook the graph chips use).
 */
function Harness({
  api,
  relationship = "diverged",
  onMerge,
  onLocate = () => {},
}: {
  api: ReturnType<typeof makeMockGitHydra>;
  relationship?: CommitPairRelationship;
  onMerge: (a: string, b: string, target?: string) => void;
  onLocate?: (sha: string) => void;
}) {
  const actions = useBranchActions({ api, onChanged: () => {} });
  const session = useBranchDragSession({
    repoState: makeRepoState(),
    computeRelationship: async () => relationship,
    onMerge,
  });
  return (
    <BranchDragContext.Provider value={session}>
      <BranchesPanel
        api={api}
        repoState={makeRepoState()}
        actions={actions}
        onRequestNewBranch={() => {}}
        collapsed={false}
        onToggleCollapsed={() => {}}
        onLocateBranch={onLocate}
        lastFetchedAt={null}
      />
      {session.overlay}
    </BranchDragContext.Provider>
  );
}

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

function makeApi() {
  return makeMockGitHydra({
    localBranches: [
      makeLocalBranch("main", { isCurrent: true, tipSha: SHA_B }),
      makeLocalBranch("feature", { tipSha: SHA_A }),
    ],
    remoteBranches: [makeRemoteBranch("origin", "main", { tipSha: SHA_B })],
  });
}

async function cards() {
  await screen.findByText("Local (2)");
  const q = (name: string) => document.querySelector<HTMLElement>(`li[data-ref-branch="${name}"]`)!;
  return { feature: q("feature"), main: q("main") };
}

afterEach(() => {
  vi.restoreAllMocks();
  document.body.style.cursor = "";
  document.body.style.userSelect = "";
});

function drag(from: HTMLElement, hit: Element | null, dx = 20) {
  document.elementFromPoint = vi.fn(() => hit);
  fireEvent.pointerDown(from, { button: 0, pointerId: 1, clientX: 0, clientY: 0 });
  fireEvent.pointerMove(window, { pointerId: 1, clientX: dx, clientY: dx });
  return () => fireEvent.pointerUp(window, { pointerId: 1, clientX: dx, clientY: dx });
}

describe("BranchesPanel card drag-to-merge", () => {
  it("local cards are drag sources/targets; remote cards are neither", async () => {
    render(<Harness api={makeApi()} onMerge={vi.fn()} />);
    const { feature } = await cards();
    expect(feature).toHaveClass("gh-branches-panel__row--draggable");
    expect(document.querySelectorAll("li[data-ref-branch]")).toHaveLength(2);
  });

  it("dragging card A onto card B shows the chip ghost, highlights the whole target card, and merges into B's branch", async () => {
    const onMerge = vi.fn();
    render(<Harness api={makeApi()} onMerge={onMerge} />);
    const { feature, main } = await cards();
    const up = drag(feature, main);
    expect(document.querySelector(".gh-drag-ghost--chip")).toHaveTextContent("feature");
    expect(main).toHaveClass("gh-branches-panel__row--drag-target");
    expect(feature).toHaveClass("gh-branches-panel__row--drag-source");
    up();
    const menu = await screen.findByRole("menu");
    expect(within(menu).getAllByRole("menuitem")).toHaveLength(1);
    const item = within(menu).getByRole("menuitem", { name: "Merge feature into main" });
    await waitFor(() => expect(item).not.toBeDisabled());
    await userEvent.click(item);
    expect(onMerge).toHaveBeenCalledWith(SHA_A, SHA_B, "main");
  });

  it("the current branch's card can be dragged as the source", async () => {
    render(<Harness api={makeApi()} onMerge={vi.fn()} />);
    const { feature, main } = await cards();
    drag(main, feature)();
    expect(await screen.findByRole("menuitem", { name: "Merge main into feature" })).toBeInTheDocument();
  });

  it("dropping on itself, or on empty space, opens no menu; self-drop shows reject + not-allowed", async () => {
    render(<Harness api={makeApi()} onMerge={vi.fn()} />);
    const { feature } = await cards();
    const up = drag(feature, feature);
    expect(feature).toHaveClass("gh-branches-panel__row--drag-reject");
    expect(document.body.style.cursor).toBe("not-allowed");
    up();
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    drag(feature, null)();
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("A ancestor of B disables the item with 'Already up to date'", async () => {
    render(<Harness api={makeApi()} relationship="a-ancestor-of-b" onMerge={vi.fn()} />);
    const { feature, main } = await cards();
    drag(feature, main)();
    const item = await screen.findByRole("menuitem", { name: "Merge feature into main" });
    await waitFor(() => expect(item).toBeDisabled());
    expect(item).toHaveAttribute("title", "Already up to date");
  });

  it("Escape aborts an in-progress drag", async () => {
    render(<Harness api={makeApi()} onMerge={vi.fn()} />);
    const { feature, main } = await cards();
    drag(feature, main);
    expect(document.querySelector(".gh-drag-ghost")).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(document.querySelector(".gh-drag-ghost")).not.toBeInTheDocument();
    expect(document.body.style.cursor).toBe("");
  });

  it("pressing Checkout/Delete never starts a drag; a plain click on the name still locates; a real drag swallows the click", async () => {
    const onLocate = vi.fn();
    render(<Harness api={makeApi()} onMerge={vi.fn()} onLocate={onLocate} />);
    const { feature, main } = await cards();
    document.elementFromPoint = vi.fn(() => null);
    const checkout = within(feature).getByRole("button", { name: /checkout/i });
    fireEvent.pointerDown(checkout, { button: 0, pointerId: 1, clientX: 0, clientY: 0 });
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 30, clientY: 30 });
    expect(document.querySelector(".gh-drag-ghost")).not.toBeInTheDocument();
    fireEvent.pointerUp(window, { pointerId: 1, clientX: 30, clientY: 30 });

    const name = within(feature).getByRole("button", { name: /jump to feature/i });
    fireEvent.pointerDown(name, { button: 0, pointerId: 1, clientX: 0, clientY: 0 });
    fireEvent.pointerUp(window, { pointerId: 1, clientX: 0, clientY: 0 });
    await userEvent.click(name);
    expect(onLocate).toHaveBeenCalledWith(SHA_A);
    onLocate.mockClear();

    // A real drag started on the name button: the trailing click must not locate.
    drag(name, main)();
    fireEvent.click(name);
    expect(onLocate).not.toHaveBeenCalled();
  });
});
