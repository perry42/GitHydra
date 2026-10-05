// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * specs/ignore-and-multiselect.md AC3, AC4, AC5, AC6 (directory), AC7, AC17 and IGNORE_PLAN_CHANGED recovery,
 * real built app + real git. Windows-creatable file names only (no `*`, trailing space, CR/LF) — see the report.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { test, expect, type Page } from "@playwright/test";
import { closeApp, removeUserDataDir, type LaunchedApp } from "../helpers/launchApp";
import { launchApp, ignoreViaMenu, openChanges, refresh, rowBtn } from "../helpers/changesHelpers";
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
async function repo(): Promise<string> {
  const d = await initRepo();
  dirs.push(d);
  await writeFile(d, "README.md", "base\n");
  await commitAll(d, "base");
  return d;
}
const status = async (d: string) => (await git(d, ["status", "--porcelain", "-uall"])).stdout;
const bytes = (d: string, p: string) => fs.readFile(path.join(d, p));
const exists = (d: string, p: string) => fs.access(path.join(d, p)).then(() => true, () => false);
const B = (...parts: (string | number[])[]) =>
  Buffer.concat(parts.map((p) => (typeof p === "string" ? Buffer.from(p, "utf8") : Buffer.from(p))));
const BOM = [0xef, 0xbb, 0xbf];
/** git check-ignore: true when ignored (exit 0), false when not (exit 1). */
async function ignored(d: string, p: string): Promise<boolean> {
  try {
    await git(d, ["check-ignore", "-q", "--no-index", "--", p]);
    return true;
  } catch (e) {
    if (/failed \(1\)/.test(String(e))) return false;
    throw e;
  }
}

async function applyIgnore(page: Page, target: RegExp) {
  const dlg = page.getByRole("alertdialog");
  await expect(dlg).toBeVisible();
  await dlg.getByRole("radio", { name: target }).check();
  await expect(dlg.getByRole("status")).toContainText(/will add/i);
  await dlg.getByRole("button", { name: /^add to /i }).click();
  await expect(dlg).toHaveCount(0);
}

// ------------------------------------------------------------------ AC3 fidelity (bytes written by the real UI)
const fidelity: { name: string; before: Buffer; after: Buffer }[] = [
  { name: "UTF-8 BOM + LF", before: B(BOM, "foo\nbar\n"), after: B(BOM, "foo\nbar\n/x.txt\n") },
  { name: "CRLF-only", before: B("foo\r\nbar\r\n"), after: B("foo\r\nbar\r\n/x.txt\r\n") },
  { name: "LF-only", before: B("foo\nbar\n"), after: B("foo\nbar\n/x.txt\n") },
  { name: "LF no trailing newline", before: B("foo\nbar"), after: B("foo\nbar\n/x.txt\n") },
  { name: "CRLF no trailing newline", before: B("foo\r\nbar"), after: B("foo\r\nbar\r\n/x.txt\r\n") },
  { name: "BOM + CRLF no trailing newline", before: B(BOM, "foo\r\nbar"), after: B(BOM, "foo\r\nbar\r\n/x.txt\r\n") },
  { name: "empty file", before: B(""), after: B("/x.txt\n") },
  { name: "mixed EOL, CRLF dominant", before: B("a\r\nb\r\nc\n"), after: B("a\r\nb\r\nc\n/x.txt\r\n") },
];
for (const c of fidelity) {
  test(`AC3 fidelity: ${c.name} target keeps every byte and gains exactly one rule line`, async () => {
    const d = await repo();
    await fs.writeFile(path.join(d, ".gitignore"), c.before);
    await git(d, ["add", ".gitignore"]);
    await git(d, ["commit", "-qm", "ign"]);
    await fs.writeFile(path.join(d, ".gitignore"), c.before); // pin exact bytes irrespective of autocrlf
    await writeFile(d, "x.txt", "x\n");
    await openChanges(h, d);
    await ignoreViaMenu(h.window, "untracked", "x.txt", /^this file/i);
    await applyIgnore(h.window, /root \.gitignore/i);
    const got = await bytes(d, ".gitignore");
    expect(got.toString("hex")).toBe(c.after.toString("hex"));
  });
}

