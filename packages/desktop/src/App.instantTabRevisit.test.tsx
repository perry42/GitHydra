// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "./App";
import { makeMockGitHydra } from "./test/mockGitHydra";
import { makeCommit } from "./test/fixtures";

/**
 * specs/instant-tab-revisit.md — App-level wiring proof: `useRepoTabs.ts` actually routes an
 * ordinary tab switch through `graph.reactivateTab()` with the right per-tab cache, and a closed
 * tab's cache is genuinely gone (not just theoretically, per the hook-level tests in
 * `useRepositoryGraph.instantTabRevisit.test.ts`, which exercise `reactivateTab()`/
 * `captureTabCache()` directly). Deeper acceptance-criteria coverage is test-agent's.
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

describe("instant tab revisit — App-level wiring (specs/instant-tab-revisit.md)", () => {
  it("AC1: switching back to an already-loaded tab with nothing changed never re-walks the commit log", async () => {
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

    await newTabInto(api, "/repoB");
    await waitFor(() => expect(screen.getByText("Repo B commit")).toBeInTheDocument());

    vi.mocked(api.createLogReader).mockClear();
    vi.mocked(api.readPage).mockClear();

    const tabs = screen.getAllByRole("tab");
    await userEvent.click(tabs[0]!);

    await waitFor(() => expect(screen.getByText("Repo A commit")).toBeInTheDocument());
    // FR-242: a clean fast-path hit never re-walks the commit log.
    expect(api.createLogReader).not.toHaveBeenCalled();
    expect(api.readPage).not.toHaveBeenCalled();
  });

  it("AC2: a commit landing in the backgrounded tab's repo is picked up on reactivation, never silently stale", async () => {
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

    await newTabInto(api, "/repoB");
    await waitFor(() => expect(screen.getByText("Repo B commit")).toBeInTheDocument());

    // Simulate a new commit having landed in repo A from outside GitHydra while tab A was
    // backgrounded — the mock has no generic "add a commit" seam, so the resolved HEAD sha for the
    // next "point session at path" call is overridden directly, matching how the hook-level tests
    // simulate the same external change.
    vi.mocked(api.getRefs).mockResolvedValueOnce({
      ok: true,
      data: [
        {
          fullName: "refs/heads/main",
          shortName: "main",
          type: "local-branch",
          targetCommitSha: "a2-new",
          isAnnotatedTag: false,
          isSymbolic: false,
        },
      ],
    });
    vi.mocked(api.openRepoCancellable).mockImplementationOnce(async (path: string) => ({
      outcome: "settled",
      result: {
        ok: true,
        data: {
          path,
          pickedPath: path,
          state: {
            gitDir: "/repoA/.git",
            commonGitDir: "/repoA/.git",
            workdir: "/repoA",
            isBare: false,
            isShallow: false,
            isWorktree: false,
            isEmpty: false,
            isUnbornHead: false,
            isDetachedHead: false,
            currentBranch: "main",
            headSha: "a2-new",
            inProgressOperation: null,
            inProgressOperationDetail: null,
          },
        },
      },
    }));

    vi.mocked(api.createLogReader).mockClear();
    const tabs = screen.getAllByRole("tab");
    await userEvent.click(tabs[0]!);

    // FR-243: the mismatch forces exactly today's full reload — the commit log is walked again
    // from the top, never silently kept on the stale cached rows.
    await waitFor(() => expect(api.createLogReader).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByText("Repo A commit")).toBeInTheDocument());
  });

  it("AC10: closing a tab discards its cache — reopening the same path in a new tab always does a full reload", async () => {
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

    await newTabInto(api, "/repoB");
    await waitFor(() => expect(screen.getByText("Repo B commit")).toBeInTheDocument());

    // Close tab A (backgrounded, with a cache entry) while tab B stays active.
    await userEvent.click(screen.getByRole("button", { name: /close repoA tab/i }));
    expect(screen.queryAllByRole("tab")).toHaveLength(1);

    vi.mocked(api.createLogReader).mockClear();

    // Reopen the same path — a brand-new tab id, no in-session cache entry (AC13's "no eligible
    // cache" case) — always a full reload.
    await newTabInto(api, "/repoA");
    await waitFor(() => expect(screen.getByText("Repo A commit")).toBeInTheDocument());
    expect(api.createLogReader).toHaveBeenCalled();
  });
});
