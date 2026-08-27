import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CommitGraph } from "./CommitGraph";
import { makeCommit, makeDisplayRows, makeRepoState } from "../../test/fixtures";

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
        theme="dark"
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
        theme="dark"
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
        theme="dark"
      />,
    );
    const listbox = screen.getByRole("listbox", { name: /commit graph/i });
    listbox.focus();
    await userEvent.keyboard("{ArrowDown}{Enter}");
    expect(onSelect).toHaveBeenCalledWith("c1");
  });

  it("renders the uncommitted-changes pseudo-node as a non-selectable option (FR-18)", () => {
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
        theme="dark"
      />,
    );
    const pseudoOption = screen.getByText(/uncommitted changes/i).closest('[role="option"]');
    expect(pseudoOption).toHaveAttribute("aria-disabled", "true");
  });
});