test("AC3 repeat of the same rule reports 'already in' and leaves bytes unchanged (via UI, untracked file twice impossible: use exclude)", async () => {
  const d = await repo();
  const before = B(BOM, "/x.txt\r\n");
  await fs.writeFile(path.join(d, ".gitignore"), before);
  await writeFile(d, "y.txt", "1\n");
  await commitAll(d, "y");
  await fs.writeFile(path.join(d, ".gitignore"), B("/y.txt\n"));
  await writeFile(d, "y.txt", "2\n");
  await openChanges(h, d);
  await ignoreViaMenu(h.window, "unstaged", "y.txt", /^this file/i);
  const dlg = h.window.getByRole("alertdialog");
  await expect(dlg.getByRole("status")).not.toHaveText("Checking…");
  await expect(dlg.getByRole("status")).toContainText(/already/i);
  expect((await bytes(d, ".gitignore")).toString()).toBe("/y.txt\n");
});

// ------------------------------------------------------------------ AC4 escaping
// The "/" anchor means # and ! are never the first character of the line, so git needs no backslash for them (check-ignore below proves it).
// The "/" anchor means # and ! are never the first character of the line, so git needs no backslash for them (check-ignore proves it).
const escapes: { file: string; sibling: string; rule: string }[] = [
  { file: "#a", sibling: "a", rule: "/#a\n" },
  { file: "!b", sibling: "b", rule: "/!b\n" },
  { file: "x[1].txt", sibling: "x1.txt", rule: "/x\\[1\\].txt\n" },
  { file: "héllo wörld.txt", sibling: "hello world.txt", rule: "/héllo wörld.txt\n" },
  { file: "日本語.txt", sibling: "日本.txt", rule: "/日本語.txt\n" },
  { file: "a#b", sibling: "ab", rule: "/a#b\n" },
  { file: "sub dir/#a", sibling: "sub dir/a", rule: "/sub dir/#a\n" },
];
for (const c of escapes) {
  test(`AC4 escaping: ${JSON.stringify(c.file)} -> ${JSON.stringify(c.rule)}; check-ignore matches it and not its sibling`, async () => {
    const d = await repo();
    await writeFile(d, c.file, "x\n");
    await writeFile(d, c.sibling, "x\n");
    await openChanges(h, d);
    await ignoreViaMenu(h.window, "untracked", c.file, /^this file/i);
    await applyIgnore(h.window, /root \.gitignore/i);
    expect((await bytes(d, ".gitignore")).toString()).toBe(c.rule);
    expect(await ignored(d, c.file)).toBe(true);
    expect(await ignored(d, c.sibling)).toBe(false);
    await expect(rowBtn(h.window, "untracked", c.file)).toHaveCount(0, { timeout: 10_000 });
    await expect(rowBtn(h.window, "untracked", c.sibling)).toBeVisible();
  });
}

test("AC4 extension scope escapes bracket characters and never writes a Windows backslash separator", async () => {
  const d = await repo();
  await writeFile(d, "deep/er/a.[b]", "x\n");
  await writeFile(d, "deep/er/a.b", "x\n");
  await openChanges(h, d);
  await ignoreViaMenu(h.window, "untracked", "deep/er/a.[b]", /all \*/i);
  await applyIgnore(h.window, /root \.gitignore/i);
  const rule = (await bytes(d, ".gitignore")).toString();
  expect(rule).toBe("*.\\[b\\]\n");
  expect(await ignored(d, "deep/er/a.[b]")).toBe(true);
  expect(await ignored(d, "deep/er/a.b")).toBe(false);
});

