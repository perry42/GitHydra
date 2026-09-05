import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "./App";
import { makeMockGitHydra } from "./test/mockGitHydra";
import { makeCommit, makeRepoState } from "./test/fixtures";
import type { IpcResult, OpenRepoOutcome } from "../shared/ipcContract";
import type { RepositoryState } from "@githydra/git-core";

/**
 * specs/repo-open-feedback.md FR-167/FR-168/FR-169/FR-170: the spinner's Cancel affordance,
 * exercised through the real UI (`TabBar`'s "+ New tab" / `EmptyState`'s "Open a repository")
 * rather than the hook directly — see `useRepositoryGraph.cancelOpen.test.ts` for the lower-level
 * state-restoration coverage this complements. AC references below are this spec's own
 * (`specs/repo-open-feedback.md`).
 *
 * specs/repo-list.md (revised IA): this file used to also exercise canceling `Toolbar`'s
 * "Open repository…" control, which replaced the active tab's repo in place — that control is
 * retired. The equivalent path is now "+ New tab" (deactivates the current tab, landing on the
 * idle empty state with no dialog of its own) followed by that landing screen's own
 * "Open a repository" (the real dialog-launcher) — see `openNewTabButton`/`openRepoButton` below.
 */

afterEach(() => {
  // @ts-expect-error test cleanup of the global bridge
  delete window.gitHydra;
  window.localStorage.clear();
});

/** Mirrors `App.repoOpenElapsed.test.tsx`'s helper — a controllable, never-auto-resolving stand-in
 * for `api.openRepoCancellable`, plus a way to simulate the eventual `{ outcome: "cancelled" }`
 * resolution a real `cancelOpenRepo(requestId)` call causes once it wins the race. */
function deferredOpenRepoCancellable(): {
  promise: Promise<OpenRepoOutcome>;
  resolveSettled: (result: IpcResult<{ path: string; state: RepositoryState }>) => void;
  resolveCancelled: () => void;
} {
  let resolve!: (outcome: OpenRepoOutcome) => void;
  const promise = new Promise<OpenRepoOutcome>((res) => {
    resolve = res;
  });
  return {
    promise,
    resolveSettled: (result) => resolve({ outcome: "settled", result }),
    resolveCancelled: () => resolve({ outcome: "cancelled" }),
  };
}

/** The landing screen's real dialog-launcher — bootstraps a path into whichever tab is currently
 * showing that screen (the very first tab, or a blank tab `newTabButton()` just created). */
function openRepoButton(): HTMLElement {
  return screen.getByRole("button", { name: "Open a repository" });
}

/** `TabBar`'s plain "+ New tab" button — no dialog of its own (specs/repo-list.md, revised IA);
 * just deactivates the current tab and lands on the idle empty state. */
function newTabButton(): HTMLElement {
  return screen.getByRole("button", { name: /open a repository in a new tab/i });
}

function cancelButton(): HTMLElement {
  return screen.getByRole("button", { name: /^cancel$/i });
}

