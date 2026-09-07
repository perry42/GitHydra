// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "./App";
import { makeMockGitHydra } from "./test/mockGitHydra";
import { makeCommit } from "./test/fixtures";
import { addPersistedRecentRepo, getPersistedRecentRepos } from "./hooks/useRecentRepos";

/**
 * specs/repo-list.md: App-level integration coverage for all 11 acceptance criteria (revised IA —
 * see the spec's inline "(Revised...)" markers).
 *
 * AC7/AC8 (no network / no telemetry) are covered by `App.repoList.e2e.test.tsx`'s real,
 * unmocked-git-core proof, mirroring `App.amendNetwork.e2e.test.tsx`'s own convention — this file
 * covers AC1/AC2/AC4/AC5/AC6/AC9/AC10/AC11 (and AC3's wiring) against the fully in-memory mock.
 *
 * Must-have 2/3 (revised IA): there is no more "Open repository…" toolbar action and no more
 * caret/popover — the landing screen (`EmptyState`, reached via the very first tab or a fresh
 * "+ New tab") is the single surface for both "Open a repository" (native dialog) and the
 * "Recent repositories" list. `browseInto`/`newTab` below are this file's two entry points.
 */

afterEach(() => {
  // @ts-expect-error test cleanup of the global bridge
  delete window.gitHydra;
  window.localStorage.clear();
});

/** Bootstraps `path` into whichever tab is currently showing the landing screen (the very first
 * tab, or a blank tab `newTab()` just created) via the real, always-a-dialog "Open a repository"
 * button. */
async function browseInto(api: ReturnType<typeof makeMockGitHydra>, path: string): Promise<void> {
  vi.mocked(api.openRepoDialog).mockResolvedValueOnce({ ok: true, data: path });
  await userEvent.click(screen.getByRole("button", { name: "Open a repository" }));
}

/** `TabBar`'s plain "+ New tab" button — deactivates the current tab (if any) and lands on the
 * idle empty state, with no dialog of its own (specs/repo-list.md Must-have 2/3, revised IA). */
async function newTab(): Promise<void> {
  await userEvent.click(screen.getByRole("button", { name: /open a repository in a new tab/i }));
}

