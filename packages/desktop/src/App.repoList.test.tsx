import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "./App";
import { makeMockGitHydra } from "./test/mockGitHydra";
import { makeCommit } from "./test/fixtures";
import { addPersistedRecentRepo, getPersistedRecentRepos } from "./hooks/useRecentRepos";

/**
 * specs/repo-list.md: App-level integration coverage for all 9 acceptance criteria.
 *
 * AC3 (the 20-entry cap/eviction) and most of the raw persistence mechanics (Must-have 1) are
 * covered exhaustively at the hook level in `hooks/useRecentRepos.test.ts` — this file only
 * re-proves the App-level *wiring* of AC3 (a real successful `openRepo` actually records into the
 * list). AC7/AC8 (no network / no telemetry) are covered by `App.repoList.e2e.test.tsx`'s real,
 * unmocked-git-core proof, mirroring `App.amendNetwork.e2e.test.tsx`'s own convention — this file
 * covers AC1/AC2/AC4/AC5/AC6/AC9 (and AC3's wiring) against the fully in-memory mock.
 *
 * Must-have 2's split-button design (see `OpenRepoMenu`'s own doc comment): "+ New tab" and
 * "Open repository…"'s existing trigger buttons ALWAYS open the native dialog directly, with or
 * without recent repos — the recent list is reached through a separate, adjacent disclosure caret
 * (`aria-label` "Recent repositories — new tab" / "Recent repositories — open repository"),
 * rendered only once there's at least one recent repo. This is why `openInNewTab`/`openInActiveTab`
 * below never need to branch on whether recents already exist.
 */

afterEach(() => {
  // @ts-expect-error test cleanup of the global bridge
  delete window.gitHydra;
  window.localStorage.clear();
});

/** Opens `path` into a brand-new tab via "+ New tab"'s (always-dialog) trigger — a real, undeduped
 * new tab regardless of how many repos have already been opened earlier in the same test. */
async function openInNewTab(api: ReturnType<typeof makeMockGitHydra>, path: string): Promise<void> {
  vi.mocked(api.openRepoDialog).mockResolvedValueOnce({ ok: true, data: path });
  await userEvent.click(screen.getByRole("button", { name: /open a repository in a new tab/i }));
}

/** Replaces the active tab's repo via Toolbar's (always-dialog) "Open repository…" trigger. */
async function openInActiveTab(api: ReturnType<typeof makeMockGitHydra>, path: string): Promise<void> {
  vi.mocked(api.openRepoDialog).mockResolvedValueOnce({ ok: true, data: path });
  await userEvent.click(screen.getByRole("button", { name: /^open repository/i }));
}

