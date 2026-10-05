// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Diagnostic (not an assertion on product behaviour except the final one): runs the real app with GIT_TRACE on, drives a
 * bulk discard, and lists every distinct git command the app spawned, flagging index-touching commands that carry no
 * `--no-optional-locks` (they can race a concurrent `git restore` for .git/index.lock).
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test, expect } from "@playwright/test";
import { closeApp, removeUserDataDir, stubOpenRepoDialog, type LaunchedApp } from "../helpers/launchApp";
import { launchApp, rowBtn } from "../helpers/changesHelpers";
import { cleanup, commitAll, git, initRepo, writeFile } from "../../src/test/gitFixture";

test("GIT_TRACE survey of every git command the app runs during open + select + bulk discard", async () => {
  const traceFile = path.join(os.tmpdir(), `githydra-trace-${Date.now()}.log`);
  process.env.GIT_TRACE = traceFile;
  let h: LaunchedApp | null = null;
  const d = await initRepo();
  try {
    for (let i = 1; i <= 6; i++) await writeFile(d, `t${i}.txt`, "base\n");
    await commitAll(d, "base");
    for (let i = 1; i <= 6; i++) await writeFile(d, `t${i}.txt`, "changed\n");
    await writeFile(d, "u1.txt", "n\n");
    h = await launchApp();
    delete process.env.GIT_TRACE;
    await stubOpenRepoDialog(h.app, d);
    await h.window.getByRole("button", { name: "Open a repository", exact: true }).click();
    await h.window.getByRole("button", { name: /^changes/i }).click();
    await rowBtn(h.window, "unstaged", "t1.txt").click();
    await rowBtn(h.window, "untracked", "u1.txt").click({ modifiers: ["Shift"] });
    await h.window.getByRole("toolbar", { name: /actions for/i }).getByRole("button", { name: /^discard/i }).click();
    const dlg = h.window.getByRole("alertdialog");
    await dlg.getByRole("checkbox", { name: /^also delete \d+ untracked file/i }).check();
    await dlg.getByRole("button", { name: /^discard \d+ files/i }).click();
    await expect(dlg).toHaveCount(0, { timeout: 60_000 });
    expect((await git(d, ["status", "--porcelain"])).stdout).toBe("");
  } finally {
    if (h) {
      await closeApp(h);
      await removeUserDataDir(h.userDataDir);
    }
    await cleanup(d);
  }
  const raw = await fs.readFile(traceFile, "utf8").catch(() => "");
  const cmds = new Map<string, number>();
  for (const line of raw.split(/\r?\n/)) {
    const m = /trace: built-in: git (.*)$/.exec(line) ?? /trace: run_command: (.*)$/.exec(line);
    if (!m) continue;
    const sig = m[1]!.replace(/'[^']*[\\/]githydra-desktop-e2e-[^']*'/g, "<repo>").replace(/\s+/g, " ").slice(0, 160);
    cmds.set(sig, (cmds.get(sig) ?? 0) + 1);
  }
  const out = [...cmds].map(([c, n]) => `${n}x git ${c}`).join("\n");
  await fs.writeFile(path.join(os.tmpdir(), "githydra-trace-summary.txt"), out);
  console.log("TRACE SUMMARY:\n" + out);
});
