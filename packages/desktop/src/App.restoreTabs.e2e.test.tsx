// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from "vitest";
import { configure, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Repository } from "@githydra/git-core";
import { App } from "./App";
import { createRealGitHydraApi, type RealGitHydraHandle } from "./test/realGitHydraApi";
import { cleanup, commitAll, git, initRepo, writeFile } from "./test/gitFixture";

/**
 * specs/restore-tabs-on-relaunch.md AC3/AC8/AC9: the real, unmocked-git-core proof — mirrors
 * `App.repoList.e2e.test.tsx`'s own split (App.restoreTabs.test.tsx covers the mock-backend
 * functional behavior; this file proves it against a REAL `RepoSession`/`@githydra/git-core`/real
 * `git` binary stack, `./test/realGitHydraApi.ts`).
 *
 * AC3 asks for "a call-count assertion at launch... the same style as the existing zero-network-
 * calls tests (`noNetworkCalls.test.ts` precedent) but asserting on git-spawn count instead."
 * `noNetworkCalls.test.ts`'s own technique — `vi.mock("node:child_process", ...)` at module scope
 * — only works there because that suite imports `gitProcess.ts` as same-package source
 * (`../src/index`); here, `@githydra/git-core` is a workspace *dependency* resolved to its
 * pre-built `dist/index.js` (`"main": "dist/index.js"`, `packages/git-core/package.json`), which
 * Vite/Vitest's SSR module runner externalizes (loads via Node's own `require`, outside the module
 * graph `vi.mock` factory replacements apply to) — confirmed empirically: the mocked `spawn` wrapper
 * is simply never invoked from this package. Spying on `Repository.open` (the one, single git-core
 * entry point every real `openRepo` call in this app funnels through — `RepoSession.open()` calls
 * it directly, `electron/repoSession.ts`) instead is a call-count proof at the equivalent
 * granularity that DOES work across that boundary: `vi.spyOn` mutates the actual, already-imported
 * class object shared by every importer in this one process, rather than depending on module
 * resolution/mocking. Every `Repository.open()` call itself spawns multiple real `git` child
 * processes underneath (rev-parse, cat-file, etc. — see git-core's own `Repository.open()`), so "0
 * calls to `Repository.open()` for this path" is exactly "0 git-process spawns for this path."
 *
 * AC8/AC9 (no network calls, regardless of host or no-remote-at-all) reuse this suite's own
 * established convention (see `App.repoList.e2e.test.tsx`'s AC7 block) rather than re-deriving a
 * new one: remotes configured against GitHub/GitLab/Bitbucket/self-hosted, all pointed at
 * non-routable addresses — an accidental network call would hang/fail loudly (this file's own
 * `configure({ asyncUtilTimeout })` would then time out), not silently succeed.
 */

configure({ asyncUtilTimeout: 12000 });

const handles: RealGitHydraHandle[] = [];
const dirs: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
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

async function addUnreachableRemotes(dir: string): Promise<void> {
  await git(dir, ["remote", "add", "origin", "https://github.com.invalid.198.51.100.1/o/r.git"]);
  await git(dir, ["remote", "add", "gitlab", "https://gitlab.com.invalid.198.51.100.1/o/r.git"]);
  await git(dir, ["remote", "add", "bitbucket", "https://bitbucket.org.invalid.198.51.100.1/o/r.git"]);
  await git(dir, ["remote", "add", "selfhosted", "https://git.example.invalid.198.51.100.1/o/r.git"]);
}

/** `Repository.open(path, ...)`'s own first positional argument for every recorded call. */
function openedPaths(spy: ReturnType<typeof vi.spyOn>): string[] {
  return spy.mock.calls.map((c) => c[0] as string);
}

