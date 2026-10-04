// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { watchWorktree, type WorktreeChange, type WorktreeWatcher } from "../src/worktreeWatcher";
import { getWorkingDirectoryStatus, getWorkingDirectoryChanges } from "../src/workingDirStatus";
import { getFileDiff } from "../src/diff";
import { Repository } from "../src/index";
import { git, initRepo, writeFile, commit, cleanup } from "./testRepo";

// specs/live-refresh.md FR-458/FR-459/AC10, against real temp repos and the real OS watcher.

const dirs: string[] = [];
const watchers: WorktreeWatcher[] = [];
afterEach(async () => {
  while (watchers.length) watchers.pop()!.close();
  while (dirs.length) await cleanup(dirs.pop()!);
});

async function makeRepo(files: Record<string, string> = { "a.txt": "a\n", "src/b.txt": "b\n" }): Promise<string> {
  const dir = await initRepo();
  dirs.push(dir);
  for (const [p, c] of Object.entries(files)) await writeFile(dir, p, c);
  await commit(dir, "init");
  return dir;
}

async function start(
  dir: string,
  opts: Parameters<typeof watchWorktree>[2] = {},
): Promise<{ changes: WorktreeChange[]; watcher: WorktreeWatcher }> {
  const changes: WorktreeChange[] = [];
  const watcher = watchWorktree(dir, (c) => changes.push(c), { debounceMs: 80, ...opts });
  watchers.push(watcher);
  await watcher.ready();
  await sleep(300); // let the native watch handle settle before the first fixture write
  return { changes, watcher };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitUntil(cond: () => boolean, timeoutMs = 5000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (cond()) return true;
    await sleep(25);
  }
  return cond();
}

