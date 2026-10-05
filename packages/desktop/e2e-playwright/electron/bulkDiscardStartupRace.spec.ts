// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Repro attempt for a field report: confirming a bulk Discard within ~2s of opening a repo made bulkDiscard return partial
 * ("pathspec did not match" / DISCARD_FINGERPRINT_UNAVAILABLE). Races the dialog against the app's own startup git reads.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { test, expect } from "@playwright/test";
import { closeApp, removeUserDataDir, stubOpenRepoDialog, type LaunchedApp } from "../helpers/launchApp";
import { launchApp, rowBtn } from "../helpers/changesHelpers";
import { cleanup, commitAll, git, initRepo, writeFile } from "../../src/test/gitFixture";

let h: LaunchedApp;
const dirs: string[] = [];
test.beforeEach(async () => {
  h = await launchApp();
});
test.afterEach(async () => {
  await closeApp(h);
  await removeUserDataDir(h.userDataDir);
  while (dirs.length) await cleanup(dirs.pop()!);
});

for (const run of [1, 2, 3, 4, 5]) {
  test(`startup race run ${run}: confirm Discard immediately after opening the repo discards all selected files`, async () => {
    const d = await initRepo();
    dirs.push(d);
    // Several commits give the startup graph load real work to overlap with.
    for (let c = 0; c < 40; c++) {
      await writeFile(d, `hist/h${c}.txt`, `c${c}\n`);
      await git(d, ["add", "-A"]);
      await git(d, ["commit", "-qm", `c${c}`]);
    }
    for (let i = 1; i <= 8; i++) await writeFile(d, `t${i}.txt`, "base\n");
    await commitAll(d, "base");
    for (let i = 1; i <= 8; i++) await writeFile(d, `t${i}.txt`, "changed\n");
    for (let i = 1; i <= 4; i++) await writeFile(d, `u${i}.txt`, "new\n");

    await stubOpenRepoDialog(h.app, d);
    await h.window.getByRole("button", { name: "Open a repository", exact: true }).click();
    // No wait for "ready": the Changes tab is clicked as soon as it exists.
    await h.window.getByRole("button", { name: /^changes/i }).click();
    await rowBtn(h.window, "unstaged", "t1.txt").click();
    await rowBtn(h.window, "untracked", "u4.txt").click({ modifiers: ["Shift"] });
    const bar = h.window.getByRole("toolbar", { name: /actions for/i });
    await bar.getByRole("button", { name: /^discard/i }).click();
    const dlg = h.window.getByRole("alertdialog");
    const confirm = dlg.getByRole("button", { name: /^discard \d+ files/i });
    await expect(confirm).toBeEnabled({ timeout: 15_000 });
    const t0 = Date.now();
    await confirm.click();
    await expect(dlg).toHaveCount(0, { timeout: 60_000 }).catch(() => {});
    const text = (await dlg.count()) ? await dlg.innerText() : "(closed)";
    console.log(`RUN ${run}: dialog after ${Date.now() - t0}ms ->`, text.replace(/\s+/g, " ").slice(0, 400));
    const s = (await git(d, ["status", "--porcelain", "-uall"])).stdout;
    console.log(`RUN ${run}: status after:`, JSON.stringify(s));
    expect(s).toBe("");
    void fs;
    void path;
  });
}
