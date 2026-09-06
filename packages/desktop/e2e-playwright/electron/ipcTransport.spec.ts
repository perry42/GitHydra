// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Gap 1 (test-agent's Playwright coverage plan): every current "e2e" test
 * (`src/App.*.e2e.test.tsx`) drives a real `GitHydraApi` in-process (`src/test/realGitHydraApi.ts`),
 * bypassing `contextBridge`/`ipcRenderer`/`ipcMain` entirely. This suite launches the REAL built
 * app (`dist-electron/main.js`/`preload.js`, produced by `npm run build`) via Playwright's
 * `_electron` launcher, so `window.gitHydra` is the genuine `contextBridge.exposeInMainWorld`
 * object, every call is a genuine `ipcRenderer.invoke` -> `ipcMain.handle` round trip (real
 * structured-clone serialization both ways), against a real temp git repo on disk.
 *
 * Scope (deliberately not exhaustive — see this suite's own hand-off notes): one representative
 * flow per method category on `GitHydraApi` (open, read/log, stage+diff+commit, branch
 * list/create/switch, stash create/apply, cherry-pick, blame) — enough breadth to prove the real
 * transport doesn't choke on any of these argument/return shapes (plain objects, arrays, nulls,
 * nested typed unions), not a re-test of business logic already covered by git-core's own tests
 * and the jsdom e2e suite.
 *
 * Each test opens its own independent temp repo + its own Electron process (`beforeEach`/
 * `afterEach`) — no shared fixture state, no ordering dependency, at the cost of a real Electron
 * launch per test (deliberately: independence over speed, matching this project's testing
 * philosophy on "zero data-loss bugs" being worth more than a fast suite).
 */
import { test, expect } from "@playwright/test";
import {
  closeApp,
  launchGitHydra,
  openRepoThroughRealUi,
  removeUserDataDir,
  type LaunchedApp,
} from "../helpers/launchApp";
import { cleanup, commitAll, git, initRepo, statusPorcelain, stashList, writeFile } from "../../src/test/gitFixture";

let handle: LaunchedApp;
let repoDir: string;

/**
 * test-agent finding (reported separately, not fixed here — see hand-off notes): `RepoSession`/
 * `Repository` never serializes concurrent git invocations against the same repo path, so a
 * mutating click can intermittently race one of the app's own fire-and-forget post-mutation
 * refresh calls and fail with a raw `fatal: Unable to create '.../index.lock': File exists` git
 * error instead of being queued/retried — observed directly against the real app on BOTH a stage
 * click and a stash-apply click while writing this suite. Retrying the click (idempotent for both
 * `stageFile` and `applyStash` — clicking "Stage"/"Apply" again after the optimistic UI has rolled
 * back is exactly what a real user would do next) keeps this suite's OWN purpose — proving the
 * real transport doesn't choke on these argument/return shapes — from being blocked by an
 * unrelated, already-reported concurrency bug in git-core's invocation layer.
 */
async function clickUntilRealGitState(
  click: () => Promise<void>,
  checkRealState: () => Promise<boolean>,
  attempts = 3,
): Promise<void> {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    await click();
    const settled = await Promise.race([
      (async () => {
        try {
          await expect(async () => expect(await checkRealState()).toBe(true)).toPass({ timeout: 4_000 });
          return true;
        } catch {
          return false;
        }
      })(),
    ]);
    if (settled) return;
  }
  // Final attempt with the full timeout, so a genuine (non-flaky) failure still reports clearly.
  await expect(async () => expect(await checkRealState()).toBe(true)).toPass({ timeout: 10_000 });
}

test.beforeEach(async () => {
  handle = await launchGitHydra();
});

test.afterEach(async () => {
  await closeApp(handle);
  await removeUserDataDir(handle.userDataDir);
  if (repoDir) await cleanup(repoDir);
});