describe("watchWorktree", () => {
  it("fires after an external save and reports the relative path", async () => {
    const dir = await makeRepo();
    const { changes } = await start(dir);
    await fs.writeFile(path.join(dir, "src", "b.txt"), "changed\n");
    expect(await waitUntil(() => changes.length > 0)).toBe(true);
    expect(changes[0]!.paths).toContain("src/b.txt");
    expect(changes[0]!.truncated).toBe(false);
  });

  it("coalesces a burst of writes into one notification", async () => {
    const dir = await makeRepo();
    const { changes } = await start(dir);
    await Promise.all(Array.from({ length: 60 }, (_, i) => fs.writeFile(path.join(dir, `burst-${i}.txt`), `${i}
`)));
    expect(await waitUntil(() => changes.length > 0)).toBe(true);
    await sleep(600);
    // Under heavy suite load a burst can straddle the max-wait once; it must never be one-per-file.
    expect(changes.length).toBeLessThanOrEqual(3);
    expect(changes.every((c) => c.paths.length <= 50)).toBe(true);
  });

  it("filters ignored directories (top-level and nested) and ignored file patterns", async () => {
    const dir = await makeRepo({ ".gitignore": "node_modules/\n*.log\n", "a.txt": "a\n", "pkg/x.txt": "x\n" });
    await fs.mkdir(path.join(dir, "node_modules", "dep"), { recursive: true });
    await fs.mkdir(path.join(dir, "pkg", "node_modules"), { recursive: true });
    const { changes } = await start(dir);
    for (let i = 0; i < 30; i++) {
      await fs.writeFile(path.join(dir, "node_modules", "dep", `f${i}.js`), "x");
      await fs.writeFile(path.join(dir, "pkg", "node_modules", `g${i}.js`), "x");
    }
    await fs.writeFile(path.join(dir, "debug.log"), "noise");
    await sleep(1200);
    expect(JSON.stringify(changes)).toBe("[]");

    await fs.writeFile(path.join(dir, "pkg", "x.txt"), "real change\n");
    expect(await waitUntil(() => changes.length > 0)).toBe(true);
    expect(changes[0]!.paths).toEqual(["pkg/x.txt"]);
  });

  it("still reports a tracked file that lives inside an ignored directory", async () => {
    const dir = await makeRepo({ ".gitignore": "vendor/\n", "a.txt": "a\n" });
    await writeFile(dir, "vendor/lib.txt", "v1\n");
    await git(dir, ["add", "-f", "vendor/lib.txt"]);
    await git(dir, ["commit", "-q", "-m", "vendor"]);
    const { changes } = await start(dir);
    await fs.writeFile(path.join(dir, "vendor", "lib.txt"), "v2\n");
    expect(await waitUntil(() => changes.length > 0)).toBe(true);
  });

  it("picks up .gitignore changes: a newly ignored directory goes quiet", async () => {
    const dir = await makeRepo();
    await fs.mkdir(path.join(dir, "out"));
    const { changes } = await start(dir);
    await fs.writeFile(path.join(dir, "out", "one.txt"), "1");
    expect(await waitUntil(() => changes.length > 0)).toBe(true);

    await fs.writeFile(path.join(dir, ".gitignore"), "out/\n");
    await sleep(1200); // .gitignore itself is a change; list recomputes
    const before = changes.length;
    await fs.writeFile(path.join(dir, "out", "two.txt"), "2");
    await sleep(1000);
    expect(changes.length).toBe(before);
  });

  it("does not fire for .git-only activity (commit, stage, index.lock)", async () => {
    const dir = await makeRepo();
    await writeFile(dir, "new.txt", "n\n");
    const { changes } = await start(dir);
    await git(dir, ["add", "new.txt"]);
    await git(dir, ["commit", "-q", "-m", "second"]);
    await fs.writeFile(path.join(dir, ".git", "index.lock"), "");
    await fs.rm(path.join(dir, ".git", "index.lock"));
    await sleep(1000);
    expect(changes).toHaveLength(0);
  });

  it("never fires from our own --no-optional-locks reads, and leaves .git/index untouched (AC10)", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 40; i++) files[`f${i}.txt`] = `content ${i}\n`;
    const dir = await makeRepo(files);
    // Touch every tracked file without changing content: the index stat data is now stale, so a plain
    // `git status` would rewrite .git/index. Preserved bytes mean we are not doing that.
    await sleep(1100);
    for (let i = 0; i < 40; i++) await fs.writeFile(path.join(dir, `f${i}.txt`), `content ${i}\n`);
    await fs.writeFile(path.join(dir, "f0.txt"), "really modified\n");

    const indexPath = path.join(dir, ".git", "index");
    const bytesBefore = await fs.readFile(indexPath);
    const mtimeBefore = (await fs.stat(indexPath)).mtimeMs;

    const { changes } = await start(dir);
    const repo = await Repository.open(dir);
    await getWorkingDirectoryStatus(dir);
    await getWorkingDirectoryChanges(dir);
    await repo.getWorkingDirectoryStatus();
    await getFileDiff(dir, { kind: "unstaged", path: "f0.txt" });
    await sleep(1200);

    expect(changes).toHaveLength(0);
    expect(Buffer.compare(await fs.readFile(indexPath), bytesBefore)).toBe(0);
    expect((await fs.stat(indexPath)).mtimeMs).toBe(mtimeBefore);
  });

  it("close() stops notifications and a closed watcher can be closed again", async () => {
    const dir = await makeRepo();
    const { changes, watcher } = await start(dir);
    await fs.writeFile(path.join(dir, "a.txt"), "1\n");
    watcher.close();
    watcher.close();
    await sleep(700);
    expect(changes).toHaveLength(0);
    await fs.writeFile(path.join(dir, "a.txt"), "2\n");
    await sleep(500);
    expect(changes).toHaveLength(0);
  });

  it("signals 'degraded' (unsupported-platform) instead of watching on Linux", async () => {
    const dir = await makeRepo();
    const reasons: string[] = [];
    const watcher = watchWorktree(dir, () => reasons.push("change"), {
      platform: "linux",
      onDegraded: (r) => reasons.push(r),
    });
    watchers.push(watcher);
    await sleep(100);
    expect(reasons).toEqual(["unsupported-platform"]);
    expect(watcher.state).toBe("degraded");
    await fs.writeFile(path.join(dir, "a.txt"), "x\n");
    await sleep(400);
    expect(reasons).toEqual(["unsupported-platform"]);
  });

  it("signals 'degraded' (too-large) and does not watch when over the entry budget", async () => {
    const dir = await makeRepo();
    const events: string[] = [];
    const watcher = watchWorktree(dir, () => events.push("change"), {
      maxWatchedEntries: 1,
      debounceMs: 50,
      onDegraded: (r) => events.push(r),
    });
    watchers.push(watcher);
    await watcher.ready();
    await sleep(200);
    await fs.writeFile(path.join(dir, "a.txt"), "x\n");
    await sleep(600);
    expect(events).toEqual(["too-large"]);
  });

  it("is a no-op null for a bare repository and works through Repository", async () => {
    const bare = await initRepo({ bare: true });
    dirs.push(bare);
    expect((await Repository.open(bare)).watchForWorktreeChanges(() => {})).toBeNull();

    const dir = await makeRepo();
    const repo = await Repository.open(dir);
    const got: WorktreeChange[] = [];
    const w = repo.watchForWorktreeChanges((c) => got.push(c), { debounceMs: 60 })!;
    watchers.push(w);
    await w.ready();
    await sleep(300);
    await fs.writeFile(path.join(dir, "a.txt"), "z\n");
    expect(await waitUntil(() => got.length > 0)).toBe(true);
  });
});
