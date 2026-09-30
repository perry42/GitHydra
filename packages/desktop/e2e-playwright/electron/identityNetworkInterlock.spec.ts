// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * specs/identity-profile-network-interlock.md — real-Electron verification (test-agent
 * independent-verification pass, not part of the original implementation). `App.identityNetwork
 * Interlock.test.tsx` already proves this against jsdom + a mocked `GitHydraApi`; this spec proves
 * the SAME behavior holds through a real `BrowserWindow`/real `contextBridge`/real `ipcMain`, per
 * this project's "no mock git itself" testing bar.
 *
 * A real local `git fetch`/`git clone` against a real repo settles too fast (sub-second) to
 * reliably observe an in-flight UI state without an artificial, timing-fragile delay — so this
 * spec instead substitutes ONE real `ipcMain.handle` registration (for exactly the fetch/clone
 * channel under test) with a test-controlled deferred promise, the same "the real UI/IPC plumbing
 * is real; only the one non-automatable native surface is stubbed" precedent this suite's own
 * `stubOpenRepoDialog` helper already established for the native file-picker dialog. Every other
 * layer — `contextBridge`, `ipcRenderer.invoke`, `App.tsx`'s real hooks, the real DOM — is exactly
 * the real thing a user's click drives.
 *
 * Both dialog/toolbar sequences below are ordered to match what a REAL user can actually click:
 * `IdentityProfilesDialog` (like `CommandPalette`/`CloneDialog`) is a full-viewport modal folded
 * into `App.tsx`'s own `anyModalDialogOpen` gate, so it must be CLOSED before the Toolbar's own
 * Fetch button (or Ctrl/Cmd+K, the only route to `CloneDialog`) is reachable at all — attempting
 * both open at once is not a real, reachable sequence in this app (see the second test's own doc
 * comment for the full finding).
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { test, expect, type ElectronApplication, type Page } from "@playwright/test";
import { closeApp, launchGitHydra, openRepoThroughRealUi, removeUserDataDir, type LaunchedApp } from "../helpers/launchApp";
import { cleanup, commitAll, initRepo, writeFile } from "../../src/test/gitFixture";

const execFileP = promisify(execFile);

let handle: LaunchedApp;
let repoDir: string;

test.afterEach(async () => {
  await closeApp(handle);
  await removeUserDataDir(handle.userDataDir);
  if (repoDir) await cleanup(repoDir);
});

/**
 * Replaces the real main-process `ipcMain.handle(channel, ...)` registration with a
 * test-controlled one that never resolves until `resolveTestIpc(app, channel, value)` is called —
 * stores the pending resolver on a main-process global keyed by channel so a later, separate
 * `app.evaluate` call (this test's "settle it now" step) can reach back into the SAME closure.
 */
async function stubPendingIpcHandler(app: ElectronApplication, channel: string): Promise<void> {
  await app.evaluate(({ ipcMain }, chan) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const g = global as any;
    g.__testPendingIpc ??= {};
    ipcMain.removeHandler(chan);
    ipcMain.handle(chan, () => new Promise((resolve) => (g.__testPendingIpc[chan] = resolve)));
  }, channel);
}

async function resolveTestIpc(app: ElectronApplication, channel: string, value: unknown): Promise<void> {
  await app.evaluate(
    (_electron, { chan, val }) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (global as any).__testPendingIpc[chan](val);
    },
    { chan: channel, val: value },
  );
}

/**
 * Creates one profile and applies it to the currently-open repo, leaving the dialog OPEN.
 *
 * This helper used to close and reopen the dialog to work around a stale-closure bug in
 * `useIdentityProfileApplication.performApply` (its post-apply `reload()` read the pre-update
 * `applications` snapshot, so a fresh Apply showed "Set locally (not by GitHydra)" and a disabled
 * Remove until the dialog remounted). That is fixed (the refetch now uses the just-written record),
 * so no workaround is needed: Remove must be enabled immediately, without a reopen.
 */
async function applyProfileAndReopen(window: Page): Promise<void> {
  await window.getByRole("button", { name: /git identity profiles/i }).click();
  const dialog = window.getByRole("dialog", { name: /git identity profiles/i });
  await dialog.getByRole("button", { name: /new profile/i }).click();
  await dialog.getByLabel(/profile name/i).fill("Work");
  await dialog.getByLabel(/^user\.name$/i).fill("Jane Doe");
  await dialog.getByLabel(/^user\.email$/i).fill("jane@work.example");
  await dialog.getByRole("button", { name: /create profile/i }).click();
  await dialog.getByRole("button", { name: /apply to this repository/i }).click();
  await expect(dialog.getByText(/^Applied: Work/)).toBeVisible();
  await expect(dialog.getByRole("button", { name: /remove applied profile/i })).toBeEnabled();
}

async function gitLocalConfig(dir: string, key: string): Promise<string | null> {
  try {
    const { stdout } = await execFileP("git", ["config", "--local", "--get", key], { cwd: dir });
    return stdout.trim();
  } catch {
    return null; // exit 1 = key unset
  }
}

