// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useRepositoryGraph } from "./useRepositoryGraph";
import { useRepoTabs } from "./useRepoTabs";
import { makeMockGitHydra } from "../test/mockGitHydra";
import { makeCommit } from "../test/fixtures";
import { isCaseInsensitiveFileSystem } from "../../shared/pathEquivalence";

/**
 * ROADMAP.md "Open tech debt — repo-open dedup uses exact string equality, no path normalization":
 * `openNewTab`/`openRecentInNewTab`'s existing-tab pre-check used to be `t.repoPath === path` —
 * exact string equality against whatever raw path the OS dialog/recent-list entry happened to
 * carry. These tests pin the fix (`looksLikeSamePath`, not `===`) at the hook level, independent
 * of `resolveOpenedPath`'s own (separately tested, main-process-only) resolution logic — the mock
 * API here echoes back whatever path it's given unchanged, so any dedup these tests observe can
 * only be coming from the pre-check itself, not from git's own toplevel resolution.
 */

afterEach(() => {
  // @ts-expect-error test cleanup of the global bridge
  delete window.gitHydra;
});

function renderTabs(api: ReturnType<typeof makeMockGitHydra>) {
  window.gitHydra = api;
  return renderHook(() => {
    const graph = useRepositoryGraph();
    const tabs = useRepoTabs({
      graph,
      rightPanel: "none",
      setRightPanel: () => {},
      getSeedRightPanel: () => "none",
    });
    return { graph, tabs };
  });
}

describe("useRepoTabs — openNewTab dedup pre-check tolerates trivial spelling variants", () => {
  it("a forward-slash vs. backslash spelling of the identical directory dedupes into one tab", async () => {
    const api = makeMockGitHydra({
      repoPath: "D:/Repos/Foo",
      commits: [makeCommit("a1", [], { subject: "Foo commit" })],
    });
    const { result } = renderTabs(api);

    await act(async () => {
      await result.current.tabs.openNewTab();
    });
    expect(result.current.tabs.tabs).toHaveLength(1);
    const firstTabId = result.current.tabs.tabs[0]!.id;

    // "+ New tab" -> blank landing screen, then pick the SAME directory again, spelled with
    // native-Windows backslashes instead of the forward slashes the first pick/mock echoed back.
    await act(async () => {
      await result.current.tabs.newTab();
    });
    vi.mocked(api.openRepoDialog).mockResolvedValueOnce({ ok: true, data: "D:\\Repos\\Foo" });
    await act(async () => {
      await result.current.tabs.openNewTab();
    });

    // Still exactly one tab, focused back on the original — the pre-check caught this synchronously
    // as "already open" and routed to `activateTab` (which legitimately re-opens *that same tab's*
    // session, since `newTab()` above tore the one live session down) rather than creating and then
    // needing to reconcile a brand-new, redundant second tab for the identical directory.
    expect(result.current.tabs.tabs).toHaveLength(1);
    expect(result.current.tabs.tabs[0]!.id).toBe(firstTabId);
    expect(result.current.tabs.activeTabId).toBe(firstTabId);
  });

  it("a trailing-separator-only spelling variant dedupes into one tab", async () => {
    const api = makeMockGitHydra({
      repoPath: "/repo/foo",
      commits: [makeCommit("a1", [], { subject: "Foo commit" })],
    });
    const { result } = renderTabs(api);

    await act(async () => {
      await result.current.tabs.openNewTab();
    });
    const firstTabId = result.current.tabs.tabs[0]!.id;

    await act(async () => {
      await result.current.tabs.newTab();
    });
    vi.mocked(api.openRepoDialog).mockResolvedValueOnce({ ok: true, data: "/repo/foo/" });
    await act(async () => {
      await result.current.tabs.openNewTab();
    });

    expect(result.current.tabs.tabs).toHaveLength(1);
    expect(result.current.tabs.activeTabId).toBe(firstTabId);
  });

  it("a case-only spelling variant dedupes exactly when the real host filesystem is case-insensitive", async () => {
    const api = makeMockGitHydra({
      repoPath: "/Repo/Foo",
      commits: [makeCommit("a1", [], { subject: "Foo commit" })],
    });
    const { result } = renderTabs(api);

    await act(async () => {
      await result.current.tabs.openNewTab();
    });
    const firstTabId = result.current.tabs.tabs[0]!.id;

    await act(async () => {
      await result.current.tabs.newTab();
    });
    vi.mocked(api.openRepoDialog).mockResolvedValueOnce({ ok: true, data: "/repo/foo" });
    await act(async () => {
      await result.current.tabs.openNewTab();
    });

    if (isCaseInsensitiveFileSystem()) {
      expect(result.current.tabs.tabs).toHaveLength(1);
      expect(result.current.tabs.activeTabId).toBe(firstTabId);
    } else {
      // Case-sensitive (Linux): these are genuinely two different directories — never over-merged.
      expect(result.current.tabs.tabs).toHaveLength(2);
    }
  });

  it("openRecentInNewTab's dedup pre-check has the same trivial-spelling tolerance", async () => {
    const api = makeMockGitHydra({
      repoPath: "D:/Repos/Foo",
      commits: [makeCommit("a1", [], { subject: "Foo commit" })],
    });
    const { result } = renderTabs(api);

    await act(async () => {
      await result.current.tabs.openNewTab();
    });
    const firstTabId = result.current.tabs.tabs[0]!.id;

    await act(async () => {
      await result.current.tabs.newTab();
    });
    let outcome!: string;
    await act(async () => {
      outcome = await result.current.tabs.openRecentInNewTab("D:\\Repos\\Foo");
    });

    expect(outcome).toBe("activated-existing");
    expect(result.current.tabs.tabs).toHaveLength(1);
    expect(result.current.tabs.activeTabId).toBe(firstTabId);
  });

  it("a genuinely different directory is never treated as a duplicate", async () => {
    const api = makeMockGitHydra({
      repoPath: "/repo/one",
      commits: [makeCommit("a1", [], { subject: "One commit" })],
      reposByPath: {
        "/repo/two": { commits: [makeCommit("b1", [], { subject: "Two commit" })] },
      },
    });
    const { result } = renderTabs(api);

    await act(async () => {
      await result.current.tabs.openNewTab();
    });
    await act(async () => {
      await result.current.tabs.newTab();
    });
    vi.mocked(api.openRepoDialog).mockResolvedValueOnce({ ok: true, data: "/repo/two" });
    await act(async () => {
      await result.current.tabs.openNewTab();
    });

    expect(result.current.tabs.tabs).toHaveLength(2);
  });
});
