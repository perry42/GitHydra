import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { RefInfo, RepositoryState } from "@githydra/git-core";
import type { IpcResult } from "../shared/ipcContract";
import { App } from "./App";
import { makeMockGitHydra } from "./test/mockGitHydra";
import { makeCommit, makeLocalBranch } from "./test/fixtures";

/**
 * specs/self-write-refresh-suppression.md — end-to-end coverage through the real production
 * wiring (`useBranchActions` + `App.tsx`'s `refreshAfterBranchOp`), not just the hook in
 * isolation (see `useRepositoryGraph.selfWriteSuppression.test.ts` for that). Exercises FR-6c's
 * two named call sites: BranchesPanel row checkout and the graph's commit context-menu Checkout.
 */

function ok<T>(data: T): IpcResult<T> {
  return { ok: true, data };
}

function mainRef(targetCommitSha: string): RefInfo {
  return {
    fullName: "refs/heads/main",
    shortName: "main",
    type: "local-branch",
    targetCommitSha,
    isAnnotatedTag: false,
    isSymbolic: false,
  };
}

function featureRef(targetCommitSha: string): RefInfo {
  return {
    fullName: "refs/heads/feature",
    shortName: "feature",
    type: "local-branch",
    targetCommitSha,
    isAnnotatedTag: false,
    isSymbolic: false,
  };
}

