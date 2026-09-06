// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useRepositoryGraph } from "./useRepositoryGraph";
import { makeMockGitHydra } from "../test/mockGitHydra";
import { makeCommit, makeStash } from "../test/fixtures";

afterEach(() => {
  // @ts-expect-error test cleanup of the global bridge
  delete window.gitHydra;
});

/**
 * specs/stash.md FR-93/FR-92/AC18: `stashCount` (the Toolbar badge) and the watcher's own
 * external-change detection for `refs/stash` — which `RefInfo`/`RepositoryState` never carry
 * (git-core's `refs.ts` deliberately excludes `refs/stash`), so this needs its own signature-based
 * comparison, independent of the ordinary ref/HEAD diff `useRepositoryGraph.test.ts` covers.
 */
describe("useRepositoryGraph — stash count and external-change detection (specs/stash.md)", () => {
  async function openReadyRepo(apiOverrides: Parameters<typeof makeMockGitHydra>[0] = {}) {
    const api = makeMockGitHydra({
      commits: [makeCommit("c1")],
      ...apiOverrides,
    });
    let onRefsChangedListener: (() => void) | null = null;
    vi.mocked(api.onRefsChanged).mockImplementation((listener) => {
      onRefsChangedListener = listener;
      return () => {
        onRefsChangedListener = null;
      };
    });

    window.gitHydra = api;
    const { result } = renderHook(() => useRepositoryGraph());

    await act(async () => {
      await result.current.openRepo("/repo");
    });
    await waitFor(() => expect(result.current.status).toBe("ready"));

    const fireWatcher = async () => {
      expect(onRefsChangedListener).not.toBeNull();
      await act(async () => {
        onRefsChangedListener!();
        await Promise.resolve();
        await Promise.resolve();
      });
    };

    return { api, result, fireWatcher };
  }

  it("FR-93: exposes the live stash count on open, and null for a bare repository", async () => {
    const { result } = await openReadyRepo({ stashes: [makeStash(0), makeStash(1)] });
    await waitFor(() => expect(result.current.stashCount).toBe(2));
  });

  it("FR-93: refreshStashList() cheaply re-fetches just the count, without disturbing other state", async () => {
    const { api, result } = await openReadyRepo({ stashes: [makeStash(0)] });
    await waitFor(() => expect(result.current.stashCount).toBe(1));

    vi.mocked(api.listStashes).mockResolvedValueOnce({ ok: true, data: [makeStash(0), makeStash(1), makeStash(2)] });
    await act(async () => {
      await result.current.refreshStashList();
    });
    expect(result.current.stashCount).toBe(3);
  });

  it("AC18: an external stash change (create/drop from a separate terminal) sets hasExternalChanges, unchanged from ordinary ref churn's behavior", async () => {
    const { api, result, fireWatcher } = await openReadyRepo({ stashes: [makeStash(0)] });
    await waitFor(() => expect(result.current.stashCount).toBe(1));
    expect(result.current.hasExternalChanges).toBe(false);

    // A stash was created from a separate terminal — `refs/stash` changed, but no ref/HEAD in
    // `RefInfo`/`RepositoryState` moved, so only the stash-specific signature comparison can catch
    // this.
    vi.mocked(api.listStashes).mockResolvedValueOnce({ ok: true, data: [makeStash(0), makeStash(1)] });
    await fireWatcher();

    await waitFor(() => expect(result.current.hasExternalChanges).toBe(true));
    // "Alert, don't silently apply" — the same precedent ordinary ref churn already follows:
    // the badge is not silently bumped ahead of the user clicking Refresh.
    expect(result.current.stashCount).toBe(1);
  });

  it("FR-92: does not flag an app-initiated stash mutation as an external change while its self-write gate is open", async () => {
    const { api, result, fireWatcher } = await openReadyRepo({ stashes: [makeStash(0)] });
    await waitFor(() => expect(result.current.stashCount).toBe(1));

    act(() => {
      result.current.beginMutation();
    });
    // The app's own write lands and the watcher fires mid-flight, exactly as a real `refs/stash`
    // write would trip `watchRepositoryRefs` (FR-91) — this must be ignored, same as it already is
    // for a branch mutation's ref writes.
    vi.mocked(api.listStashes).mockResolvedValue({ ok: true, data: [makeStash(0), makeStash(1)] });
    await fireWatcher();
    expect(result.current.hasExternalChanges).toBe(false);

    // The operation's own confirming read (mirroring App's `refreshAfterStashOp`) closes the gate
    // and folds the new signature in as the baseline — no alert.
    await act(async () => {
      await result.current.refreshRefs();
      await result.current.refreshStashList();
    });
    expect(result.current.hasExternalChanges).toBe(false);
    expect(result.current.stashCount).toBe(2);
  });

  it("refresh() re-fetches the stash count alongside everything else and clears hasExternalChanges", async () => {
    const { api, result, fireWatcher } = await openReadyRepo({ stashes: [makeStash(0)] });
    await waitFor(() => expect(result.current.stashCount).toBe(1));

    vi.mocked(api.listStashes).mockResolvedValueOnce({ ok: true, data: [makeStash(0), makeStash(1)] });
    await fireWatcher();
    await waitFor(() => expect(result.current.hasExternalChanges).toBe(true));

    vi.mocked(api.listStashes).mockResolvedValueOnce({ ok: true, data: [makeStash(0), makeStash(1)] });
    await act(async () => {
      await result.current.refresh();
    });
    expect(result.current.hasExternalChanges).toBe(false);
    expect(result.current.stashCount).toBe(2);
  });
});
