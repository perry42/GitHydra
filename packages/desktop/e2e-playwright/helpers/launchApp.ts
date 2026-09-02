/**
 * Test-only helper for the Electron-launching Playwright specs (`e2e-playwright/electron/*`) —
 * launches the REAL built app (`dist-electron/main.js`, produced by `npm run build`), giving
 * every spec a real `contextBridge`/`ipcMain`/`BrowserWindow`, never a mock.
 */
import { _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const desktopRoot = path.resolve(__dirname, "..", "..");
const mainJsPath = path.join(desktopRoot, "dist-electron", "main.js");

export interface LaunchedApp {
  app: ElectronApplication;
  window: Page;
  userDataDir: string;
}

/**
 * Launches the real app with its own isolated `--user-data-dir` (a real Electron/Chromium
 * command-line switch, honored before `app.whenReady()`) so `window-bounds.json` and any other
 * persisted state never leaks between test runs or a developer's own real GitHydra profile.
 * Pass `existingUserDataDir` to relaunch against the SAME profile (Gap 2's "restores on the next
 * launch" flow) instead of getting a fresh one.
 */
export async function launchGitHydra(
  extraArgs: string[] = [],
  existingUserDataDir?: string,
): Promise<LaunchedApp> {
  const userDataDir = existingUserDataDir ?? (await fs.mkdtemp(path.join(os.tmpdir(), "githydra-pw-userdata-")));
  const app = await electron.launch({
    args: [mainJsPath, `--user-data-dir=${userDataDir}`, ...extraArgs],
    cwd: desktopRoot,
  });
  const window = await app.firstWindow();
  await window.waitForLoadState("domcontentloaded");
  return { app, window, userDataDir };
}

/**
 * Monkeypatches the REAL running main process's `dialog.showOpenDialog` — runtime-only, scoped to
 * this one launched instance, never touches any file on disk — so the Toolbar's real "Open
 * repository…" button can drive a real folder pick through the real IPC round trip without an
 * actual native OS file-picker dialog, which Playwright cannot drive headlessly. This is the one
 * `GitHydraApi` method that has no real implementation possible in an automated test (see
 * `src/test/realGitHydraApi.ts`'s own doc comment for the same tradeoff in the jsdom suite).
 */
export async function stubOpenRepoDialog(app: ElectronApplication, repoPath: string): Promise<void> {
  await app.evaluate(({ dialog }, dir) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (dialog as any).showOpenDialog = async () => ({ canceled: false, filePaths: [dir] });
  }, repoPath);
}

/** Closes the app window/process only — does not remove `userDataDir` (callers that need to
 * relaunch against the same profile call this, then `launchGitHydra(..., userDataDir)` again). */
export async function closeApp(handle: Pick<LaunchedApp, "app">): Promise<void> {
  await handle.app.close().catch(() => {});
}

export async function removeUserDataDir(userDataDir: string): Promise<void> {
  await fs.rm(userDataDir, { recursive: true, force: true }).catch(() => {});
}

/** Opens the given real repo path through the real UI (Toolbar's "Open repository…" button ->
 * stubbed dialog -> real `openRepo` IPC round trip), then waits for a reliable "finished opening"
 * signal — the Stashes toolbar toggle only renders once `graph.status === "ready"`. */
export async function openRepoThroughRealUi(handle: LaunchedApp, repoPath: string): Promise<void> {
  await stubOpenRepoDialog(handle.app, repoPath);
  await handle.window.getByRole("button", { name: /open repository/i }).click();
  await handle.window.getByRole("button", { name: /^stashes/i }).waitFor({ timeout: 15_000 });
}
