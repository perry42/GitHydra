// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * specs/live-refresh.md in the real built app against a real repo, with every "external" change made by a real
 * `git` process or file write outside GitHydra's own IPC, picked up by the real working-tree watch (no focus
 * event is faked; the focus fallback is covered at hook level in useRepositoryGraph.liveRefresh.test.ts).
 */
import { test, expect, type Page } from "@playwright/test";
import { closeApp, launchGitHydra, removeUserDataDir, stubOpenRepoDialog, type LaunchedApp } from "../helpers/launchApp";
import { cleanup, commitAll, git, initRepo, makeTempDir, writeFile } from "../../src/test/gitFixture";

let handle: LaunchedApp;
const dirs: string[] = [];

test.beforeEach(async () => {
  handle = await launchGitHydra();
});

test.afterEach(async () => {
  await closeApp(handle);
  await removeUserDataDir(handle.userDataDir);
  while (dirs.length) await cleanup(dirs.pop()!);
});

async function openRepo(repoPath: string): Promise<void> {
  await stubOpenRepoDialog(handle.app, repoPath);
  await handle.window.getByRole("button", { name: "Open a repository", exact: true }).click();
  await handle.window.getByRole("button", { name: /^stashes/i }).waitFor({ timeout: 15_000 });
}

const win = (): Page => handle.window;
const row = (subject: string) => win().locator('[role="option"]', { hasText: subject });
const banner = () => win().getByText(/history changed outside githydra/i);

async function repoWithTwoCommits(): Promise<string> {
  const dir = await initRepo();
  dirs.push(dir);
  await writeFile(dir, "a.txt", "base\n");
  await commitAll(dir, "First commit");
  await writeFile(dir, "a.txt", "second\n");
  await commitAll(dir, "Second commit");
  return dir;
}

test("AC6: an idle external commit on the current branch follows silently: no banner, new row selected", async () => {
  const dir = await repoWithTwoCommits();
  await openRepo(dir);
  await row("Second commit").click();
  await expect(row("Second commit")).toHaveAttribute("aria-selected", "true");

  await writeFile(dir, "b.txt", "external\n");
  await commitAll(dir, "External commit");

  await expect(row("External commit")).toBeVisible({ timeout: 10_000 });
  await expect(row("External commit")).toHaveAttribute("aria-selected", "true");
  await expect(banner()).toHaveCount(0);
});

test("AC6: an idle external detached checkout moves selection to the new HEAD without a banner", async () => {
  const dir = await repoWithTwoCommits();
  await openRepo(dir);
  await git(dir, ["checkout", "--detach", "HEAD~1"]);

  await expect(row("First commit")).toHaveAttribute("aria-selected", "true", { timeout: 10_000 });
  await expect(banner()).toHaveCount(0);
});

test("AC6: an idle external branch switch follows too", async () => {
  const dir = await repoWithTwoCommits();
  await git(dir, ["branch", "older", "HEAD~1"]);
  await openRepo(dir);
  await git(dir, ["checkout", "older"]);

  await expect(row("First commit")).toHaveAttribute("aria-selected", "true", { timeout: 10_000 });
  await expect(banner()).toHaveCount(0);
});

test("AC5: an idle external fetch applies silently and leaves selection alone", async () => {
  const dir = await repoWithTwoCommits();
  const remote = await initRepo({ bare: true });
  dirs.push(remote);
  await git(dir, ["remote", "add", "origin", remote]);
  await git(dir, ["push", "-u", "origin", "HEAD"]);
  const other = await makeTempDir("githydra-other-");
  dirs.push(other);
  await git(other, ["clone", remote, "."]);
  await writeFile(other, "r.txt", "remote\n");
  await commitAll(other, "Remote commit");
  await git(other, ["push", "origin", "HEAD"]);

  await openRepo(dir);
  await row("First commit").click();
  await expect(row("First commit")).toHaveAttribute("aria-selected", "true");
  await git(dir, ["fetch", "origin"]);

  await expect(row("Remote commit")).toBeVisible({ timeout: 10_000 });
  await expect(row("First commit")).toHaveAttribute("aria-selected", "true");
  await expect(banner()).toHaveCount(0);
});

test("AC7: with the command palette open the move shows the banner and changes nothing; closing it applies by itself", async () => {
  const dir = await repoWithTwoCommits();
  await openRepo(dir);
  await row("Second commit").click();

  await win().keyboard.press("Control+k");
  await expect(win().getByRole("dialog")).toBeVisible();
  await writeFile(dir, "b.txt", "external\n");
  await commitAll(dir, "External commit");

  await expect(banner()).toBeVisible({ timeout: 10_000 });
  await expect(row("External commit")).toHaveCount(0);
  await expect(row("Second commit")).toHaveAttribute("aria-selected", "true");

  await win().keyboard.press("Escape");
  await expect(banner()).toHaveCount(0, { timeout: 10_000 });
  await expect(row("External commit")).toHaveAttribute("aria-selected", "true");
});

