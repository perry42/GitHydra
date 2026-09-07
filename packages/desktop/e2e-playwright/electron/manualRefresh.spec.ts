// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * test-agent verification: independent real-Electron/real-git coverage for
 * specs/refresh-without-teardown.md's product-facing acceptance criteria (AC1/AC2/AC3/AC4/AC7),
 * exercised against the REAL contextBridge/ipcMain transport and a REAL on-disk git repo (not the
 * jsdom `App.test.tsx` suite's mocked bridge) — the closest thing to an actual manual app launch
 * this environment's tooling supports (see `launchApp.ts`'s own doc comment on why a bare `npm
 * start`/direct `electron.exe` invocation doesn't work in this particular sandboxed shell:
 * `ELECTRON_RUN_AS_NODE=1` is set ambiently here, and this harness is the one thing that already
 * strips it for a spawned Electron process).
 */
import { test, expect } from "@playwright/test";
import { closeApp, launchGitHydra, removeUserDataDir, stubOpenRepoDialog, type LaunchedApp } from "../helpers/launchApp";
import { cleanup, commitAll, git, initRepo, writeFile } from "../../src/test/gitFixture";

let handle: LaunchedApp;
let repoDir: string;

/**
 * test-agent finding (reported separately, not fixed in the shared helper — see this task's
 * hand-off notes): `launchApp.ts`'s own `openRepoThroughRealUi`'s `/open a repository/i` button
 * locator is no longer unambiguous against the current TabBar — it now also matches the "+" new-
 * tab button's own `aria-label="Open a repository in a new tab"`, so calling the shared helper
 * throws a Playwright strict-mode violation before ever reaching the actual repo. Scoped to this
 * spec only (an exact-text match against the landing screen's own button) rather than editing the
 * shared helper every other Electron spec in this suite also depends on.
 */
async function openRepoThroughRealUiExact(handle: LaunchedApp, repoPath: string): Promise<void> {
  await stubOpenRepoDialog(handle.app, repoPath);
  await handle.window.getByRole("button", { name: "Open a repository", exact: true }).click();
  await handle.window.getByRole("button", { name: /^stashes/i }).waitFor({ timeout: 15_000 });
}

test.beforeEach(async () => {
  handle = await launchGitHydra();
});

test.afterEach(async () => {
  await closeApp(handle);
  await removeUserDataDir(handle.userDataDir);
  if (repoDir) await cleanup(repoDir);
});

test("AC1/AC2/AC3/AC4/AC6: clicking the real Toolbar Refresh button never shows the opening spinner, keeps DetailPanel mounted, keeps selection, and its busy state clears", async () => {
  repoDir = await initRepo();
  await writeFile(repoDir, "a.txt", "base\n");
  await commitAll(repoDir, "First commit");
  await writeFile(repoDir, "a.txt", "second\n");
  await commitAll(repoDir, "Second commit");

  await openRepoThroughRealUiExact(handle, repoDir);

  // Select the real first commit row so DetailPanel is genuinely open against real fetched data.
  const firstCommitRow = handle.window.locator('[role="option"]', { hasText: "First commit" });
  await expect(firstCommitRow).toBeVisible();
  await firstCommitRow.click();
  const detailPanel = handle.window.getByRole("complementary", { name: "Commit details" });
  await expect(detailPanel).toBeVisible();
  await expect(detailPanel.getByText("First commit")).toBeVisible();

  const refreshButton = handle.window.getByRole("button", { name: /^refresh commit graph$/i });
  await refreshButton.click();

  // AC2/AC3: no "Opening repository…" takeover, no DetailPanel disappearance, at any point
  // reachable through this real (fast, but real IPC round-trip) click.
  await expect(handle.window.getByText(/opening repository/i)).not.toBeVisible();
  await expect(detailPanel).toBeVisible();
  await expect(detailPanel.getByText("First commit")).toBeVisible();

  // AC4: the busy affordance clears back to idle once the real refresh round trip settles.
  await expect(handle.window.getByRole("button", { name: /^refresh commit graph$/i })).toBeEnabled({
    timeout: 10_000,
  });

  // Both original commits are still visible — the graph was reloaded, not blanked.
  await expect(handle.window.locator('[role="option"]', { hasText: "Second commit" })).toBeVisible();
  await expect(firstCommitRow).toBeVisible();
});

test("AC7: Refresh recovers a real external commit made from a separate terminal while GitHydra was open", async () => {
  repoDir = await initRepo();
  await writeFile(repoDir, "a.txt", "base\n");
  await commitAll(repoDir, "Only commit");

  await openRepoThroughRealUiExact(handle, repoDir);
  // test-agent finding (same class as `openRepoThroughRealUiExact`'s own doc comment): a bare
  // `getByText` here is ambiguous — BranchesPanel renders the current branch's own tip-commit
  // subject alongside the commit graph row's, and Playwright's `getByText` substring-matches both.
  // Scoped to the graph row specifically (same locator line 87 below already uses for its
  // absence-check), matching every other commit-row assertion in this spec.
  const onlyCommitRow = handle.window.locator('[role="option"]', { hasText: "Only commit" });
  await expect(onlyCommitRow).toBeVisible();
  await expect(handle.window.locator('[role="option"]', { hasText: "New external commit" })).toHaveCount(0);

  // A real commit lands from a separate git invocation entirely outside GitHydra's own IPC.
  await writeFile(repoDir, "b.txt", "external\n");
  await commitAll(repoDir, "New external commit");
  const { stdout: newHead } = await git(repoDir, ["rev-parse", "--short", "HEAD"]);

  await handle.window.getByRole("button", { name: /^refresh commit graph$/i }).click();

  const newCommitRow = handle.window.locator('[role="option"]', { hasText: "New external commit" });
  await expect(newCommitRow).toBeVisible({ timeout: 10_000 });
  await expect(newCommitRow.getByText(newHead.trim())).toBeVisible();
});
