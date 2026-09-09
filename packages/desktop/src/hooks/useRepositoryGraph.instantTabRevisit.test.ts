// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { RefInfo } from "@githydra/git-core";
import type { OpenRepoOutcome } from "../../shared/ipcContract";
import { PAGE_SIZE, useRepositoryGraph } from "./useRepositoryGraph";
import { makeMockGitHydra } from "../test/mockGitHydra";
import { makeCommit, makeRepoState } from "../test/fixtures";

/**
 * specs/instant-tab-revisit.md — hook-level coverage for `captureTabCache()`/`reactivateTab()`,
 * independent of which UI surface (`useRepoTabs.ts`) wires them into an actual tab switch (that
 * wiring is covered by `App.multiRepoTabs.test.tsx`-style App-level tests instead). Tests exercise
 * the hook directly against a single already-open repo, simulating "this tab was backgrounded,
 * something may or may not have changed, and it's now being reactivated" by overriding the mock's
 * next `openRepoCancellable`/`getRefs`/`listStashes`/`getWorkingDirectoryChanges` responses
 * in-between a `captureTabCache()` call and a `reactivateTab()` call for the same path — mirroring
 * exactly what a real external change (or lack thereof) would look like to the hook's own fresh
 * read.
 */

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

function tagRef(name: string, targetCommitSha: string): RefInfo {
  return {
    fullName: `refs/tags/${name}`,
    shortName: name,
    type: "tag",
    targetCommitSha,
    isAnnotatedTag: false,
    isSymbolic: false,
  };
}

afterEach(() => {
  // @ts-expect-error test cleanup of the global bridge
  delete window.gitHydra;
  vi.restoreAllMocks();
});

async function openReadyRepo(options: Parameters<typeof makeMockGitHydra>[0] = {}) {
  const api = makeMockGitHydra({ commits: [makeCommit("c1")], refs: [mainRef("c1")], ...options });
  window.gitHydra = api;
  const { result } = renderHook(() => useRepositoryGraph());
  await act(async () => {
    await result.current.openRepo("/repo");
  });
  await waitFor(() => expect(result.current.status).toBe("ready"));
  return { api, result };
}