test("AC7: a commit-message draft holds the apply back until it is cleared", async () => {
  const dir = await repoWithTwoCommits();
  await writeFile(dir, "dirty.txt", "wip\n");
  await openRepo(dir);
  await win().getByRole("button", { name: /^changes/i }).click();
  const subject = win().getByPlaceholder("Summarize this commit");
  await subject.fill("half typed");

  await writeFile(dir, "b.txt", "external\n");
  await git(dir, ["add", "b.txt"]);
  await git(dir, ["commit", "-m", "External commit"]);

  await expect(banner()).toBeVisible({ timeout: 10_000 });
  await expect(row("External commit")).toHaveCount(0);

  await subject.fill("");
  await win().getByRole("heading", { name: "Changes" }).click(); // blur the composer
  await expect(banner()).toHaveCount(0, { timeout: 10_000 });
  await expect(row("External commit")).toBeVisible();
});

test("AC2/AC1: an external `git add` moves the file to Staged with the selection following its path; an external edit shows up on its own", async () => {
  const dir = await repoWithTwoCommits();
  await writeFile(dir, "a.txt", "edited once\n");
  await writeFile(dir, "z.txt", "other\n");
  await openRepo(dir);
  await win().getByRole("button", { name: /^changes/i }).click();
  const panel = win().getByRole("complementary", { name: "Changes" });
  const aRow = panel.getByRole("button", { name: /modified.*a\.txt/i });
  await expect(aRow).toHaveAttribute("aria-pressed", "true");

  await git(dir, ["add", "a.txt"]);
  await expect(panel.getByRole("heading", { name: /^Staged \(1\)/ })).toBeVisible({ timeout: 10_000 });
  await expect(panel.getByRole("button", { name: /modified.*a\.txt/i })).toHaveAttribute("aria-pressed", "true");
  await expect(banner()).toHaveCount(0);

  await writeFile(dir, "n.txt", "brand new\n");
  await expect(panel.getByRole("button", { name: /n\.txt/ }).first()).toBeVisible({ timeout: 10_000 });
});

test("AC3/AC4: an open diff reloads in place with scroll kept, and a reverted file says it no longer has changes", async () => {
  const dir = await initRepo();
  dirs.push(dir);
  const body = (tail: string) => Array.from({ length: 160 }, (_, i) => `line ${i}`).join("\n") + `\n${tail}\n`;
  await writeFile(dir, "long.txt", body("tail"));
  await writeFile(dir, "other.txt", "x\n");
  await commitAll(dir, "Base");
  await writeFile(dir, "long.txt", body("tail one"));
  await writeFile(dir, "other.txt", "y\n");
  await openRepo(dir);
  await win().getByRole("button", { name: /^changes/i }).click();
  const panel = win().getByRole("complementary", { name: "Changes" });
  await panel.getByRole("button", { name: /modified.*long\.txt/i }).click();
  await expect(panel.getByText("tail one")).toBeVisible();

  const scroller = panel.locator(".gh-diff-view__hunks");
  await scroller.evaluate((el) => (el.scrollTop = 0));
  const before = await scroller.evaluate((el) => el.scrollTop);

  await writeFile(dir, "long.txt", body("tail two"));
  await expect(panel.getByText("tail two")).toBeVisible({ timeout: 10_000 });
  expect(await scroller.evaluate((el) => el.scrollTop)).toBe(before);

  await git(dir, ["checkout", "--", "long.txt"]);
  await expect(panel.getByText("This file no longer has changes.")).toBeVisible({ timeout: 10_000 });
  await expect(panel.getByRole("button", { name: /modified.*other\.txt/i })).toHaveAttribute("aria-pressed", "false");
});

test("AC8: an external merge conflict raises the operation alert, is never idle-applied, and shows no applied state until Refresh", async () => {
  const dir = await initRepo();
  dirs.push(dir);
  await writeFile(dir, "c.txt", "base\n");
  await commitAll(dir, "Base");
  await git(dir, ["checkout", "-b", "feature"]);
  await writeFile(dir, "c.txt", "feature side\n");
  await commitAll(dir, "Feature change");
  await git(dir, ["checkout", "-"]);
  await writeFile(dir, "c.txt", "main side\n");
  await commitAll(dir, "Main change");
  await openRepo(dir);

  await git(dir, ["merge", "feature"]).catch(() => {}); // conflicts: exits non-zero, MERGE_HEAD is written

  const alert = win().getByRole("alert").filter({ hasText: /merge/i });
  await expect(alert.first()).toBeVisible({ timeout: 10_000 });
  // Never idle-applied: the stale repo state still shows no operation, so there is nothing to Abort or Continue yet.
  await expect(win().getByRole("button", { name: /abort/i })).toHaveCount(0);

  await alert.first().getByRole("button", { name: "Refresh" }).click();
  await expect(win().getByRole("button", { name: /abort/i }).first()).toBeEnabled({ timeout: 10_000 });
});
