// SPDX-License-Identifier: GPL-3.0-or-later
/** Screenshots (light + dark) of the ignore / multi-select surfaces for human review against DESIGN.md. Also geometry checks. */
import { test, expect } from "@playwright/test";
import { closeApp, removeUserDataDir, type LaunchedApp } from "../helpers/launchApp";
import { launchApp, openChanges, rowBtn, rowLi, setTheme, shot } from "../helpers/changesHelpers";
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

for (const theme of ["light", "dark"] as const) {
  test(`${theme}: bulk bar, narrow bulk bar, selected/hover/focus rows, ignore menu and dialogs`, async () => {
    const d = await initRepo();
    dirs.push(d);
    await writeFile(d, "src/components/VeryLongComponentNameForWidthTesting.tsx", "a\n");
    for (const n of ["a", "b", "c"]) await writeFile(d, `src/${n}.ts`, "base\n");
    await writeFile(d, "t.log", "x\n");
    await commitAll(d, "base");
    for (const n of ["a", "b", "c"]) await writeFile(d, `src/${n}.ts`, "changed\n");
    await writeFile(d, "src/components/VeryLongComponentNameForWidthTesting.tsx", "b\n");
    await writeFile(d, "t.log", "y\n");
    for (let i = 1; i <= 4; i++) await writeFile(d, `new${i}.txt`, "n\n");
    await writeFile(d, "staged1.txt", "s\n");
    await git(d, ["add", "staged1.txt"]);
    await openChanges(h, d);
    await setTheme(h, theme);
    await h.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1280, 800));

    // Selected rows + hover + focus.
    await rowBtn(h.window, "unstaged", "src/a.ts").click({ position: { x: 8, y: 8 } });
    await rowBtn(h.window, "unstaged", "src/b.ts").click({ modifiers: ["Control"], position: { x: 8, y: 8 } });
    await rowBtn(h.window, "untracked", "new1.txt").click({ modifiers: ["Control"], position: { x: 8, y: 8 } });
    await rowBtn(h.window, "staged", "staged1.txt").click({ modifiers: ["Control"], position: { x: 8, y: 8 } });
    await rowBtn(h.window, "unstaged", "src/c.ts").focus();
    await rowLi(h.window, "untracked", "new2.txt").hover();
    await shot(h.window, `${theme}-01-selected-hover-focus-bulkbar-wide`);
    const panel = h.window.locator(".gh-changes-panel");
    await panel.screenshot({ path: `${(await import("../helpers/changesHelpers")).SHOT_DIR}/${theme}-01b-panel.png` });

    // Narrow window + minimum file list width: bulk bar geometry.
    await h.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(880, 700));
    const sep = h.window.getByRole("separator", { name: "Resize file list" });
    await sep.focus();
    for (let i = 0; i < 60; i++) await h.window.keyboard.press("ArrowLeft");
    const bar = h.window.locator(".gh-bulk-bar");
    await expect(bar).toBeVisible();
    const geo = await h.window.evaluate(() => {
      const bar = document.querySelector<HTMLElement>(".gh-bulk-bar")!;
      const scroller = bar.parentElement!;
      const b = bar.getBoundingClientRect();
      const p = scroller.getBoundingClientRect();
      const buttons = [...bar.querySelectorAll<HTMLElement>("button")].map((x) => {
        const r = x.getBoundingClientRect();
        return { label: x.textContent, left: r.left, right: r.right, top: r.top, bottom: r.bottom, sw: x.scrollWidth, cw: x.clientWidth };
      });
      return { barLeft: b.left, barRight: b.right, barH: b.height, parentRight: p.right, scrollOverflowX: bar.scrollWidth > bar.clientWidth, buttons };
    });
    console.log(`${theme} NARROW BAR GEO`, JSON.stringify(geo));
    await shot(h.window, `${theme}-02-bulkbar-narrow`);
    await bar.screenshot({ path: `${(await import("../helpers/changesHelpers")).SHOT_DIR}/${theme}-02b-bulkbar-narrow-closeup.png` });
    await h.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1280, 800));
    for (let i = 0; i < 60; i++) await h.window.keyboard.press("ArrowRight");

    // Ignore menu (single row, then submenu).
    await rowBtn(h.window, "untracked", "new3.txt").click({ position: { x: 8, y: 12 } }); // plain click first: see bulk-bar/right-click bug in report
    await rowBtn(h.window, "untracked", "new3.txt").click({ button: "right", position: { x: 8, y: 12 } });
    await h.window.waitForTimeout(400);
    console.log("MENUDBG", await h.window.evaluate(() => JSON.stringify({ menus: document.querySelectorAll(".gh-context-menu").length, roles: [...document.querySelectorAll("[role=menu]")].map((e) => e.textContent) })));
    await shot(h.window, `${theme}-03-row-context-menu`);
    await h.window.getByRole("menuitem", { name: /^ignore…/i }).click({ position: { x: 8, y: 8 } });
    await shot(h.window, `${theme}-04-ignore-scope-menu`);
    await h.window.getByRole("menuitem", { name: /^this file/i }).click({ position: { x: 8, y: 8 } });
    await shot(h.window, `${theme}-05-add-to-dialog`);
    await h.window.getByRole("alertdialog").getByRole("button", { name: "Cancel" }).click({ position: { x: 8, y: 8 } });

    // Tracked dialog.
    await rowBtn(h.window, "unstaged", "t.log").click({ position: { x: 8, y: 12 } });
    await rowBtn(h.window, "unstaged", "t.log").click({ button: "right", position: { x: 8, y: 8 } });
    await h.window.getByRole("menuitem", { name: /^ignore…/i }).click({ position: { x: 8, y: 8 } });
    await h.window.getByRole("menuitem", { name: /all \*\.log files/i }).click({ position: { x: 8, y: 8 } });
    await h.window.getByRole("alertdialog").getByRole("button", { name: /^next/i }).click({ position: { x: 8, y: 8 } });
    await expect(h.window.getByRole("alertdialog")).toContainText(/stay on disk/i);
    await shot(h.window, `${theme}-06-tracked-dialog`);
    await h.window.getByRole("alertdialog").getByRole("button", { name: "Cancel" }).click({ position: { x: 8, y: 8 } });

    // Multi-select context menu + bulk discard dialog.
    await rowBtn(h.window, "unstaged", "src/a.ts").click({ position: { x: 8, y: 8 } });
    await rowBtn(h.window, "unstaged", "src/b.ts").click({ modifiers: ["Control"], position: { x: 8, y: 8 } });
    await rowBtn(h.window, "unstaged", "src/b.ts").click({ button: "right", position: { x: 8, y: 8 } });
    await shot(h.window, `${theme}-07-multi-context-menu`);
    await h.window.keyboard.press("Escape");
    await h.window.getByRole("toolbar", { name: /actions for/i }).getByRole("button", { name: /^discard/i }).click({ position: { x: 8, y: 8 } });
    await expect(h.window.getByRole("alertdialog").getByRole("button", { name: /^discard 2/i })).toBeEnabled();
    await shot(h.window, `${theme}-08-bulk-discard-dialog`);
    await h.window.getByRole("alertdialog").getByRole("button", { name: "Cancel" }).click({ position: { x: 8, y: 8 } });

    // Discard all dialog.
    await h.window.getByRole("button", { name: "Discard all…" }).click({ position: { x: 8, y: 8 } });
    await expect(h.window.getByRole("alertdialog").getByRole("checkbox")).toBeVisible();
    await shot(h.window, `${theme}-09-discard-all-dialog`);
    await h.window.getByRole("alertdialog").getByRole("checkbox").check();
    await shot(h.window, `${theme}-10-discard-all-dialog-untracked-checked`);
  });
}