describe("useRepositoryGraph — instant tab revisit (specs/instant-tab-revisit.md)", () => {
  it("FR-240: captureTabCache() returns null before any repo is open", () => {
    window.gitHydra = makeMockGitHydra();
    const { result } = renderHook(() => useRepositoryGraph());
    expect(result.current.captureTabCache()).toBeNull();
  });

  it("AC1/FR-242: a clean comparison applies the cache directly — no createLogReader/readPage, status never leaves 'ready', openSequence bumps once", async () => {
    const { api, result } = await openReadyRepo();
    const cache = result.current.captureTabCache();
    expect(cache).not.toBeNull();

    vi.mocked(api.createLogReader).mockClear();
    vi.mocked(api.readPage).mockClear();
    const openSequenceBefore = result.current.openSequence;
    const statusesSeen = new Set<string>([result.current.status]);

    await act(async () => {
      const p = result.current.reactivateTab("/repo", { filter: {}, selectedSha: null }, cache);
      statusesSeen.add(result.current.status);
      await p;
      statusesSeen.add(result.current.status);
    });

    expect(statusesSeen).toEqual(new Set(["ready"]));
    expect(result.current.openSequence).toBe(openSequenceBefore + 1);
    expect(api.createLogReader).not.toHaveBeenCalled();
    expect(api.readPage).not.toHaveBeenCalled();
    expect(result.current.displayRows).toHaveLength(1);
  });

  it("AC2/FR-243: a HEAD move (new commit landed externally) forces a full reload", async () => {
    const { api, result } = await openReadyRepo();
    const cache = result.current.captureTabCache();
    expect(cache).not.toBeNull();

    // Simulate an external commit having landed: the next "point session at path" call reports a
    // different HEAD sha than what was cached.
    vi.mocked(api.openRepoCancellable).mockImplementationOnce(
      async (path: string, _requestId: string): Promise<OpenRepoOutcome> => ({
        outcome: "settled",
        result: {
          ok: true,
          data: {
            path,
            pickedPath: path,
            state: { ...cache!.repoState, headSha: "c2" },
          },
        },
      }),
    );
    vi.mocked(api.getRefs).mockResolvedValueOnce({ ok: true, data: [mainRef("c2")] });

    await act(async () => {
      await result.current.reactivateTab("/repo", { filter: {}, selectedSha: null }, cache);
    });

    // FR-243: exactly today's full reopen — the reader is recreated from scratch.
    expect(api.createLogReader).toHaveBeenCalled();
    await waitFor(() => expect(result.current.status).toBe("ready"));
  });

  it("AC3: a non-current branch/tag created elsewhere (HEAD's own sha unchanged) still forces a full reload", async () => {
    const { api, result } = await openReadyRepo();
    const cache = result.current.captureTabCache();
    expect(cache).not.toBeNull();

    vi.mocked(api.getRefs).mockResolvedValueOnce({
      ok: true,
      data: [mainRef("c1"), tagRef("v1", "c1")],
    });

    vi.mocked(api.createLogReader).mockClear();
    await act(async () => {
      await result.current.reactivateTab("/repo", { filter: {}, selectedSha: null }, cache);
    });

    expect(api.createLogReader).toHaveBeenCalled();
  });

  it("AC4: an in-progress-operation starting externally (no named ref moving) still forces a full reload", async () => {
    const { api, result } = await openReadyRepo();
    const cache = result.current.captureTabCache();
    expect(cache).not.toBeNull();

    vi.mocked(api.openRepoCancellable).mockImplementationOnce(
      async (path: string, _requestId: string): Promise<OpenRepoOutcome> => ({
        outcome: "settled",
        result: {
          ok: true,
          data: {
            path,
            pickedPath: path,
            state: { ...cache!.repoState, inProgressOperation: "merge", inProgressOperationDetail: null },
          },
        },
      }),
    );

    vi.mocked(api.createLogReader).mockClear();
    await act(async () => {
      await result.current.reactivateTab("/repo", { filter: {}, selectedSha: null }, cache);
    });

    expect(api.createLogReader).toHaveBeenCalled();
  });

  it("AC5: a tab already showing an undismissed external-changes banner is never cached", async () => {
    let watcherListener: (() => void) | null = null;
    const api = makeMockGitHydra({ commits: [makeCommit("c1")], refs: [mainRef("c1")] });
    vi.mocked(api.onRefsChanged).mockImplementation((listener) => {
      watcherListener = listener;
      return () => {
        watcherListener = null;
      };
    });
    window.gitHydra = api;
    const { result } = renderHook(() => useRepositoryGraph());
    await act(async () => {
      await result.current.openRepo("/repo");
    });
    await waitFor(() => expect(result.current.status).toBe("ready"));

    // A branch moves externally while idle — the watcher's own drift check flags it.
    vi.mocked(api.getRefs).mockResolvedValueOnce({ ok: true, data: [mainRef("c2")] });
    await act(async () => {
      watcherListener!();
      await Promise.resolve();
      await Promise.resolve();
    });
    await waitFor(() => expect(result.current.hasExternalChanges).toBe(true));

    // Even though the watcher's own confirming read already advanced `lastConfirmedRef` to match
    // the new (drifted) disk state, the tab must still be ineligible for caching — the banner is
    // still undismissed, and the displayed *rows* were never actually reloaded to match.
    expect(result.current.captureTabCache()).toBeNull();
  });

  it("AC6: working-dir-only changes take the fast path but still show live status", async () => {
    const { api, result } = await openReadyRepo({ workingDirStatus: { hasChanges: false, staged: 0, unstaged: 0, untracked: 0, conflicted: 0 } });
    const cache = result.current.captureTabCache();
    expect(cache).not.toBeNull();

    vi.mocked(api.getWorkingDirectoryChanges).mockResolvedValueOnce({
      ok: true,
      data: { staged: [], unstaged: [{ path: "a.txt", status: "modified", category: "unstaged" }], untracked: [], conflicted: [] },
    });

    vi.mocked(api.createLogReader).mockClear();
    await act(async () => {
      await result.current.reactivateTab("/repo", { filter: {}, selectedSha: null }, cache);
    });

    // FR-242: hit — no reader recreated — but the fresh (not cached) working-dir data is shown.
    expect(api.createLogReader).not.toHaveBeenCalled();
    expect(result.current.workingDirStatus?.unstaged).toBe(1);
  });

  it("AC7: a stash created externally (no ref/HEAD change) forces a full reload", async () => {
    const { api, result } = await openReadyRepo({ stashes: [] });
    const cache = result.current.captureTabCache();
    expect(cache).not.toBeNull();

    // Not `mockResolvedValueOnce`: `reactivateTab`'s own fresh-read comparison AND the eventual
    // full-reload's `refreshAuxData` (once the mismatch is found) both call `listStashes` — both
    // must see the new stash, exactly as two independent reads of real, already-changed disk state
    // would.
    vi.mocked(api.listStashes).mockResolvedValue({
      ok: true,
      data: [{ index: 0, ref: "stash@{0}", sha: "s1", message: "WIP", branch: "main", date: "2024-01-01", parentSha: "c1" }],
    });

    vi.mocked(api.createLogReader).mockClear();
    await act(async () => {
      await result.current.reactivateTab("/repo", { filter: {}, selectedSha: null }, cache);
    });

    expect(api.createLogReader).toHaveBeenCalled();
    await waitFor(() => expect(result.current.stashCount).toBe(1));
  });

  it("AC8: a tab whose live commit list exceeds PAGE_SIZE rows is never cached, even with nothing changed", async () => {
    const commits = Array.from({ length: PAGE_SIZE + 20 }, (_, i) => makeCommit(`c${i}`));
    const { result } = await openReadyRepo({ commits });
    await waitFor(() => expect(result.current.hasMore).toBe(true));

    await act(async () => {
      result.current.loadMore();
    });
    await waitFor(() => expect(result.current.displayRows.length).toBeGreaterThan(PAGE_SIZE));

    expect(result.current.captureTabCache()).toBeNull();
  });

  it("AC9/FR-245: 'Load more' after a fast-path reactivation returns the correct next page with no gap or duplicate", async () => {
    const commits = Array.from({ length: PAGE_SIZE + 30 }, (_, i) => makeCommit(`c${i}`));
    const { api, result } = await openReadyRepo({ commits });
    await waitFor(() => expect(result.current.displayRows).toHaveLength(PAGE_SIZE));

    const cache = result.current.captureTabCache();
    expect(cache).not.toBeNull();
    expect(cache!.rows).toHaveLength(PAGE_SIZE);

    await act(async () => {
      await result.current.reactivateTab("/repo", { filter: {}, selectedSha: null }, cache);
    });
    // Fast-path hit: no live reader yet.
    expect(result.current.hasMore).toBe(true);

    await act(async () => {
      result.current.loadMore();
    });
    await waitFor(() => expect(result.current.displayRows).toHaveLength(PAGE_SIZE + 30));

    const shas = result.current.displayRows.map((r) => (r.kind === "commit" ? r.laid.commit.sha : null));
    expect(new Set(shas).size).toBe(shas.length); // no duplicates
    expect(shas).toEqual(commits.map((c) => c.sha)); // no gaps, correct order
    expect(result.current.hasMore).toBe(false);
    void api;
  });

  it("security fix (specs/instant-tab-revisit.md FR-245): HEAD moving AFTER a fast-path reactivation but BEFORE 'Load more' falls back to a full reload instead of corrupting rows", async () => {
    // The exact interleaving the bug report identified as untested: `reactivateTab`'s own
    // comparison only proves the cache was correct AT THAT MOMENT — nothing re-verified it was
    // still true by the time the lazy reader-creation branch inside `loadMore()` actually fires.
    const commits = Array.from({ length: PAGE_SIZE + 30 }, (_, i) => makeCommit(`c${i}`));
    const { api, result } = await openReadyRepo({ commits });
    await waitFor(() => expect(result.current.displayRows).toHaveLength(PAGE_SIZE));

    const cache = result.current.captureTabCache();
    expect(cache).not.toBeNull();
    expect(cache!.rows).toHaveLength(PAGE_SIZE);

    await act(async () => {
      await result.current.reactivateTab("/repo", { filter: {}, selectedSha: null }, cache);
    });
    // Fast-path hit: no live reader yet (mirrors AC9's own assertion for the clean case).
    expect(result.current.hasMore).toBe(true);

    // Simulate a commit landing on HEAD in the window between reactivation and the "Load more"
    // click: a real new commit history with one extra commit ("cNEW") prepended ahead of
    // everything the cache/reactivation already confirmed as current.
    const newHistory = [makeCommit("cNEW"), ...commits];
    vi.mocked(api.getState).mockResolvedValue({
      ok: true,
      data: { ...cache!.repoState, headSha: "cNEW" },
    });

    // Full control over the post-drift reader so the test can assert on *content*, not just call
    // counts — a reader created against this "new" history behaves like a real `git log` reader
    // would: sequential, starting at the new HEAD.
    let readerSeq = 0;
    const cursors = new Map<string, { offset: number }>();
    vi.mocked(api.createLogReader).mockImplementation(async () => {
      const id = `post-drift-reader-${++readerSeq}`;
      cursors.set(id, { offset: 0 });
      return { ok: true, data: id };
    });
    vi.mocked(api.readPage).mockImplementation(async (readerId: string, count: number) => {
      const cursor = cursors.get(readerId);
      if (!cursor) return { ok: true, data: { commits: [], done: true } };
      const slice = newHistory.slice(cursor.offset, cursor.offset + count);
      cursor.offset += slice.length;
      return { ok: true, data: { commits: slice, done: cursor.offset >= newHistory.length } };
    });

    await act(async () => {
      result.current.loadMore();
      await Promise.resolve();
      await Promise.resolve();
    });
    await waitFor(() => expect(result.current.displayRows).toHaveLength(PAGE_SIZE));

    // Correct outcome: a fresh, fully-reloaded first page from the NEW history (starting at
    // "cNEW"), not the old buggy fast-forward-past-`rowsRef.current.length` result, which would
    // have discarded "cNEW" entirely and duplicated `c${PAGE_SIZE - 1}` (present once in the
    // stale cached page, and again as the first row of the wrongly-offset "next page").
    const shas = result.current.displayRows.map((r) => (r.kind === "commit" ? r.laid.commit.sha : null));
    expect(new Set(shas).size).toBe(shas.length); // AC9: no duplicates
    expect(shas).toEqual(newHistory.slice(0, PAGE_SIZE).map((c) => c.sha)); // AC9: no gaps, correct order
    expect(shas[0]).toBe("cNEW");
    expect(result.current.repoState?.headSha).toBe("cNEW");
  });

  it("FR-243/AC13: reactivateTab with no cache behaves exactly like a full openRepo (status transitions through 'opening')", async () => {
    const api = makeMockGitHydra({ commits: [makeCommit("c1")], refs: [mainRef("c1")] });
    window.gitHydra = api;
    const { result } = renderHook(() => useRepositoryGraph());

    // A deferred, controllable `openRepoCancellable` (same technique `App.repoOpenElapsed.test.tsx`
    // uses) so the "opening" state can actually be observed before the attempt settles, rather than
    // racing a synchronous read against React's own batching of the state update.
    let resolveOpen!: (outcome: OpenRepoOutcome) => void;
    vi.mocked(api.openRepoCancellable).mockReturnValueOnce(
      new Promise<OpenRepoOutcome>((resolve) => {
        resolveOpen = resolve;
      }),
    );

    act(() => {
      void result.current.reactivateTab("/repo", { filter: {}, selectedSha: null }, null);
    });
    await waitFor(() => expect(result.current.status).toBe("opening"));

    await act(async () => {
      resolveOpen({
        outcome: "settled",
        result: { ok: true, data: { path: "/repo", pickedPath: "/repo", state: makeRepoState({ headSha: "c1" }) } },
      });
    });

    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(api.createLogReader).toHaveBeenCalled();
  });

  it("FR-240/FR-242: a cached ready commit selection is restored instantly on a hit, without a redundant getCommit fetch", async () => {
    const commit = makeCommit("c1", [], { subject: "Only commit" });
    const { api, result } = await openReadyRepo({ commits: [commit] });

    act(() => {
      result.current.selectCommit("c1");
    });
    await waitFor(() => expect(result.current.commitDetail.status).toBe("ready"));

    const cache = result.current.captureTabCache();
    expect(cache).not.toBeNull();
    expect(cache!.commitDetail?.commit.sha).toBe("c1");

    vi.mocked(api.getCommit).mockClear();
    let outcome: { cancelled: boolean; selectionRestored: boolean } | undefined;
    await act(async () => {
      outcome = await result.current.reactivateTab("/repo", { filter: {}, selectedSha: "c1" }, cache);
    });

    expect(outcome!.selectionRestored).toBe(true);
    expect(result.current.commitDetail).toEqual({ status: "ready", commit, files: [] });
    // Restored directly from the cache — never re-fetched.
    expect(api.getCommit).not.toHaveBeenCalled();
  });
});
