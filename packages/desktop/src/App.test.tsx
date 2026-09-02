import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "./App";
import { makeMockGitHydra } from "./test/mockGitHydra";
import { makeCommit, makeConflictedFile, makeRepoState } from "./test/fixtures";
import type { LocalBranchInfo } from "@githydra/git-core";

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

    // Must-have A: the filter form is collapsed by default (specs/layout-and-view-polish.md).
    await userEvent.click(screen.getByRole("button", { name: /search & filter/i }));
    await userEvent.type(screen.getByLabelText(/^author$/i), "nobody-matches-this");
    await userEvent.click(screen.getByRole("button", { name: "Search" }));

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

    // Must-have A: the filter form is collapsed by default (specs/layout-and-view-polish.md).
    await userEvent.click(screen.getByRole("button", { name: /search & filter/i }));
    // Apply a filter that narrows down to just the one "Rare Author" commit.
    await userEvent.type(screen.getByLabelText(/^author$/i), "Rare Author");
    await userEvent.click(screen.getByRole("button", { name: "Search" }));
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

  it("opens the Changes panel via the Toolbar toggle, and switches back to commit details on selection (FR-28/FR-29)", async () => {
    const commits = [makeCommit("c1", [], { subject: "Only commit" })];
    const api = makeMockGitHydra({
      commits,
      workingDirectoryChanges: {
        staged: [],
        unstaged: [{ path: "a.ts", status: "modified", category: "unstaged" }],
        untracked: [],
        conflicted: [],
      },
      workingDirStatus: { hasChanges: true, staged: 0, unstaged: 1, untracked: 0, conflicted: 0 },
    });
    window.gitHydra = api;
    render(<App />);

    await userEvent.click(screen.getByRole("button", { name: /open repository/i }));
    await waitFor(() => expect(screen.getByText("Only commit")).toBeInTheDocument());

    const toggle = screen.getByRole("button", { name: /changes, 1 pending/i });
    await userEvent.click(toggle);
    expect(await screen.findByRole("complementary", { name: "Changes" })).toBeInTheDocument();
    expect(screen.getByText("Unstaged (1)")).toBeInTheDocument();

    // Selecting a commit switches the right rail back to commit details, closing the Changes panel.
    await userEvent.click(screen.getByText("Only commit"));
    await waitFor(() => expect(screen.getByRole("complementary", { name: "Commit details" })).toBeInTheDocument());
    expect(screen.queryByRole("complementary", { name: "Changes" })).not.toBeInTheDocument();
  });

  it("clicking the checkpoint pseudo-node opens the Changes panel and auto-selects the first diffable file, instead of being a dead click (AC2, Must-have #2)", async () => {
    const commits = [makeCommit("c1", [], { subject: "Only commit" })];
    const api = makeMockGitHydra({
      commits,
      workingDirectoryChanges: {
        staged: [],
        unstaged: [{ path: "a.ts", status: "modified", category: "unstaged" }],
        untracked: [],
        conflicted: [],
      },
      workingDirStatus: { hasChanges: true, staged: 0, unstaged: 1, untracked: 0, conflicted: 0 },
      fileDiff: {
        status: "ok",
        isBinary: false,
        hunks: [
          {
            header: "@@ -1 +1 @@",
            oldStart: 1,
            oldLines: 1,
            newStart: 1,
            newLines: 1,
            lines: [{ type: "add", content: "checkpoint diff content", oldLineNumber: null, newLineNumber: 1 }],
          },
        ],
      },
    });
    window.gitHydra = api;
    render(<App />);

    await userEvent.click(screen.getByRole("button", { name: /open repository/i }));
    await waitFor(() => expect(screen.getByText("Only commit")).toBeInTheDocument());

    await userEvent.click(screen.getByText(/uncommitted changes/i));

    expect(await screen.findByRole("complementary", { name: "Changes" })).toBeInTheDocument();
    expect(screen.queryByRole("complementary", { name: "Commit details" })).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByText("checkpoint diff content")).toBeInTheDocument());
    expect(vi.mocked(api.getUnstagedFileDiff)).toHaveBeenCalledWith("a.ts");
  });

  it("clicking the checkpoint node while a commit's DetailPanel is open switches to the Changes panel instead of stacking or no-oping (Must-have #2)", async () => {
    const commits = [makeCommit("c1", [], { subject: "Only commit" })];
    const api = makeMockGitHydra({
      commits,
      workingDirectoryChanges: {
        staged: [],
        unstaged: [{ path: "a.ts", status: "modified", category: "unstaged" }],
        untracked: [],
        conflicted: [],
      },
      workingDirStatus: { hasChanges: true, staged: 0, unstaged: 1, untracked: 0, conflicted: 0 },
    });
    window.gitHydra = api;
    render(<App />);

    await userEvent.click(screen.getByRole("button", { name: /open repository/i }));
    await waitFor(() => expect(screen.getByText("Only commit")).toBeInTheDocument());

    // First select the real commit — DetailPanel (not Changes) is the visible right panel.
    await userEvent.click(screen.getByText("Only commit"));
    expect(await screen.findByRole("complementary", { name: "Commit details" })).toBeInTheDocument();
    expect(screen.queryByRole("complementary", { name: "Changes" })).not.toBeInTheDocument();

    // Now click the checkpoint pseudo-node: must replace DetailPanel with the Changes panel
    // (Must-have #2's "opens the Changes panel if it isn't already the visible right panel"),
    // not stack both panels and not silently no-op because *some* right panel was already open.
    await userEvent.click(screen.getByText(/uncommitted changes/i));
    expect(await screen.findByRole("complementary", { name: "Changes" })).toBeInTheDocument();
    expect(screen.queryByRole("complementary", { name: "Commit details" })).not.toBeInTheDocument();
    await waitFor(() => expect(vi.mocked(api.getUnstagedFileDiff)).toHaveBeenCalledWith("a.ts"));
  });

  it("re-clicking the checkpoint node while the Changes panel is already open reloads it in place rather than doing nothing (Must-have #3)", async () => {
    const commits = [makeCommit("c1", [], { subject: "Only commit" })];
    const api = makeMockGitHydra({
      commits,
      workingDirectoryChanges: {
        staged: [],
        unstaged: [{ path: "a.ts", status: "modified", category: "unstaged" }],
        untracked: [],
        conflicted: [],
      },
      workingDirStatus: { hasChanges: true, staged: 0, unstaged: 1, untracked: 0, conflicted: 0 },
    });
    window.gitHydra = api;
    render(<App />);

    await userEvent.click(screen.getByRole("button", { name: /open repository/i }));
    await waitFor(() => expect(screen.getByText("Only commit")).toBeInTheDocument());

    await userEvent.click(screen.getByText(/uncommitted changes/i));
    const asideBefore = await screen.findByRole("complementary", { name: "Changes" });
    await waitFor(() => expect(vi.mocked(api.getWorkingDirectoryChanges)).toHaveBeenCalledTimes(1));

    await userEvent.click(screen.getByText(/uncommitted changes/i));

    // Same panel instance (no unmount/remount) but a fresh reload was triggered.
    expect(screen.getByRole("complementary", { name: "Changes" })).toBe(asideBefore);
    await waitFor(() => expect(vi.mocked(api.getWorkingDirectoryChanges).mock.calls.length).toBeGreaterThanOrEqual(2));
  });

  it("clears a stale branch-action error banner when a different repository is opened (regression, specs/branch-management.md)", async () => {
    const commits = [makeCommit("c1", [], { subject: "Only commit" })];
    const localBranches: LocalBranchInfo[] = [
      {
        name: "feature",
        fullName: "refs/heads/feature",
        tipSha: "c1",
        tipSubject: "",
        tipAuthorName: "",
        tipAuthorEmail: "",
        tipAuthorDate: "",
        tipCommitterDate: "",
        isCurrent: false,
        checkedOutInWorktree: null,
        upstreamName: null,
        upstreamGone: false,
        ahead: null,
        behind: null,
      },
    ];
    const api = makeMockGitHydra({ commits, localBranches });
    window.gitHydra = api;
    render(<App />);

    await userEvent.click(screen.getByRole("button", { name: /open repository/i }));
    await waitFor(() => expect(screen.getByText("Only commit")).toBeInTheDocument());

    // Trigger a branch-action error (any typed failure works -- the bug is about the error's
    // persistence across a repo switch, not which specific operation produced it) and confirm it
    // renders (design-pass "Branches panel relocation": the Branches sidebar is persistent/always
    // visible now, so it shows this error itself rather than App rendering a top-level banner —
    // see App.tsx's `branchActions.error && (sidebarCollapsed || ...)` condition).
    vi.mocked(api.deleteBranch).mockResolvedValueOnce({
      ok: false,
      error: { name: "BranchCheckedOutError", message: 'Branch "feature" could not be deleted: some real git reason' },
    });
    await userEvent.click(screen.getByRole("button", { name: "Delete" }));
    await userEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(screen.getByText(/some real git reason/i)).toBeInTheDocument());

    // Now open a second, different repository -- the stale error must not survive the switch.
    vi.mocked(api.openRepoDialog).mockResolvedValueOnce({ ok: true, data: "/repo2" });
    vi.mocked(api.openRepo).mockResolvedValueOnce({
      ok: true,
      data: {
        path: "/repo2",
        state: {
          gitDir: "/repo2/.git",
          commonGitDir: "/repo2/.git",
          workdir: "/repo2",
          isBare: false,
          isShallow: false,
          isWorktree: false,
          isEmpty: false,
          isUnbornHead: false,
          isDetachedHead: false,
          currentBranch: "main",
          headSha: "c1",
          inProgressOperation: null,
          inProgressOperationDetail: null,
        },
      },
    });
    await userEvent.click(screen.getByRole("button", { name: /open repository/i }));

    await waitFor(() => expect(screen.getByText("/repo2")).toBeInTheDocument());
    expect(screen.queryByText(/some real git reason/i)).not.toBeInTheDocument();
  });

  /**
   * specs/graph-head-indicator-and-refresh-alerting.md Problem 2 — revises the AC11 follow-up
   * (specs/merge-rebase-conflict-resolution.md): a watcher-detected operation-state change must
   * no longer silently update anything (the Changes panel's own "Conflicted" list included) — it
   * must alert instead, matching FR-6's "alert, don't silently apply" precedent for ordinary ref
   * churn, and block the conflict-resolution actions until the user clicks that alert's Refresh.
   */
  it("does not auto-refresh the Changes panel's Conflicted list on a simulated watcher fire — shows a distinct alert instead and blocks resolve actions until Refresh (Problem 2 AC2/AC3/AC4)", async () => {
    const commits = [makeCommit("c1", [], { subject: "Only commit" })];
    const mergingState = makeRepoState({
      headSha: "c1",
      inProgressOperation: "merge",
      inProgressOperationDetail: {
        kind: "merge",
        headSha: "c1",
        headSubject: "Only commit",
        mergeHeadSha: "feature123",
        mergeHeadSubject: "Feature work",
        incomingRef: "feature",
      },
    });
    const api = makeMockGitHydra({
      commits,
      repoState: mergingState,
      conflictedFiles: [makeConflictedFile("conflict.ts")],
      conflictSideLabels: {
        ours: { label: "Your branch", refName: null, sha: null },
        theirs: { label: "Incoming", refName: null, sha: null },
      },
      workingDirectoryChanges: {
        staged: [],
        unstaged: [],
        untracked: [],
        conflicted: [{ path: "conflict.ts", status: "unmerged", category: "conflicted" }],
      },
      workingDirStatus: { hasChanges: true, staged: 0, unstaged: 0, untracked: 0, conflicted: 1 },
    });

    let onRefsChangedListener: (() => void) | null = null;
    vi.mocked(api.onRefsChanged).mockImplementation((listener) => {
      onRefsChangedListener = listener;
      return () => {
        onRefsChangedListener = null;
      };
    });

    window.gitHydra = api;
    render(<App />);

    await userEvent.click(screen.getByRole("button", { name: /open repository/i }));
    await waitFor(() => expect(screen.getByText("Only commit")).toBeInTheDocument());

    await userEvent.click(screen.getByRole("button", { name: /changes/i }));
    await waitFor(() => expect(screen.getByText("Conflicted (1)")).toBeInTheDocument());
    await userEvent.click(screen.getByRole("button", { name: /conflict\.ts/i }));
    const acceptOurs = await screen.findByRole("button", { name: /accept your branch/i });
    expect(acceptOurs).toBeEnabled();

    // External `git merge --abort`: MERGE_HEAD is gone, exactly as test-agent's live repro did
    // from a separate terminal — the watcher only re-reads `RepositoryState` to detect this, it
    // never silently re-fetches working-dir status/changes for this path (Problem 2 AC6: zero
    // extra requests until the user acts).
    const abortedState = makeRepoState({
      headSha: "c1",
      inProgressOperation: null,
      inProgressOperationDetail: null,
    });
    vi.mocked(api.getState).mockResolvedValueOnce({ ok: true, data: abortedState });

    expect(onRefsChangedListener).not.toBeNull();
    await act(async () => {
      onRefsChangedListener!();
      // Let the watcher handler's internal `await api.getState()` microtask flush, same
      // convention as `useRepositoryGraph.test.ts`'s own `fireWatcher` helper.
      await Promise.resolve();
      await Promise.resolve();
    });

    // Nothing silently applied: the stale-but-previously-correct Conflicted list and resolve
    // actions are still exactly as they were.
    expect(screen.getByText("Conflicted (1)")).toBeInTheDocument();
    expect(acceptOurs).toBeDisabled();
    expect(screen.getByRole("button", { name: /accept incoming/i })).toBeDisabled();

    // The distinct alert is visible, naming the operation, separate from the ordinary
    // "History changed outside GitHydra" copy.
    const alert = screen.getByText(/in-progress merge changed outside githydra/i);
    expect(alert).toBeInTheDocument();

    // Now the user clicks that alert's own Refresh — this (and only this) applies the update.
    vi.mocked(api.openRepo).mockResolvedValueOnce({ ok: true, data: { path: "/repo", state: abortedState } });
    vi.mocked(api.getWorkingDirStatus).mockResolvedValueOnce({
      ok: true,
      data: { hasChanges: false, staged: 0, unstaged: 0, untracked: 0, conflicted: 0 },
    });
    vi.mocked(api.getWorkingDirectoryChanges).mockResolvedValueOnce({
      ok: true,
      data: { staged: [], unstaged: [], untracked: [], conflicted: [] },
    });

    const refreshButton = within(alert.closest(".gh-status-banner") as HTMLElement).getByRole("button", {
      name: /refresh/i,
    });
    await userEvent.click(refreshButton);

    await waitFor(() => expect(screen.queryByText("Conflicted (1)")).not.toBeInTheDocument());
    expect(screen.queryByText(/in-progress merge changed outside githydra/i)).not.toBeInTheDocument();
  });

  // specs/graph-head-indicator-and-refresh-alerting.md Problem 1.
  describe("HEAD auto-follow after app-initiated HEAD moves", () => {
    it("selects and visually marks the checked-out commit without an extra click, and doesn't force-open the DetailPanel (AC2)", async () => {
      const commits = [
        makeCommit("c2", ["c1"], { subject: "Second commit" }),
        makeCommit("c1", [], { subject: "First commit" }),
      ];
      const api = makeMockGitHydra({ commits });
      window.gitHydra = api;
      render(<App />);

      await userEvent.click(screen.getByRole("button", { name: /open repository/i }));
      await waitFor(() => expect(screen.getByText("Second commit")).toBeInTheDocument());

      fireContextMenu(screen.getByText("First commit"));
      await userEvent.click(await screen.findByRole("menuitem", { name: /checkout commit/i }));

      await waitFor(() => {
        const row = screen.getByText("First commit").closest('[role="option"]');
        expect(row).toHaveAttribute("aria-selected", "true");
      });
      const secondRow = screen.getByText("Second commit").closest('[role="option"]');
      expect(secondRow).toHaveAttribute("aria-selected", "false");
      // A programmatic auto-follow, not a user click — must not steal focus from whatever right
      // panel (if any) the user already had open (here: none).
      expect(screen.queryByRole("complementary", { name: "Commit details" })).not.toBeInTheDocument();
    });

    it("selects the new branch tip after switching branches from the Branches panel (AC3)", async () => {
      const commits = [
        makeCommit("c2", ["c1"], { subject: "Second commit" }),
        makeCommit("c1", [], { subject: "First commit" }),
      ];
      const localBranches: LocalBranchInfo[] = [
        {
          name: "feature",
          fullName: "refs/heads/feature",
          tipSha: "c1",
          tipSubject: "",
          tipAuthorName: "",
          tipAuthorEmail: "",
          tipAuthorDate: "",
          tipCommitterDate: "",
          isCurrent: false,
          checkedOutInWorktree: null,
          upstreamName: null,
          upstreamGone: false,
          ahead: null,
          behind: null,
        },
      ];
      const api = makeMockGitHydra({ commits, localBranches });
      window.gitHydra = api;
      render(<App />);

      await userEvent.click(screen.getByRole("button", { name: /open repository/i }));
      await waitFor(() => expect(screen.getByText("Second commit")).toBeInTheDocument());

      await userEvent.click(within(screen.getByRole("complementary", { name: "Branches" })).getByRole("button", { name: /^checkout$/i }));

      await waitFor(() => {
        const row = screen.getByText("First commit").closest('[role="option"]');
        expect(row).toHaveAttribute("aria-selected", "true");
      });
    });
  });

  // specs/graph-head-indicator-and-refresh-alerting.md Addendum 2, Problem 1a.
  describe("stale ref-decoration chip after a HEAD move (Addendum 2, Problem 1a)", () => {
    it("clears a stale 'HEAD (detached)' chip from the previously-current row after checking out a different commit, and shows it correctly on the new one", async () => {
      const commits = [
        makeCommit("c2", ["c1"], {
          subject: "Second commit",
          // Simulates what git-core's real `enrich()` bakes into a row's `commit.refs` when it's
          // first loaded/paginated in while it's the (detached) HEAD commit — this is the
          // "already-loaded row" whose ref decoration this fix must correct once HEAD moves away
          // from it (mockGitHydra's `readPage`, unlike the real reader, never re-derives this on
          // its own, so seeding it here stands in for a row loaded before this test's checkout).
          refs: [{ name: "HEAD", fullName: null, type: "head" }],
        }),
        makeCommit("c1", [], { subject: "First commit" }),
      ];
      window.gitHydra = makeMockGitHydra({
        commits,
        repoState: { isDetachedHead: true, currentBranch: null, headSha: "c2" },
      });
      render(<App />);

      await userEvent.click(screen.getByRole("button", { name: /open repository/i }));
      await waitFor(() => expect(screen.getByText("Second commit")).toBeInTheDocument());
      const initialHeadRow = screen.getByText("Second commit").closest<HTMLElement>('[role="option"]')!;
      expect(within(initialHeadRow).getByText("HEAD (detached)")).toBeInTheDocument();

      fireContextMenu(screen.getByText("First commit"));
      await userEvent.click(await screen.findByRole("menuitem", { name: /checkout commit/i }));

      // The new HEAD row picks up the (correct) "HEAD (detached)" chip immediately — no click/
      // scroll/re-load/remount required (AC1).
      await waitFor(() => {
        const newHeadRow = screen.getByText("First commit").closest<HTMLElement>('[role="option"]')!;
        expect(within(newHeadRow).getByText("HEAD (detached)")).toBeInTheDocument();
      });
      // ...and the OLD HEAD row's leftover chip is gone, regardless of scroll position (AC2) —
      // this is the actual regression: before this fix, both rows showed it simultaneously.
      const oldHeadRow = screen.getByText("Second commit").closest<HTMLElement>('[role="option"]')!;
      expect(within(oldHeadRow).queryByText("HEAD (detached)")).not.toBeInTheDocument();
    });
  });
});

/** jsdom doesn't synthesize a real "contextmenu" event from userEvent yet — fire it directly
 * (same convention `CommitGraph.test.tsx` already uses). */
function fireContextMenu(target: Element) {
  target.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
}
