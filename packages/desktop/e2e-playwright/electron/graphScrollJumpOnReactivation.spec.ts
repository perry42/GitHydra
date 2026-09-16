// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * test-agent verification: real-Electron/real-git coverage for
 * specs/graph-head-indicator-and-refresh-alerting.md Addendum 3's "Verification gap found by
 * test-agent (2026-09-16)" — the ONE scenario in that addendum that had not yet been verified
 * live (only via the jsdom regression test
 * `src/App.graphScrollJumpOnReactivation.e2e.test.tsx`, and the new `CommitGraph.test.tsx` unit
 * tests for `initialScrollTop`/`onScrollPositionChange`).
 *
 * Root cause recap (unchanged from the jsdom regression test's own doc comment): once a tab's
 * live loaded row count exceeds `PAGE_SIZE` (150, `useRepositoryGraph.ts`) via ordinary near-end
 * auto-pagination, `captureTabCache()` (`instant-tab-revisit.md` FR-240/AC8, untouched by this
 * fix) correctly refuses to cache that tab, so reactivating it falls back to a full `openRepo()`
 * reopen — which unmounts/remounts `CommitGraph` in `App.tsx`'s `MainArea`. Before this round's
 * fix, `CommitGraph`'s scroll offset was local `useState` on the DOM node and came back at 0
 * regardless of the earlier `followSignal` fix. This round's fix threads `initialScrollTop`/
 * `onScrollPositionChange` through a `MainArea`-level ref (survives the remount, since `MainArea`
 * itself never unmounts) to restore it.
 *
 * This spec exercises that exact path against the REAL contextBridge/ipcMain transport and a REAL
 * on-disk git repo (not jsdom/mocked bridge) — a real scrollable DOM element, real native
 * `scrollTop` clamping as pages load in, and a real tab switch through the real UI.
 */
import { test, expect } from "@playwright/test";
import {
  closeApp,
  launchGitHydra,
  removeUserDataDir,
  stubOpenRepoDialog,
  type LaunchedApp,
} from "../helpers/launchApp";
import { cleanup, commitAll, initRepo, writeFile } from "../../src/test/gitFixture";

let handle: LaunchedApp;
let repoADir: string;
let repoBDir: string;

// Mirrors PAGE_SIZE (useRepositoryGraph.ts) without importing renderer source into this Node-side
// spec file — kept as a literal since PAGE_SIZE is a stable, already-covered-by-unit-test constant,
// not something this spec is verifying.
const PAGE_SIZE = 150;
const TOTAL_COMMITS = PAGE_SIZE + 20; // second page is non-empty, but still small/fast to build

async function openRepoThroughRealUiExact(h: LaunchedApp, repoPath: string): Promise<void> {
  await stubOpenRepoDialog(h.app, repoPath);
  await h.window.getByRole("button", { name: "Open a repository", exact: true }).click();
  await h.window.getByRole("button", { name: /^stashes/i }).waitFor({ timeout: 15_000 });
}

async function newTabInto(h: LaunchedApp, repoPath: string): Promise<void> {
  await stubOpenRepoDialog(h.app, repoPath);
  await h.window.getByRole("button", { name: "Open a repository in a new tab", exact: true }).click();
  await h.window.getByRole("button", { name: "Open a repository", exact: true }).click();
  await h.window.getByRole("button", { name: /^stashes/i }).waitFor({ timeout: 15_000 });
}

test.beforeEach(async () => {
  handle = await launchGitHydra();
});

test.afterEach(async () => {
  await closeApp(handle);
  await removeUserDataDir(handle.userDataDir);
  if (repoADir) await cleanup(repoADir);
  if (repoBDir) await cleanup(repoBDir);
});

test("AC1 (Addendum 3's verification gap): scroll position survives a fallback-reopen once a tab's rows exceed PAGE_SIZE", async () => {
  test.setTimeout(120_000);

  repoADir = await initRepo();
  // `--allow-empty` commits build a deep-enough history fast, without needing distinct file
  // content per commit — this spec cares about row COUNT/scroll position, not diff content.
  for (let i = 1; i <= TOTAL_COMMITS; i++) {
    await writeFile(repoADir, "marker.txt", `commit ${i}\n`);
    await commitAll(repoADir, `Repo A commit ${i}`);
  }

  repoBDir = await initRepo();
  await writeFile(repoBDir, "b.txt", "b\n");
  await commitAll(repoBDir, "Repo B commit");

  await openRepoThroughRealUiExact(handle, repoADir);

  const topCommitRow = handle.window.locator('[role="option"]', { hasText: `Repo A commit ${TOTAL_COMMITS}` });
  await expect(topCommitRow).toBeVisible();

  const scroller = handle.window.locator('[role="listbox"][aria-label="Commit graph"]');

  // Scroll to the bottom of the currently-loaded first page — a real native scroll, which fires a
  // real "scroll" event and lets `CommitGraph`'s own near-end/`onLoadMore` logic (unmodified by
  // this fix) load page 2, crossing the `PAGE_SIZE` row-count cache-eligibility cap. This is
  // exactly what "select a commit far down a tab's history" means for a repo bigger than one page.
  // Page 1 covers commits `TOTAL_COMMITS`..21 (150 rows); "commit 10" only renders once page 2 has
  // loaded, so its visibility is proof that the live row count has crossed the `PAGE_SIZE` (150)
  // cache-eligibility cap. Deliberately a plain substring match (not a `$`-anchored regex): each
  // row's accessible text concatenates the short SHA/subject/author/date with no separator before
  // the next field, so `$` never matches at the end of the subject text; a bare substring is safe
  // here since virtualization (`computeVisibleRange`'s 8-row overscan) only ever renders a ~32-row
  // window around the current scroll position, far too narrow to simultaneously render another
  // commit number that happens to contain "10" as a substring (e.g. "110").
  const page2BoundaryRow = handle.window.locator('[role="option"]', { hasText: "Repo A commit 10" });
  await expect(async () => {
    await scroller.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    await expect(page2BoundaryRow).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 20_000 });

  const scrollTopBeforeSwitch = await scroller.evaluate((el) => el.scrollTop);
  expect(scrollTopBeforeSwitch).toBeGreaterThan(0); // sanity: we really did scroll deep

  await newTabInto(handle, repoBDir);
  await expect(handle.window.locator('[role="option"]', { hasText: "Repo B commit" })).toBeVisible();

  const tabs = handle.window.getByRole("tab");
  await tabs.first().click();

  // FR-240/AC8 (unchanged, working as documented): row count exceeded PAGE_SIZE when
  // backgrounded, so the tab wasn't cached; reactivation re-walks the commit log from scratch
  // (real IPC round trip, real spinner/opening transition) rather than reusing cached rows.
  // Deliberately NOT asserting the top commit becomes visible here: if the scroll-restore fix
  // under test works, the graph should settle back near the bottom (where it was before switching
  // away) essentially immediately, so the top row may never render at all — asserting its
  // visibility would make this test pass only when the fix is broken. Waiting for `page2BoundaryRow`
  // instead confirms both the full reopen completed AND the deep scroll position was restored (that
  // row is only in the virtualization window when scrolled back down near it).
  await expect(page2BoundaryRow).toBeVisible({ timeout: 15_000 });

  // THE ACTUAL FIX UNDER TEST: despite the full reopen (which unmounts/remounts `CommitGraph`),
  // the restored scroll position should settle back at (not reset to 0 from) where it was before
  // switching away, once the chase-pagination restore effect has had a chance to reload page 2 and
  // re-apply the remembered offset.
  await expect
    .poll(async () => scroller.evaluate((el) => el.scrollTop), { timeout: 15_000 })
    .toBe(scrollTopBeforeSwitch);

  // Sanity cross-check on the SAME fix: the top commit is reachable by scrolling back up — proof
  // the full history really did reload (not just a leftover/stale DOM from before the tab switch).
  await scroller.evaluate((el) => {
    el.scrollTop = 0;
  });
  await expect(topCommitRow).toBeVisible({ timeout: 10_000 });
});
