// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * test-agent independent verification spec (temporary, not part of the permanent suite): visually
 * confirms, against a REAL launched Electron app and a REAL on-disk repo that has genuinely been
 * through `git filter-branch`, that ROADMAP.md's "commit graph shows duplicate pre-/post-rewrite
 * commits plus phantom stash-synthetic rows for any filter-branch'd repo" bug (fixed in
 * `packages/git-core/src/commitLog.ts`'s `buildRevisionArgs()`, commit 55cc17a) does not reproduce
 * in the actual rendered graph — not just in the unit-level `commitLog.test.ts` regression test.
 */
import { test, expect } from "@playwright/test";
import { closeApp, launchGitHydra, openRepoThroughRealUi, removeUserDataDir, type LaunchedApp } from "../helpers/launchApp";
import { cleanup, commitAll, git, initRepo, writeFile } from "../../src/test/gitFixture";

let handle: LaunchedApp;
let repoDir: string;

test.beforeEach(async () => {
  handle = await launchGitHydra();
});

test.afterEach(async () => {
  await closeApp(handle);
  await removeUserDataDir(handle.userDataDir);
  if (repoDir) await cleanup(repoDir);
});

test("graph shows only the rewritten commits, no duplicate pre-rewrite rows and no phantom stash rows, after a real git filter-branch", async () => {
  repoDir = await initRepo();
  await writeFile(repoDir, "a.txt", "1\n");
  await commitAll(repoDir, "first");
  await writeFile(repoDir, "a.txt", "2\n");
  await commitAll(repoDir, "second");

  // A real stash, so refs/original/refs/stash (the phantom-row source) actually gets created too —
  // matches the reported bug exactly ("even when git stash list was empty" after filter-branch,
  // since filter-branch backs up whatever refs/stash pointed at BEFORE the rewrite, and the
  // in-progress rewrite drops the live refs/stash ref itself, leaving `git stash list` empty
  // afterwards while the backup ref still lingers).
  await writeFile(repoDir, "a.txt", "dirty\n");
  await git(repoDir, ["stash", "push", "-m", "wip before rewrite"]);
  await git(repoDir, ["stash", "drop"]);

  await git(repoDir, ["filter-branch", "-f", "--msg-filter", "sed 's/$/ (rewritten)/'", "--", "--all"], {
    FILTER_BRANCH_SQUELCH_WARNING: "1",
  });

  // Sanity: the rewrite really did leave a refs/original/* backup ref reachable via --all.
  const { stdout: originalRef } = await git(repoDir, ["rev-parse", "refs/original/refs/heads/main"]);
  expect(originalRef.trim()).not.toBe("");

  await openRepoThroughRealUi(handle, repoDir);

  const rows = handle.window.locator('[role="option"]');
  await expect(rows.filter({ hasText: "second (rewritten)" })).toBeVisible();
  await expect(rows.filter({ hasText: "first (rewritten)" })).toBeVisible();

  // Exactly two rows total: no duplicate pre-rewrite "first"/"second" (without the suffix), and
  // no phantom "On main:"/"index on main:"/"untracked files on main:" synthetic stash rows.
  await expect(rows).toHaveCount(2);
  await expect(rows.filter({ hasText: /^(?!.*\(rewritten\)).*first/ })).toHaveCount(0);
  await expect(rows.filter({ hasText: /^(?!.*\(rewritten\)).*second/ })).toHaveCount(0);
  await expect(handle.window.getByText(/^On main:/)).toHaveCount(0);
  await expect(handle.window.getByText(/^index on main:/)).toHaveCount(0);
  await expect(handle.window.getByText(/^untracked files on main:/)).toHaveCount(0);
});
