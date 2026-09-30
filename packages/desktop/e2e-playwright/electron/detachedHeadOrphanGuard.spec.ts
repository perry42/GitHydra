// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Real-Electron verification of the FR-430 detached-HEAD orphan guard
 * (specs/branch-panel-drag-merge.md): every GitHydra-initiated checkout that would leave commits
 * no ref reaches asks FIRST; nothing (HEAD, index, working tree) changes until the user confirms.
 *
 * Real pointer events, real scratch git repos, screenshots (dark + light) under
 * `.tmp-critique-screenshots/detached-head-orphan-guard/` (git-ignored).
 */
import { test, expect, type Locator, type Page } from "@playwright/test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { closeApp, launchGitHydra, removeUserDataDir, stubOpenRepoDialog, type LaunchedApp } from "../helpers/launchApp";
import { cleanup, commitAll, git, initRepo, writeFile } from "../../src/test/gitFixture";

const SHOT_DIR = path.join(process.cwd(), ".tmp-critique-screenshots", "detached-head-orphan-guard");

let handle: LaunchedApp;
let repoDir: string;

test.beforeEach(async () => {
  await fs.mkdir(SHOT_DIR, { recursive: true });
  handle = await launchGitHydra();
  repoDir = "";
});
test.afterEach(async () => {
  await closeApp(handle);
  await removeUserDataDir(handle.userDataDir);
  if (repoDir) await cleanup(repoDir);
});

async function shot(name: string, target?: Locator): Promise<void> {
  const file = path.join(SHOT_DIR, `${name}.png`);
  if (target) await target.screenshot({ path: file });
  else await handle.window.screenshot({ path: file });
}

async function openRepo(theme: "dark" | "light" = "dark"): Promise<Page> {
  const w = handle.window;
  await w.evaluate((t) => window.localStorage.setItem("githydra:theme", t), theme);
  await w.reload();
  await w.waitForLoadState("domcontentloaded");
  await stubOpenRepoDialog(handle.app, repoDir);
  await w.getByRole("button", { name: "Open a repository", exact: true }).click();
  await w.getByRole("button", { name: /^stashes/i }).waitFor({ timeout: 15_000 });
  await expect(w.locator("html")).toHaveAttribute("data-theme", theme);
  return w;
}

const rev = async (ref: string) => (await git(repoDir, ["rev-parse", ref])).stdout.trim();
const isDetached = async () => {
  try {
    await git(repoDir, ["symbolic-ref", "-q", "HEAD"]);
    return false;
  } catch {
    return true;
  }
};

/** main: Base; feat: Feat commit; HEAD detached at main + ONE orphan commit (`orphanSubject`). */
async function buildOrphanRepo(orphanSubject = "ORPHAN detached commit"): Promise<{ orphanSha: string; mainSha: string }> {
  repoDir = await initRepo();
  await writeFile(repoDir, "a.txt", "base\n");
  await commitAll(repoDir, "Base commit");
  await git(repoDir, ["checkout", "-q", "-b", "feat"]);
  await writeFile(repoDir, "f.txt", "f\n");
  await commitAll(repoDir, "Feat commit");
  await git(repoDir, ["checkout", "-q", "--detach", "main"]);
  const mainSha = await rev("main");
  await writeFile(repoDir, "orphan.txt", "o\n");
  await commitAll(repoDir, orphanSubject);
  return { orphanSha: await rev("HEAD"), mainSha };
}

const card = (w: Page, name: string) => w.locator(`li[data-ref-branch="${name}"]`);
const chip = (w: Page, name: string) => w.locator(`.gh-commit-row__refgutter [data-ref-branch="${name}"]`).first();
const dialog = (w: Page) => w.getByRole("alertdialog");
const banner = (w: Page) => w.getByRole("status").filter({ hasText: /behind at/ });

async function center(loc: Locator) {
  const b = (await loc.boundingBox())!;
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}
async function dragCardOntoCard(w: Page, from: string, to: string) {
  const b = (await card(w, from).boundingBox())!;
  const x = b.x + 6;
  const y = b.y + 5;
  await w.mouse.move(x, y);
  await w.mouse.down();
  await w.mouse.move(x + 12, y + 12, { steps: 3 });
  const t = (await card(w, to).boundingBox())!;
  await w.mouse.move(t.x + 6, t.y + 5, { steps: 8 });
  await w.mouse.up();
}

type Path = "branches-button" | "chip-menu" | "commit-menu" | "drag-merge" | "palette-new-branch";