function externalDuringRaceRef(targetCommitSha: string): RefInfo {
  return {
    fullName: "refs/heads/someone-elses-branch",
    shortName: "someone-elses-branch",
    type: "local-branch",
    targetCommitSha,
    isAnnotatedTag: false,
    isSymbolic: false,
  };
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function fireWatcher(api: ReturnType<typeof makeMockGitHydra>): void {
  const calls = vi.mocked(api.onRefsChanged).mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  calls[calls.length - 1]![0]();
}

const externalBanner = () => screen.queryByText(/history changed outside gitHydra/i);

afterEach(() => {
  // @ts-expect-error test cleanup of the global bridge
  delete window.gitHydra;
});

describe("App — self-write refresh suppression, real BranchesPanel/graph wiring", () => {
  it("AC1: checking out a branch via BranchesPanel never shows the external-changes banner, across 5+ consecutive checkouts", async () => {
    const commit = makeCommit("c1", [], { subject: "Only commit" });
    const api = makeMockGitHydra({
      commits: [commit],
      refs: [mainRef("c1"), featureRef("c1")],
      localBranches: [
        makeLocalBranch("main", { isCurrent: true, tipSha: "c1" }),
        makeLocalBranch("feature", { isCurrent: false, tipSha: "c1" }),
      ],
    });
    window.gitHydra = api;
    render(<App />);

    await userEvent.click(screen.getByRole("button", { name: /open repository/i }));
    await waitFor(() => expect(screen.getByText("Only commit")).toBeInTheDocument());

    // design-pass "Branches panel relocation": the sidebar is persistent/always visible now, no
    // toggle click needed to reach it.
    const branchesPanel = await screen.findByRole("complementary", { name: "Branches" });

    for (let i = 0; i < 5; i++) {
      const target = i % 2 === 0 ? "feature" : "main";
      // Scoped to the Branches panel — the graph's own ref chips (specs/graph-head-indicator-and-
      // refresh-alerting.md) also render "main"/"feature" text elsewhere on the page now.
      const row = within(branchesPanel).getByText(target).closest("li")!;
      // design-pass "Branches panel relocation": the row's first `<button>` in DOM order is now
      // the branch-name jump button (`gh-branches-panel__name`), not Checkout — a plain
      // `querySelector("button")` would silently click that instead and this test would pass
      // vacuously (no checkout ever happens, so of course no external-changes banner appears).
      // Query Checkout by role/name explicitly, same as the rest of this codebase's Branches-panel
      // tests already do.
      const checkoutButton = within(row).getByRole("button", { name: /^checkout$/i });
      await userEvent.click(checkoutButton);
      await waitFor(() => expect(checkoutButton).not.toHaveTextContent(/working/i));
      // The watcher's own debounced fire for this exact checkout's disk write.
      fireWatcher(api);
      await flush();
      expect(externalBanner()).not.toBeInTheDocument();
    }
  });

  it("AC1/FR-6c: the graph's commit context-menu Checkout action never shows the external-changes banner", async () => {
    const commits = [
      makeCommit("c2", ["c1"], { subject: "Second commit" }),
      makeCommit("c1", [], { subject: "First commit" }),
    ];
    const api = makeMockGitHydra({ commits, refs: [mainRef("c2")] });
    window.gitHydra = api;
    render(<App />);

    await userEvent.click(screen.getByRole("button", { name: /open repository/i }));
    await waitFor(() => expect(screen.getByText("First commit")).toBeInTheDocument());

    const target = screen.getByText("First commit");
    target.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    await userEvent.click(await screen.findByRole("menuitem", { name: /checkout commit/i }));

    await flush();
    fireWatcher(api);
    await flush();
    expect(externalBanner()).not.toBeInTheDocument();
  });

  it("AC5 (real race, through the real BranchesPanel checkout wiring): an external ref write landing on disk mid-checkout is still surfaced, not silently absorbed", async () => {
    // Same technique as the hook-level AC5 test (see useRepositoryGraph.selfWriteSuppression.test.ts
    // for the full rationale): a live, shared, mutable refs array the mock reads straight from, so
    // a real `setTimeout`-driven "second process" write races against the real click-driven
    // checkout with genuinely uncontrolled timing — not a `mockResolvedValueOnce` FIFO chain.
    const commit = makeCommit("c1", [], { subject: "Only commit" });
    const refsOnDisk: RefInfo[] = [mainRef("c1"), featureRef("c1")];
    const api = makeMockGitHydra({
      commits: [commit],
      refs: refsOnDisk,
      localBranches: [
        makeLocalBranch("main", { isCurrent: true, tipSha: "c1" }),
        makeLocalBranch("feature", { isCurrent: false, tipSha: "c1" }),
      ],
    });
    window.gitHydra = api;
    render(<App />);

    await userEvent.click(screen.getByRole("button", { name: /open repository/i }));
    await waitFor(() => expect(screen.getByText("Only commit")).toBeInTheDocument());
    const branchesPanel = await screen.findByRole("complementary", { name: "Branches" });

    // The real `switchBranch` call resolves in well under a millisecond in this mock (a plain
    // resolved Promise) — far faster than any `setTimeout`-driven "second process" write could
    // plausibly land, which would trivially defeat the race below. Give it a small, real delay
    // (mirroring real git's own I/O latency) so the external write below has a genuine chance to
    // land on disk *before* our own confirming read fires, while still preserving the mock's real
    // state mutation (`record.currentBranchState`) that the rest of the app depends on.
    const baseSwitchBranch = vi.mocked(api.switchBranch).getMockImplementation()!;
    vi.mocked(api.switchBranch).mockImplementationOnce(async (branchName: string) => {
      await new Promise((resolve) => setTimeout(resolve, 40));
      return baseSwitchBranch(branchName);
    });

    // A second, independent actor writes a brand new branch ref onto the same "disk" on a real
    // timer, scheduled before the click so it has every opportunity to land during the checkout's
    // in-flight window, mirroring test-agent's reproduction (external write landing before the
    // app's own confirming read).
    setTimeout(() => {
      refsOnDisk.push(externalDuringRaceRef("c1"));
    }, 15);

    const row = within(branchesPanel).getByText("feature").closest("li")!;
    // See the AC1 test above for why this must be an explicit role/name query, not
    // `querySelector("button")` (which now hits the row's branch-name jump button first).
    const checkoutButton = within(row).getByRole("button", { name: /^checkout$/i });
    await userEvent.click(checkoutButton);
    await waitFor(() => expect(checkoutButton).not.toHaveTextContent(/working/i));

    await waitFor(() => expect(externalBanner()).toBeInTheDocument());
  });

  it("AC4: a genuine external change while idle still shows the banner (unchanged regression check)", async () => {
    const commit = makeCommit("c1", [], { subject: "Only commit" });
    const api = makeMockGitHydra({ commits: [commit], refs: [mainRef("c1")] });
    window.gitHydra = api;
    render(<App />);

    await userEvent.click(screen.getByRole("button", { name: /open repository/i }));
    await waitFor(() => expect(screen.getByText("Only commit")).toBeInTheDocument());
    expect(externalBanner()).not.toBeInTheDocument();

    const externalState: RepositoryState = {
      gitDir: "/repo/.git",
      commonGitDir: "/repo/.git",
      workdir: "/repo",
      isBare: false,
      isShallow: false,
      isWorktree: false,
      isEmpty: false,
      isUnbornHead: false,
      isDetachedHead: false,
      currentBranch: "someone-elses-branch",
      headSha: "c1",
      inProgressOperation: null,
      inProgressOperationDetail: null,
    };
    vi.mocked(api.getState).mockResolvedValueOnce(ok(externalState));
    vi.mocked(api.getRefs).mockResolvedValueOnce(ok([mainRef("c1")]));

    fireWatcher(api);
    await waitFor(() => expect(externalBanner()).toBeInTheDocument());

    // AC6: manual refresh clears it.
    await userEvent.click(screen.getByRole("button", { name: /refresh commit graph/i }));
    await waitFor(() => expect(externalBanner()).not.toBeInTheDocument());
  });
});
