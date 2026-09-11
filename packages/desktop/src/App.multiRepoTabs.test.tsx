// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "./App";
import { makeMockGitHydra } from "./test/mockGitHydra";
import { makeCommit } from "./test/fixtures";
import { persistRightPanel } from "./hooks/useLayoutPreferences";

/**
 * specs/multi-repo-tabs.md: App-level integration coverage for the tab bar's orchestration —
 * tab creation/switch/close, per-tab independent state, and the "one live backend session"
 * architecture decision. Kept in its own file (rather than folded into App.test.tsx) since it's
 * a self-contained pass through this spec's acceptance criteria.
 *
 * specs/repo-list.md (revised IA): `Toolbar`'s "Open repository…" control (this spec's original
 * AC3 subject — "replaces only the active tab's repo") is retired entirely, and "+ New tab" no
 * longer opens the native dialog itself — it deactivates the current tab and lands on the idle
 * empty state, whose own "Open a repository" is the real dialog-launcher. `openFirstTab`/
 * `newTabInto` below reflect that: bootstrapping the very first tab and opening every subsequent
 * tab both go through the landing screen, just reached differently (nothing, vs. "+ New tab"
 * first). AC10 (same-path duplicate tabs) is retired outright by repo-list.md's global-dedup
 * revision — see that test's removal note further down.
 */

afterEach(() => {
  // @ts-expect-error test cleanup of the global bridge
  delete window.gitHydra;
  window.localStorage.clear();
});

/** Bootstraps the very first tab from the initial landing screen. */
async function openFirstTab(): Promise<void> {
  await userEvent.click(screen.getByRole("button", { name: "Open a repository" }));
}

/** Opens `path` into an additional tab: "+ New tab" (no dialog of its own) followed by the fresh
 * landing screen's own "Open a repository" (the real, always-a-dialog launcher). */
async function newTabInto(api: ReturnType<typeof makeMockGitHydra>, path: string): Promise<void> {
  vi.mocked(api.openRepoDialog).mockResolvedValueOnce({ ok: true, data: path });
  await userEvent.click(screen.getByRole("button", { name: /open a repository in a new tab/i }));
  await userEvent.click(screen.getByRole("button", { name: "Open a repository" }));
}