test("AC4 nested path name rule uses forward slashes only (no backslash separator)", async () => {
  const d = await repo();
  await writeFile(d, "one/two/three.txt", "x\n");
  await openChanges(h, d);
  await ignoreViaMenu(h.window, "untracked", "one/two/three.txt", /^this file/i);
  await applyIgnore(h.window, /root \.gitignore/i);
  expect((await bytes(d, ".gitignore")).toString()).toBe("/one/two/three.txt\n");
});

// ------------------------------------------------------------------ AC5
test("AC5 a tracked file already ignored by another file's rule reports 'already ignored by <file>:<line>', writes nothing, only Stop Tracking is offered", async () => {
  const d = await repo();
  await writeFile(d, ".gitignore", "# c\n*.log\n");
  await commitAll(d, "ign");
  await writeFile(d, "a.log", "1\n");
  await git(d, ["add", "-f", "a.log"]);
  await git(d, ["commit", "-qm", "force"]);
  await writeFile(d, "a.log", "2\n");
  await openChanges(h, d);
  await ignoreViaMenu(h.window, "unstaged", "a.log", /^this file/i);
  await h.window.getByRole("alertdialog").getByRole("radio", { name: /private/i }).check();
  const dlg = h.window.getByRole("alertdialog");
  await expect(dlg.getByRole("status")).toContainText(/already ignored by \.gitignore:2/i);
  await dlg.getByRole("button", { name: /^next/i }).click();
  await expect(dlg.getByRole("button", { name: "Ignore only" })).toHaveCount(0);
  await expect(dlg.getByRole("button", { name: "Ignore and Stop Tracking" })).toBeEnabled();
  await dlg.getByRole("button", { name: "Cancel" }).click();
  expect((await bytes(d, ".gitignore")).toString()).toBe("# c\n*.log\n");
  expect((await bytes(d, ".git/info/exclude")).toString()).not.toContain("a.log");
});

test("AC5 a later '!' negation that re-includes the path gets an honest 'still not ignored' notice and the file stays listed", async () => {
  const d = await repo();
  await writeFile(d, "sub/.gitignore", "!keep.log\n");
  await commitAll(d, "neg");
  await writeFile(d, "sub/keep.log", "x\n");
  await openChanges(h, d);
  await ignoreViaMenu(h.window, "untracked", "sub/keep.log", /all \*\.log/i);
  await applyIgnore(h.window, /root \.gitignore/i);
  await expect(h.window.getByText(/still not ignored/i)).toBeVisible();
  await expect(h.window.getByText(/re-includes it/i)).toBeVisible();
  expect((await bytes(d, ".gitignore")).toString()).toBe("*.log\n");
  await refresh(h.window);
  await expect(rowBtn(h.window, "untracked", "sub/keep.log")).toBeVisible();
});

