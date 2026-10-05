// SPDX-License-Identifier: GPL-3.0-or-later
/** Screenshots (light + dark) of the ignore / multi-select surfaces for human review against DESIGN.md and the approved mockup. Also geometry checks. */
import { test, expect } from "@playwright/test";
import { closeApp, removeUserDataDir, type LaunchedApp } from "../helpers/launchApp";
import { SHOT_DIR, ignorePopover, launchApp, openChanges, popoverReady, rowBtn, rowLi, setTheme, shot } from "../helpers/changesHelpers";
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
  test(`${theme}: headers, bottom bar, rows, ignore popover (untracked, tracked, private), menus, discard confirms`, async () => {
    test.setTimeout(180_000);
    const d = await initRepo();
    dirs.push(d);
    await writeFile(d, "src/components/VeryLongComponentNameForWidthTesting.tsx", "a\n");
    for (const n of ["a", "b", "c", "d", "e", "f", "g"]) await writeFile(d, `src/${n}.ts`, "base\n");
    await writeFile(d, "t.log", "x\n");
    await writeFile(d, "logs/old.log", "x\n");
    await writeFile(d, "logs/db.log", "x\n");
    await commitAll(d, "base");
    for (const n of ["a", "b", "c", "d", "e", "f", "g"]) await writeFile(d, `src/${n}.ts`, "changed\nmore\n");
    await writeFile(d, "src/components/VeryLongComponentNameForWidthTesting.tsx", "b\n");
    await writeFile(d, "t.log", "y\n");
    for (let i = 1; i <= 4; i++) await writeFile(d, `new${i}.txt`, "n\n");
    await writeFile(d, "debug.log", "n\n");
    await writeFile(d, "staged1.txt", "s\n");
    await git(d, ["add", "staged1.txt"]);
    await openChanges(h, d);
    await setTheme(h, theme);
    await h.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1280, 800));
    const panel = h.window.locator(".gh-changes-panel");

    // 01 rows: selected, hover, focus; headers relabelled; bar.
    await rowBtn(h.window, "unstaged", "src/a.ts").click({ position: { x: 8, y: 8 } });
    await rowBtn(h.window, "unstaged", "src/b.ts").click({ modifiers: ["Control"], position: { x: 8, y: 8 } });
    await rowBtn(h.window, "untracked", "new1.txt").click({ modifiers: ["Control"], position: { x: 8, y: 8 } });
    await rowBtn(h.window, "staged", "staged1.txt").click({ modifiers: ["Control"], position: { x: 8, y: 8 } });
    await rowBtn(h.window, "unstaged", "src/c.ts").focus();
    await rowLi(h.window, "untracked", "new2.txt").hover();
    await expect(h.window.getByRole("button", { name: "Stage 3 selected" })).toBeVisible();
    await expect(h.window.getByRole("button", { name: "Unstage 1 selected" })).toBeVisible();
    await panel.screenshot({ path: `${SHOT_DIR}/${theme}-01-panel-selected-hover-focus-bar-headers.png` });

    // File name never covered while hovered: the name box and the action buttons do not overlap.
    const hoverGeo = await h.window.evaluate(() => {
      const li = document.querySelector<HTMLElement>('[data-row-key="untracked:new2.txt"]')!.closest("li")!;
      const name = li.querySelector<HTMLElement>(".gh-changes-panel__file-name")!.getBoundingClientRect();
      const actions = li.querySelector<HTMLElement>(".gh-changes-panel__file-actions")!.getBoundingClientRect();
      return { nameRight: name.right, actionsLeft: actions.left };
    });
    expect(hoverGeo.nameRight).toBeLessThanOrEqual(hoverGeo.actionsLeft);

    // 02 narrow window + minimum file-list width: bar and headers.
    await h.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(880, 700));
    const sep = h.window.getByRole("separator", { name: "Resize file list" });
    await sep.focus();
    for (let i = 0; i < 60; i++) await h.window.keyboard.press("ArrowLeft");
    const bar = h.window.locator(".gh-bulk-bar");
    await expect(bar).toBeVisible();
    const geo = await h.window.evaluate(() => {
      const bar = document.querySelector<HTMLElement>(".gh-bulk-bar")!;
      const b = bar.getBoundingClientRect();
      const p = bar.parentElement!.getBoundingClientRect();
      return { barLeft: b.left, barRight: b.right, parentRight: p.right, overflowX: bar.scrollWidth > bar.clientWidth };
    });
    expect(geo.overflowX).toBe(false);
    expect(geo.barRight).toBeLessThanOrEqual(geo.parentRight + 1);
    await panel.screenshot({ path: `${SHOT_DIR}/${theme}-02-narrow-bar-headers.png` });
    await h.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1280, 800));
    for (let i = 0; i < 60; i++) await h.window.keyboard.press("ArrowRight");

    // 03 header overflow menu.
    await h.window.getByRole("button", { name: "Clear" }).click();
    await h.window.getByRole("button", { name: "Unstaged section actions" }).click();
    await shot(h.window, `${theme}-03-header-overflow-menu`);
    await h.window.keyboard.press("Escape");

    // 04 row context menu, then the one popover (untracked, with +N files).
    await rowBtn(h.window, "untracked", "debug.log").click({ position: { x: 8, y: 12 } });
    await rowBtn(h.window, "untracked", "debug.log").click({ button: "right", position: { x: 8, y: 12 } });
    await shot(h.window, `${theme}-04-row-context-menu`);
    await h.window.getByRole("menuitem", { name: /^ignore…/i }).click();
    await popoverReady(h.window);
    await shot(h.window, `${theme}-05-ignore-popover-name`);
    await ignorePopover(h.window).getByRole("radio", { name: /All \*\.log files/ }).check();
    await popoverReady(h.window);
    await shot(h.window, `${theme}-06-ignore-popover-extension`);
    await ignorePopover(h.window).getByRole("combobox", { name: "Add to" }).selectOption("exclude");
    await popoverReady(h.window);
    await shot(h.window, `${theme}-07-ignore-popover-private`);
    await h.window.keyboard.press("Escape");

    // 08/09 tracked variant, collapsed then expanded.
    await rowBtn(h.window, "unstaged", "t.log").click({ position: { x: 8, y: 12 } });
    await rowBtn(h.window, "unstaged", "t.log").click({ button: "right", position: { x: 8, y: 8 } });
    await h.window.getByRole("menuitem", { name: /^ignore…/i }).click();
    await popoverReady(h.window);
    await ignorePopover(h.window).getByRole("radio", { name: /All \*\.log files/ }).check();
    await popoverReady(h.window);
    await expect(ignorePopover(h.window).getByRole("button", { name: "Ignore and stop tracking" })).toBeEnabled();
    await shot(h.window, `${theme}-08-ignore-popover-tracked-collapsed`);
    await ignorePopover(h.window).getByRole("button", { name: /^show \d+ files?/i }).click();
    await shot(h.window, `${theme}-09-ignore-popover-tracked-expanded`);
    await h.window.keyboard.press("Escape");

    // 10 multi-select context menu; 11 discard confirm, names only (<=5); 12 discard confirm with counts (6-20).
    await rowBtn(h.window, "unstaged", "src/a.ts").click({ position: { x: 8, y: 8 } });
    await rowBtn(h.window, "unstaged", "src/b.ts").click({ modifiers: ["Control"], position: { x: 8, y: 8 } });
    await rowBtn(h.window, "unstaged", "src/b.ts").click({ button: "right", position: { x: 8, y: 8 } });
    await shot(h.window, `${theme}-10-multi-context-menu`);
    await h.window.keyboard.press("Escape");
    await h.window.getByRole("toolbar", { name: /actions for/i }).getByRole("button", { name: /^discard/i }).click();
    await expect(h.window.getByRole("alertdialog").getByRole("button", { name: /^discard 2/i })).toBeEnabled();
    await shot(h.window, `${theme}-11-discard-names-only`);
    await h.window.getByRole("alertdialog").getByRole("button", { name: "Cancel" }).click();

    await rowBtn(h.window, "unstaged", "src/a.ts").click({ position: { x: 8, y: 8 } });
    await rowBtn(h.window, "unstaged", "src/g.ts").click({ modifiers: ["Shift"], position: { x: 8, y: 8 } });
    await rowBtn(h.window, "unstaged", "t.log").click({ modifiers: ["Control"], position: { x: 8, y: 8 } });
    await rowBtn(h.window, "unstaged", "src/components/VeryLongComponentNameForWidthTesting.tsx").click({ modifiers: ["Control"], position: { x: 8, y: 8 } });
    await rowBtn(h.window, "untracked", "new1.txt").click({ modifiers: ["Control"], position: { x: 8, y: 8 } });
    await h.window.getByRole("toolbar", { name: /actions for/i }).getByRole("button", { name: /^discard/i }).click();
    await expect(h.window.getByRole("alertdialog").getByRole("button", { name: /^discard \d+ files/i })).toBeEnabled();
    await expect(h.window.getByRole("alertdialog").getByText("+2").first()).toBeVisible({ timeout: 10_000 });
    await shot(h.window, `${theme}-12-discard-with-counts`);
    await h.window.getByRole("alertdialog").getByRole("checkbox").check();
    await shot(h.window, `${theme}-13-discard-with-counts-untracked-ticked`);
    await h.window.getByRole("alertdialog").getByRole("button", { name: "Cancel" }).click();

    // 14 Discard all (always type-to-confirm).
    await h.window.getByRole("button", { name: "Unstaged section actions" }).click();
    await h.window.getByRole("menuitem", { name: "Discard all changes…" }).click();
    await expect(h.window.getByRole("alertdialog").getByRole("checkbox")).toBeVisible();
    await expect(h.window.getByRole("alertdialog").getByRole("textbox")).toBeVisible();
    await shot(h.window, `${theme}-14-discard-all-dialog`);
  });
}
