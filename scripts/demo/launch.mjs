// SPDX-License-Identifier: GPL-3.0-or-later
// Launches the BUILT app (one window) with an isolated profile, opens a repo through the real UI, and closes only what it started.
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import * as path from "node:path";
import { desktopRoot } from "./lib.mjs";

const mainJs = path.join(desktopRoot, "dist-electron", "main.js");

export async function launchApp({ userDataDir, repos }) {
  const { _electron: electron } = createRequire(path.join(desktopRoot, "package.json"))("@playwright/test");
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE; // otherwise electron behaves as plain Node and there is no window
  const app = await electron.launch({ args: [mainJs, `--user-data-dir=${userDataDir}`], cwd: desktopRoot, env });
  const child = app.process(); // kept: app.process() throws once the app has closed
  const pid = child.pid;
  const closed = new Promise((resolve) => app.on("close", resolve));
  const win = await app.firstWindow();
  // The first Open click gets repos[0], later opens (+ tab button) get the following repos, then the real native dialog returns.
  await app.evaluate(({ dialog }, queue) => {
    const orig = dialog.showOpenDialog.bind(dialog);
    dialog.showOpenDialog = async (...a) => (queue.length ? { canceled: false, filePaths: [queue.shift()] } : orig(...a));
  }, repos.slice());
  const open = win.getByRole("button", { name: "Open a repository", exact: true });
  const stashes = win.getByRole("button", { name: /^stashes/i });
  let ready = false;
  try {
    await Promise.race([open.waitFor({ timeout: 20000 }), stashes.waitFor({ timeout: 20000 })]);
    if (await open.isVisible().catch(() => false)) await open.click(); // a same-profile relaunch may have restored the tab already
    await stashes.waitFor({ timeout: 20000 });
    ready = true;
  } catch { /* an unusual repo (e.g. empty/bare) may not show the toolbar; the window is still usable */ }
  return { app, win, pid, child, ready, closed };
}

/** Closes only the process this script started: destroy windows (a dirty-editor veto must not block us), app.close, then force the pid tree. */
export async function closeLaunched(h) {
  if (!h) return;
  await Promise.race([
    (async () => {
      await h.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach((w) => w.destroy())).catch(() => {});
      await h.app.close().catch(() => {});
    })(),
    new Promise((r) => setTimeout(r, 5000)),
  ]);
  const exited = h.child.exitCode !== null || h.child.signalCode !== null;
  if (!exited && h.pid) {
    try {
      if (process.platform === "win32") execFileSync("taskkill", ["/PID", String(h.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
      else process.kill(h.pid, "SIGKILL");
    } catch { /* already gone */ }
  }
}