test("real Electron: Apply shows 'Applied by GitHydra' with Remove enabled immediately, and Remove clears it with the correct disabled reason (no dialog reopen)", async () => {
  repoDir = await initRepo();
  await writeFile(repoDir, "a.txt", "hello\n");
  await commitAll(repoDir, "initial commit");
  handle = await launchGitHydra();
  await openRepoThroughRealUi(handle, repoDir);

  await applyProfileAndReopen(handle.window);
  const dialog = handle.window.getByRole("dialog", { name: /git identity profiles/i });
  await expect(dialog.getByText("Set locally (not by GitHydra)")).toHaveCount(0);
  await expect(dialog.getByText(/Applied by GitHydra/i).first()).toBeVisible();
  await expect(dialog.getByRole("button", { name: /remove applied profile/i })).not.toHaveAttribute("title");
  expect(await gitLocalConfig(repoDir, "user.name")).toBe("Jane Doe");

  await dialog.getByRole("button", { name: /remove applied profile/i }).click();
  const remove = dialog.getByRole("button", { name: /remove applied profile/i });
  await expect(remove).toBeDisabled();
  await expect(remove).toHaveAttribute("title", "No GitHydra-applied identity to remove from this repository.");
  await expect(dialog.getByText(/^Applied: Work/)).toHaveCount(0);
  await expect(dialog.getByText(/Applied by GitHydra/i)).toHaveCount(0);
  await expect(dialog.getByText("Set locally (not by GitHydra)")).toHaveCount(0);
  expect(await gitLocalConfig(repoDir, "user.name")).toBeNull();
  expect(await gitLocalConfig(repoDir, "user.email")).toBeNull();
});

test("AC1/AC3/AC9 (real Electron): a real in-flight fetch (real contextBridge/ipcMain round trip) disables Apply/Remove and re-enables on settle; Toolbar's own Fetch button is unaffected by the dialog's open/closed state", async () => {
  repoDir = await initRepo();
  await writeFile(repoDir, "a.txt", "hello\n");
  await commitAll(repoDir, "initial commit");

  handle = await launchGitHydra();
  await openRepoThroughRealUi(handle, repoDir);

  // Give this repo a managed identity so the Remove button isn't ALSO disabled for its own
  // pre-existing `!hasAnyManaged` reason, then leave the dialog CLOSED (a real user can't reach
  // the Toolbar's Fetch button while any modal is open — see this file's own top doc comment).
  await applyProfileAndReopen(handle.window);
  await handle.window.getByRole("button", { name: "Done" }).click();
  await expect(handle.window.getByRole("dialog", { name: /git identity profiles/i })).toHaveCount(0);

  // Substitute the real fetch IPC handler with a controllable, never-settling-until-we-say-so one,
  // THEN start the real (stubbed) fetch from the Toolbar — reachable, since no modal is open yet.
  await stubPendingIpcHandler(handle.app, "repo:fetchAllRemotes");
  const fetchButton = handle.window.getByRole("button", { name: /^fetch all remotes$/i });
  await fetchButton.click();
  await expect(handle.window.getByRole("button", { name: /fetching remotes…/i })).toBeDisabled();

  // With the fetch genuinely in flight, NOW open IdentityProfilesDialog (reachable: fetch is
  // async/non-blocking, unlike a modal) and confirm Apply/Remove are disabled with the real,
  // FR-384/FR-385-specified copy.
  await handle.window.getByRole("button", { name: /git identity profiles/i }).click();
  const dialog = handle.window.getByRole("dialog", { name: /git identity profiles/i });
  const applyButton = dialog.getByRole("button", { name: /apply to this repository/i });
  const removeButton = dialog.getByRole("button", { name: /remove applied profile/i });
  await expect(applyButton).toBeDisabled();
  await expect(applyButton).toHaveAttribute("title", "Disabled while a fetch is in progress on this repository.");
  await expect(removeButton).toBeDisabled();
  await expect(removeButton).toHaveAttribute("title", "Disabled while a fetch is in progress on this repository.");

  // AC9: closing the dialog mid-fetch must not change Toolbar's own Fetch button state at all —
  // it never depended on `identityProfilesOpen` in the first place.
  await dialog.getByRole("button", { name: "Done" }).click();
  await expect(handle.window.getByRole("dialog", { name: /git identity profiles/i })).toHaveCount(0);
  await expect(handle.window.getByRole("button", { name: /fetching remotes…/i })).toBeDisabled();

  // The fetch settles.
  await resolveTestIpc(handle.app, "repo:fetchAllRemotes", { outcome: "settled", result: { ok: true, data: { outcomes: [] } } });
  await expect(handle.window.getByRole("button", { name: /^fetch all remotes$/i })).toBeEnabled();

  // Reopening confirms the disabled state cleared in the same render pass, no reload needed.
  await handle.window.getByRole("button", { name: /git identity profiles/i }).click();
  const reopened = handle.window.getByRole("dialog", { name: /git identity profiles/i });
  await expect(reopened.getByRole("button", { name: /apply to this repository/i })).toBeEnabled();
  await expect(reopened.getByRole("button", { name: /apply to this repository/i })).not.toHaveAttribute("title");
  await expect(reopened.getByRole("button", { name: /remove applied profile/i })).toBeEnabled();
  await expect(reopened.getByRole("button", { name: /remove applied profile/i })).not.toHaveAttribute("title");
});