describe("repo-list (specs/repo-list.md)", () => {
  it("AC9: a fresh profile shows no 'Recent repositories' section at all — today's empty state unchanged", () => {
    window.gitHydra = makeMockGitHydra();
    render(<App />);
    expect(screen.getByText("No repository open", { selector: "p.gh-empty-state__title" })).toBeInTheDocument();
    expect(screen.queryByText("Recent repositories")).not.toBeInTheDocument();
    // Non-goal-adjacent: no disclosure caret/popover exists anywhere either.
    expect(screen.queryByRole("button", { name: /recent repositories/i })).not.toBeInTheDocument();
  });

  it("AC1: opening a repo persists it, and a fresh App instance (simulating relaunch) shows it under 'Recent repositories' with no browsing", async () => {
    const api = makeMockGitHydra({ repoPath: "/repoA", commits: [makeCommit("a1", [], { subject: "Repo A commit" })] });
    window.gitHydra = api;
    const { unmount } = render(<App />);
    await browseInto(api, "/repoA");
    await waitFor(() => expect(screen.getByText("Repo A commit")).toBeInTheDocument());
    expect(getPersistedRecentRepos()).toEqual(["/repoA"]);
    // specs/restore-tabs-on-relaunch.md: close the tab before "quitting" so this test isolates
    // the Recent Repositories list's own persistence (this spec's AC1) from that separate,
    // later-added feature's tab-session restoration — with the tab still open at quit time,
    // relaunch would correctly restore and auto-load it instead of landing on the idle screen
    // (that cross-feature interaction has its own coverage in `App.restoreTabs.test.tsx`).
    await userEvent.click(screen.getByRole("button", { name: /close repoA tab/i }));
    await waitFor(() => expect(screen.getByText("No repository open", { selector: "p.gh-empty-state__title" })).toBeInTheDocument());
    unmount();

    // "Relaunch": a fresh App instance against the same (never-cleared-in-this-test) localStorage.
    render(<App />);
    expect(screen.getByText("No repository open", { selector: "p.gh-empty-state__title" })).toBeInTheDocument();
    expect(screen.getByText("Recent repositories")).toBeInTheDocument();
    expect(screen.getByTitle("/repoA")).toBeInTheDocument();
  });

  it("AC2: clicking a recent entry from the initial landing screen opens it directly, with no native dialog", async () => {
    addPersistedRecentRepo("/repoA");
    const api = makeMockGitHydra({ repoPath: "/repoA", commits: [makeCommit("a1", [], { subject: "Repo A commit" })] });
    window.gitHydra = api;
    render(<App />);

    await userEvent.click(screen.getByTitle("/repoA"));
    await waitFor(() => expect(screen.getByText("Repo A commit")).toBeInTheDocument());
    expect(api.openRepoDialog).not.toHaveBeenCalled();
    // Must-have 3: from the empty state, a recent click opens into a (the first) tab.
    expect(screen.getAllByRole("tab")).toHaveLength(1);
  });

  it("AC2/Must-have 3: clicking a recent entry from a freshly-created '+ New tab' landing screen opens it into that tab, with no native dialog", async () => {
    const api = makeMockGitHydra({
      repoPath: "/repoA",
      commits: [makeCommit("a1", [], { subject: "Repo A commit" })],
      reposByPath: {
        "/repoB": { commits: [makeCommit("b1", [], { subject: "Repo B commit" })] },
      },
    });
    window.gitHydra = api;
    render(<App />);
    await browseInto(api, "/repoA");
    await waitFor(() => expect(screen.getByText("Repo A commit")).toBeInTheDocument());
    // Close it so repoA is "recent" but not currently open in any tab — isolates this test from
    // AC4's dedup (covered separately below).
    await userEvent.click(screen.getByRole("button", { name: /close repoA tab/i }));
    await waitFor(() => expect(screen.getByText("No repository open", { selector: "p.gh-empty-state__title" })).toBeInTheDocument());

    await newTab();
    vi.mocked(api.openRepoDialog).mockClear();
    await userEvent.click(screen.getByTitle("/repoA"));
    await waitFor(() => expect(screen.getByText("Repo A commit")).toBeInTheDocument());
    expect(api.openRepoDialog).not.toHaveBeenCalled();
    expect(screen.getAllByRole("tab")).toHaveLength(1);
  });

  it("AC3 (wiring): each real successful open records into the persisted recent list, most-recent-first", async () => {
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
    await browseInto(api, "/repoA");
    await waitFor(() => expect(screen.getByText("Repo A commit")).toBeInTheDocument());
    await newTab();
    await browseInto(api, "/repoB");
    await waitFor(() => expect(screen.getByText("Repo B commit")).toBeInTheDocument());
    await newTab();
    await browseInto(api, "/repoC");
    await waitFor(() => expect(screen.getByText("Repo C commit")).toBeInTheDocument());

    expect(getPersistedRecentRepos()).toEqual(["/repoC", "/repoB", "/repoA"]);
  });

  it("AC4: clicking an already-open repo's recent entry (from a fresh '+ New tab' landing screen) focuses that tab instead of creating a duplicate", async () => {
    const api = makeMockGitHydra({
      repoPath: "/repoA",
      commits: [makeCommit("a1", [], { subject: "Repo A commit" })],
      reposByPath: {
        "/repoB": { commits: [makeCommit("b1", [], { subject: "Repo B commit" })] },
      },
    });
    window.gitHydra = api;
    render(<App />);
    await browseInto(api, "/repoA");
    await waitFor(() => expect(screen.getByText("Repo A commit")).toBeInTheDocument());
    await newTab();
    await browseInto(api, "/repoB");
    await waitFor(() => expect(screen.getByText("Repo B commit")).toBeInTheDocument());
    expect(screen.getAllByRole("tab")).toHaveLength(2);

    // repoA is already open in tab 1 (now in the background) — "+ New tab" again, then clicking
    // repoA's recent entry there must focus tab 1, not create a third tab. Scoped within the
    // "Recent repositories" list: both it and tab 1's own tab button share the same `title`
    // attribute (the full repo path) once tab 1 exists, so an unscoped `getByTitle` is ambiguous.
    await newTab();
    vi.mocked(api.openRepoDialog).mockClear();
    await userEvent.click(within(screen.getByRole("list")).getByTitle("/repoA"));

    await waitFor(() => expect(screen.getByText("Repo A commit")).toBeInTheDocument());
    expect(api.openRepoDialog).not.toHaveBeenCalled();
    const tabs = screen.getAllByRole("tab");
    expect(tabs).toHaveLength(2);
    expect(tabs[0]).toHaveAttribute("aria-selected", "true");
    expect(tabs[1]).toHaveAttribute("aria-selected", "false");
  });

  it("AC5 (revised — dedup is now global, not recent-list-only): manually browsing to a path already open in another tab focuses that tab instead of creating a duplicate", async () => {
    const api = makeMockGitHydra({
      repoPath: "/repoA",
      commits: [makeCommit("a1", [], { subject: "Repo A commit" })],
      reposByPath: {
        "/repoB": { commits: [makeCommit("b1", [], { subject: "Repo B commit" })] },
      },
    });
    window.gitHydra = api;
    render(<App />);
    await browseInto(api, "/repoA");
    await waitFor(() => expect(screen.getByText("Repo A commit")).toBeInTheDocument());
    await newTab();
    await browseInto(api, "/repoB");
    await waitFor(() => expect(screen.getByText("Repo B commit")).toBeInTheDocument());
    expect(screen.getAllByRole("tab")).toHaveLength(2);

    // "+ New tab" again, then manually browse (native-dialog path, NOT a recent-list click) to the
    // exact same path already open in tab 1 — AC5's global dedup must fire here too.
    await newTab();
    await browseInto(api, "/repoA");

    await waitFor(() => expect(screen.getByText("Repo A commit")).toBeInTheDocument());
    const tabs = screen.getAllByRole("tab");
    expect(tabs).toHaveLength(2);
    expect(tabs[0]).toHaveTextContent("repoA");
    expect(tabs[0]).toHaveAttribute("aria-selected", "true");
    expect(tabs[1]).toHaveAttribute("aria-selected", "false");
  });

  it("AC6: a recent entry that fails to open shows an inline 'not found' state with 'Try again' and 'Remove', leaving other entries and tabs untouched", async () => {
    addPersistedRecentRepo("/repoGone");
    addPersistedRecentRepo("/repoA");
    const api = makeMockGitHydra({ repoPath: "/repoA", commits: [makeCommit("a1", [], { subject: "Repo A commit" })] });
    window.gitHydra = api;
    render(<App />);

    vi.mocked(api.openRepoCancellable).mockResolvedValueOnce({
      outcome: "settled",
      result: { ok: false, error: { name: "NotAGitRepositoryError", message: "no longer a valid git repository" } },
    });

    await userEvent.click(screen.getByTitle("/repoGone"));

    await waitFor(() => expect(screen.getByText(/not found/i)).toBeInTheDocument());
    expect(screen.getByRole("button", { name: /try again/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /remove from list/i })).toBeInTheDocument();
    // Never a silent failure/navigation — still the idle empty state, still zero tabs.
    expect(screen.getByText("No repository open", { selector: "p.gh-empty-state__title" })).toBeInTheDocument();
    expect(screen.queryAllByRole("tab")).toHaveLength(0);
    // The other entry is completely unaffected.
    expect(screen.getByTitle("/repoA")).toBeInTheDocument();

    // "Try again" re-attempts the same path — still not found (no retry-count limit, no error
    // dialog on a repeat failure), the not-found state simply keeps showing.
    vi.mocked(api.openRepoCancellable).mockResolvedValueOnce({
      outcome: "settled",
      result: { ok: false, error: { name: "NotAGitRepositoryError", message: "no longer a valid git repository" } },
    });
    await userEvent.click(screen.getByRole("button", { name: /try again/i }));
    await waitFor(() => expect(screen.getByText(/not found/i)).toBeInTheDocument());
    expect(screen.queryAllByRole("tab")).toHaveLength(0);

    await userEvent.click(screen.getByRole("button", { name: /remove from list/i }));
    expect(screen.queryByTitle("/repoGone")).not.toBeInTheDocument();
    expect(screen.getByTitle("/repoA")).toBeInTheDocument();
    expect(getPersistedRecentRepos()).toEqual(["/repoA"]);

    // The remaining entry still opens normally afterward.
    await userEvent.click(screen.getByTitle("/repoA"));
    await waitFor(() => expect(screen.getByText("Repo A commit")).toBeInTheDocument());
  });

  it("AC6 (Try again succeeding): a transient not-found path opens normally once 'Try again' is clicked and the path is valid again", async () => {
    addPersistedRecentRepo("/repoFlaky");
    const api = makeMockGitHydra({ repoPath: "/repoFlaky", commits: [makeCommit("a1", [], { subject: "Flaky commit" })] });
    window.gitHydra = api;
    render(<App />);

    vi.mocked(api.openRepoCancellable).mockResolvedValueOnce({
      outcome: "settled",
      result: { ok: false, error: { name: "NotAGitRepositoryError", message: "no longer a valid git repository" } },
    });
    await userEvent.click(screen.getByTitle("/repoFlaky"));
    await waitFor(() => expect(screen.getByText(/not found/i)).toBeInTheDocument());

    // The mock's default `openRepoCancellable` resolves successfully for this next attempt.
    await userEvent.click(screen.getByRole("button", { name: /try again/i }));
    await waitFor(() => expect(screen.getByText("Flaky commit")).toBeInTheDocument());
    expect(screen.getAllByRole("tab")).toHaveLength(1);
  });

  // security-reviewer/test-agent: AC6's "restore, don't navigate away" behavior — a not-found
  // recent-list click on a freshly-blanked "+ New tab" landing screen must not disturb a different,
  // already-open background tab. specs/repo-list.md's revised IA retired the old "replace the
  // active tab in place" restore path this describe block used to also cover (that entry point no
  // longer exists — see `openRecentInActiveTab`'s removal) — only the "+ New tab" path remains.
  it("AC6 (restore-on-failure correctness): a not-found recent click from a fresh '+ New tab' landing screen leaves an already-open background tab completely untouched", async () => {
    addPersistedRecentRepo("/repoGone");
    const api = makeMockGitHydra({ repoPath: "/repoA", commits: [makeCommit("a1", [], { subject: "Repo A commit" })] });
    window.gitHydra = api;
    render(<App />);
    await browseInto(api, "/repoA");
    await waitFor(() => expect(screen.getByText("Repo A commit")).toBeInTheDocument());
    expect(screen.getAllByRole("tab")).toHaveLength(1);

    await newTab();
    vi.mocked(api.openRepoCancellable).mockResolvedValueOnce({
      outcome: "settled",
      result: { ok: false, error: { name: "NotAGitRepositoryError", message: "no longer a valid git repository" } },
    });
    await userEvent.click(screen.getByTitle("/repoGone"));

    await waitFor(() => expect(screen.getByText(/not found/i)).toBeInTheDocument());
    // Stays on the idle landing screen — "+ New tab" already deliberately backgrounded tab A
    // before any dialog was opened, so a failed attempt here has no "active tab" to fall back to.
    expect(screen.queryByText(/could not open this repository/i)).not.toBeInTheDocument();
    expect(screen.queryByText("Repo A commit")).not.toBeInTheDocument();

    // Tab A itself is completely unaffected — still present, still reactivatable with its real data.
    const tabs = screen.getAllByRole("tab");
    expect(tabs).toHaveLength(1);
    expect(tabs[0]).toHaveTextContent("repoA");
    expect(tabs[0]).toHaveAttribute("aria-selected", "false");
    await userEvent.click(tabs[0]!);
    await waitFor(() => expect(screen.getByText("Repo A commit")).toBeInTheDocument());
  });

  it("AC10: no 'Open repository…' toolbar action, popover, or modal exists anywhere — 'Open a repository' on the landing screen is the only surface", async () => {
    const api = makeMockGitHydra({ repoPath: "/repoA", commits: [makeCommit("a1", [], { subject: "Repo A commit" })] });
    window.gitHydra = api;
    render(<App />);
    expect(screen.queryByRole("button", { name: /^open repository/i })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open a repository" })).toBeInTheDocument();

    await browseInto(api, "/repoA");
    await waitFor(() => expect(screen.getByText("Repo A commit")).toBeInTheDocument());
    // Still true once a repo is open — Toolbar carries no such control at any point.
    expect(screen.queryByRole("button", { name: /^open repository/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("AC11: the landing screen shows a visually reserved 'Clone a repository' action that is permanently disabled, alongside 'Open a repository'", () => {
    window.gitHydra = makeMockGitHydra();
    render(<App />);
    expect(screen.getByRole("button", { name: "Open a repository" })).toBeEnabled();
    expect(screen.getByRole("button", { name: /clone a repository/i })).toBeDisabled();
  });
});