describe("restore-tabs-on-relaunch (specs/restore-tabs-on-relaunch.md): real git-core proof", () => {
  it(
    "AC1/AC2/AC3/AC4/AC8/AC9: relaunch with 3 restored tabs opens git-core only for the active one, remains network-free, and only reaches the other repos once their tabs are actually clicked — with GitHub/GitLab/Bitbucket/self-hosted remotes configured (none reachable) and a purely local repo alike",
    async () => {
      const dirA = await initRepo();
      dirs.push(dirA);
      await writeFile(dirA, "a.txt", "1\n");
      await commitAll(dirA, "Repo A commit");
      await addUnreachableRemotes(dirA);

      const dirB = await initRepo();
      dirs.push(dirB);
      await writeFile(dirB, "b.txt", "1\n");
      await commitAll(dirB, "Repo B commit");
      // AC9: purely local, no remote at all — deliberately the odd one out among the three.

      const dirC = await initRepo();
      dirs.push(dirC);
      await writeFile(dirC, "c.txt", "1\n");
      await commitAll(dirC, "Repo C commit");
      await addUnreachableRemotes(dirC);

      // Session 1: open all three, leaving repo C active (opened last).
      const handle1 = createRealGitHydraApi();
      handles.push(handle1);
      window.gitHydra = handle1.api;
      const { unmount } = render(<App />);
      handle1.setDialogPath(dirA);
      await userEvent.click(screen.getByRole("button", { name: "Open a repository" }));
      await screen.findByText("Repo A commit", {}, { timeout: 10000 });
      await userEvent.click(screen.getByRole("button", { name: /open a repository in a new tab/i }));
      handle1.setDialogPath(dirB);
      await userEvent.click(screen.getByRole("button", { name: "Open a repository" }));
      await screen.findByText("Repo B commit", {}, { timeout: 10000 });
      await userEvent.click(screen.getByRole("button", { name: /open a repository in a new tab/i }));
      handle1.setDialogPath(dirC);
      await userEvent.click(screen.getByRole("button", { name: "Open a repository" }));
      await screen.findByText("Repo C commit", {}, { timeout: 10000 });
      expect(screen.getAllByRole("tab")).toHaveLength(3);
      unmount();
      // @ts-expect-error test cleanup — simulating the app actually quitting before "relaunch".
      delete window.gitHydra;

      // "Relaunch": fresh RepoSession/window.gitHydra, same on-disk repos, same persisted session
      // (real localStorage, never cleared between these two "sessions" in this test) — the spy is
      // installed right at this boundary so only relaunch-caused `Repository.open()` calls count.
      const openSpy = vi.spyOn(Repository, "open");
      const handle2 = createRealGitHydraApi();
      handles.push(handle2);
      window.gitHydra = handle2.api;
      render(<App />);

      // AC1: same 3 tabs, same order, on the very first render.
      const tabs = screen.getAllByRole("tab");
      expect(tabs).toHaveLength(3);
      expect(tabs[2]).toHaveAttribute("aria-selected", "true");

      // AC2: repo C (the previously-active tab) loads automatically, and AC8/AC9 already hold for
      // it here (this `findByText` would itself time out/hang had a network call actually fired
      // against repo C's unreachable GitHub/GitLab/Bitbucket/self-hosted remotes).
      await screen.findByText("Repo C commit", {}, { timeout: 10000 });

      // AC3: git-core was opened exactly once — for repo C. Repos A/B were never touched.
      expect(openSpy).toHaveBeenCalledTimes(1);
      expect(openedPaths(openSpy)).toEqual([dirC]);

      // AC4: clicking an inactive restored tab (repo A) now — and only now — reaches the real
      // repo, through the ordinary lazy-activation path (and stays network-free, same reasoning).
      await userEvent.click(tabs[0]!);
      await screen.findByText("Repo A commit", {}, { timeout: 10000 });
      expect(openSpy).toHaveBeenCalledTimes(2);
      expect(openedPaths(openSpy)).toEqual([dirC, dirA]);
      // Repo B (still never clicked, purely local/no-remote — AC9) remains completely untouched.
      expect(openedPaths(openSpy)).not.toContain(dirB);
    },
    30000,
  );

  it(
    "AC5: a restored tab whose directory was deleted since the last session shows the inline not-found state on activation, real backend included, without disturbing the sibling tab",
    async () => {
      const dirGone = await initRepo();
      await writeFile(dirGone, "a.txt", "1\n");
      await commitAll(dirGone, "Gone commit");

      const dirLive = await initRepo();
      dirs.push(dirLive);
      await writeFile(dirLive, "b.txt", "1\n");
      await commitAll(dirLive, "Live commit");

      const handle1 = createRealGitHydraApi();
      handles.push(handle1);
      window.gitHydra = handle1.api;
      const { unmount } = render(<App />);
      handle1.setDialogPath(dirGone);
      await userEvent.click(screen.getByRole("button", { name: "Open a repository" }));
      await screen.findByText("Gone commit", {}, { timeout: 10000 });
      await userEvent.click(screen.getByRole("button", { name: /open a repository in a new tab/i }));
      handle1.setDialogPath(dirLive);
      await userEvent.click(screen.getByRole("button", { name: "Open a repository" }));
      await screen.findByText("Live commit", {}, { timeout: 10000 });
      unmount();
      // @ts-expect-error test cleanup
      delete window.gitHydra;

      // The directory genuinely no longer exists by the time of "relaunch" — not just a removed
      // `.git`, the whole path is gone (moved/deleted, per the spec's own wording).
      await cleanup(dirGone);

      const handle2 = createRealGitHydraApi();
      handles.push(handle2);
      window.gitHydra = handle2.api;
      render(<App />);
      await screen.findByText("Live commit", {}, { timeout: 10000 });

      const tabs = screen.getAllByRole("tab");
      expect(tabs).toHaveLength(2);
      await userEvent.click(tabs[0]!); // the now-gone repo's tab

      await waitFor(() => expect(screen.getByText("Repository not found")).toBeInTheDocument(), { timeout: 10000 });
      expect(screen.getByRole("button", { name: /try again/i })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /remove from list/i })).toBeInTheDocument();
      expect(screen.queryByText(/could not open this repository/i)).not.toBeInTheDocument();
      expect(screen.getAllByRole("tab")).toHaveLength(2);

      await userEvent.click(screen.getAllByRole("tab")[1]!);
      await screen.findByText("Live commit", {}, { timeout: 10000 });
    },
    30000,
  );
});
