// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "./App";
import { makeMockGitHydra } from "./test/mockGitHydra";
import { makeCommit } from "./test/fixtures";
import { PAGE_SIZE } from "./hooks/useRepositoryGraph";

/**
 * test-agent finding, verifying fix/graph-scroll-jump-on-reactivation against
 * specs/graph-head-indicator-and-refresh-alerting.md Addendum 3 AC1.
 *
 * AC1's own scenario is "select a commit far down a tab's history, switch to another tab and
 * back... the graph's scroll position afterward is identical to before switching away." But
 * `useRepositoryGraph.ts`'s `captureTabCache()` (specs/instant-tab-revisit.md FR-240/AC8,
 * unchanged by this branch) refuses to cache a tab whose live row count exceeds `PAGE_SIZE`
 * (150) at the moment it's backgrounded — scrolling "far down" a history bigger than one page
 * routinely loads past that cap via ordinary near-end auto-pagination. When the cache is refused,
 * `useRepoTabs.ts`'s `activateTabCore` falls back to `graph.openRepo()` on reactivation — a full
 * reload that re-walks the commit log AND (per `App.tsx`'s `MainArea`) transitions `CommitGraph`
 * out of and back into existence via the `graph.status === "opening"`/empty-`displayRows` branches,
 * which unmounts and remounts `CommitGraph`, resetting its own internal `scrollTop` React state
 * (`useState(0)`) back to zero — the exact "scroll jumps on reactivation" symptom this branch's
 * `followSignal` fix was written to eliminate, reached via a different, untouched code path
 * (FR-240's cache-eligibility cap) that this branch's fix doesn't address.
 */

afterEach(() => {
  // @ts-expect-error test cleanup of the global bridge
  delete window.gitHydra;
  window.localStorage.clear();
});

async function openFirstTab(): Promise<void> {
  await userEvent.click(screen.getByRole("button", { name: "Open a repository" }));
}

async function newTabInto(api: ReturnType<typeof makeMockGitHydra>, path: string): Promise<void> {
  vi.mocked(api.openRepoDialog).mockResolvedValueOnce({ ok: true, data: path });
  await userEvent.click(screen.getByRole("button", { name: /open a repository in a new tab/i }));
  await userEvent.click(screen.getByRole("button", { name: "Open a repository" }));
}

describe("Addendum 3 AC1 regression — scroll jump resurfaces once a tab's rows exceed PAGE_SIZE", () => {
  it("a tab scrolled past PAGE_SIZE rows loses its fast-path cache and re-walks the commit log on reactivation (root cause)", async () => {
    const manyCommits = Array.from({ length: PAGE_SIZE + 20 }, (_, i) =>
      makeCommit(`a${PAGE_SIZE + 20 - i}`, i < PAGE_SIZE + 19 ? [`a${PAGE_SIZE + 19 - i}`] : [], {
        subject: `Repo A commit ${PAGE_SIZE + 20 - i}`,
      }),
    );
    const api = makeMockGitHydra({
      repoPath: "/repoA",
      commits: manyCommits,
      reposByPath: {
        "/repoB": { commits: [makeCommit("b1", [], { subject: "Repo B commit" })] },
      },
    });
    window.gitHydra = api;
    render(<App />);

    await openFirstTab();
    await waitFor(() => expect(screen.getByText(`Repo A commit ${PAGE_SIZE + 20}`)).toBeInTheDocument());

    // Scroll far enough to cross the near-end pagination threshold and load past PAGE_SIZE rows —
    // this is exactly what "select a commit far down a tab's history" means for any repo bigger
    // than one page (AC1's own scenario).
    const scroller = screen.getByRole("listbox", { name: /commit graph/i });
    fireEvent.scroll(scroller, { target: { scrollTop: (PAGE_SIZE + 10) * 28 } });
    await waitFor(() => expect(screen.getByText(`Repo A commit 1`)).toBeInTheDocument());
    const scrollTopBeforeSwitch = scroller.scrollTop;
    expect(scrollTopBeforeSwitch).toBeGreaterThan(0); // sanity: we really did scroll deep

    await newTabInto(api, "/repoB");
    await waitFor(() => expect(screen.getByText("Repo B commit")).toBeInTheDocument());

    vi.mocked(api.createLogReader).mockClear();
    const tabs = screen.getAllByRole("tab");
    await userEvent.click(tabs[0]!);

    // FR-240/AC8 (unchanged, working as documented): the tab's row count exceeded PAGE_SIZE when
    // it was backgrounded, so `captureTabCache()` refused to cache it — reactivation falls back to
    // a full reopen, re-walking the commit log from scratch.
    await waitFor(() => expect(api.createLogReader).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByText(`Repo A commit ${PAGE_SIZE + 20}`)).toBeInTheDocument());

    // THE ACTUAL AC1 VIOLATION: `App.tsx`'s `MainArea` renders `OpeningSpinner`/an empty-rows
    // loading state (never `<CommitGraph>`) while `graph.status === "opening"`/`displayRows` is
    // still empty, which is unconditionally true during this full-reopen fallback — so
    // `CommitGraph` unmounts and remounts, and its internal `scrollTop` (`useState(0)`) comes back
    // at zero regardless of what `followSignal` does. AC1 requires "the graph's scroll position
    // afterward is identical to before switching away" — this asserts that literal requirement,
    // and it currently fails: the reopened tab is back at the top (scrollTop 0), not restored to
    // `scrollTopBeforeSwitch`, exactly the pre-fix "scroll jumps on reactivation" symptom, just
    // reached via FR-240's cache cap instead of the old unconditional-`selectedSha`-effect bug this
    // branch fixed.
    const scrollerAfter = screen.getByRole("listbox", { name: /commit graph/i });
    expect(scrollerAfter.scrollTop).toBe(scrollTopBeforeSwitch);
  });
});