describe("repo-open cancel affordance (repo-open-feedback.md FR-167/168/169/170)", () => {
  it("FR-167/AC2: Cancel is present from the very first render of the spinner, with no delay threshold", async () => {
    const api = makeMockGitHydra({
      repoPath: "/repoA",
      commits: [makeCommit("a1", [], { subject: "Repo A commit" })],
    });
    window.gitHydra = api;
    const deferred = deferredOpenRepoCancellable();
    vi.mocked(api.openRepoCancellable).mockReturnValueOnce(deferred.promise);
    render(<App />);

    await userEvent.click(openRepoButton());

    await waitFor(() => expect(screen.getByText("Opening repository…")).toBeInTheDocument());
    // Present immediately — before any elapsed-time tick, not gated behind a threshold.
    expect(screen.getByText("0s")).toBeInTheDocument();
    expect(cancelButton()).toBeInTheDocument();
    expect(cancelButton()).toBeEnabled();

    // Settle the deferred attempt so the test doesn't leave a dangling unhandled promise/timer.
    await act(async () => {
      deferred.resolveSettled({ ok: true, data: { path: "/repoA", state: makeRepoState({ headSha: "a1" }) } });
    });
  });

  it("FR-168/FR-169/AC3/AC4: canceling a fresh tab's very first open returns to the idle empty state — never the error UI, never a ready graph", async () => {
    const api = makeMockGitHydra({
      repoPath: "/repoA",
      commits: [makeCommit("a1", [], { subject: "Repo A commit" })],
    });
    window.gitHydra = api;
    const deferred = deferredOpenRepoCancellable();
    vi.mocked(api.openRepoCancellable).mockReturnValueOnce(deferred.promise);
    render(<App />);

    await userEvent.click(openRepoButton());
    await waitFor(() => expect(screen.getByText("Opening repository…")).toBeInTheDocument());

    await userEvent.click(cancelButton());
    expect(api.cancelOpenRepo).toHaveBeenCalledTimes(1);

    // Simulate the real backend eventually resolving `{ outcome: "cancelled" }` once
    // `cancelOpenRepo` wins the race — same convention `App.repoOpenElapsed.test.tsx` uses for the
    // deferred-resolve half of a controllable async call.
    await act(async () => {
      deferred.resolveCancelled();
    });

    await waitFor(() => expect(screen.getByText("No repository open", { selector: "p.gh-empty-state__title" })).toBeInTheDocument());
    expect(screen.queryByText("Opening repository…")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByText(/Could not open this repository/i)).not.toBeInTheDocument();
    expect(screen.queryByText("Repo A commit")).not.toBeInTheDocument();
    // FR-168: no stray tab left behind either — a canceled bootstrap-open must not leave an
    // unreachable tab (`activateTab` no-ops when a tab is already "active", so a leftover tab here
    // would be permanently stuck).
    expect(screen.queryAllByRole("tab")).toHaveLength(0);
  });

  it("FR-168/FR-169: canceling a '+ New tab' bootstrap attempt returns to the idle landing screen without disturbing the still-open background tab", async () => {
    const api = makeMockGitHydra({
      repoPath: "/repoA",
      commits: [makeCommit("a1", [], { subject: "Repo A commit" })],
      reposByPath: {
        "/repoB": { commits: [makeCommit("b1", [], { subject: "Repo B commit" })] },
      },
    });
    window.gitHydra = api;
    render(<App />);

    await userEvent.click(openRepoButton());
    await waitFor(() => expect(screen.getByText("Repo A commit")).toBeInTheDocument());

    // specs/repo-list.md (revised IA): "+ New tab" itself deactivates tab A and lands on the idle
    // empty state with no dialog of its own — tab A stays exactly as it was, just backgrounded.
    await userEvent.click(newTabButton());
    await waitFor(() => expect(screen.getByText("No repository open", { selector: "p.gh-empty-state__title" })).toBeInTheDocument());
    expect(screen.queryByText("Repo A commit")).not.toBeInTheDocument();

    vi.mocked(api.openRepoDialog).mockResolvedValueOnce({ ok: true, data: "/repoB" });
    const deferred = deferredOpenRepoCancellable();
    vi.mocked(api.openRepoCancellable).mockReturnValueOnce(deferred.promise);

    await userEvent.click(openRepoButton());
    await waitFor(() => expect(screen.getByText("Opening repository…")).toBeInTheDocument());

    await userEvent.click(cancelButton());
    await act(async () => {
      deferred.resolveCancelled();
    });

    // Canceling this bootstrap returns to the idle landing screen — it does not resurrect tab A
    // automatically, since "+ New tab" already deliberately backgrounded it before any dialog was
    // even opened (a deliberate consequence of the revised IA, not a bug).
    await waitFor(() => expect(screen.getByText("No repository open", { selector: "p.gh-empty-state__title" })).toBeInTheDocument());
    expect(screen.queryByText("Repo B commit")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByText(/Could not open this repository/i)).not.toBeInTheDocument();

    // Tab A is still there, present but inactive — reactivating it shows its real, untouched data.
    const tabs = screen.getAllByRole("tab");
    expect(tabs).toHaveLength(1);
    expect(tabs[0]).toHaveTextContent("repoA");
    expect(tabs[0]).toHaveAttribute("aria-selected", "false");
    await userEvent.click(tabs[0]!);
    await waitFor(() => expect(screen.getByText("Repo A commit")).toBeInTheDocument());
  });

  it("AC9: canceling requires no confirmation step and is instantly re-triggerable — a second open right after a cancel succeeds normally", async () => {
    const api = makeMockGitHydra({
      repoPath: "/repoA",
      commits: [makeCommit("a1", [], { subject: "Repo A commit" })],
    });
    window.gitHydra = api;
    const deferred = deferredOpenRepoCancellable();
    vi.mocked(api.openRepoCancellable).mockReturnValueOnce(deferred.promise);
    render(<App />);

    await userEvent.click(openRepoButton());
    await waitFor(() => expect(screen.getByText("Opening repository…")).toBeInTheDocument());

    // A single click — no ConfirmDialog/alertdialog appears.
    await userEvent.click(cancelButton());
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    await act(async () => {
      deferred.resolveCancelled();
    });
    await waitFor(() => expect(screen.getByText("No repository open", { selector: "p.gh-empty-state__title" })).toBeInTheDocument());

    // Re-triggering immediately works normally (the mock's default openRepoCancellable resolves
    // right away for this second attempt).
    await userEvent.click(openRepoButton());
    await waitFor(() => expect(screen.getByText("Repo A commit")).toBeInTheDocument());
  });

  it("FR-170: the same Cancel affordance and restore behavior is available with no special-casing regardless of whether the landing screen is the very first tab or one freshly created via '+ New tab'", async () => {
    const api = makeMockGitHydra({
      repoPath: "/repoA",
      commits: [makeCommit("a1", [], { subject: "Repo A commit" })],
      reposByPath: {
        "/repoB": { commits: [makeCommit("b1", [], { subject: "Repo B commit" })] },
      },
    });
    window.gitHydra = api;
    render(<App />);

    // Entry point 1: the very first tab's landing screen.
    const first = deferredOpenRepoCancellable();
    vi.mocked(api.openRepoCancellable).mockReturnValueOnce(first.promise);
    await userEvent.click(openRepoButton());
    await waitFor(() => expect(cancelButton()).toBeInTheDocument());
    await userEvent.click(cancelButton());
    await act(async () => {
      first.resolveCancelled();
    });
    await waitFor(() => expect(screen.getByText("No repository open", { selector: "p.gh-empty-state__title" })).toBeInTheDocument());

    // Entry point 2: bootstrap that same first tab for real, then close it, then reach the landing
    // screen again via "+ New tab" instead — same Cancel affordance, same restore, no tab left over.
    await userEvent.click(openRepoButton());
    await waitFor(() => expect(screen.getByText("Repo A commit")).toBeInTheDocument());
    await userEvent.click(screen.getByRole("button", { name: /close repoA tab/i }));
    await waitFor(() => expect(screen.getByText("No repository open", { selector: "p.gh-empty-state__title" })).toBeInTheDocument());

    vi.mocked(api.openRepoDialog).mockResolvedValueOnce({ ok: true, data: "/repoB" });
    const second = deferredOpenRepoCancellable();
    vi.mocked(api.openRepoCancellable).mockReturnValueOnce(second.promise);
    await userEvent.click(newTabButton());
    await userEvent.click(openRepoButton());
    await waitFor(() => expect(cancelButton()).toBeInTheDocument());
    await userEvent.click(cancelButton());
    await act(async () => {
      second.resolveCancelled();
    });
    await waitFor(() => expect(screen.getByText("No repository open", { selector: "p.gh-empty-state__title" })).toBeInTheDocument());
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryAllByRole("tab")).toHaveLength(0);
  });

  it("FR-168: canceling a tab-activation (switching to another already-open tab) restores the tab that was active before the switch", async () => {
    const api = makeMockGitHydra({
      repoPath: "/repoA",
      commits: [makeCommit("a1", [], { subject: "Repo A commit" })],
      reposByPath: {
        "/repoB": { commits: [makeCommit("b1", [], { subject: "Repo B commit" })] },
      },
    });
    window.gitHydra = api;
    render(<App />);

    await userEvent.click(openRepoButton());
    await waitFor(() => expect(screen.getByText("Repo A commit")).toBeInTheDocument());

    vi.mocked(api.openRepoDialog).mockResolvedValueOnce({ ok: true, data: "/repoB" });
    await userEvent.click(newTabButton());
    await userEvent.click(openRepoButton());
    await waitFor(() => expect(screen.getByText("Repo B commit")).toBeInTheDocument());

    const tabs = screen.getAllByRole("tab");
    expect(tabs).toHaveLength(2);

    // Switch back toward tab A, but cancel that switch mid-flight.
    const deferred = deferredOpenRepoCancellable();
    vi.mocked(api.openRepoCancellable).mockReturnValueOnce(deferred.promise);
    await userEvent.click(tabs[0]!);
    await waitFor(() => expect(screen.getByText("Opening repository…")).toBeInTheDocument());

    await userEvent.click(cancelButton());
    await act(async () => {
      deferred.resolveCancelled();
    });

    // Tab B (the one active before this canceled switch) is showing again, still marked active.
    await waitFor(() => expect(screen.getByText("Repo B commit")).toBeInTheDocument());
    const tabsAfter = screen.getAllByRole("tab");
    expect(tabsAfter[1]).toHaveAttribute("aria-selected", "true");
    expect(tabsAfter[0]).toHaveAttribute("aria-selected", "false");
  });
});