test("opens a real repo through the real contextBridge/ipcMain transport and renders its real commit history", async () => {
  repoDir = await initRepo();
  await writeFile(repoDir, "a.txt", "base\n");
  const sha = await commitAll(repoDir, "Initial commit for IPC transport test");

  await openRepoThroughRealUi(handle, repoDir);

  // `openRepo` (round-tripping RepositoryState), `getRefs`, `createLogReader`+`readPage` (round-
  // tripping CommitInfo[]) all crossed the real transport to get here — the commit row rendering
  // with the real subject text and abbreviated real sha is proof none of that data was mangled or
  // dropped in transit.
  await expect(handle.window.getByText("Initial commit for IPC transport test")).toBeVisible();
  await expect(handle.window.getByText(sha.slice(0, 7))).toBeVisible();
});

test("stages a file and creates a commit through the real transport, landing a real commit on disk", async () => {
  repoDir = await initRepo();
  await writeFile(repoDir, "a.txt", "base\n");
  await commitAll(repoDir, "base");
  await writeFile(repoDir, "b.txt", "new file\n");

  await openRepoThroughRealUi(handle, repoDir);

  await handle.window.getByRole("button", { name: /^changes/i }).click();
  const changesPanel = handle.window.getByRole("complementary", { name: "Changes" });
  await expect(changesPanel).toBeVisible();

  // `getWorkingDirectoryChanges`/`getUntrackedFileDiff` (real transport round trip) surfaced the
  // untracked file; `stageFile` (a plain string argument) moves it into Staged. Retried against the
  // real on-disk index (see `clickUntilRealGitState`'s doc comment) rather than a single click.
  await clickUntilRealGitState(
    () => changesPanel.getByRole("button", { name: /^stage$/i }).click(),
    async () => (await statusPorcelain(repoDir)).includes("A  b.txt"),
  );
  await expect(changesPanel.locator(".gh-changes-panel__section", { hasText: "Staged (1)" })).toBeVisible();

  // `createCommit` (a plain-object argument: { subject, body, ... }) — its return value crossing
  // the transport correctly is what lets the UI clear the composer/refresh without erroring.
  await changesPanel.locator("#gh-commit-subject").fill("Add b.txt via real IPC transport");
  await changesPanel.getByRole("button", { name: /^commit$/i }).click();

  await expect(async () => {
    expect(await statusPorcelain(repoDir)).toBe("");
  }).toPass({ timeout: 10_000 });

  const { stdout } = await git(repoDir, ["log", "-1", "--pretty=%s"]);
  expect(stdout.trim()).toBe("Add b.txt via real IPC transport");
});

test("creates and switches a branch through the real transport, moving real HEAD on disk", async () => {
  repoDir = await initRepo();
  await writeFile(repoDir, "a.txt", "base\n");
  await commitAll(repoDir, "base");

  await openRepoThroughRealUi(handle, repoDir);

  // The Branches sidebar is a persistent, expanded-by-default left panel (design-pass "Branches
  // panel relocation") — no toggle needed to reveal it.
  await handle.window.getByRole("button", { name: /new branch/i }).click();
  const dialog = handle.window.getByRole("dialog");
  await expect(dialog).toBeVisible();

  // `validateBranchName` (a plain string argument/boolean-ish return) runs on every keystroke;
  // `createBranch` (a CreateBranchOptions plain object) creates + (per the checked "switch to it"
  // default) `switchBranch`s in one submit.
  await dialog.getByLabel("Branch name").fill("feature/ipc-transport");
  await dialog.getByRole("button", { name: /create branch/i }).click();
  await expect(dialog).not.toBeVisible();

  await expect(async () => {
    const { stdout } = await git(repoDir, ["rev-parse", "--abbrev-ref", "HEAD"]);
    expect(stdout.trim()).toBe("feature/ipc-transport");
  }).toPass({ timeout: 10_000 });

  // The Toolbar's current-branch label is driven by `getState`'s real refreshed RepositoryState —
  // proof the round trip's return value reflects the branch switch, not a stale cached value.
  await expect(handle.window.getByRole("button", { name: /branches — current branch feature\/ipc-transport/i })).toBeVisible();
});