/** Starts a checkout that would leave the detached HEAD, via the given UI path. Returns once the trigger fired. */
async function trigger(w: Page, via: Path): Promise<void> {
  switch (via) {
    case "branches-button":
      await card(w, "feat").getByRole("button", { name: /^Checkout/ }).click();
      return;
    case "chip-menu":
      await chip(w, "feat").click({ button: "right" });
      await w.getByRole("menuitem", { name: /^Checkout$/ }).click();
      return;
    case "commit-menu": {
      const row = w.locator(".gh-commit-row").filter({ hasText: "Feat commit" }).first();
      await row.click({ button: "right", position: { x: 300, y: 8 } });
      await w.getByRole("menuitem", { name: /^Checkout commit/ }).click();
      return;
    }
    case "drag-merge":
      await dragCardOntoCard(w, "feat", "main");
      await w.getByRole("menuitem", { name: "Merge feat into main" }).click();
      return;
    case "palette-new-branch": {
      await w.keyboard.press("Control+k");
      await w.getByRole("combobox").fill("New branch");
      await w.keyboard.press("Enter");
      await w.getByLabel("Branch name").fill("fromPalette");
      await w.getByRole("button", { name: /^Create/ }).click();
      return;
    }
  }
}

const ALL_PATHS: Path[] = ["branches-button", "chip-menu", "commit-menu", "drag-merge", "palette-new-branch"];

// ---------------------------------------------------------------- AC1
test.describe("AC1: no dialog/banner when nothing would be orphaned", () => {
  for (const variant of ["branch-tip", "old-commit"] as const) {
    for (const via of ["branches-button", "chip-menu"] as const) {
      test(`detached at ${variant}, checkout via ${via}: no dialog, no banner, checkout happens`, async () => {
        repoDir = await initRepo();
        await writeFile(repoDir, "a.txt", "base\n");
        const base = await commitAll(repoDir, "Base commit");
        await writeFile(repoDir, "a.txt", "two\n");
        await commitAll(repoDir, "Second commit");
        await git(repoDir, ["checkout", "-q", "-b", "feat"]);
        await writeFile(repoDir, "f.txt", "f\n");
        await commitAll(repoDir, "Feat commit");
        await git(repoDir, ["checkout", "-q", "--detach", variant === "branch-tip" ? "main" : base]);
        const w = await openRepo();
        await trigger(w, via);
        await expect.poll(async () => (await isDetached()) === false, { timeout: 10_000 }).toBe(true);
        await w.waitForTimeout(500);
        await expect(dialog(w)).toHaveCount(0);
        await expect(banner(w)).toHaveCount(0);
        expect((await git(repoDir, ["symbolic-ref", "--short", "HEAD"])).stdout.trim()).toBe("feat");
      });
    }
  }
});

// ---------------------------------------------------------------- AC2 (+ cancel leaves everything unchanged)
test.describe("AC2: every checkout path asks BEFORE checking out; Cancel changes nothing", () => {
  for (const via of ALL_PATHS) {
    test(`via ${via}`, async () => {
      const { orphanSha } = await buildOrphanRepo();
      const w = await openRepo();
      await trigger(w, via);
      await expect(dialog(w)).toBeVisible();
      await expect(dialog(w)).toContainText("ORPHAN detached commit");
      // Until confirmed: HEAD, branches and working tree are untouched.
      expect(await rev("HEAD")).toBe(orphanSha);
      expect(await isDetached()).toBe(true);
      expect(await fs.readFile(path.join(repoDir, "orphan.txt"), "utf8")).toContain("o");
      await expect(fs.access(path.join(repoDir, "f.txt"))).rejects.toBeTruthy();
      expect((await git(repoDir, ["branch", "--list", "fromPalette"])).stdout.trim()).toBe("");
      await shot(`ac2-dialog-${via}`);
      await dialog(w).getByRole("button", { name: "Cancel" }).click();
      await expect(dialog(w)).toHaveCount(0);
      await w.waitForTimeout(500);
      expect(await rev("HEAD")).toBe(orphanSha);
      expect(await isDetached()).toBe(true);
      expect((await git(repoDir, ["branch", "--list", "fromPalette"])).stdout.trim()).toBe("");
      await expect(banner(w)).toHaveCount(0);
    });
  }
});

