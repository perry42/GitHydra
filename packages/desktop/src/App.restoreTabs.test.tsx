// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "./App";
import { makeMockGitHydra } from "./test/mockGitHydra";
import { makeCommit } from "./test/fixtures";

/**
 * specs/restore-tabs-on-relaunch.md: App-level integration coverage for the 10 acceptance
 * criteria, against the fully in-memory mock — mirrors `App.repoList.test.tsx`'s own "simulated
 * relaunch" style (a fresh `<App/>` instance against the same never-cleared `localStorage`).
 * AC3/AC8 (zero git-process-spawn/network calls for inactive restored tabs) get their own real,
 * unmocked-git-core proof in `App.restoreTabs.e2e.test.tsx`, mirroring
 * `App.repoList.e2e.test.tsx`'s split; this file covers AC3's wiring via the mock's own call-count
 * spy (`api.openRepoCancellable`), same technique this suite already uses elsewhere.
 */

afterEach(() => {
  // @ts-expect-error test cleanup of the global bridge
  delete window.gitHydra;
  window.localStorage.clear();
});

async function browseInto(api: ReturnType<typeof makeMockGitHydra>, path: string): Promise<void> {
  vi.mocked(api.openRepoDialog).mockResolvedValueOnce({ ok: true, data: path });
  await userEvent.click(screen.getByRole("button", { name: "Open a repository" }));
}

async function newTab(): Promise<void> {
  await userEvent.click(screen.getByRole("button", { name: /open a repository in a new tab/i }));
}

