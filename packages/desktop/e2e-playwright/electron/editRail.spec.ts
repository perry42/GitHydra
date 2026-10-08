// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Real-Electron check of specs/edit-in-diff.md FR-532 (collapsed file-list rail): nothing in the 44px rail overflows or overlaps,
 * row actions are neither visible nor hit-testable while collapsed, and the hover overlay restores them. Shots go to $RAIL_SHOTS.
 */
import { test, expect, type Page } from "@playwright/test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { closeApp, launchGitHydra, removeUserDataDir, stubOpenRepoDialog, type LaunchedApp } from "../helpers/launchApp";
import { cleanup, commitAll, git, initRepo } from "../../src/test/gitFixture";

let handle: LaunchedApp;
let repoDir: string;

test.afterEach(async () => {
  await closeApp(handle);
  await removeUserDataDir(handle.userDataDir);
  if (repoDir) await cleanup(repoDir);
});

const rowLabel = (w: Page, section: string, p: string) =>
  w
    .locator("section.gh-changes-panel__section", { has: w.locator("h3", { hasText: new RegExp(`^${section}`) }) })
    .locator("li.gh-changes-panel__file", { hasText: p })
    .locator(".gh-changes-panel__file-label");

async function setTheme(w: Page, theme: "light" | "dark") {
  if ((await w.evaluate(() => document.documentElement.dataset.theme)) === theme) return;
  await w.getByRole("button", { name: "More actions" }).click();
  await w.getByRole("menuitem", { name: /switch to (light|dark) theme/i }).click();
  await expect.poll(() => w.evaluate(() => document.documentElement.dataset.theme)).toBe(theme);
}

/** Parks the pointer on the editor's far corner: clear of the rail and of its expanded overlay at any window width. */
async function parkPointer(w: Page) {
  const b = (await w.locator(".cm-editor").boundingBox())!;
  await w.mouse.move(b.x + b.width - 20, b.y + b.height - 20);
}

/** Geometry of the collapsed rail, measured in the page so it is what the user sees. */
async function railReport(w: Page) {
  return w.evaluate(() => {
    const files = document.querySelector<HTMLElement>(".gh-changes-panel__files")!;
    const rail = files.getBoundingClientRect();
    const box = (el: Element) => {
      const r = el.getBoundingClientRect();
      return { l: r.left, t: r.top, r: r.right, b: r.bottom, w: r.width, h: r.height };
    };
    const problems: string[] = [];
    const rows = [...files.querySelectorAll<HTMLElement>("li.gh-changes-panel__file")];
    const visible = (el: Element) => {
      const cs = getComputedStyle(el);
      const r = (el.closest(".gh-changes-panel__file-actions") ?? el).getBoundingClientRect();
      return cs.display !== "none" && cs.visibility !== "hidden" && Number(cs.opacity) > 0 && r.width > 1 && r.height > 1;
    };
    for (const row of rows) {
      const parts: Array<[string, Element]> = [];
      const icon = row.querySelector(".gh-file-status-icon");
      if (icon) parts.push(["icon", icon]);
      const dot = row.querySelector(".gh-changes-panel__unsaved-dot");
      if (dot) parts.push(["dot", dot]);
      const mixed = row.querySelector(".gh-changes-panel__mixed");
      if (mixed) parts.push(["mixed", mixed]);
      row.querySelectorAll(".gh-changes-panel__file-actions button").forEach((b, i) => visible(b) && parts.push([`action${i}`, b]));
      const boxes = parts.map(([n, e]) => [n, box(e)] as const);
      for (const [n, b] of boxes) {
        if (b.l < rail.left - 0.5 || b.r > rail.right + 0.5) problems.push(`${n} outside rail: ${b.l}-${b.r} vs ${rail.left}-${rail.right}`);
      }
      for (let i = 0; i < boxes.length; i++)
        for (let j = i + 1; j < boxes.length; j++) {
          const a = boxes[i]![1];
          const c = boxes[j]![1];
          if (a.l < c.r - 0.5 && c.l < a.r - 0.5 && a.t < c.b - 0.5 && c.t < a.b - 0.5) problems.push(`${boxes[i]![0]} overlaps ${boxes[j]![0]}`);
        }
      const hit = document.elementFromPoint(rail.left + rail.width / 2, row.getBoundingClientRect().top + 14);
      if (hit && !row.contains(hit)) problems.push("row centre is covered by another element");
      else if (hit && hit.closest(".gh-changes-panel__file-actions")) problems.push("row centre hits an action button");
    }
    const first = files.querySelector(".gh-changes-panel__scroll > section")?.getBoundingClientRect();
    return {
      problems,
      railWidth: rail.width,
      scrollOverflowX: (files.querySelector(".gh-changes-panel__scroll") as HTMLElement).scrollWidth - rail.width,
      firstRowTop: rows[0]?.getBoundingClientRect().top ?? 0,
      listTop: first?.top ?? 0,
      rowHeights: rows.map((r) => r.getBoundingClientRect().height),
    };
  });
}