test("creates and applies a stash through the real transport, round-tripping the working directory contents", async () => {
  repoDir = await initRepo();
  await writeFile(repoDir, "a.txt", "base\n");
  await commitAll(repoDir, "base");
  await writeFile(repoDir, "a.txt", "changed for stash\n");

  await openRepoThroughRealUi(handle, repoDir);

  await handle.window.getByRole("button", { name: /^stashes/i }).click();
  const stashPanel = handle.window.getByRole("complementary", { name: "Stashes" });
  await stashPanel.getByRole("button", { name: /new stash/i }).click();
  const dialog = handle.window.getByRole("dialog");
  await dialog.getByRole("button", { name: /create stash/i }).click();
  await expect(dialog).not.toBeVisible();

  await expect(async () => {
    expect(await statusPorcelain(repoDir)).toBe("");
  }).toPass({ timeout: 10_000 });
  await expect(async () => {
    expect(await stashList(repoDir)).toHaveLength(1);
  }).toPass({ timeout: 10_000 });

  // `applyStash` (a plain number index argument) restores the real working-tree content — the
  // round trip's success is only provable by the real file content changing back on disk.
  // Retried against real on-disk state (see `clickUntilRealGitState`'s doc comment) rather than a
  // single click.
  await clickUntilRealGitState(
    () => stashPanel.getByRole("button", { name: /^apply$/i }).click(),
    async () => (await statusPorcelain(repoDir)) !== "",
  );
});

test("cherry-picks a commit from another branch through the real transport, landing a real new commit", async () => {
  repoDir = await initRepo();
  await writeFile(repoDir, "a.txt", "base\n");
  await commitAll(repoDir, "base");
  await git(repoDir, ["checkout", "-q", "-b", "feature"]);
  await writeFile(repoDir, "feature.txt", "feature work\n");
  const featureSha = await commitAll(repoDir, "Feature commit to cherry-pick");
  await git(repoDir, ["checkout", "-q", "main"]);

  await openRepoThroughRealUi(handle, repoDir);

  // The default commit log reader walks `--all` refs (git-core's `commitLog.ts`), so the
  // feature-branch commit is present in the graph without needing "show all refs" toggled.
  const row = handle.window.locator('[role="option"]', { hasText: featureSha.slice(0, 7) });
  await expect(row).toBeVisible({ timeout: 10_000 });
  await row.click({ button: "right" });

  const menu = handle.window.getByRole("menu");
  await expect(menu).toBeVisible();
  // `cherryPick(shas: readonly string[])` — an array argument crossing the real transport.
  await menu.getByRole("menuitem", { name: /^cherry-pick$/i }).click();

  await expect(async () => {
    const { stdout } = await git(repoDir, ["log", "-1", "--pretty=%s"]);
    expect(stdout.trim()).toBe("Feature commit to cherry-pick");
  }).toPass({ timeout: 10_000 });
});

test("views blame for a working-tree file through the real transport, rendering the real per-line result", async () => {
  repoDir = await initRepo();
  await writeFile(repoDir, "blame-me.txt", "line one\nline two\n");
  await commitAll(repoDir, "Add blame-me.txt");

  await openRepoThroughRealUi(handle, repoDir);

  await handle.window.getByRole("button", { name: /^changes/i }).click();
  const changesPanel = handle.window.getByRole("complementary", { name: "Changes" });
  // The file shows up under Unstaged/Untracked only if actually changed — commit it clean, then
  // there's nothing in Changes; instead stage a trivial edit so the row (and its context menu)
  // exists to right-click.
  await writeFile(repoDir, "blame-me.txt", "line one\nline two\nline three\n");
  await handle.window.getByRole("button", { name: /^refresh/i }).click();
  // Scoped to the file-list row specifically (`.gh-changes-panel__file`) — auto-selecting this
  // file also repeats its name in the diff column's own heading, so an unscoped text match is
  // ambiguous (strict-mode violation).
  const fileRow = changesPanel.locator(".gh-changes-panel__file", { hasText: "blame-me.txt" });
  await expect(fileRow).toBeVisible({ timeout: 10_000 });

  await fileRow.click({ button: "right" });
  const menu = handle.window.getByRole("menu");
  await menu.getByRole("menuitem", { name: /^blame$/i }).click();

  // `getFileBlame(path, revision)` returns an array of per-line blame entries — the panel opening
  // with this file's exact real path (crossed the transport intact) is the observable proof.
  const blamePanel = handle.window.getByRole("complementary", { name: "Blame" });
  await expect(blamePanel).toBeVisible();
  await expect(blamePanel.getByText("blame-me.txt", { exact: false })).toBeVisible();
});