// ---------------------------------------------------------------- AC3 + AC10
for (const theme of ["dark", "light"] as const) {
  test(`AC3 [${theme}]: dialog a11y (focus, trap, Tab order, Escape, names) and legible "Heads up" notice`, async () => {
    await buildOrphanRepo();
    const w = await openRepo(theme);
    await trigger(w, "branches-button");
    const d = dialog(w);
    await expect(d).toBeVisible();
    const create = d.getByRole("button", { name: "Create branch here…" });
    const leave = d.getByRole("button", { name: "Leave commits behind" });
    const cancel = d.getByRole("button", { name: "Cancel" });
    await expect(cancel).toBeFocused();
    await shot(`ac3-${theme}-dialog`);
    const focusedName = () => w.evaluate(() => document.activeElement?.textContent ?? "");
    await w.keyboard.press("Tab");
    expect(await focusedName()).toBe("Create branch here…");
    await w.keyboard.press("Tab");
    expect(await focusedName()).toBe("Leave commits behind");
    await w.keyboard.press("Tab");
    expect(await focusedName()).toBe("Cancel");
    for (let i = 0; i < 7; i += 1) {
      await w.keyboard.press("Tab");
      expect(await w.evaluate(() => !!document.activeElement?.closest('[role="alertdialog"]'))).toBe(true);
    }
    await w.keyboard.press("Shift+Tab");
    await expect(d.getByRole("button")).toHaveCount(3);
    await expect(create).toBeVisible();
    await expect(leave).toBeVisible();
    // Names are text (not color-only): every button has visible text and an accessible name.
    for (const b of [create, leave, cancel]) expect((await b.innerText()).trim().length).toBeGreaterThan(3);
    // Focus starts on Cancel again next time; Escape cancels.
    await w.keyboard.press("Escape");
    await expect(d).toHaveCount(0);
    expect(await isDetached()).toBe(true);
  });

  test(`AC10 [${theme}]: hostile subject renders inert, isolated and truncated`, async () => {
    const rtl = "‮";
    const subject = `Cancel${rtl} txt.exe <img src=x onerror=window.__pwned=1> \u0007\u001b[31m${"WIDE".repeat(60)}`;
    repoDir = await initRepo();
    await writeFile(repoDir, "a.txt", "base\n");
    await commitAll(repoDir, "Base commit");
    await git(repoDir, ["checkout", "-q", "-b", "feat"]);
    await writeFile(repoDir, "f.txt", "f\n");
    await commitAll(repoDir, "Feat commit");
    await git(repoDir, ["checkout", "-q", "--detach", "main"]);
    await writeFile(repoDir, "orphan.txt", "o\n");
    await git(repoDir, ["add", "-A"]);
    const msgFile = path.join(os.tmpdir(), `githydra-hostile-${Date.now()}.txt`);
    await fs.writeFile(msgFile, subject + "\n", "utf8");
    await git(repoDir, ["commit", "-q", "--cleanup=verbatim", "-F", msgFile]);
    await fs.rm(msgFile, { force: true });

    const w = await openRepo(theme);
    await card(w, "feat").getByRole("button", { name: /^Checkout/ }).click();
    const d = dialog(w);
    await expect(d).toBeVisible();
    const row = d.locator(".gh-orphan-dialog__subject").first();
    const text = await row.innerText();
    expect(text).not.toContain(rtl);
    expect(text).not.toContain("\u0007");
    expect(text.length).toBeLessThanOrEqual(125); // 120 code points + ellipsis
    expect(text.endsWith("…")).toBe(true);
    await expect(row.locator("img")).toHaveCount(0);
    expect(await w.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined();
    // Not a fake button: exactly the three real buttons exist and the accessible name is unaffected.
    await expect(d.getByRole("button")).toHaveCount(3);
    const box = (await row.boundingBox())!;
    const dbox = (await d.boundingBox())!;
    expect(box.x + box.width).toBeLessThanOrEqual(dbox.x + dbox.width + 1);
    await shot(`ac10-${theme}-hostile-subject`, d);
  });
}

// ---------------------------------------------------------------- AC4
test("AC4: 'Create branch here…' reuses the naming flow, then the checkout proceeds and the commit is reachable", async () => {
  const { orphanSha } = await buildOrphanRepo();
  const w = await openRepo();
  await trigger(w, "branches-button");
  await dialog(w).getByRole("button", { name: "Create branch here…" }).click();
  const naming = w.getByRole("dialog", { name: "Create branch here" });
  await expect(naming).toBeVisible();
  await shot("ac4-naming-step");
  await naming.getByLabel("Branch name").fill("saved-work");
  await naming.getByRole("button", { name: /^Create/ }).click();
  // After success the original checkout (feat) proceeds.
  await expect.poll(async () => (await isDetached()) === false, { timeout: 15_000 }).toBe(true);
  expect((await git(repoDir, ["symbolic-ref", "--short", "HEAD"])).stdout.trim()).toBe("feat");
  expect((await git(repoDir, ["branch", "--contains", orphanSha, "--format=%(refname:short)"])).stdout).toContain("saved-work");
  expect(await rev("saved-work")).toBe(orphanSha);
  await expect(dialog(w)).toHaveCount(0);
  await expect(banner(w)).toHaveCount(0);
});

// ---------------------------------------------------------------- AC5
for (const theme of ["dark", "light"] as const) test(`AC5 [${theme}]: 'Leave commits behind' proceeds; banner with short SHA, working Create-branch action; Dismiss keeps commits`, async () => {
  const { orphanSha } = await buildOrphanRepo();
  const short = orphanSha.slice(0, 7);
  const w = await openRepo(theme);
  await trigger(w, "branches-button");
  await dialog(w).getByRole("button", { name: "Leave commits behind" }).click();
  await expect.poll(async () => (await isDetached()) === false, { timeout: 15_000 }).toBe(true);
  await expect(banner(w)).toContainText(short);
  await shot(`ac5-${theme}-banner`);
  // Dismiss does not touch the commits.
  await banner(w).getByRole("button", { name: "Dismiss" }).click();
  await expect(banner(w)).toHaveCount(0);
  expect((await git(repoDir, ["cat-file", "-t", orphanSha])).stdout.trim()).toBe("commit");
  expect(await rev("feat")).not.toBe(orphanSha);
});

test("AC5b: banner 'Create branch at <sha>' saves the commit and the banner clears", async () => {
  const { orphanSha } = await buildOrphanRepo();
  const short = orphanSha.slice(0, 7);
  const w = await openRepo();
  await trigger(w, "branches-button");
  await dialog(w).getByRole("button", { name: "Leave commits behind" }).click();
  await expect(banner(w)).toContainText(short);
  await banner(w).getByRole("button", { name: `Create branch at ${short}` }).click();
  const naming = w.getByRole("dialog", { name: "Create branch here" });
  await naming.getByLabel("Branch name").fill("rescued");
  await naming.getByRole("button", { name: /^Create/ }).click();
  await expect.poll(async () => (await git(repoDir, ["branch", "--list", "rescued"])).stdout.trim(), { timeout: 10_000 }).not.toBe("");
  expect(await rev("rescued")).toBe(orphanSha);
  expect((await git(repoDir, ["symbolic-ref", "--short", "HEAD"])).stdout.trim()).toBe("feat"); // did not switch
  await expect(banner(w)).toHaveCount(0);
});

test("AC5c: banner clears on tab switch", async () => {
  await buildOrphanRepo();
  const other = await initRepo();
  await writeFile(other, "x.txt", "x\n");
  await commitAll(other, "Other repo commit");
  try {
    const w = await openRepo();
    await trigger(w, "branches-button");
    await dialog(w).getByRole("button", { name: "Leave commits behind" }).click();
    await expect(banner(w)).toBeVisible();
    await stubOpenRepoDialog(handle.app, other);
    await w.getByRole("button", { name: /new tab/i }).click();
    await w.getByRole("button", { name: /open a repository|open repository/i }).first().click();
    await expect(banner(w)).toHaveCount(0);
    await shot("ac5c-after-new-tab");
    // Switch back to the first tab: the banner must not resurrect.
    await w.getByRole("tab").first().click();
    await w.waitForTimeout(500);
    await expect(banner(w)).toHaveCount(0);
  } finally {
    await cleanup(other);
  }
});

// ---------------------------------------------------------------- AC6
test("AC6: drag-to-merge while detached: Cancel changes nothing and runs no merge; Confirm merges", async () => {
  const { orphanSha, mainSha } = await buildOrphanRepo();
  const w = await openRepo();
  await trigger(w, "drag-merge");
  await expect(dialog(w)).toContainText(/Merging .+ into main needs to check out main first/);
  await shot("ac6-drag-dialog");
  await dialog(w).getByRole("button", { name: "Cancel" }).click();
  await w.waitForTimeout(800);
  expect(await rev("HEAD")).toBe(orphanSha);
  expect(await isDetached()).toBe(true);
  expect(await rev("main")).toBe(mainSha);
  await expect(fs.access(path.join(repoDir, ".git", "MERGE_HEAD"))).rejects.toBeTruthy();
  await expect(w.getByRole("button", { name: "Refresh commit graph" })).toBeVisible();

  await trigger(w, "drag-merge");
  await dialog(w).getByRole("button", { name: "Leave commits behind" }).click();
  await expect.poll(async () => await rev("main"), { timeout: 15_000 }).toBe(await rev("feat"));
  expect((await git(repoDir, ["symbolic-ref", "--short", "HEAD"])).stdout.trim()).toBe("main");
  await expect(banner(w)).toContainText(orphanSha.slice(0, 7));
  await expect(card(w, "main").getByText("Current")).toBeVisible();
});

// ---------------------------------------------------------------- AC7
test("AC7: in-progress merge -> no orphan dialog is reached", async () => {
  repoDir = await initRepo();
  await writeFile(repoDir, "a.txt", "base\n");
  await commitAll(repoDir, "Base commit");
  await git(repoDir, ["checkout", "-q", "-b", "feat"]);
  await writeFile(repoDir, "a.txt", "feat side\n");
  await commitAll(repoDir, "Feat edits a.txt");
  await git(repoDir, ["checkout", "-q", "main"]);
  await writeFile(repoDir, "a.txt", "main side\n");
  await commitAll(repoDir, "Main edits a.txt");
  await git(repoDir, ["merge", "feat"]).catch(() => undefined);
  const w = await openRepo();
  await expect(w.getByRole("button", { name: "Abort", exact: true })).toBeVisible();
  await card(w, "feat").getByRole("button", { name: /^Checkout/ }).click({ trial: false }).catch(() => undefined);
  await w.waitForTimeout(800);
  await expect(dialog(w).filter({ hasText: /not saved on any branch/ })).toHaveCount(0);
});

// ---------------------------------------------------------------- AC8
for (const theme of ["dark", "light"] as const) test(`AC8 [${theme}]: HEAD moved while the dialog is open -> nothing checked out, notice shown, guard re-runs`, async () => {
  const { orphanSha } = await buildOrphanRepo();
  const w = await openRepo(theme);
  await trigger(w, "branches-button");
  await expect(dialog(w)).toBeVisible();
  // Another process moves HEAD onto a different orphan commit (still detached).
  await git(repoDir, ["commit", "-q", "--allow-empty", "-m", "Second orphan made externally"]);
  const moved = await rev("HEAD");
  expect(moved).not.toBe(orphanSha);
  await dialog(w).getByRole("button", { name: "Leave commits behind" }).click();
  await expect(w.getByRole("alert").filter({ hasText: /HEAD changed while the dialog was open/ })).toBeVisible({ timeout: 10_000 });
  await shot(`ac8-${theme}-head-moved`);
  expect(await isDetached()).toBe(true);
  expect(await rev("HEAD")).toBe(moved);
  await expect(dialog(w)).toContainText("Second orphan made externally");
  await expect(w.getByRole("button", { name: "Cancel" })).toBeFocused();
});

test("AC8b: HEAD moved by `git switch` to a branch while the dialog is open -> nothing checked out by GitHydra", async () => {
  await buildOrphanRepo();
  const w = await openRepo();
  await trigger(w, "branches-button");
  await expect(dialog(w)).toBeVisible();
  await git(repoDir, ["stash", "-u", "-q"]).catch(() => undefined);
  await git(repoDir, ["switch", "-q", "main"]);
  const before = await rev("HEAD");
  await dialog(w).getByRole("button", { name: "Leave commits behind" }).click();
  await w.waitForTimeout(1500);
  // HEAD attached at main is a definitive `none`: the guard's re-run proceeds. Either outcome must
  // leave the repo consistent; record where HEAD ended up.
  const head = (await git(repoDir, ["symbolic-ref", "--short", "-q", "HEAD"]).catch(() => ({ stdout: "" }))).stdout.trim();
  test.info().annotations.push({ type: "ac8b-final-head", description: `${head || "detached"} (was main @ ${before.slice(0, 7)})` });
  await shot("ac8b-after");
});

// ---------------------------------------------------------------- AC9
for (const theme of ["dark", "light"] as const) {
  test(`AC9 [${theme}]: unreadable ref makes the check fail -> generic 'couldn't check' dialog, no stderr`, async () => {
    const { orphanSha } = await buildOrphanRepo();
    const w = await openRepo(theme);
    // Corrupt AFTER the app loaded: the orphan commit's loose object, so `git rev-list` fails while
    // `rev-parse HEAD` still resolves. (A merely dangling branch ref is silently ignored by git.)
    const objPath = path.join(repoDir, ".git", "objects", orphanSha.slice(0, 2), orphanSha.slice(2));
    await fs.chmod(objPath, 0o666).catch(() => undefined);
    await fs.writeFile(objPath, "not a zlib stream");
    await trigger(w, "branches-button");
    const d = dialog(w);
    await expect(d).toBeVisible();
    await expect(d).toHaveAccessibleName(/Couldn't check whether this HEAD has unsaved commits/);
    const text = await d.innerText();
    expect(text).not.toMatch(/fatal|bad object|error:|1234567890/i);
    await shot(`ac9-${theme}-unknown`);
    expect(await isDetached()).toBe(true);
  });
}

// ---------------------------------------------------------------- AC11
test("AC11: palette 'Create branch at detached HEAD' only when detached, and it works", async () => {
  repoDir = await initRepo();
  await writeFile(repoDir, "a.txt", "base\n");
  await commitAll(repoDir, "Base commit");
  const w0 = await openRepo();
  await w0.keyboard.press("Control+k");
  await w0.getByRole("combobox").fill("detached HEAD");
  await expect(w0.getByText("Create branch at detached HEAD")).toHaveCount(0);
  await w0.keyboard.press("Escape");
  await cleanup(repoDir);

  const { orphanSha } = await buildOrphanRepo();
  await handle.window.evaluate(() => window.localStorage.clear());
  const w = await openRepo();
  await w.keyboard.press("Control+k");
  await w.getByRole("combobox").fill("detached HEAD");
  await expect(w.getByText("Create branch at detached HEAD")).toBeVisible();
  await shot("ac11-palette-entry");
  await w.keyboard.press("Enter");
  const naming = w.getByRole("dialog", { name: "Create branch here" });
  await naming.getByLabel("Branch name").fill("from-palette-head");
  await naming.getByRole("button", { name: /^Create/ }).click();
  await expect.poll(async () => (await git(repoDir, ["branch", "--list", "from-palette-head"])).stdout.trim(), { timeout: 10_000 }).not.toBe("");
  expect(await rev("from-palette-head")).toBe(orphanSha);
  expect(await isDetached()).toBe(true); // creating a branch here must not switch away
});

// ---------------------------------------------------------------- AC12
test("AC12a: Escape in the stacked naming step closes ONLY the naming step (back to the orphan dialog), not both", async () => {
  const { orphanSha } = await buildOrphanRepo();
  const w = await openRepo();
  await trigger(w, "branches-button");
  await dialog(w).getByRole("button", { name: "Create branch here…" }).click();
  const naming = w.getByRole("dialog", { name: "Create branch here" });
  await expect(naming).toBeVisible();
  await w.keyboard.press("Escape");
  await expect(naming).toHaveCount(0);
  await expect(dialog(w)).toBeVisible(); // orphan dialog is back, nothing decided
  expect(await rev("HEAD")).toBe(orphanSha);
  expect(await isDetached()).toBe(true);
  await w.keyboard.press("Escape");
  await expect(dialog(w)).toHaveCount(0);
});

test("AC12b: opening the orphan dialog while another dialog (New Branch) is open", async () => {
  await buildOrphanRepo();
  const w = await openRepo();
  await w.keyboard.press("Control+k");
  await w.getByRole("combobox").fill("New branch");
  await w.keyboard.press("Enter");
  const nb = w.getByRole("dialog", { name: "New Branch" });
  await expect(nb).toBeVisible();
  await nb.getByLabel("Branch name").fill("via-nb");
  await nb.getByRole("button", { name: /^Create/ }).click(); // switchToIt defaults on -> guard prompts
  await expect(dialog(w)).toBeVisible();
  await shot("ac12b-stacked");
  await w.keyboard.press("Escape");
  await expect(dialog(w)).toHaveCount(0);
  const nbStillOpen = await nb.count();
  test.info().annotations.push({ type: "ac12b-new-branch-dialog-open-after-escape", description: String(nbStillOpen) });
  expect(await isDetached()).toBe(true);
  expect((await git(repoDir, ["branch", "--list", "via-nb"])).stdout.trim()).toBe("");
});
