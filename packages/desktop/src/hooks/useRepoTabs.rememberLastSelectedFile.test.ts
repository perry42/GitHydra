// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useState } from "react";
import { useRepositoryGraph } from "./useRepositoryGraph";
import { SESSION_TABS_KEY, useRepoTabs, type RememberedFileSelection, type RightPanel } from "./useRepoTabs";
import { makeMockGitHydra } from "../test/mockGitHydra";
import { makeCommit } from "../test/fixtures";

/**
 * specs/remember-last-selected-file.md: hook-level coverage for FR-215 through FR-219 — direct
 * `useRepoTabs`/`useRepositoryGraph` wiring (no `<App/>`), mirroring
 * `useRepoTabs.restoreSession.test.ts`'s own harness style. App-level integration coverage (the
 * full cross-panel/cross-tab behavior) lives in `App.rememberLastSelectedFile.test.tsx`.
 */

afterEach(() => {
  // @ts-expect-error test cleanup of the global bridge
  delete window.gitHydra;
  window.localStorage.clear();
});

function renderTabs(api: ReturnType<typeof makeMockGitHydra>) {
  window.gitHydra = api;
  return renderHook(() => {
    const graph = useRepositoryGraph();
    const [rightPanel, setRightPanel] = useState<RightPanel>("none");
    const [selectedFile, setSelectedFile] = useState<RememberedFileSelection | null>(null);
    const tabs = useRepoTabs({
      graph,
      rightPanel,
      setRightPanel,
      getSeedRightPanel: () => "none",
      selectedFile,
      setSelectedFile,
    });
    return { graph, tabs, rightPanel, setRightPanel, selectedFile, setSelectedFile };
  });
}