/**
 * AC7/FR-381 finding: this scenario, as worded in the spec ("Opening CloneDialog and starting a
 * clone, with IdentityProfilesDialog also open against an already-open, unrelated repo") describes
 * a UI state that cannot be reached by a real user in this app, for two independent, pre-existing
 * (unrelated-to-this-fix) reasons directly confirmed in this real-Electron run:
 *
 *   1. `IdentityProfilesDialog`/`CommandPalette`/`CloneDialog` are each folded into `App.tsx`'s own
 *      `anyModalDialogOpen` gate, which SUSPENDS Ctrl/Cmd+K (the only route to `CloneDialog` per
 *      FR-351) while any other modal — including `IdentityProfilesDialog` — is open. Confirmed
 *      directly: pressing Ctrl+K while `IdentityProfilesDialog` is open never opens
 *      `CommandPalette` in the real app.
 *   2. Even reversing the order, `CloneDialog` cannot be dismissed while a clone is actually in
 *      flight short of cancelling it (`backdropActive: clone.phase !== "cloning"`, and its own
 *      Escape handler calls `cancelClone()` instead of `onClose()` mid-clone) — so there is no way
 *      to "start a clone, then also open IdentityProfilesDialog" either. Confirmed directly: with
 *      `CloneDialog` open and cloning, its full-viewport overlay (`position: fixed; inset: 0;
 *      z-index: 1100`, same z-index `IdentityProfilesDialog` uses) blocks every click to the
 *      Toolbar underneath, including the "Git identity profiles" button.
 *
 * This does not make FR-381 functionally wrong — `computeIdentityNetworkOpDisabledReason`'s own
 * signature (`isFetching, isPulling, isPushing`) structurally cannot be influenced by a clone at
 * all, regardless of whether the two dialogs could ever be visible together — but it means AC7, as
 * literally written, is unverifiable via genuine end-to-end UI interaction; the existing
 * `App.identityNetworkInterlock.test.tsx`'s own AC7 test only achieves "both open" because RTL's
 * `userEvent.click()` does not perform real hit-testing/z-index occlusion the way a real browser
 * (and this Playwright spec) does. Flagging this rather than writing a real-Electron test that
 * quietly reproduces the jsdom test's same non-representative click-through.
 */
test("AC7/FR-381 (real Electron): confirms, rather than assumes, that the two dialogs can never actually coexist — direct evidence for this file's own doc comment above", async () => {
  repoDir = await initRepo();
  await writeFile(repoDir, "a.txt", "hello\n");
  await commitAll(repoDir, "initial commit");

  handle = await launchGitHydra();
  await openRepoThroughRealUi(handle, repoDir);

  await handle.window.getByRole("button", { name: /git identity profiles/i }).click();
  await expect(handle.window.getByRole("dialog", { name: /git identity profiles/i })).toBeVisible();

  // Reason 1: Ctrl+K (the only route to CloneDialog per FR-351) is suspended while
  // IdentityProfilesDialog is open (`anyModalDialogOpen`) — CommandPalette never appears.
  await handle.window.keyboard.press("Control+k");
  await expect(handle.window.getByRole("dialog", { name: /command palette/i })).toHaveCount(0, { timeout: 2000 });
  await expect(handle.window.getByRole("option", { name: /clone a repository/i })).toHaveCount(0);

  // Reason 2, reversed order: close IdentityProfilesDialog, open CloneDialog via the now-reachable
  // Ctrl+K, start a clone, and confirm its overlay physically blocks the Toolbar's "Git identity
  // profiles" button underneath (a real Playwright actionability failure, not an assertion this
  // test invents) — so there is no way to reach IdentityProfilesDialog while a clone is in flight
  // either.
  await handle.window.getByRole("button", { name: "Done" }).click();
  await stubPendingIpcHandler(handle.app, "repo:clone");
  await handle.window.keyboard.press("Control+k");
  await handle.window.getByRole("option", { name: /clone a repository/i }).click();
  const cloneDialog = handle.window.getByRole("dialog", { name: /clone a repository/i });
  await cloneDialog.getByLabel(/repository url/i).fill("/some/remote");
  await cloneDialog.getByLabel(/destination folder/i).fill("/some/destination");
  await cloneDialog.getByRole("button", { name: /^clone$/i }).click();
  await expect(cloneDialog.getByText(/cloning…/i)).toBeVisible();

  await expect(
    handle.window.getByRole("button", { name: /git identity profiles/i }).click({ timeout: 2000 }),
  ).rejects.toThrow(/intercepts pointer events/);

  await resolveTestIpc(handle.app, "repo:clone", { outcome: "settled", result: { ok: true, data: { path: "/some/destination" } } });
});