describe("multi-repo tabs", () => {
  it("Must-have 1: the tab bar is visible even with zero repos open", () => {
    window.gitHydra = makeMockGitHydra();
    render(<App />);
    expect(screen.getByRole("tablist", { name: /open repositories/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /open a repository in a new tab/i })).toBeInTheDocument();
    expect(screen.queryAllByRole("tab")).toHaveLength(0);
  });

  it("AC1/AC2: '+ New tab' opens a second repo without closing or altering the first tab's state", async () => {
    const api = makeMockGitHydra({
      repoPath: "/repoA",
      commits: [makeCommit("a1", [], { subject: "Repo A commit", authorName: "Ada" })],
      reposByPath: {
        "/repoB": { commits: [makeCommit("b1", [], { subject: "Repo B commit", authorName: "Bob" })] },
      },
    });
    window.gitHydra = api;
    render(<App />);

    await openFirstTab();
    await waitFor(() => expect(screen.getByText("Repo A commit")).toBeInTheDocument());

    // Select a commit in tab A (opens its DetailPanel) before switching away.
    await userEvent.click(screen.getByText("Repo A commit"));
    await waitFor(() => expect(screen.getByRole("complementary", { name: "Commit details" })).toBeInTheDocument());

    await newTabInto(api, "/repoB");

    await waitFor(() => expect(screen.getByText("Repo B commit")).toBeInTheDocument());
    expect(screen.queryByText("Repo A commit")).not.toBeInTheDocument();
    // A brand-new tab has no remembered selection — no DetailPanel/Changes panel open yet.
    expect(screen.queryByRole("complementary", { name: "Commit details" })).not.toBeInTheDocument();

    const tabs = screen.getAllByRole("tab");
    expect(tabs).toHaveLength(2);
    expect(tabs[0]).toHaveTextContent("repoA");
    expect(tabs[1]).toHaveTextContent("repoB");
    expect(tabs[1]).toHaveAttribute("aria-selected", "true");

    // AC1: switching back to tab A restores its selected commit/DetailPanel untouched.
    await userEvent.click(tabs[0]!);
    await waitFor(() => expect(screen.getByText("Repo A commit")).toBeInTheDocument());
    await waitFor(() => expect(screen.getByRole("complementary", { name: "Commit details" })).toBeInTheDocument());
  });

  it("AC3 (revised — specs/repo-list.md's IA retired the replace-in-place control this AC originally exercised): opening a third repo via '+ New tab' only ever adds a tab, never replaces an existing one", async () => {
    const api = makeMockGitHydra({
      repoPath: "/repoA",
      commits: [makeCommit("a1", [], { subject: "Repo A commit" })],
      reposByPath: {
        "/repoB": { commits: [makeCommit("b1", [], { subject: "Repo B commit" })] },
        "/repoC": { commits: [makeCommit("c1", [], { subject: "Repo C commit" })] },
      },
    });
    window.gitHydra = api;
    render(<App />);

    await openFirstTab();
    await waitFor(() => expect(screen.getByText("Repo A commit")).toBeInTheDocument());

    await newTabInto(api, "/repoB");
    await waitFor(() => expect(screen.getByText("Repo B commit")).toBeInTheDocument());

    // There is no more "replace the active tab in place" control (specs/repo-list.md Must-have 2/
    // AC10) — opening repo C, even while tab B is active, only ever adds a third tab.
    await newTabInto(api, "/repoC");
    await waitFor(() => expect(screen.getByText("Repo C commit")).toBeInTheDocument());

    const tabs = screen.getAllByRole("tab");
    expect(tabs).toHaveLength(3);
    expect(tabs[0]).toHaveTextContent("repoA");
    expect(tabs[1]).toHaveTextContent("repoB");
    expect(tabs[2]).toHaveTextContent("repoC");

    await userEvent.click(tabs[0]!);
    await waitFor(() => expect(screen.getByText("Repo A commit")).toBeInTheDocument());
    await userEvent.click(tabs[1]!);
    await waitFor(() => expect(screen.getByText("Repo B commit")).toBeInTheDocument());
  });

  // specs/find-commits-overlay.md Non-goals/FR-263/FR-265/AC9: this AC4 requirement (a tab's
  // applied filter survives switching away and back) is DELIBERATELY REVERSED by that later
  // feature — "persisting the filter across ... a tab switch" is now an explicit non-goal (a
  // "find," not a "keep a narrowed view open" feature, per the user's own framing). Updated in
  // place, rather than left asserting the now-wrong behavior, to instead cover what actually ships
  // today: switching away from a tab with the Find Commits overlay open closes it AND clears that
  // tab's filter, so reactivating it shows the unfiltered view again, not the old filtered one.
  it("AC4 (superseded by specs/find-commits-overlay.md): switching tabs while Find Commits is open clears tab A's filter — it does NOT survive the switch", async () => {
    const api = makeMockGitHydra({
      repoPath: "/repoA",
      commits: [
        makeCommit("a1", [], { subject: "From Ada", authorName: "Ada" }),
        makeCommit("a2", [], { subject: "From Bob", authorName: "Bob" }),
      ],
      reposByPath: {
        "/repoB": { commits: [makeCommit("b1", [], { subject: "Repo B commit", authorName: "Carol" })] },
      },
    });
    window.gitHydra = api;
    render(<App />);

    await openFirstTab();
    await waitFor(() => expect(screen.getByText("From Ada")).toBeInTheDocument());

    await userEvent.click(screen.getByRole("button", { name: "Find commits" }));
    await userEvent.type(screen.getByLabelText(/^author$/i), "Ada");
    await userEvent.click(screen.getByRole("button", { name: "Search" }));
    await waitFor(() => expect(screen.queryByText("From Bob")).not.toBeInTheDocument());
    expect(screen.getByText("From Ada")).toBeInTheDocument();

    await newTabInto(api, "/repoB");
    await waitFor(() => expect(screen.getByText("Repo B commit")).toBeInTheDocument());
    // The overlay force-closed the moment tab B activated (FR-265).
    expect(screen.queryByRole("search", { name: /find commits/i })).not.toBeInTheDocument();

    const tabs = screen.getAllByRole("tab");
    await userEvent.click(tabs[0]!);

    // Tab A's filter was cleared before it was backgrounded (AC9) — both commits are visible
    // again, and reopening Find Commits shows a blank form, not the old "Ada" value.
    await waitFor(() => expect(screen.getByText("From Bob")).toBeInTheDocument());
    expect(screen.getByText("From Ada")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Find commits" }));
    expect(screen.getByLabelText(/^author$/i)).toHaveValue("");
  });

  it("AC5: the Changes panel open in tab A stays open across a switch to tab B and back, with tab B unaffected throughout", async () => {
    const api = makeMockGitHydra({
      repoPath: "/repoA",
      commits: [makeCommit("a1", [], { subject: "Repo A commit" })],
      workingDirectoryChanges: { staged: [], unstaged: [{ path: "a.ts", status: "modified", category: "unstaged" }], untracked: [], conflicted: [] },
      workingDirStatus: { hasChanges: true, staged: 0, unstaged: 1, untracked: 0, conflicted: 0 },
      reposByPath: {
        "/repoB": { commits: [makeCommit("b1", [], { subject: "Repo B commit" })] },
      },
    });
    window.gitHydra = api;
    render(<App />);

    await openFirstTab();
    await waitFor(() => expect(screen.getByText("Repo A commit")).toBeInTheDocument());

    // Tab B is created *before* tab A's Changes panel is toggled open, so its own remembered
    // panel state is captured as "none" — independent of whatever tab A does afterward.
    await newTabInto(api, "/repoB");
    await waitFor(() => expect(screen.getByText("Repo B commit")).toBeInTheDocument());
    expect(screen.queryByRole("complementary", { name: "Changes" })).not.toBeInTheDocument();

    const tabs = screen.getAllByRole("tab");
    await userEvent.click(tabs[0]!);
    await waitFor(() => expect(screen.getByText("Repo A commit")).toBeInTheDocument());
    await userEvent.click(screen.getByRole("button", { name: /changes, 1 pending/i }));
    const changesPanel = await screen.findByRole("complementary", { name: "Changes" });
    expect(within(changesPanel).getByText("Unstaged (1)")).toBeInTheDocument();

    // Switching to tab B must not show tab A's now-open Changes panel — it stays unaffected.
    await userEvent.click(tabs[1]!);
    await waitFor(() => expect(screen.getByText("Repo B commit")).toBeInTheDocument());
    expect(screen.queryByRole("complementary", { name: "Changes" })).not.toBeInTheDocument();

    // Switching back to tab A: its Changes panel is still open, showing *fresh* (not stale) data.
    await userEvent.click(tabs[0]!);
    await waitFor(() => expect(screen.getByText("Repo A commit")).toBeInTheDocument());
    const reshownPanel = await screen.findByRole("complementary", { name: "Changes" });
    expect(within(reshownPanel).getByText("Unstaged (1)")).toBeInTheDocument();
  });

  it("AC6: activating a different tab closes the previously active tab's reader", async () => {
    const api = makeMockGitHydra({
      repoPath: "/repoA",
      commits: [makeCommit("a1", [], { subject: "Repo A commit" })],
      reposByPath: {
        "/repoB": { commits: [makeCommit("b1", [], { subject: "Repo B commit" })] },
      },
    });
    window.gitHydra = api;
    render(<App />);

    await openFirstTab();
    await waitFor(() => expect(screen.getByText("Repo A commit")).toBeInTheDocument());
    expect(vi.mocked(api.closeReader)).not.toHaveBeenCalled();

    await newTabInto(api, "/repoB");
    await waitFor(() => expect(screen.getByText("Repo B commit")).toBeInTheDocument());

    // Opening the second tab's reader tore down tab A's — exactly one live reader at a time
    // (Architecture decision option B / AC6), the same `session.open` teardown any repo-open uses.
    expect(vi.mocked(api.closeReader)).toHaveBeenCalledWith("reader-1");
  });

  it("AC7: a tab whose repo fails to open shows an error scoped to that tab; other tabs stay switchable", async () => {
    const api = makeMockGitHydra({
      repoPath: "/repoA",
      commits: [makeCommit("a1", [], { subject: "Repo A commit" })],
    });
    window.gitHydra = api;
    render(<App />);

    await openFirstTab();
    await waitFor(() => expect(screen.getByText("Repo A commit")).toBeInTheDocument());

    vi.mocked(api.openRepoDialog).mockResolvedValueOnce({ ok: true, data: "/broken" });
    vi.mocked(api.openRepoCancellable).mockResolvedValueOnce({
      outcome: "settled",
      result: { ok: false, error: { name: "NotAGitRepositoryError", message: "not a git repository" } },
    });
    await userEvent.click(screen.getByRole("button", { name: /open a repository in a new tab/i }));
    await userEvent.click(screen.getByRole("button", { name: "Open a repository" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/not a git repository/i));

    const tabs = screen.getAllByRole("tab");
    expect(tabs).toHaveLength(2);

    // Switching back to tab A still works — the broken tab's failure didn't affect it.
    await userEvent.click(tabs[0]!);
    await waitFor(() => expect(screen.getByText("Repo A commit")).toBeInTheDocument());
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("AC8/AC9: closing the active tab activates an adjacent tab; closing the last tab returns to the idle empty state without closing the window", async () => {
    const api = makeMockGitHydra({
      repoPath: "/repoA",
      commits: [makeCommit("a1", [], { subject: "Repo A commit" })],
      reposByPath: {
        "/repoB": { commits: [makeCommit("b1", [], { subject: "Repo B commit" })] },
      },
    });
    window.gitHydra = api;
    render(<App />);

    await openFirstTab();
    await waitFor(() => expect(screen.getByText("Repo A commit")).toBeInTheDocument());
    await userEvent.click(screen.getByText("Repo A commit"));
    await waitFor(() => expect(screen.getByRole("complementary", { name: "Commit details" })).toBeInTheDocument());

    await newTabInto(api, "/repoB");
    await waitFor(() => expect(screen.getByText("Repo B commit")).toBeInTheDocument());

    // Close the active tab (B) — the adjacent tab (A) activates automatically.
    const closeB = screen.getByRole("button", { name: /close repoB tab/i });
    await userEvent.click(closeB);
    await waitFor(() => expect(screen.getByText("Repo A commit")).toBeInTheDocument());
    expect(screen.getAllByRole("tab")).toHaveLength(1);

    // AC8: reopening repo B's path afterward (a new tab) starts with no memory of the old
    // selection/filter/panel — the DetailPanel it never itself opened isn't showing.
    await newTabInto(api, "/repoB");
    await waitFor(() => expect(screen.getByText("Repo B commit")).toBeInTheDocument());
    expect(screen.queryByRole("complementary", { name: "Commit details" })).not.toBeInTheDocument();

    // AC9: close both remaining tabs — the window stays mounted, showing the idle empty state.
    const remainingTabs = screen.getAllByRole("tab");
    await userEvent.click(within(screen.getByRole("tablist")).getAllByRole("button", { name: /close .* tab/i })[1]!);
    await waitFor(() => expect(screen.getAllByRole("tab")).toHaveLength(1));
    await userEvent.click(within(screen.getByRole("tablist")).getAllByRole("button", { name: /close .* tab/i })[0]!);

    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(/no repository open/i));
    expect(screen.queryAllByRole("tab")).toHaveLength(0);
    // security review: closing the last tab must tear down the main-process session (readers +
    // ref-change watcher + the live repo) via the explicit `closeRepoSession` channel — not just
    // this hook's own renderer-side reader/state reset (`api.closeReader`) — see
    // `repoSession.test.ts`/`main.test.ts` for proof of what that channel actually closes.
    expect(api.closeRepoSession).toHaveBeenCalled();
    void remainingTabs;
  });

  it("security review: '+ New tab' tears down the main-process session (not just the renderer's own readers) when it deactivates the current tab", async () => {
    const api = makeMockGitHydra({
      repoPath: "/repoA",
      commits: [makeCommit("a1", [], { subject: "Repo A commit" })],
    });
    window.gitHydra = api;
    render(<App />);

    await openFirstTab();
    await waitFor(() => expect(screen.getByText("Repo A commit")).toBeInTheDocument());
    expect(api.closeRepoSession).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: /open a repository in a new tab/i }));
    await waitFor(() => expect(screen.getByText("No repository open", { selector: "p.gh-empty-state__title" })).toBeInTheDocument());

    // The explicit main-process teardown channel was called — not just the renderer's own
    // commit-log reader close (`api.closeReader`), which alone leaves the ref-change file watcher
    // (and the live `Repository`) orphaned on the main-process side.
    expect(api.closeRepoSession).toHaveBeenCalledTimes(1);
  });

  // AC10 (retired — specs/repo-list.md's global-dedup revision): this used to assert that
  // opening the same repo path into two tabs was allowed, and that a branch switch in one didn't
  // affect the other until reactivated. Both are now impossible to exercise the same way: a
  // second open of an already-open path focuses the existing tab instead of creating a duplicate
  // (see `App.repoList.test.tsx`'s AC4/AC5 for that dedup behavior, covering both the
  // recent-list-click and manual-browse entry points). The independent-per-tab-state guarantee
  // this test also exercised (a mutation in one tab not leaking into another until reactivated)
  // remains fully covered by AC1 (selection/DetailPanel), AC4 (filters), and AC5 (Changes panel)
  // above, all using two distinct repo paths — product-manager confirmed nothing is lost by
  // retiring the same-path variant specifically.

  it("AC11: a brand-new tab seeds its rightPanel from the persisted global preference", async () => {
    persistRightPanel("changes");
    const api = makeMockGitHydra({
      repoPath: "/repoA",
      commits: [makeCommit("a1", [], { subject: "Repo A commit" })],
      workingDirectoryChanges: { staged: [], unstaged: [], untracked: [], conflicted: [] },
      workingDirStatus: { hasChanges: false, staged: 0, unstaged: 0, untracked: 0, conflicted: 0 },
    });
    window.gitHydra = api;
    render(<App />);

    await openFirstTab();
    await waitFor(() => expect(screen.getByText("Repo A commit")).toBeInTheDocument());
    expect(await screen.findByRole("complementary", { name: "Changes" })).toBeInTheDocument();
  });

  it("Bug 1 stress check: a burst of rapid alternating tab clicks (no waits) never leaves a tab's label mismatched with another repo's content", async () => {
    const api = makeMockGitHydra({
      repoPath: "/repoA",
      commits: [makeCommit("a1", [], { subject: "Repo A commit" })],
      reposByPath: {
        "/repoB": { commits: [makeCommit("b1", [], { subject: "Repo B commit" })] },
        "/repoC": { commits: [makeCommit("c1", [], { subject: "Repo C commit" })] },
      },
    });
    window.gitHydra = api;
    render(<App />);

    await openFirstTab();
    await waitFor(() => expect(screen.getByText("Repo A commit")).toBeInTheDocument());

    await newTabInto(api, "/repoB");
    await waitFor(() => expect(screen.getByText("Repo B commit")).toBeInTheDocument());

    await newTabInto(api, "/repoC");
    await waitFor(() => expect(screen.getByText("Repo C commit")).toBeInTheDocument());

    const tabs = screen.getAllByRole("tab");
    expect(tabs).toHaveLength(3);

    // A burst of alternating clicks fired with zero `await`s between them (`fireEvent`, not
    // `userEvent`, deliberately — it dispatches synchronously and bypasses the `disabled`
    // attribute the same way a real click landing in the tiny window before React has re-rendered
    // that attribute would). Currently active tab is C; this fires A, B, A, C in immediate
    // succession — exactly the "fast alternating clicks, no waits" shape test-agent's repro used.
    fireEvent.click(tabs[0]!);
    fireEvent.click(tabs[1]!);
    fireEvent.click(tabs[0]!);
    fireEvent.click(tabs[2]!);

    // The in-flight-switch guard (`useRepoTabs`'s `switching` lock) means only the *first* click
    // of that burst — the one that actually started a switch — can ever win; every other click in
    // the same burst is dropped rather than queued, so the deterministic outcome is "switched to
    // whatever the first click targeted" (tab A here), not some mismatched hybrid state.
    await waitFor(() => expect(screen.getByText("Repo A commit")).toBeInTheDocument());
    expect(screen.queryByText("Repo B commit")).not.toBeInTheDocument();
    expect(screen.queryByText("Repo C commit")).not.toBeInTheDocument();
    const settledTabs = screen.getAllByRole("tab");
    expect(settledTabs[0]).toHaveAttribute("aria-selected", "true");
    expect(settledTabs[0]).toHaveTextContent("repoA");
    expect(settledTabs[1]).toHaveAttribute("aria-selected", "false");
    expect(settledTabs[2]).toHaveAttribute("aria-selected", "false");

    // The UI recovers afterward — not stuck permanently "switching" — a normal click still works.
    await userEvent.click(settledTabs[2]!);
    await waitFor(() => expect(screen.getByText("Repo C commit")).toBeInTheDocument());
  });
});
