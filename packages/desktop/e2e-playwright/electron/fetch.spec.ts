// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * specs/online-sync-fetch.md FR-320 through FR-328: the real, no-mock verification for this
 * feature's whole stack — real Electron `contextBridge`/`ipcMain` transport (`ipcTransport.spec.ts`'s
 * own established pattern), real `git fetch` against a real local `file://` bare remote (no
 * network, no credentials — the fixture git-core-engineer's own fetch.test.ts established for this
 * exact reason), and real on-disk ref state asserted independently of the UI.
 *
 * Scenario: repo `local` tracks bare remote `origin`. A second clone `otherClone` pushes a new
 * commit to `origin` that `local` doesn't have yet (simulating a teammate's push); `local` also
 * makes its OWN local commit that it hasn't pushed — so after a fetch, `main` is both ahead AND
 * behind its upstream (a genuine divergence, FR-326's warning-glyph case), not merely behind.
 */
import { test, expect } from "@playwright/test";
import {
  closeApp,
  launchGitHydra,
  openRepoThroughRealUi,
  removeUserDataDir,
  type LaunchedApp,
} from "../helpers/launchApp";
import { cleanup, commitAll, git, initRepo, writeFile } from "../../src/test/gitFixture";

let handle: LaunchedApp;
let localDir: string;
let bareDir: string;
let otherCloneDir: string;

test.afterEach(async () => {
  await closeApp(handle);
  await removeUserDataDir(handle.userDataDir);
  if (localDir) await cleanup(localDir);
  if (bareDir) await cleanup(bareDir);
  if (otherCloneDir) await cleanup(otherCloneDir);
});

test("Fetch updates remote-tracking refs, shows a diverged warning glyph, and refreshes the 'last fetched' caption — all with no restart (FR-326/FR-327)", async () => {
  // --- Fixture: a bare remote, a tracking local clone, and a second clone that pushes ahead. ---
  bareDir = await initRepo({ bare: true });

  localDir = await initRepo();
  await writeFile(localDir, "a.txt", "base\n");
  await commitAll(localDir, "base commit");
  await git(localDir, ["remote", "add", "origin", bareDir]);
  await git(localDir, ["push", "-q", "-u", "origin", "main"]);

  otherCloneDir = await initRepo();
  await git(otherCloneDir, ["remote", "add", "origin", bareDir]);
  await git(otherCloneDir, ["fetch", "-q", "origin"]);
  await git(otherCloneDir, ["checkout", "-q", "-b", "main", "origin/main"]);
  await writeFile(otherCloneDir, "from-teammate.txt", "pushed by someone else\n");
  const teammateSha = await commitAll(otherCloneDir, "A teammate's commit, pushed to origin");
  await git(otherCloneDir, ["push", "-q", "origin", "main"]);

  // `local`'s own unpushed commit — after a fetch, `main` is ahead of origin/main by this one AND
  // behind it by the teammate's one (a genuine divergence).
  await writeFile(localDir, "local-only.txt", "not pushed\n");
  await commitAll(localDir, "A local commit that was never pushed");

  // Sanity: before any fetch, origin/main in `local`'s own git dir must NOT yet know about the
  // teammate's commit — proves the later assertion is really observing a fetch's effect.
  const beforeFetch = await git(localDir, ["rev-parse", "origin/main"]);
  expect(beforeFetch.stdout.trim()).not.toBe(teammateSha);

  // --- Real app ---
  handle = await launchGitHydra();
  await openRepoThroughRealUi(handle, localDir);

  const fetchButton = handle.window.getByRole("button", { name: /^fetch all remotes$/i });
  await expect(fetchButton).toBeVisible();

  // FR-326: no fetch has happened yet this session.
  await expect(handle.window.getByText("never fetched this session").first()).toBeVisible();

  await fetchButton.click();

  // FR-327/AC5: the per-remote outcome banner appears once the real `git fetch` settles, naming
  // the real remote ("origin") truthfully as successful.
  await expect(handle.window.getByText(/origin: fetched successfully/i)).toBeVisible({ timeout: 15_000 });

  // The real, independent proof: `local`'s own on-disk `origin/main` now resolves to the
  // teammate's real commit SHA — not just a UI claim.
  await expect(async () => {
    const { stdout } = await git(localDir, ["rev-parse", "origin/main"]);
    expect(stdout.trim()).toBe(teammateSha);
  }).toPass({ timeout: 10_000 });

  // Dismiss the outcome banner, then verify the UI reflects the fresh fetch with no restart/manual
  // refresh (FR-326's own "updates immediately" requirement).
  await handle.window.getByRole("button", { name: /^dismiss$/i }).click();

  // BranchesPanel row: a real relative "fetched ... ago" caption, no longer the "never fetched"
  // placeholder, and real ahead/behind counts (↑1 local, ↓1 from the teammate's push).
  await expect(handle.window.getByText(/^fetched (just now|\d+ seconds? ago)$/i).first()).toBeVisible();
  await expect(handle.window.getByText("↑1 ↓1 origin/main")).toBeVisible();

  // The commit graph's ref chip for `main` (a diverged local branch — ahead AND behind) carries
  // the FR-326 warning glyph, surfaced in its accessible name/tooltip.
  const mainChip = handle.window.getByRole("img", { name: /local branch: main \(diverged from its upstream\)/i });
  await expect(mainChip).toBeVisible();
});

// A real cancel-mid-fetch scenario is deliberately NOT exercised here against this real, local
// `file://` remote: that fetch settles too fast (near-instant) to reliably land a click in the
// narrow "fetching" window without either a flaky race or an artificially slowed-down fixture,
// and this suite's own standing convention (`ipcTransport.spec.ts`) is real transport/data-shape
// verification, not timing-sensitive races. Cancellation itself is covered deterministically two
// other ways: `useFetchAction.test.ts` (a controlled, deferred-promise mock proves the UI's own
// request-id/cancel-signal wiring) and git-core's own `fetch.test.ts` (a real, slow-enough
// scenario proving the underlying git process is actually killed, no orphaned process). Flagged
// here rather than shipping a test that would intermittently fail for reasons unrelated to a real
// bug.