test("collapsed rail: no overflow, no overlap, actions inert; overlay restores them", async () => {
  test.setTimeout(240_000);
  const shots = process.env.RAIL_SHOTS ?? (await fs.mkdtemp(path.join(os.tmpdir(), "githydra-pw-rail-")));
  await fs.mkdir(shots, { recursive: true });
  handle = await launchGitHydra();
  const root = process.env.GH_FIXTURE_ROOT;
  repoDir = root ? await fs.mkdtemp(path.join(root, "rail-")) : await initRepo();
  if (root) await git(repoDir, ["init", "-q", "--initial-branch=main"]);
  const put = (rel: string, data: string) => fs.mkdir(path.dirname(path.join(repoDir, rel)), { recursive: true }).then(() => fs.writeFile(path.join(repoDir, rel), data));
  const lines = Array.from({ length: 60 }, (_, i) => `line ${i + 1}`);
  await put("a.txt", lines.join("\n") + "\n");
  await put("b.txt", "one\ntwo\n");
  await put("staged.txt", "s1\ns2\n");
  await put("c.txt", "base\n");
  await commitAll(repoDir, "base");
  await git(repoDir, ["checkout", "-q", "-b", "other"]);
  await put("c.txt", "other side\n");
  await commitAll(repoDir, "other");
  await git(repoDir, ["checkout", "-q", "main"]);
  await put("c.txt", "main side\n");
  await commitAll(repoDir, "main");
  await git(repoDir, ["merge", "other"]).catch(() => {});
  await put("a.txt", lines.map((l, i) => (i === 5 || i === 50 ? `${l} changed` : l)).join("\n") + "\n");
  await put("b.txt", "one\nTWO\n");
  await put("staged.txt", "s1\nS2\n");
  await git(repoDir, ["add", "staged.txt"]);
  await put("newdir/x.txt", "x\n");

  const w = handle.window;
  await stubOpenRepoDialog(handle.app, repoDir);
  await w.getByRole("button", { name: "Open a repository", exact: true }).click();
  await w.getByRole("button", { name: /^stashes/i }).waitFor({ timeout: 15_000 });
  await w.getByRole("button", { name: /^changes/i }).click();
  await w.locator(".gh-changes-panel__file").first().waitFor({ timeout: 15_000 });
  await rowLabel(w, "Unstaged", "a.txt").click();
  await w.getByRole("checkbox", { name: "Hunk 1 of 2" }).click();
  await expect(rowLabel(w, "Staged", "a.txt")).toBeVisible({ timeout: 10_000 });
  await rowLabel(w, "Unstaged", "b.txt").click();

  const edit = w.locator("[data-edit-button]");
  const cm = w.locator(".cm-content");
  for (const [size, width, height] of [["1400", 1400, 900], ["900", 900, 700]] as const) {
    await handle.app.evaluate(({ BrowserWindow }, [ww, hh]) => BrowserWindow.getAllWindows()[0]!.setSize(ww as number, hh as number), [width, height]);
    await w.waitForTimeout(500);
    for (const theme of ["dark", "light"] as const) {
      await setTheme(w, theme);
      await rowLabel(w, "Unstaged", "b.txt").click();
      await expect(edit).toBeEnabled();
      await edit.click();
      await expect(cm).toBeFocused();
      await w.keyboard.press("Control+End");
      await w.keyboard.type(" dirty");
      await expect(w.locator(".gh-edit__state", { hasText: "Unsaved" })).toBeVisible();
      // Move the pointer off the rail and drop keyboard focus from it, so it is collapsed.
      await parkPointer(w);
      await w.waitForTimeout(500);
      await w.screenshot({ path: path.join(shots, `rail-dirty-${theme}-${size}.png`) });
      const rep = await railReport(w);
      expect(rep.problems).toEqual([]);
      expect(rep.railWidth).toBe(44);
      expect(rep.scrollOverflowX).toBeLessThanOrEqual(0);
      expect(rep.rowHeights.every((h) => h === 28)).toBe(true);
      expect(Math.abs(rep.firstRowTop - rep.listTop)).toBeLessThan(40);

      // Hover overlay: the actions come back and are hit-testable.
      await w.locator("li.gh-changes-panel__file", { has: w.locator(".gh-changes-panel__file-actions--blocked") }).hover();
      await w.waitForTimeout(450);
      await w.screenshot({ path: path.join(shots, `rail-overlay-${theme}-${size}.png`) });
      const overlay = await w.evaluate(() => {
        const files = document.querySelector<HTMLElement>(".gh-changes-panel__files")!;
        const b = files.querySelector<HTMLElement>(".gh-changes-panel__file-actions--blocked button")!;
        const r = b.getBoundingClientRect();
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return { w: files.getBoundingClientRect().width, hit: b.contains(hit), opacity: getComputedStyle(b.parentElement!).opacity };
      });
      expect(overlay.w).toBeGreaterThan(150);
      expect(overlay.hit).toBe(true);
      expect(overlay.opacity).toBe("1");
      await parkPointer(w);

      await w.getByRole("button", { name: "Back to diff" }).click();
      await w.getByRole("alertdialog").getByRole("button", { name: "Discard" }).click();
      await expect(cm).toHaveCount(0);

      // Clean (not dirty) editing of a staged-content file: the rail rows keep their layout too.
      await rowLabel(w, "Staged", "staged.txt").click();
      await expect(edit).toBeEnabled();
      await edit.click();
      await expect(cm).toBeFocused();
      await parkPointer(w);
      await w.waitForTimeout(500);
      await w.screenshot({ path: path.join(shots, `rail-clean-staged-${theme}-${size}.png`) });
      const clean = await railReport(w);
      expect(clean.problems).toEqual([]);
      await w.getByRole("button", { name: "Back to diff" }).click();
      await expect(cm).toHaveCount(0);
    }
  }
});
