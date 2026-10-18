// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Visual record for specs/worktrees.md FR-644: the hook-trust dialog (normal, truncated, binary, relative core.hooksPath, other
 * hooks) in light and dark. Files go to $HOOK_SHOTS (never the repo). No assertions beyond "the scene reached its state".
 */
import { test, expect, type Page } from "@playwright/test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { closeApp, launchGitHydra, removeUserDataDir, stubOpenRepoDialog, type LaunchedApp } from "../helpers/launchApp";
import { cleanup, commitAll, git, makeTempDir, writeFile } from "../../src/test/gitFixture";

let handle: LaunchedApp | undefined;
let parent: string | undefined;

test.afterEach(async () => {
  await closeApp(handle);
  if (handle) await removeUserDataDir(handle.userDataDir);
  if (parent) await cleanup(parent);
  handle = undefined;
  parent = undefined;
});

async function scene(name: string, plant: (repo: string) => Promise<void>): Promise<void> {
  const shots = process.env.HOOK_SHOTS ?? (await fs.mkdtemp(path.join(os.tmpdir(), "githydra-pw-hookshots-")));
  await fs.mkdir(shots, { recursive: true });
  parent = await makeTempDir("pw-hookshots-");
  const repo = path.join(parent, "acme");
  await fs.mkdir(repo);
  await git(repo, ["init", "-q", "--initial-branch=main"]);
  await writeFile(repo, "a.txt", "base\n");
  await commitAll(repo, "Base commit");
  await git(repo, ["branch", "free"]);
  await plant(repo);

  handle = await launchGitHydra();
  const w: Page = handle.window;
  await handle.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach((b) => b.setSize(1280, 800)));
  await stubOpenRepoDialog(handle.app, repo);
  await w.getByRole("button", { name: "Open a repository", exact: true }).click();
  await w.getByRole("button", { name: /^stashes/i }).waitFor({ timeout: 15_000 });
  const toggle = w.getByRole("button", { name: /^Worktrees/ });
  // The section auto-collapses while the list still loads (count <= 1), then auto-expands: a click made in between would collapse
  // it again. Retry until it is really open.
  await expect(async () => {
    if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true", { timeout: 1000 });
  }).toPass({ timeout: 15_000 });
  await w.getByRole("button", { name: /Jump to free in the commit graph/ }).click({ button: "right" });
  await w.getByRole("menuitem", { name: /Create worktree/ }).click();
  const create = w.getByRole("dialog", { name: "Create worktree" });
  await expect(create.getByLabel("Folder")).toHaveValue(/free$/);
  await create.getByRole("button", { name: "Create worktree" }).click();
  const dialog = w.getByRole("alertdialog", { name: "Run the post-checkout hook?" });
  await expect(dialog).toBeVisible();
  await w.waitForTimeout(250);
  for (const theme of ["light", "dark"] as const) {
    await w.evaluate((t) => (document.documentElement.dataset.theme = t), theme);
    await w.waitForTimeout(250);
    await dialog.screenshot({ path: path.join(shots, `hook-${name}-${theme}.png`) });
    if (name === "normal") await w.screenshot({ path: path.join(shots, `hook-${name}-window-${theme}.png`) });
  }
  await dialog.getByRole("button", { name: "Cancel" }).click();
}

const hookFile = (repo: string, dir = "hooks") => path.join(repo, ".git", dir, "post-checkout");

test("hook dialog: normal", async () => {
  await scene("normal", async (repo) => {
    await fs.writeFile(hookFile(repo), "#!/bin/sh\n# Notify the team chat after a checkout.\ncurl -s https://example.com/hooks/notify -d \"branch=$(git rev-parse --abbrev-ref HEAD)\"\n", { mode: 0o755 });
  });
});

test("hook dialog: truncated", async () => {
  await scene("truncated", async (repo) => {
    const lines = ["#!/bin/sh", ...Array.from({ length: 79 }, (_, i) => `echo "step ${i + 1}: refresh generated files"`)];
    await fs.writeFile(hookFile(repo), lines.join("\n") + "\n", { mode: 0o755 });
  });
});

test("hook dialog: binary", async () => {
  await scene("binary", async (repo) => {
    await fs.writeFile(hookFile(repo), Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0xff, 0xfe, 0x00, 0x01]), { mode: 0o755 });
  });
});

test("hook dialog: relative core.hooksPath", async () => {
  await scene("relative-hookspath", async (repo) => {
    await fs.mkdir(path.join(repo, ".githooks"), { recursive: true });
    await fs.writeFile(path.join(repo, ".githooks", "post-checkout"), "#!/bin/sh\n./scripts/setup-env.sh\n", { mode: 0o755 });
    await git(repo, ["config", "core.hooksPath", ".githooks"]);
  });
});

test("hook dialog: other hooks, bidi characters", async () => {
  await scene("other-hooks", async (repo) => {
    await fs.writeFile(hookFile(repo), "#!/bin/sh\n# ok ‮ tpircs\necho checkout\n", { mode: 0o755 });
    await fs.writeFile(hookFile(repo).replace("post-checkout", "pre-commit"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    await fs.writeFile(hookFile(repo).replace("post-checkout", "reference-transaction"), "#!/bin/sh\ncat >/dev/null\n", { mode: 0o755 });
  });
});