describe("repo-list (specs/repo-list.md)", () => {
  it("AC9: a fresh profile shows no 'Recent repositories' section at all — today's empty state unchanged", () => {
    window.gitHydra = makeMockGitHydra();
    render(<App />);
    expect(screen.getByText("No repository open", { selector: "p.gh-empty-state__title" })).toBeInTheDocument();
    expect(screen.queryByText("Recent repositories")).not.toBeInTheDocument();
    // Non-goal-adjacent: no disclosure caret exists yet either, on either control.
    expect(screen.queryByRole("button", { name: /recent repositories/i })).not.toBeInTheDocument();
  });

  it("AC1: opening a repo persists it, and a fresh App instance (simulating relaunch) shows it under 'Recent repositories' with no browsing", async () => {
    const api = makeMockGitHydra({ repoPath: "/repoA", commits: [makeCommit("a1", [], { subject: "Repo A commit" })] });
    window.gitHydra = api;
    const { unmount } = render(<App />);
    await openInActiveTab(api, "/repoA");
    await waitFor(() => expect(screen.getByText("Repo A commit")).toBeInTheDocument());
    expect(getPersistedRecentRepos()).toEqual(["/repoA"]);
    unmount();

    // "Relaunch": a fresh App instance against the same (never-cleared-in-this-test) localStorage.
    render(<App />);
    expect(screen.getByText("No repository open", { selector: "p.gh-empty-state__title" })).toBeInTheDocument();
    expect(screen.getByText("Recent repositories")).toBeInTheDocument();
    expect(screen.getByTitle("/repoA")).toBeInTheDocument();
  });

  it("AC2: clicking a recent entry from the empty state opens it directly, with no native dialog", async () => {
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

  it("AC2/Must-have 3: clicking a recent entry from '+ New tab's caret opens a new tab (or focuses an existing one); from 'Open repository…'s caret it replaces/focuses — both with no native dialog", async () => {
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
    await openInNewTab(api, "/repoA");
    await waitFor(() => expect(screen.getByText("Repo A commit")).toBeInTheDocument());
    await openInNewTab(api, "/repoB");
    await waitFor(() => expect(screen.getByText("Repo B commit")).toBeInTheDocument());
    // Recents are now ["/repoB", "/repoA"], two tabs open.

    vi.mocked(api.openRepoDialog).mockClear();

    // "+ New tab"'s caret opens the recent-repos popover, not the dialog.
    await userEvent.click(screen.getByRole("button", { name: /recent repositories — new tab/i }));
    const newTabPopover = await screen.findByRole("group", { name: /recent repositories — new tab/i });
    // repoA is already open in tab 1 — AC4 dedup fires: tab 1 is focused, no third tab created.
    await userEvent.click(within(newTabPopover).getByTitle("/repoA"));
    await waitFor(() => expect(screen.getByText("Repo A commit")).toBeInTheDocument());
    expect(screen.getAllByRole("tab")).toHaveLength(2);
    expect(api.openRepoDialog).not.toHaveBeenCalled();

    // Toolbar's "Open repository…" caret — repoB is already open in tab 2, so clicking it here
    // must focus tab 2 rather than replacing tab 1 (still the active tab).
    await userEvent.click(screen.getByRole("button", { name: /recent repositories — open repository/i }));
    const openRepoPopover = await screen.findByRole("group", { name: /recent repositories — open repository/i });
    await userEvent.click(within(openRepoPopover).getByTitle("/repoB"));
    await waitFor(() => expect(screen.getByText("Repo B commit")).toBeInTheDocument());
    const tabs = screen.getAllByRole("tab");
    expect(tabs).toHaveLength(2);
    expect(tabs[1]).toHaveAttribute("aria-selected", "true");
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
    await openInActiveTab(api, "/repoA");
    await waitFor(() => expect(screen.getByText("Repo A commit")).toBeInTheDocument());
    await openInActiveTab(api, "/repoB");
    await waitFor(() => expect(screen.getByText("Repo B commit")).toBeInTheDocument());
    await openInActiveTab(api, "/repoC");
    await waitFor(() => expect(screen.getByText("Repo C commit")).toBeInTheDocument());

    expect(getPersistedRecentRepos()).toEqual(["/repoC", "/repoB", "/repoA"]);
  });

  it("AC4: clicking an already-open repo's recent entry focuses that tab instead of creating a duplicate", async () => {
    const api = makeMockGitHydra({
      repoPath: "/repoA",
      commits: [makeCommit("a1", [], { subject: "Repo A commit" })],
      reposByPath: {
        "/repoB": { commits: [makeCommit("b1", [], { subject: "Repo B commit" })] },
      },
    });
    window.gitHydra = api;
    render(<App />);
    await openInNewTab(api, "/repoA");
    await waitFor(() => expect(screen.getByText("Repo A commit")).toBeInTheDocument());
    await openInNewTab(api, "/repoB");
    await waitFor(() => expect(screen.getByText("Repo B commit")).toBeInTheDocument());
    expect(screen.getAllByRole("tab")).toHaveLength(2);

    // repoA is already open in tab 1 — clicking it from "+ New tab"'s recent menu must focus tab 1,
    // not create a third tab.
    await userEvent.click(screen.getByRole("button", { name: /recent repositories — new tab/i }));
    const popover = await screen.findByRole("group", { name: /recent repositories — new tab/i });
    await userEvent.click(within(popover).getByTitle("/repoA"));

    await waitFor(() => expect(screen.getByText("Repo A commit")).toBeInTheDocument());
    const tabs = screen.getAllByRole("tab");
    expect(tabs).toHaveLength(2);
    expect(tabs[0]).toHaveAttribute("aria-selected", "true");
    expect(tabs[1]).toHaveAttribute("aria-selected", "false");
  });

  it("AC5: two tabs opened by manually browsing to the same path stay both open — dedup never applies to a manual Browse click", async () => {
    const api = makeMockGitHydra({
      repoPath: "/repoB",
      commits: [makeCommit("b1", [], { subject: "Repo B commit" })],
    });
    window.gitHydra = api;
    render(<App />);
    await openInActiveTab(api, "/repoB");
    await waitFor(() => expect(screen.getByText("Repo B commit")).toBeInTheDocument());
    expect(screen.getAllByRole("tab")).toHaveLength(1);

    // Recents now has exactly one entry ("/repoB") — using "+ New tab"'s own (always-dialog)
    // trigger to open the SAME path again (never a recent-list click) must still create a second,
    // undeduped tab.
    await openInNewTab(api, "/repoB");

    await waitFor(() => expect(screen.getAllByRole("tab")).toHaveLength(2));
    const tabs = screen.getAllByRole("tab");
    expect(tabs[0]).toHaveTextContent("repoB");
    expect(tabs[1]).toHaveTextContent("repoB");
    expect(tabs[1]).toHaveAttribute("aria-selected", "true");
  });

  it("AC6: a recent entry that fails to open shows an inline 'not found' + 'remove from list' state, leaving other entries and tabs untouched", async () => {
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
    expect(screen.getByRole("button", { name: /remove from list/i })).toBeInTheDocument();
    // Never a silent failure/navigation — still the idle empty state, still zero tabs.
    expect(screen.getByText("No repository open", { selector: "p.gh-empty-state__title" })).toBeInTheDocument();
    expect(screen.queryAllByRole("tab")).toHaveLength(0);
    // The other entry is completely unaffected.
    expect(screen.getByTitle("/repoA")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /remove from list/i }));
    expect(screen.queryByTitle("/repoGone")).not.toBeInTheDocument();
    expect(screen.getByTitle("/repoA")).toBeInTheDocument();
    expect(getPersistedRecentRepos()).toEqual(["/repoA"]);

    // The remaining entry still opens normally afterward.
    await userEvent.click(screen.getByTitle("/repoA"));
    await waitFor(() => expect(screen.getByText("Repo A commit")).toBeInTheDocument());
  });

  // security-reviewer/test-agent: AC6's "restore, don't navigate away" behavior previously only
  // had coverage for `restoreGraphAfterFailedRecentOpen(null)` (the zero-tabs bootstrap path,
  // via `closeRepo()`) — the populated-tab-restore branch (a not-found click while a *different*
  // repo is already the active tab, the actual re-open-real-prior-content path) had none. These
  // two tests cover it from both callers that can reach it: "+ New tab" (`openRecentInNewTab`,
  // AC4/AC6 with an existing active tab) and "Open repository…" (`openRecentInActiveTab`,
  // replacing the active tab). Both assert the active tab's real, correct data is showing
  // afterward — never the app-wide "Could not open this repository" screen.
  describe("AC6 (restore-on-failure correctness): a not-found recent click while a different repo is already active restores that repo's real content", () => {
    async function setUpRepoAWithGoneEntry() {
      // Seeded before render so both "+ New tab"'s and "Open repository…"'s carets already exist
      // by the time repo A is opened (a caret only renders once recents are non-empty).
      addPersistedRecentRepo("/repoGone");
      const api = makeMockGitHydra({ repoPath: "/repoA", commits: [makeCommit("a1", [], { subject: "Repo A commit" })] });
      window.gitHydra = api;
      render(<App />);
      // A single click on the always-dialog trigger — the mock's default `openRepoDialog` already
      // resolves to `/repoA` (the configured `repoPath`) — opens exactly one tab, repo A active.
      await userEvent.click(screen.getByRole("button", { name: /open a repository in a new tab/i }));
      await waitFor(() => expect(screen.getByText("Repo A commit")).toBeInTheDocument());
      expect(screen.getAllByRole("tab")).toHaveLength(1);

      vi.mocked(api.openRepoCancellable).mockResolvedValueOnce({
        outcome: "settled",
        result: { ok: false, error: { name: "NotAGitRepositoryError", message: "no longer a valid git repository" } },
      });
      return api;
    }

    it("via '+ New tab's recent menu: the active tab (repo A) is restored, still showing its real commit graph", async () => {
      await setUpRepoAWithGoneEntry();

      await userEvent.click(screen.getByRole("button", { name: /recent repositories — new tab/i }));
      const popover = await screen.findByRole("group", { name: /recent repositories — new tab/i });
      await userEvent.click(within(popover).getByTitle("/repoGone"));

      await waitFor(() => expect(within(popover).getByText(/not found/i)).toBeInTheDocument());
      await userEvent.keyboard("{Escape}");

      // The active tab is exactly as it was before the failed attempt — real content, not the
      // app-wide error screen, and no extra tab was left behind.
      expect(screen.getByText("Repo A commit")).toBeInTheDocument();
      expect(screen.queryByText(/could not open this repository/i)).not.toBeInTheDocument();
      const tabs = screen.getAllByRole("tab");
      expect(tabs).toHaveLength(1);
      expect(tabs[0]).toHaveTextContent("repoA");
      expect(tabs[0]).toHaveAttribute("aria-selected", "true");
    });

    it("via 'Open repository…'s recent menu: the active tab (repo A) is restored, still showing its real commit graph", async () => {
      await setUpRepoAWithGoneEntry();

      await userEvent.click(screen.getByRole("button", { name: /recent repositories — open repository/i }));
      const popover = await screen.findByRole("group", { name: /recent repositories — open repository/i });
      await userEvent.click(within(popover).getByTitle("/repoGone"));

      await waitFor(() => expect(within(popover).getByText(/not found/i)).toBeInTheDocument());
      await userEvent.keyboard("{Escape}");

      expect(screen.getByText("Repo A commit")).toBeInTheDocument();
      expect(screen.queryByText(/could not open this repository/i)).not.toBeInTheDocument();
      const tabs = screen.getAllByRole("tab");
      expect(tabs).toHaveLength(1);
      expect(tabs[0]).toHaveTextContent("repoA");
      expect(tabs[0]).toHaveAttribute("aria-selected", "true");
    });
  });
});