describe("restore-tabs-on-relaunch (specs/restore-tabs-on-relaunch.md)", () => {
  it("AC1/AC2/AC3: relaunch rebuilds all 3 tabs in order on the first render, auto-loads only the previously-active one, and makes exactly one open call", async () => {
    const api = makeMockGitHydra({
      repoPath: "/repoA",
      commits: [makeCommit("a1", [], { subject: "Repo A commit" })],
      reposByPath: {
        "/repoB": { commits: [makeCommit("b1", [], { subject: "Repo B commit" })] },
        "/repoC": { commits: [makeCommit("c1", [], { subject: "Repo C commit" })] },
      },
    });
    window.gitHydra = api;
    const { unmount } = render(<App />);
    await browseInto(api, "/repoA");
    await waitFor(() => expect(screen.getByText("Repo A commit")).toBeInTheDocument());
    await newTab();
    await browseInto(api, "/repoB");
    await waitFor(() => expect(screen.getByText("Repo B commit")).toBeInTheDocument());
    await newTab();
    await browseInto(api, "/repoC");
    await waitFor(() => expect(screen.getByText("Repo C commit")).toBeInTheDocument());
    expect(screen.getAllByRole("tab")).toHaveLength(3);
    unmount();

    // "Relaunch": a fresh App instance against the same (never-cleared-in-this-test) localStorage
    // and the same mock backend — reset the call spy right at the simulated quit boundary so only
    // relaunch-caused calls are counted below (AC3).
    vi.mocked(api.openRepoCancellable).mockClear();
    render(<App />);

    // AC1: same 3 tabs, same order, on the very first render.
    const tabs = screen.getAllByRole("tab");
    expect(tabs).toHaveLength(3);
    expect(tabs[0]).toHaveTextContent("repoA");
    expect(tabs[1]).toHaveTextContent("repoB");
    expect(tabs[2]).toHaveTextContent("repoC");
    expect(tabs[2]).toHaveAttribute("aria-selected", "true");
    expect(tabs[0]).toHaveAttribute("aria-selected", "false");
    expect(tabs[1]).toHaveAttribute("aria-selected", "false");

    // AC2: repoC's (the previously-active tab) commit graph loads with no user interaction.
    await waitFor(() => expect(screen.getByText("Repo C commit")).toBeInTheDocument());

    // AC3: exactly one open call total — repoA/repoB were never touched.
    expect(api.openRepoCancellable).toHaveBeenCalledTimes(1);
    expect(vi.mocked(api.openRepoCancellable).mock.calls[0]![0]).toBe("/repoC");
  });

  it("AC4: clicking an inactive restored tab loads it exactly like an ordinary tab switch, replaying its remembered selectedSha (DetailPanel reopens)", async () => {
    const api = makeMockGitHydra({
      repoPath: "/repoA",
      commits: [makeCommit("a1", [], { subject: "Repo A commit" })],
      reposByPath: {
        "/repoB": { commits: [makeCommit("b1", [], { subject: "Repo B commit" })] },
      },
    });
    window.gitHydra = api;
    const { unmount } = render(<App />);
    await browseInto(api, "/repoA");
    await waitFor(() => expect(screen.getByText("Repo A commit")).toBeInTheDocument());
    // Select the commit — opens DetailPanel, tab-scoped state (FR-211).
    await userEvent.click(screen.getByText("Repo A commit"));
    expect(await screen.findByRole("complementary", { name: "Commit details" })).toBeInTheDocument();

    await newTab();
    await browseInto(api, "/repoB");
    await waitFor(() => expect(screen.getByText("Repo B commit")).toBeInTheDocument());
    unmount();

    render(<App />);
    await waitFor(() => expect(screen.getByText("Repo B commit")).toBeInTheDocument());
    // Not yet activated — no DetailPanel from repoA showing (nothing has loaded it back).
    expect(screen.queryByRole("complementary", { name: "Commit details" })).not.toBeInTheDocument();

    const tabs = screen.getAllByRole("tab");
    await userEvent.click(tabs[0]!); // repoA
    await waitFor(() => expect(screen.getByText("Repo A commit")).toBeInTheDocument());
    expect(await screen.findByRole("complementary", { name: "Commit details" })).toBeInTheDocument();
  });

  it("AC5: a restored tab whose path no longer resolves shows the inline not-found state on activation, without a crash or losing the rest of the session", async () => {
    const api = makeMockGitHydra({
      repoPath: "/repoGone",
      reposByPath: {
        "/repoA": { commits: [makeCommit("a1", [], { subject: "Repo A commit" })] },
      },
    });
    window.gitHydra = api;
    const { unmount } = render(<App />);
    await browseInto(api, "/repoGone");
    await waitFor(() => expect(screen.getByRole("tab")).toBeInTheDocument());
    await newTab();
    await browseInto(api, "/repoA");
    await waitFor(() => expect(screen.getByText("Repo A commit")).toBeInTheDocument());
    unmount();

    render(<App />);
    await waitFor(() => expect(screen.getByText("Repo A commit")).toBeInTheDocument());

    vi.mocked(api.openRepoCancellable).mockResolvedValueOnce({
      outcome: "settled",
      result: { ok: false, error: { name: "NotAGitRepositoryError", message: "no longer a valid git repository" } },
    });
    const tabs = screen.getAllByRole("tab");
    await userEvent.click(within(screen.getByRole("tablist")).getByText("repoGone"));

    await waitFor(() => expect(screen.getByText("Repository not found")).toBeInTheDocument());
    expect(screen.getByRole("alert")).toHaveTextContent(/not found/i);
    expect(screen.getByRole("button", { name: /try again/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /remove from list/i })).toBeInTheDocument();
    // Never the app-wide error screen, never a crash.
    expect(screen.queryByText(/could not open this repository/i)).not.toBeInTheDocument();
    // The rest of the session is untouched — both tabs still present.
    expect(screen.getAllByRole("tab")).toHaveLength(2);
    expect(tabs[0]).toHaveTextContent("repoGone");

    // "Remove from list" discards it; the other tab is unaffected and still reachable.
    await userEvent.click(screen.getByRole("button", { name: /remove from list/i }));
    expect(screen.queryByText("repoGone")).not.toBeInTheDocument();
    expect(screen.getAllByRole("tab")).toHaveLength(1);
    await userEvent.click(screen.getAllByRole("tab")[0]!);
    await waitFor(() => expect(screen.getByText("Repo A commit")).toBeInTheDocument());
  });

  it("AC6: quitting with zero tabs open shows the empty landing screen again on relaunch, never a phantom tab", async () => {
    window.gitHydra = makeMockGitHydra();
    const { unmount } = render(<App />);
    expect(screen.getByText("No repository open", { selector: "p.gh-empty-state__title" })).toBeInTheDocument();
    unmount();

    render(<App />);
    expect(screen.getByText("No repository open", { selector: "p.gh-empty-state__title" })).toBeInTheDocument();
    expect(screen.queryAllByRole("tab")).toHaveLength(0);
  });

  it("AC7: quitting on the blank '+ New tab' landing screen (with a real tab backgrounded) restores that tab unfocused, landing screen on top", async () => {
    const api = makeMockGitHydra({ repoPath: "/repoA", commits: [makeCommit("a1", [], { subject: "Repo A commit" })] });
    window.gitHydra = api;
    const { unmount } = render(<App />);
    await browseInto(api, "/repoA");
    await waitFor(() => expect(screen.getByText("Repo A commit")).toBeInTheDocument());
    await newTab();
    await waitFor(() => expect(screen.getByText("No repository open", { selector: "p.gh-empty-state__title" })).toBeInTheDocument());
    unmount();

    vi.mocked(api.openRepoCancellable).mockClear();
    render(<App />);

    // Landing screen on top — not repoA's content.
    expect(screen.getByText("No repository open", { selector: "p.gh-empty-state__title" })).toBeInTheDocument();
    expect(screen.queryByText("Repo A commit")).not.toBeInTheDocument();
    // repoA's tab is still there, restored, just unfocused.
    const tabs = screen.getAllByRole("tab");
    expect(tabs).toHaveLength(1);
    expect(tabs[0]).toHaveTextContent("repoA");
    expect(tabs[0]).toHaveAttribute("aria-selected", "false");
    // Never silently refocused/reopened.
    expect(api.openRepoCancellable).not.toHaveBeenCalled();

    await userEvent.click(tabs[0]!);
    await waitFor(() => expect(screen.getByText("Repo A commit")).toBeInTheDocument());
  });

  it("AC10: an unavailable localStorage falls back to today's behavior (empty landing screen), never a crash", async () => {
    const api = makeMockGitHydra({ repoPath: "/repoA", commits: [makeCommit("a1", [], { subject: "Repo A commit" })] });
    window.gitHydra = api;
    const { unmount } = render(<App />);
    await browseInto(api, "/repoA");
    await waitFor(() => expect(screen.getByText("Repo A commit")).toBeInTheDocument());
    unmount();

    // jsdom's `localStorage` doesn't let a plain `window.localStorage.getItem = fn`
    // reassignment actually take effect (its `getItem`/`setItem` are routed through the Storage
    // interface regardless of own-property overrides) — replacing the whole `window.localStorage`
    // property is what genuinely simulates "unavailable" here, mirroring a real private/sandboxed
    // browsing context throwing on `localStorage` access at all.
    const originalStorage = window.localStorage;
    const throwing = {
      getItem: () => {
        throw new Error("localStorage unavailable (private/sandboxed mode)");
      },
      setItem: () => {
        throw new Error("localStorage unavailable (private/sandboxed mode)");
      },
    };
    Object.defineProperty(window, "localStorage", { value: throwing, configurable: true, writable: true });
    try {
      expect(() => render(<App />)).not.toThrow();
      expect(screen.getByText("No repository open", { selector: "p.gh-empty-state__title" })).toBeInTheDocument();
      expect(screen.queryAllByRole("tab")).toHaveLength(0);
    } finally {
      Object.defineProperty(window, "localStorage", { value: originalStorage, configurable: true, writable: true });
    }
  });
});
