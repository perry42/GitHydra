// SPDX-License-Identifier: GPL-3.0-or-later
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { configure, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "./App";
import { createRealGitHydraApi, type RealGitHydraHandle } from "./test/realGitHydraApi";
import { cleanup, commitAll, git, initRepo, makeTempDir, writeFile } from "./test/gitFixture";

// Real `git clone` child-process spawns underneath every `waitFor` — same rationale as
// `App.clone.e2e.test.tsx`.
configure({ asyncUtilTimeout: 15000 });

/**
 * test-agent verification (fix/clone-mkdir-versioncheck-fsmonitor-audit): gap sweep beyond
 * `App.clone.e2e.test.tsx`'s own AC1-AC4 coverage — that suite's own cancellation test
 * ("FR-354/FR-355: clicking Cancel mid-clone...") only exercises a SINGLE missing level
 * (`parentDir` already exists; only the leaf `cancelled-clone` folder itself is created). These
 * tests specifically exercise the NEW recursive-mkdir behavior this fix branch adds: many missing
 * levels at once, and — the one case the builder's own git-core unit tests couldn't prove by
 * themselves — that the real UI's Cancel button, clicked through the real dialog, still produces
 * the exact same whole-subtree cleanup git-core's own tests already proved at the `clone()` call
 * level directly.
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

describe("specs/online-sync-clone.md — fix/clone-mkdir-versioncheck-fsmonitor-audit gap sweep", () => {
  it(
    "clones into a destination requiring MANY (6) missing intermediate parent levels, creating every one of them",
    async () => {
      const { remoteDir, headSha } = await setupRemote();
      const parentDir = await makeTempDir();
      dirs.push(parentDir);
      const destination = path.join(parentDir, "l1", "l2", "l3", "l4", "l5", "l6-cloned-repo");

      const handle = createRealGitHydraApi();
      handles.push(handle);
      await openCloneDialog(handle);

      await userEvent.type(screen.getByLabelText(/repository url/i), remoteDir);
      await userEvent.type(screen.getByLabelText(/destination folder/i), destination);
      await userEvent.click(screen.getByRole("button", { name: /^clone$/i }));

      await screen.findByRole("button", { name: /stashes/i }, { timeout: 10000 });
      expect(screen.queryByRole("dialog", { name: /clone a repository/i })).not.toBeInTheDocument();

      const { stdout } = await git(destination, ["rev-parse", "HEAD"]);
      expect(stdout.trim()).toBe(headSha);
    },
    60000,
  );

  it(
    "clicking Cancel mid-clone into a destination requiring several missing intermediate levels removes the ENTIRE created subtree (not just the leaf), leaving the pre-existing ancestor alone",
    async () => {
      const { remoteDir } = await setupRemote();
      const parentDir = await makeTempDir();
      dirs.push(parentDir);
      // parentDir already exists (makeTempDir); everything below it is newly created by this clone.
      const destination = path.join(parentDir, "new1", "new2", "new3-cancelled-clone");

      const handle = createRealGitHydraApi();
      handles.push(handle);
      await openCloneDialog(handle);

      await userEvent.type(screen.getByLabelText(/repository url/i), remoteDir);
      await userEvent.type(screen.getByLabelText(/destination folder/i), destination);
      await userEvent.click(screen.getByRole("button", { name: /^clone$/i }));

      await screen.findByText(/cloning…/i);
      await userEvent.click(screen.getByRole("button", { name: /^cancel$/i }));

      await waitFor(() => expect(screen.getByRole("button", { name: /^clone$/i })).toBeInTheDocument());
      expect(screen.queryByText(/cloning…/i)).not.toBeInTheDocument();

      // The ENTIRE subtree this clone attempt created (new1, and everything under it) is gone...
      await waitFor(async () => {
        await expect(fs.access(path.join(parentDir, "new1"))).rejects.toThrow();
      });
      // ...but the pre-existing ancestor directory (parentDir itself) is left alone, empty.
      expect(await fs.readdir(parentDir)).toEqual([]);
    },
    60000,
  );
});
