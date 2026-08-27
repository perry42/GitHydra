import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "./App";
import { makeMockGitHydra } from "./test/mockGitHydra";
import { makeCommit } from "./test/fixtures";

afterEach(() => {
  // @ts-expect-error test cleanup of the global bridge
  delete window.gitHydra;
});

describe("App", () => {
  it("shows the empty (no repo open) state on first launch", () => {
    window.gitHydra = makeMockGitHydra();
    render(<App />);
    expect(screen.getByRole("status")).toHaveTextContent(/no repository open/i);
  });

  it("opens a repo via the toolbar and renders its commit graph end to end", async () => {
    const commits = [
      makeCommit("c2", ["c1"], { subject: "Second commit" }),
      makeCommit("c1", [], { subject: "First commit" }),
    ];
    window.gitHydra = makeMockGitHydra({ commits });
    render(<App />);

    await userEvent.click(screen.getByRole("button", { name: /open repository/i }));

    await waitFor(() => expect(screen.getByText("Second commit")).toBeInTheDocument());
    expect(screen.getByText("First commit")).toBeInTheDocument();
    expect(screen.getByText("/repo")).toBeInTheDocument();
  });

  it("shows the AC7 empty state for a zero-commit repo", async () => {
    window.gitHydra = makeMockGitHydra({ repoState: { isEmpty: true }, commits: [] });
    render(<App />);
    await userEvent.click(screen.getByRole("button", { name: /open repository/i }));
    await waitFor(() => expect(screen.getByText(/no commits yet/i)).toBeInTheDocument());
  });

  it("does not render an uncommitted-changes pseudo-node for a bare repository (AC5)", async () => {
    const commits = [makeCommit("c1", [], { subject: "Only commit" })];
    window.gitHydra = makeMockGitHydra({
      repoState: { isBare: true, workdir: null, headSha: "c1" },
      commits,
      workingDirStatus: null,
    });
    render(<App />);
    await userEvent.click(screen.getByRole("button", { name: /open repository/i }));
    await waitFor(() => expect(screen.getByText("Only commit")).toBeInTheDocument());
    expect(screen.queryByText(/uncommitted changes/i)).not.toBeInTheDocument();
    expect(screen.getByText(/bare repository/i)).toBeInTheDocument();
  });

  it("shows an explicit 'no matching commits' state when a filter narrows results to zero (FR-14)", async () => {
    const commits = [makeCommit("c1", [], { subject: "Only commit", authorName: "Jane" })];
    window.gitHydra = makeMockGitHydra({ commits });
    render(<App />);
    await userEvent.click(screen.getByRole("button", { name: /open repository/i }));
    await waitFor(() => expect(screen.getByText("Only commit")).toBeInTheDocument());

    await userEvent.type(screen.getByLabelText(/^author$/i), "nobody-matches-this");
    await userEvent.click(screen.getByRole("button", { name: /search/i }));

    await waitFor(() => expect(screen.getByText(/no matching commits/i)).toBeInTheDocument());
    expect(screen.queryByText("Only commit")).not.toBeInTheDocument();
  });

  it("clearing a filter after scrolling restores the cached view instead of reloading from scratch (AC-10)", async () => {
    // 160 commits: PAGE_SIZE (150) covers the first page, leaving a "deep" commit (index 155,
    // sha c5) reachable only after scrolling to trigger a second page load.
    const commits = Array.from({ length: 160 }, (_, i) => {
      const sha = `c${160 - i}`;
      const parents = i < 159 ? [`c${160 - i - 1}`] : [];
      return makeCommit(sha, parents, { authorName: i === 155 ? "Rare Author" : "Ada Lovelace" });
    });
    const api = makeMockGitHydra({ commits });
    window.gitHydra = api;
    render(<App />);

    await userEvent.click(screen.getByRole("button", { name: /open repository/i }));
    await waitFor(() => expect(screen.getByText("Commit c160")).toBeInTheDocument());
    expect(vi.mocked(api.createLogReader)).toHaveBeenCalledTimes(1);

    // Scroll near the bottom of the (currently 150-row) loaded set to trigger the second page.
    const scroller = screen.getByRole("listbox", { name: /commit graph/i });
    scroller.scrollTop = 140 * 28;
    fireEvent.scroll(scroller);
    await waitFor(() => expect(screen.getByText("Commit c5")).toBeInTheDocument());

    const readPageCallsAfterScroll = vi.mocked(api.readPage).mock.calls.length;
    expect(readPageCallsAfterScroll).toBe(2);
    expect(vi.mocked(api.createLogReader)).toHaveBeenCalledTimes(1);

    // Apply a filter that narrows down to just the one "Rare Author" commit.
    await userEvent.type(screen.getByLabelText(/^author$/i), "Rare Author");
    await userEvent.click(screen.getByRole("button", { name: /search/i }));
    await waitFor(() => expect(screen.queryByText("Commit c160")).not.toBeInTheDocument());
    expect(vi.mocked(api.createLogReader)).toHaveBeenCalledTimes(2);

    const readPageCallsAfterFilter = vi.mocked(api.readPage).mock.calls.length;

    // Clear the filter: should restore the already-loaded 160-row baseline (including the
    // scrolled-to "deep" commit, at the same scroll position — the scroller's own scrollTop
    // isn't reset since CommitGraph stays mounted) with no new reader/page fetch.
    await userEvent.click(screen.getByRole("button", { name: /clear/i }));
    await waitFor(() => expect(screen.getByText("Commit c5")).toBeInTheDocument());
    // Full 160-row baseline restored (not just the first page): spacer height reflects all rows.
    expect(scroller.querySelector(".gh-commit-graph__spacer")).toHaveStyle({ height: "4480px" });

    expect(vi.mocked(api.createLogReader)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(api.readPage).mock.calls.length).toBe(readPageCallsAfterFilter);
  });
});
