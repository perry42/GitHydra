// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * test-agent spot-check (not a full re-verification): quick live-Electron regression check that
 * genuine app-initiated HEAD moves still auto-select-and-scroll after
 * fix/graph-scroll-jump-on-reactivation's changes, per
 * specs/graph-head-indicator-and-refresh-alerting.md's original AC2 and this branch's Addendum 3
 * AC4 ("Checking out a commit... still auto-scrolls to the new HEAD exactly as this spec's
 * existing AC2-4/AC6 require — unregressed"). This branch's diff (App.tsx's `MainArea` scroll-
 * position ref, CommitGraph.tsx's `initialScrollTop`/`onScrollPositionChange`/restore-chase effect)
 * doesn't touch the `followSignal`/`selectCommit` auto-follow path this exercises, and round 1 of
 * this same session already confirmed this live before that path existed — this is a cheap
 * confirmation it's still intact, not new coverage of previously-unverified behavior.
 */
import { test, expect } from "@playwright/test";
import { closeApp, launchGitHydra, removeUserDataDir, stubOpenRepoDialog, type LaunchedApp } from "../helpers/launchApp";
import { cleanup, commitAll, initRepo, writeFile } from "../../src/test/gitFixture";

let handle: LaunchedApp;
let repoDir: string;

async function openRepoThroughRealUiExact(h: LaunchedApp, repoPath: string): Promise<void> {
  await stubOpenRepoDialog(h.app, repoPath);
  await h.window.getByRole("button", { name: "Open a repository", exact: true }).click();
  await h.window.getByRole("button", { name: /^stashes/i }).waitFor({ timeout: 15_000 });
}

test.beforeEach(async () => {
  handle = await launchGitHydra();
});

test.afterEach(async () => {
  await closeApp(handle);
  await removeUserDataDir(handle.userDataDir);
  if (repoDir) await cleanup(repoDir);
});

test("AC4 spot-check: checking out an older commit from GitHydra's own UI still auto-selects it (detached HEAD)", async () => {
  repoDir = await initRepo();
  await writeFile(repoDir, "a.txt", "one\n");
  await commitAll(repoDir, "First commit");
  await writeFile(repoDir, "a.txt", "two\n");
  await commitAll(repoDir, "Second commit");
  await writeFile(repoDir, "a.txt", "three\n");
  await commitAll(repoDir, "Third commit");

  await openRepoThroughRealUiExact(handle, repoDir);

  const firstCommitRow = handle.window.locator('[role="option"]', { hasText: "First commit" });
  await expect(firstCommitRow).toBeVisible();
  await expect(firstCommitRow).toHaveAttribute("aria-selected", "false");

  await firstCommitRow.click({ button: "right" });
  await handle.window.getByRole("menuitem", { name: /checkout commit \(detached\)/i }).click();

  // Real detached checkout via real git — the row for the checked-out commit should become the
  // selected row with no additional click, per AC2/AC4 (auto-follow on genuine app-initiated HEAD
  // moves), and it must still be visible (it already was, but this confirms auto-follow doesn't
  // scroll it away either).
  await expect(firstCommitRow).toHaveAttribute("aria-selected", "true", { timeout: 10_000 });
  await expect(firstCommitRow).toBeVisible();
});
