// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "./App";
import { makeMockGitHydra } from "./test/mockGitHydra";
import { makeCommit, makeLocalBranch } from "./test/fixtures";

/**
 * Regression coverage for a real bug found by using the app: `App.tsx`'s `refreshEverything` —
 * which backs the Toolbar's Refresh button, `Ctrl/Cmd+R`/`F5`, AND the external-change alert's own
 * refresh action — refreshed the graph and bumped `StashPanel`'s independent list fetch, but never
 * bumped `BranchesPanel`'s.
 *
 * `useBranchList` only refetches when its `reloadToken` prop changes (or on its own mount), and the
 * panel is mounted persistently while a repo is open, so nothing ever refetched it after a branch
 * was created/deleted/switched from a separate terminal. The graph's own HEAD/ref decoration DID
 * update in the same pass, so the two surfaces disagreed with each other at the same instant — the
 * graph showing HEAD on one branch while the Branches list still captioned a different branch
 * "Current". That reads as a rendering bug rather than as staleness, which is why it's worth a test
 * asserting the user-visible outcome rather than just the call count.
 */

afterEach(() => {
  // @ts-expect-error test cleanup of the global bridge
  delete window.gitHydra;
  window.localStorage.clear();
});

async function openRepoWithBranches() {
  const commits = [makeCommit("c1", [], { subject: "Only commit" })];
  window.gitHydra = makeMockGitHydra({
    commits,
    localBranches: [makeLocalBranch("main", { isCurrent: true })],
  });
  render(<App />);
  await userEvent.click(screen.getByRole("button", { name: "Open a repository" }));
  await waitFor(() => expect(screen.getByText("Only commit")).toBeInTheDocument());
}

/** The Branches sidebar, scoped so assertions can't accidentally match the commit graph's own
 * rendering of the same branch name (the ref-chip gutter renders branch names too). */
function branchesPanel() {
  return screen.getByRole("complementary", { name: /branches/i });
}

describe("App — Branches panel refetches on a full refresh", () => {
  it("shows a branch created externally after the Toolbar's Refresh, without reopening the repo", async () => {
    await openRepoWithBranches();
    const api = window.gitHydra!;

    expect(within(branchesPanel()).queryByText("feature/from-terminal")).not.toBeInTheDocument();

    // Simulate a branch created outside the app (a terminal `git branch`) between renders: the
    // next read returns it, exactly as a real re-read of the repo would.
    vi.mocked(api.listBranches).mockImplementation(() =>
      Promise.resolve({
        ok: true,
        data: [
          makeLocalBranch("main", { isCurrent: true }),
          makeLocalBranch("feature/from-terminal"),
        ],
      }) as ReturnType<typeof api.listBranches>,
    );

    await userEvent.click(screen.getByRole("button", { name: /refresh/i }));

    await waitFor(() =>
      expect(within(branchesPanel()).getByText("feature/from-terminal")).toBeInTheDocument(),
    );
  });

  it("refetches the branch list on Ctrl+R, the same as the Toolbar button", async () => {
    await openRepoWithBranches();
    const api = window.gitHydra!;

    const callsBeforeRefresh = vi.mocked(api.listBranches).mock.calls.length;
    await userEvent.keyboard("{Control>}r{/Control}");

    await waitFor(() =>
      expect(vi.mocked(api.listBranches).mock.calls.length).toBeGreaterThan(callsBeforeRefresh),
    );
  });
});