// ------------------------------------------------------------------ AC6 directory scope
test("AC6 directory scope untracks every tracked file under that directory (incl. nested) and no others; all stay on disk", async () => {
  const d = await repo();
  await writeFile(d, "build/a.o", "1\n");
  await writeFile(d, "build/sub/b.o", "1\n");
  await writeFile(d, "build/sub/deeper/c.txt", "1\n");
  await writeFile(d, "other/d.o", "1\n");
  await commitAll(d, "o");
  await writeFile(d, "build/a.o", "2\n");
  await openChanges(h, d);
  await ignoreViaMenu(h.window, "unstaged", "build/a.o", /all files in build\//i);
  const dlg = h.window.getByRole("alertdialog");
  await dlg.getByRole("button", { name: /^next/i }).click();
  await expect(dlg).toContainText(/removes 3 files from git's index/i);
  await dlg.getByRole("button", { name: "Ignore and Stop Tracking" }).click();
  await expect(dlg).toHaveCount(0);
  const s = await status(d);
  expect(s).toContain("D  build/a.o");
  expect(s).toContain("D  build/sub/b.o");
  expect(s).toContain("D  build/sub/deeper/c.txt");
  expect(s).not.toContain("other/d.o");
  expect((await bytes(d, "build/a.o")).toString()).toBe("2\n");
  expect(await exists(d, "build/sub/b.o")).toBe(true);
  expect((await bytes(d, ".gitignore")).toString()).toBe("/build/\n");
});

// ------------------------------------------------------------------ AC7
test("AC7 mixed row + Stop Tracking: confirm warns staged edits are dropped; ends as staged deletion with the worktree edit kept", async () => {
  const d = await repo();
  await writeFile(d, "m.txt", "v1\n");
  await commitAll(d, "m");
  await writeFile(d, "m.txt", "v2 staged\n");
  await git(d, ["add", "m.txt"]);
  await writeFile(d, "m.txt", "v3 worktree\n");
  await openChanges(h, d);
  await ignoreViaMenu(h.window, "unstaged", "m.txt", /^this file/i);
  const dlg = h.window.getByRole("alertdialog");
  await dlg.getByRole("button", { name: /^next/i }).click();
  await expect(dlg).toContainText(/partly staged file: the staged edits are dropped from the index/i);
  await dlg.getByRole("button", { name: "Ignore and Stop Tracking" }).click();
  await expect(dlg).toHaveCount(0);
  expect((await bytes(d, "m.txt")).toString()).toBe("v3 worktree\n");
  expect(await status(d)).toBe("D  m.txt\n?? .gitignore\n");
});

test("AC7 staged rename + Stop Tracking untracks the NEW path only; old path stays staged as deleted; says so", async () => {
  const d = await repo();
  await writeFile(d, "old.txt", "content that is long enough to be detected as a rename\nline2\nline3\n");
  await commitAll(d, "old");
  await git(d, ["mv", "old.txt", "new.txt"]);
  await openChanges(h, d);
  await ignoreViaMenu(h.window, "staged", "new.txt", /^this file/i);
  const dlg = h.window.getByRole("alertdialog");
  await dlg.getByRole("button", { name: /^next/i }).click();
  await expect(dlg).toContainText(/staged rename: only the new path is untracked; the old path stays staged as deleted/i);
  await dlg.getByRole("button", { name: "Ignore and Stop Tracking" }).click();
  await expect(dlg).toHaveCount(0);
  expect(await exists(d, "new.txt")).toBe(true);
  expect(await status(d)).toBe("D  old.txt\n?? .gitignore\n");
});

test("AC7 forced rm --cached failure (index.lock held) leaves the rule file as before, or reports the true state", async () => {
  const d = await repo();
  await writeFile(d, "t.txt", "a\n");
  await commitAll(d, "t");
  await writeFile(d, "t.txt", "b\n");
  await openChanges(h, d);
  await ignoreViaMenu(h.window, "unstaged", "t.txt", /^this file/i);
  const dlg = h.window.getByRole("alertdialog");
  await dlg.getByRole("button", { name: /^next/i }).click();
  await expect(dlg).toContainText(/stay on disk/i);
  const lock = path.join(d, ".git", "index.lock");
  await fs.writeFile(lock, "");
  await dlg.getByRole("button", { name: "Ignore and Stop Tracking" }).click();
  await h.window.waitForTimeout(2500);
  const ruleExists = await exists(d, ".gitignore");
  const dialogText = (await dlg.count()) ? await dlg.innerText() : "(dialog closed) " + (await h.window.locator("body").innerText()).slice(0, 600);
  console.log("AC7 lock: .gitignore exists =", ruleExists, "| UI:", dialogText.replace(/\s+/g, " ").slice(0, 400));
  await fs.rm(lock, { force: true });
  // Honest outcomes: rule never written/restored, OR it was written AND the UI says it was (checked below).
  const tracked = (await git(d, ["ls-files", "t.txt"])).stdout.trim();
  expect(tracked).toBe("t.txt"); // nothing was untracked
  if (ruleExists) {
    expect(dialogText).toMatch(/added|written|rule/i);
  }
  expect((await bytes(d, "t.txt")).toString()).toBe("b\n");
});

// ------------------------------------------------------------------ IGNORE_PLAN_CHANGED
test("IGNORE_PLAN_CHANGED: tracked set changes between preview and apply -> refused, nothing written, preview refreshed, retry succeeds", async () => {
  const d = await repo();
  await writeFile(d, "build/a.o", "1\n");
  await writeFile(d, "build/b.o", "1\n");
  await commitAll(d, "o");
  await writeFile(d, "build/a.o", "2\n");
  await openChanges(h, d);
  await ignoreViaMenu(h.window, "unstaged", "build/a.o", /all files in build\//i);
  const dlg = h.window.getByRole("alertdialog");
  await dlg.getByRole("button", { name: /^next/i }).click();
  await expect(dlg).toContainText(/removes 2 files/i);
  // The tracked set under build/ grows after the user was shown "2 files".
  await writeFile(d, "build/c.o", "1\n");
  await git(d, ["add", "build/c.o"]);
  await dlg.getByRole("button", { name: "Ignore and Stop Tracking" }).click();
  await expect(dlg).toContainText(/changed since you previewed them/i, { timeout: 10_000 });
  expect(await exists(d, ".gitignore")).toBe(false);
  expect((await git(d, ["ls-files", "build"])).stdout.trim().split("\n").length).toBe(3);
  await expect(dlg).toContainText(/removes 3 files/i, { timeout: 10_000 });
  await dlg.getByRole("button", { name: "Ignore and Stop Tracking" }).click();
  await expect(dlg).toHaveCount(0, { timeout: 10_000 });
  expect((await git(d, ["ls-files", "build"])).stdout.trim()).toBe("");
  expect((await bytes(d, ".gitignore")).toString()).toBe("/build/\n");
});

// ------------------------------------------------------------------ AC17 watcher ignore list refresh
async function instrument(): Promise<void> {
  await h.app.evaluate(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const g = globalThis as any;
    if (g.__spawnLog) return;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const req = typeof require === "function" ? require : process.mainModule!.require;
    const cp = req("node:child_process");
    const orig = cp.spawn;
    g.__spawnLog = [];
    cp.spawn = function (cmd: string, args: string[], ...rest: unknown[]) {
      g.__spawnLog.push({ t: Date.now(), args: Array.isArray(args) ? args.slice(0, 10) : [] });
      return orig.call(this, cmd, args, ...rest);
    };
  });
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const statusSpawns = (): Promise<number> => h.app.evaluate(() => ((globalThis as any).__spawnLog ?? []).filter((e: { args: string[] }) => e.args.includes("status")).length);

for (const target of [
  { label: "root .gitignore", re: /root \.gitignore/i },
  { label: "private .git/info/exclude", re: /private/i },
]) {
  test(`AC17 after an ignore write to ${target.label}, a new matching file in the watched dir triggers NO status refresh (control: a non-matching file does)`, async () => {
    const d = await repo();
    await writeFile(d, "gen/seed.txt", "x\n");
    await openChanges(h, d);
    await h.window.waitForTimeout(1500);
    await instrument();
    await ignoreViaMenu(h.window, "untracked", "gen/seed.txt", /all files in gen\//i);
    await applyIgnore(h.window, target.re);
    await expect(rowBtn(h.window, "untracked", "gen/seed.txt")).toHaveCount(0, { timeout: 10_000 });
    await h.window.waitForTimeout(3000); // let the post-write refresh and the watcher's ignore-list recompute settle
    const before = await statusSpawns();
    await writeFile(d, "gen/new1.txt", "x\n");
    await writeFile(d, "gen/deep/new2.txt", "x\n");
    await h.window.waitForTimeout(3000);
    const after = await statusSpawns();
    console.log(`AC17 ${target.label}: status spawns before=${before} after=${after}`);
    expect(after - before).toBe(0);
    // Control: the watcher is alive for a file that is NOT ignored.
    await writeFile(d, "visible.txt", "x\n");
    await expect(rowBtn(h.window, "untracked", "visible.txt")).toBeVisible({ timeout: 10_000 });
  });
}
