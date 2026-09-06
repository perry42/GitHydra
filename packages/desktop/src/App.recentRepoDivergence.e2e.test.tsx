// SPDX-License-Identifier: GPL-3.0-or-later
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { configure, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "./App";
import { createRealGitHydraApi, type RealGitHydraHandle } from "./test/realGitHydraApi";
import { cleanup, commitAll, initRepo, writeFile } from "./test/gitFixture";

configure({ asyncUtilTimeout: 12000 });

/**
 * specs/repo-open-feedback-fixes.md FR-204/FR-205, AC6/AC7: real-git, real-`RepoSession` coverage
 * for the Recent Repositories entry's persistent "originally-picked path" secondary context — a
 * sibling to `App.repoOpenPathResolution.e2e.test.tsx`'s AC5/AC7/AC8/AC9 coverage of the
 * underlying resolved-path fix (`graph.repoPath`/tab labels) itself. That file never closes the
 * freshly-opened tab, so it can't observe the Recent Repositories list at all; this file closes
 * the tab to reach the landing screen and proves the full data flow — `App.tsx`'s `onRepoOpened` ->
 * `useRecentRepos.addRecentRepo` -> `EmptyState` -> `RecentRepoRow` — actually renders the
 * divergence in the DOM, not just as an internal state flag.
 */

const handles: RealGitHydraHandle[] = [];
const dirs: string[] = [];

afterEach(async () => {
  // @ts-expect-error test cleanup of the global bridge
  delete window.gitHydra;
  window.localStorage.clear();
  await new Promise((resolve) => setTimeout(resolve, 350));
  while (handles.length) handles.pop()!.dispose();
  while (dirs.length) {
    const dir = dirs.pop()!;
    try {
      await cleanup(dir);
    } catch {
      // Best-effort Windows file-lock tolerance, same as the sibling e2e files.
    }
  }
});

function normalizePathForAssertion(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

async function closeTheOnlyOpenTab(): Promise<void> {
  const closeButtons = screen.getAllByRole("button", { name: /^close .* tab$/i });
  expect(closeButtons).toHaveLength(1);
  await userEvent.click(closeButtons[0]!);
}

/** `getByTitle` with an equality check that tolerates git's always-forward-slash resolved-path
 * spelling vs. a native-Windows-backslash `dir` from `makeTempDir` — the same trivial-spelling
 * tolerance `looksLikeSamePath`/the sibling e2e file's own `normalizePathForAssertion` establish;
 * a real divergence (a different directory entirely) is unaffected by this normalization. */
function getByTitleNormalized(expected: string): HTMLElement {
  return screen.getByTitle(
    (_content, element) => normalizePathForAssertion(element?.getAttribute("title") ?? "") === normalizePathForAssertion(expected),
  );
}

describe("Recent Repositories divergent-path secondary context (specs/repo-open-feedback-fixes.md FR-204/FR-205)", () => {
  it("AC6: opening a subfolder of a repo's working tree, then closing the tab, shows the resolved root as the entry's primary path plus the originally-picked subfolder as persistent secondary context", async () => {
    const dir = await initRepo();
    dirs.push(dir);
    await writeFile(dir, "sub/file.txt", "content\n");
    await commitAll(dir, "Repo commit");
    const subDir = path.join(dir, "sub");

    const handle = createRealGitHydraApi();
    handles.push(handle);
    handle.setDialogPath(subDir);
    window.gitHydra = handle.api;
    render(<App />);

    await userEvent.click(screen.getByRole("button", { name: "Open a repository" }));
    await screen.findByText("Repo commit", {}, { timeout: 10000 });

    await closeTheOnlyOpenTab();
    await waitFor(() =>
      expect(screen.getByText("No repository open", { selector: "p.gh-empty-state__title" })).toBeInTheDocument(),
    );

    expect(screen.getByText("Recent repositories")).toBeInTheDocument();
    // The entry's primary path is the resolved parent toplevel, never the picked subfolder.
    expect(screen.queryByTitle(subDir)).not.toBeInTheDocument();
    expect(getByTitleNormalized(dir)).toBeInTheDocument();
    // The originally-picked subfolder is persistently surfaced as secondary context — a real DOM
    // text node, verifiable days later, not a one-time toast.
    const secondary = screen.getByText(/originally opened from/i);
    expect(normalizePathForAssertion(secondary.textContent ?? "")).toContain(normalizePathForAssertion(subDir));
  }, 30000);

  it("AC7: opening a repo's actual root directly, then closing the tab, shows that entry with no secondary-context line at all", async () => {
    const dir = await initRepo();
    dirs.push(dir);
    await writeFile(dir, "a.txt", "1\n");
    await commitAll(dir, "Repo commit");

    const handle = createRealGitHydraApi();
    handles.push(handle);
    handle.setDialogPath(dir);
    window.gitHydra = handle.api;
    render(<App />);

    await userEvent.click(screen.getByRole("button", { name: "Open a repository" }));
    await screen.findByText("Repo commit", {}, { timeout: 10000 });

    await closeTheOnlyOpenTab();
    await waitFor(() =>
      expect(screen.getByText("No repository open", { selector: "p.gh-empty-state__title" })).toBeInTheDocument(),
    );

    expect(screen.getByText("Recent repositories")).toBeInTheDocument();
    expect(getByTitleNormalized(dir)).toBeInTheDocument();
    expect(screen.queryByText(/originally opened from/i)).not.toBeInTheDocument();
  }, 30000);
});
