// SPDX-License-Identifier: GPL-3.0-or-later
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { configure, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "./App";
import { createRealGitHydraApi, type RealGitHydraHandle } from "./test/realGitHydraApi";
import { cleanup, commitAll, git, initRepo, makeTempDir, writeFile } from "./test/gitFixture";
import { getPersistedRecentRepos } from "./hooks/useRecentRepos";

// Real `git clone` child-process spawns underneath every `waitFor` — same rationale as
// `App.push.e2e.test.tsx`/`App.pull.e2e.test.tsx` (RTL's default 1000ms timeout is too tight).
configure({ asyncUtilTimeout: 15000 });

/**
 * specs/online-sync-clone.md — the acceptance-criteria sweep that needs the REAL running app, not a
 * mocked `window.gitHydra`: does driving the actual `CloneDialog` form (URL + destination fields,
 * Clone/Cancel buttons) really produce a real working-tree checkout on disk, open it as a new tab,
 * and record it in Recent Repositories (AC1); does a destination that already contains files get
 * refused with git's own real reason (AC2); does the Cancel button actually abort an in-flight
 * clone and leave nothing behind (AC3/AC4, mirroring git-core's own already-proven cleanup
 * contract) — exactly like `App.push.e2e.test.tsx` already does for Push. No network — the "remote"
 * is a real local bare repo on disk, the same technique every other online-sync e2e suite uses.
 *
 * Each test uses its own independent temp directories (no shared fixture state).
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
      // Best-effort: an occasional Windows file-lock shouldn't fail this test's own assertions.
    }
  }
});

/** A real local bare "remote" seeded with one commit — clone's own source URL, mirroring
 * `App.push.e2e.test.tsx`'s `setupRemoteAndClone` for the "remote" half only (this feature clones
 * FROM one, it doesn't need an existing working clone of its own). */
async function setupRemote(): Promise<{ remoteDir: string; headSha: string }> {
  const remoteDir = await initRepo({ bare: true });
  dirs.push(remoteDir);
  const seedDir = await initRepo();
  dirs.push(seedDir);
  await writeFile(seedDir, "a.txt", "line1\nline2\nline3\n");
  const headSha = await commitAll(seedDir, "base commit");
  await git(seedDir, ["remote", "add", "origin", remoteDir]);
  await git(seedDir, ["push", "-q", "origin", "main"]);
  return { remoteDir, headSha };
}

async function openCloneDialog(handle: RealGitHydraHandle): Promise<void> {
  window.gitHydra = handle.api;
  render(<App />);
  await userEvent.click(await screen.findByRole("button", { name: /clone a repository/i }));
  await screen.findByRole("dialog", { name: /clone a repository/i });
}

describe("specs/online-sync-clone.md — real App + real git-core integration", () => {
  it(
    "AC1: cloning a reachable local bare fixture repo by path produces a real working-tree checkout, opens as a new tab, and appears in Recent Repositories",
    async () => {
      const { remoteDir, headSha } = await setupRemote();
      const parentDir = await makeTempDir();
      dirs.push(parentDir);
      const destination = path.join(parentDir, "cloned-repo");

      const handle = createRealGitHydraApi();
      handles.push(handle);
      await openCloneDialog(handle);

      await userEvent.type(screen.getByLabelText(/repository url/i), remoteDir);
      await userEvent.type(screen.getByLabelText(/destination folder/i), destination);
      await userEvent.click(screen.getByRole("button", { name: /^clone$/i }));

      // The dialog closes and the real cloned repo opens as a new tab.
      await screen.findByRole("button", { name: /stashes/i }, { timeout: 10000 });
      expect(screen.queryByRole("dialog", { name: /clone a repository/i })).not.toBeInTheDocument();

      // A real working-tree checkout genuinely exists on disk at the chosen destination.
      const { stdout } = await git(destination, ["rev-parse", "HEAD"]);
      expect(stdout.trim()).toBe(headSha);
      // Normalizes CRLF, since a real git checkout on Windows may apply `core.autocrlf` — this
      // assertion cares that the real file content round-tripped, not about line-ending policy.
      const checkedOutFile = (await fs.readFile(path.join(destination, "a.txt"), "utf8")).replace(/\r\n/g, "\n");
      expect(checkedOutFile).toBe("line1\nline2\nline3\n");

      // FR-356: recorded in Recent Repositories via the app's own existing mechanism.
      expect(getPersistedRecentRepos()).toContain(destination);
    },
    60000,
  );

  it(
    "AC2: cloning into a destination that already contains files is refused with git's real reason surfaced verbatim",
    async () => {
      const { remoteDir } = await setupRemote();
      const destination = await makeTempDir();
      dirs.push(destination);
      await writeFile(destination, "already-here.txt", "pre-existing content\n");

      const handle = createRealGitHydraApi();
      handles.push(handle);
      await openCloneDialog(handle);

      await userEvent.type(screen.getByLabelText(/repository url/i), remoteDir);
      await userEvent.type(screen.getByLabelText(/destination folder/i), destination);
      await userEvent.click(screen.getByRole("button", { name: /^clone$/i }));

      const alert = await screen.findByRole("alert", {}, { timeout: 10000 });
      expect(alert).toHaveTextContent(/could not clone/i);
      await userEvent.click(screen.getByText(/^details$/i));
      expect(alert).toHaveTextContent(/already exists and is not an empty directory/i);

      // Never silently merged into or overwrote the pre-existing content.
      const untouched = await fs.readFile(path.join(destination, "already-here.txt"), "utf8");
      expect(untouched).toBe("pre-existing content\n");
      // No partial clone content (e.g. a stray .git) was left behind alongside it.
      const entries = await fs.readdir(destination);
      expect(entries).toEqual(["already-here.txt"]);
    },
    60000,
  );

  it(
    "FR-354/FR-355: clicking Cancel mid-clone actually aborts it and removes the destination GitHydra itself created",
    async () => {
      const { remoteDir } = await setupRemote();
      const parentDir = await makeTempDir();
      dirs.push(parentDir);
      const destination = path.join(parentDir, "cancelled-clone");

      const handle = createRealGitHydraApi();
      handles.push(handle);
      await openCloneDialog(handle);

      await userEvent.type(screen.getByLabelText(/repository url/i), remoteDir);
      await userEvent.type(screen.getByLabelText(/destination folder/i), destination);
      await userEvent.click(screen.getByRole("button", { name: /^clone$/i }));

      await screen.findByText(/cloning…/i);
      await userEvent.click(screen.getByRole("button", { name: /^cancel$/i }));

      // The dialog returns to the editable form — cloning was genuinely abandoned, not just hidden.
      await waitFor(() => expect(screen.getByRole("button", { name: /^clone$/i })).toBeInTheDocument());
      expect(screen.queryByText(/cloning…/i)).not.toBeInTheDocument();

      // git-core's own FR-355 cleanup contract: a destination it created itself is removed again.
      await waitFor(async () => {
        await expect(fs.access(destination)).rejects.toThrow();
      });
    },
    60000,
  );

  it(
    "FR-356: cloning while a repo is already open still creates a genuinely new tab, leaving the original tab's repo untouched",
    async () => {
      const { remoteDir, headSha } = await setupRemote();
      const otherRepoDir = await initRepo();
      dirs.push(otherRepoDir);
      await writeFile(otherRepoDir, "other.txt", "other repo content\n");
      await commitAll(otherRepoDir, "other repo commit");

      const parentDir = await makeTempDir();
      dirs.push(parentDir);
      const destination = path.join(parentDir, "second-tab-clone");

      const handle = createRealGitHydraApi();
      handles.push(handle);
      handle.setDialogPath(otherRepoDir);
      window.gitHydra = handle.api;
      render(<App />);
      await userEvent.click(screen.getByRole("button", { name: "Open a repository" }));
      await screen.findByRole("button", { name: /stashes/i }, { timeout: 10000 });

      // specs/online-sync-clone.md FR-351: with a repo already open, the landing screen's own
      // "Clone a repository" button no longer exists (that screen only renders when idle) — the
      // Command Palette entry (CLAUDE.md's standing "new actions get a palette entry" convention)
      // is the one way to reach it here, exactly like a real user would.
      await userEvent.keyboard("{Control>}k{/Control}");
      await userEvent.click(await screen.findByRole("option", { name: /clone a repository/i }));
      await screen.findByRole("dialog", { name: /clone a repository/i });
      await userEvent.type(screen.getByLabelText(/repository url/i), remoteDir);
      await userEvent.type(screen.getByLabelText(/destination folder/i), destination);
      await userEvent.click(screen.getByRole("button", { name: /^clone$/i }));

      await waitFor(() => expect(screen.getAllByRole("tab").length).toBe(2));
      const { stdout } = await git(destination, ["rev-parse", "HEAD"]);
      expect(stdout.trim()).toBe(headSha);

      // The original tab's own repo is completely untouched by the clone.
      const untouched = await fs.readFile(path.join(otherRepoDir, "other.txt"), "utf8");
      expect(untouched).toBe("other repo content\n");
    },
    60000,
  );
});