describe("useRepoTabs — remember last selected file (FR-215/FR-216)", () => {
  it("snapshotActiveTab captures the live selectedFile into the backgrounded tab, and a freshly-created tab starts with none", async () => {
    const api = makeMockGitHydra({
      repoPath: "/repoA",
      commits: [makeCommit("a1", [], { subject: "A" })],
      reposByPath: { "/repoB": { commits: [makeCommit("b1", [], { subject: "B" })] } },
    });
    const { result } = renderTabs(api);

    await act(async () => {
      await result.current.tabs.openNewTab();
    });
    act(() => result.current.setRightPanel("commit"));
    act(() => result.current.setSelectedFile({ kind: "commit", path: "a-file.ts" }));

    vi.mocked(api.openRepoDialog).mockResolvedValueOnce({ ok: true, data: "/repoB" });
    await act(async () => {
      await result.current.tabs.openNewTab();
    });

    const tabA = result.current.tabs.tabs[0]!;
    expect(tabA.remembered.selectedFile).toEqual({ kind: "commit", path: "a-file.ts" });
    // FR-216: a brand-new tab starts with nothing selected — never leaks the backgrounded tab's.
    expect(result.current.selectedFile).toBeNull();
  });

  it("FR-217/FR-218: activating a different tab replays ITS OWN remembered file (not the one being backgrounded)", async () => {
    const api = makeMockGitHydra({
      repoPath: "/repoA",
      commits: [makeCommit("a1", [], { subject: "A" })],
      reposByPath: { "/repoB": { commits: [makeCommit("b1", [], { subject: "B" })] } },
    });
    const { result } = renderTabs(api);
    await act(async () => {
      await result.current.tabs.openNewTab();
    });
    act(() => result.current.setSelectedFile({ kind: "commit", path: "a-file.ts" }));

    vi.mocked(api.openRepoDialog).mockResolvedValueOnce({ ok: true, data: "/repoB" });
    await act(async () => {
      await result.current.tabs.openNewTab();
    });
    act(() => result.current.setSelectedFile({ kind: "changes", category: "unstaged", path: "b-file.ts" }));

    const tabA = result.current.tabs.tabs[0]!;
    await act(async () => {
      await result.current.tabs.activateTab(tabA.id);
    });

    // repoB's own selection was captured on the way out...
    const tabB = result.current.tabs.tabs[1]!;
    expect(tabB.remembered.selectedFile).toEqual({ kind: "changes", category: "unstaged", path: "b-file.ts" });
    // ...and repoA's replays onto the live value, not repoB's.
    expect(result.current.selectedFile).toEqual({ kind: "commit", path: "a-file.ts" });
  });

  it("AC5: closeTab's adjacent reactivation replays the adjacent tab's own remembered file, never the just-closed tab's", async () => {
    const api = makeMockGitHydra({
      repoPath: "/repoA",
      commits: [makeCommit("a1", [], { subject: "A" })],
      reposByPath: { "/repoB": { commits: [makeCommit("b1", [], { subject: "B" })] } },
    });
    const { result } = renderTabs(api);
    await act(async () => {
      await result.current.tabs.openNewTab();
    });
    act(() => result.current.setSelectedFile({ kind: "commit", path: "should-never-replay.ts" }));

    vi.mocked(api.openRepoDialog).mockResolvedValueOnce({ ok: true, data: "/repoB" });
    await act(async () => {
      await result.current.tabs.openNewTab();
    });
    act(() => result.current.setSelectedFile({ kind: "commit", path: "b-file.ts" }));

    const tabB = result.current.tabs.tabs[1]!;
    act(() => result.current.tabs.closeTab(tabB.id));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    // The adjacent (only remaining) tab is repoA — its own remembered file replays.
    expect(result.current.selectedFile).toEqual({ kind: "commit", path: "should-never-replay.ts" });
  });

  it("FR-217/FR-218: app-relaunch restoration (the mount-time eager activation) replays the previously-active tab's remembered file", async () => {
    window.localStorage.setItem(
      SESSION_TABS_KEY,
      JSON.stringify({
        tabs: [
          {
            repoPath: "/repoA",
            remembered: {
              selectedSha: "a1",
              filter: {},
              showAllRefs: false,
              rightPanel: "commit",
              selectedFile: { kind: "commit", path: "restored.ts" },
            },
          },
        ],
        activeRepoPath: "/repoA",
      }),
    );
    const api = makeMockGitHydra({ repoPath: "/repoA", commits: [makeCommit("a1", [], { subject: "A" })] });
    const { result } = renderTabs(api);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(result.current.selectedFile).toEqual({ kind: "commit", path: "restored.ts" });
  });

  it("AC6: a tab's remembered.selectedFile is never cleared/mutated by this hook — it survives being reactivated (and re-backgrounded) so it's still there for a later relaunch", async () => {
    const api = makeMockGitHydra({
      repoPath: "/repoA",
      commits: [makeCommit("a1", [], { subject: "A" })],
      reposByPath: { "/repoB": { commits: [makeCommit("b1", [], { subject: "B" })] } },
    });
    const { result } = renderTabs(api);
    await act(async () => {
      await result.current.tabs.openNewTab();
    });
    act(() => result.current.setSelectedFile({ kind: "commit", path: "a-file.ts" }));

    vi.mocked(api.openRepoDialog).mockResolvedValueOnce({ ok: true, data: "/repoB" });
    await act(async () => {
      await result.current.tabs.openNewTab(); // backgrounds repoA, snapshotting its selectedFile
    });
    expect(result.current.tabs.tabs[0]!.remembered.selectedFile).toEqual({ kind: "commit", path: "a-file.ts" });

    // Reactivating repoA replays its remembered file (per the earlier test) but — unlike an
    // earlier design this hook does NOT implement — never clears the tabs-array copy of it.
    const tabA = result.current.tabs.tabs[0]!;
    await act(async () => {
      await result.current.tabs.activateTab(tabA.id);
    });
    expect(result.current.tabs.tabs.find((t) => t.id === tabA.id)!.remembered.selectedFile).toEqual({
      kind: "commit",
      path: "a-file.ts",
    });
  });

  it("FR-215: a pre-existing (older-build) persisted session lacking `selectedFile` entirely degrades gracefully to null, without losing selectedSha/filter/rightPanel", async () => {
    window.localStorage.setItem(
      SESSION_TABS_KEY,
      JSON.stringify({
        tabs: [{ repoPath: "/repoA", remembered: { selectedSha: "a1", filter: {}, showAllRefs: true, rightPanel: "commit" } }],
        activeRepoPath: "/repoA",
      }),
    );
    const api = makeMockGitHydra({ repoPath: "/repoA", commits: [makeCommit("a1", [], { subject: "A" })] });
    const { result } = renderTabs(api);

    expect(result.current.tabs.tabs[0]!.remembered.selectedFile).toBeNull();
    expect(result.current.tabs.tabs[0]!.remembered.showAllRefs).toBe(true);
    expect(result.current.tabs.tabs[0]!.remembered.rightPanel).toBe("commit");
  });
});
