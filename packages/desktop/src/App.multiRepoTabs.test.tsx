import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "./App";
import { makeMockGitHydra } from "./test/mockGitHydra";
import { makeCommit } from "./test/fixtures";
import { persistRightPanel } from "./hooks/useLayoutPreferences";

/** specs/multi-repo-tabs.md: App-level integration coverage for the tab bar's orchestration —
 * tab creation/switch/close, per-tab independent state, and the "one live backend session"
 * architecture decision. Kept in its own file (rather than folded into App.test.tsx) since it's
 * a self-contained pass through all 13 acceptance criteria. */

afterEach(() => {
  // @ts-expect-error test cleanup of the global bridge
  delete window.gitHydra;
  window.localStorage.clear();
});

async function openFirstTab(): Promise<void> {
  await userEvent.click(screen.getByRole("button", { name: /open repository/i }));
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

    vi.mocked(api.openRepoDialog).mockResolvedValueOnce({ ok: true, data: "/repoB" });
    await userEvent.click(screen.getByRole("button", { name: /open a repository in a new tab/i }));

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

  it("AC3: Toolbar's 'Open repository…' replaces only the active tab, leaving other tabs untouched", async () => {
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

    vi.mocked(api.openRepoDialog).mockResolvedValueOnce({ ok: true, data: "/repoB" });
    await userEvent.click(screen.getByRole("button", { name: /open a repository in a new tab/i }));
    await waitFor(() => expect(screen.getByText("Repo B commit")).toBeInTheDocument());

    // Toolbar's existing control now replaces tab B (the active one) with repo C — tab A must
    // still exist afterward, unaffected.
    vi.mocked(api.openRepoDialog).mockResolvedValueOnce({ ok: true, data: "/repoC" });
    await userEvent.click(screen.getByRole("button", { name: /^open repository/i }));
    await waitFor(() => expect(screen.getByText("Repo C commit")).toBeInTheDocument());

    const tabs = screen.getAllByRole("tab");
    expect(tabs).toHaveLength(2);
    expect(tabs[0]).toHaveTextContent("repoA");
    expect(tabs[1]).toHaveTextContent("repoC");

    await userEvent.click(tabs[0]!);
    await waitFor(() => expect(screen.getByText("Repo A commit")).toBeInTheDocument());
  });

  it("AC4: independent filters — tab A's applied filter survives switching to tab B and back", async () => {
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

    await userEvent.click(screen.getByRole("button", { name: /search & filter/i }));
    await userEvent.type(screen.getByLabelText(/^author$/i), "Ada");
    await userEvent.click(screen.getByRole("button", { name: "Search" }));
    await waitFor(() => expect(screen.queryByText("From Bob")).not.toBeInTheDocument());
    expect(screen.getByText("From Ada")).toBeInTheDocument();

    vi.mocked(api.openRepoDialog).mockResolvedValueOnce({ ok: true, data: "/repoB" });
    await userEvent.click(screen.getByRole("button", { name: /open a repository in a new tab/i }));
    await waitFor(() => expect(screen.getByText("Repo B commit")).toBeInTheDocument());

    const tabs = screen.getAllByRole("tab");
    await userEvent.click(tabs[0]!);

    // Tab A's filter field value and filtered result set are both restored, not cleared — and
    // (Bug 2 fix) the disclosure itself is already showing them, not re-collapsed behind an extra
    // click.
    await waitFor(() => expect(screen.getByText("From Ada")).toBeInTheDocument());
    expect(screen.queryByText("From Bob")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /search & filter/i })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByLabelText(/^author$/i)).toHaveValue("Ada");
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
    vi.mocked(api.openRepoDialog).mockResolvedValueOnce({ ok: true, data: "/repoB" });
    await userEvent.click(screen.getByRole("button", { name: /open a repository in a new tab/i }));
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

    vi.mocked(api.openRepoDialog).mockResolvedValueOnce({ ok: true, data: "/repoB" });
    await userEvent.click(screen.getByRole("button", { name: /open a repository in a new tab/i }));
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
    vi.mocked(api.openRepo).mockResolvedValueOnce({
      ok: false,
      error: { name: "NotAGitRepositoryError", message: "not a git repository" },
    });
    await userEvent.click(screen.getByRole("button", { name: /open a repository in a new tab/i }));
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

    vi.mocked(api.openRepoDialog).mockResolvedValueOnce({ ok: true, data: "/repoB" });
    await userEvent.click(screen.getByRole("button", { name: /open a repository in a new tab/i }));
    await waitFor(() => expect(screen.getByText("Repo B commit")).toBeInTheDocument());

    // Close the active tab (B) — the adjacent tab (A) activates automatically.
    const closeB = screen.getByRole("button", { name: /close repoB tab/i });
    await userEvent.click(closeB);
    await waitFor(() => expect(screen.getByText("Repo A commit")).toBeInTheDocument());
    expect(screen.getAllByRole("tab")).toHaveLength(1);

    // AC8: reopening repo B's path afterward (a new tab) starts with no memory of the old
    // selection/filter/panel — the DetailPanel it never itself opened isn't showing.
    vi.mocked(api.openRepoDialog).mockResolvedValueOnce({ ok: true, data: "/repoB" });
    await userEvent.click(screen.getByRole("button", { name: /open a repository in a new tab/i }));
    await waitFor(() => expect(screen.getByText("Repo B commit")).toBeInTheDocument());
    expect(screen.queryByRole("complementary", { name: "Commit details" })).not.toBeInTheDocument();

    // AC9: close both remaining tabs — the window stays mounted, showing the idle empty state.
    const remainingTabs = screen.getAllByRole("tab");
    await userEvent.click(within(screen.getByRole("tablist")).getAllByRole("button", { name: /close .* tab/i })[1]!);
    await waitFor(() => expect(screen.getAllByRole("tab")).toHaveLength(1));
    await userEvent.click(within(screen.getByRole("tablist")).getAllByRole("button", { name: /close .* tab/i })[0]!);

    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(/no repository open/i));
    expect(screen.queryAllByRole("tab")).toHaveLength(0);
    void remainingTabs;
  });

  it("AC10: opening the same repo path in two tabs is allowed; a branch switch in one doesn't affect the other until reactivated", async () => {
    const api = makeMockGitHydra({
      repoPath: "/repoA",
      commits: [makeCommit("a1", [], { subject: "Repo A commit" })],
      localBranches: [
        {
          name: "main",
          fullName: "refs/heads/main",
          tipSha: "a1",
          tipSubject: "",
          tipAuthorName: "",
          tipAuthorEmail: "",
          tipAuthorDate: "",
          tipCommitterDate: "",
          isCurrent: true,
          checkedOutInWorktree: null,
          upstreamName: null,
          upstreamGone: false,
          ahead: null,
          behind: null,
        },
        {
          name: "feature",
          fullName: "refs/heads/feature",
          tipSha: "a1",
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
      ],
    });
    window.gitHydra = api;
    render(<App />);

    await openFirstTab();
    await waitFor(() => expect(screen.getByText("Repo A commit")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: /branches — current branch main/i })).toBeInTheDocument();

    // A second tab pointed at the exact same path — not deduplicated.
    vi.mocked(api.openRepoDialog).mockResolvedValueOnce({ ok: true, data: "/repoA" });
    await userEvent.click(screen.getByRole("button", { name: /open a repository in a new tab/i }));
    await waitFor(() => expect(screen.getAllByRole("tab")).toHaveLength(2));

    // Switch to "feature" from tab 2's Branches sidebar — persistent (design-pass "Branches panel
    // relocation"), so it's already visible with no toggle click needed.
    const featureRow = screen.getByText("feature").closest(".gh-branches-panel__row") as HTMLElement;
    await userEvent.click(within(featureRow).getByRole("button", { name: "Checkout" }));
    await waitFor(() => expect(screen.getByRole("button", { name: /branches — current branch feature/i })).toBeInTheDocument());

    // Tab 1 still shows "main" until it's itself reactivated.
    const tabs = screen.getAllByRole("tab");
    await userEvent.click(tabs[0]!);
    await waitFor(() => expect(screen.getByRole("button", { name: /branches — current branch main/i })).toBeInTheDocument());
  });

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

    vi.mocked(api.openRepoDialog).mockResolvedValueOnce({ ok: true, data: "/repoB" });
    await userEvent.click(screen.getByRole("button", { name: /open a repository in a new tab/i }));
    await waitFor(() => expect(screen.getByText("Repo B commit")).toBeInTheDocument());

    vi.mocked(api.openRepoDialog).mockResolvedValueOnce({ ok: true, data: "/repoC" });
    await userEvent.click(screen.getByRole("button", { name: /open a repository in a new tab/i }));
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
