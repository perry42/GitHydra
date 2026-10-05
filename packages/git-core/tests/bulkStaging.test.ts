// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { stagePaths, unstagePaths, type BulkRow } from "../src/bulkStaging";
import { batchArgs } from "../src/argvBatch";
import { BulkStagingError } from "../src/errors";
import { _enqueueGitTaskForTests, _getSpawnCountForTests } from "../src/gitProcess";
import { git, initRepo, writeFile, commit, cleanup } from "./testRepo";

const dirs: string[] = [];
afterEach(async () => {
  while (dirs.length) await cleanup(dirs.pop()!);
});

async function repo(): Promise<string> {
  const d = await initRepo();
  dirs.push(d);
  await git(d, ["config", "core.autocrlf", "false"]);
  return d;
}

async function porcelain(d: string): Promise<string[]> {
  const { stdout } = await git(d, ["status", "--porcelain=v1", "--untracked-files=all", "-z"]);
  return stdout.split("\0").filter(Boolean).sort();
}

const win = process.platform === "win32";

describe("batchArgs", () => {
  it("splits under the budget and never drops or reorders items", () => {
    const items = Array.from({ length: 2000 }, (_, i) => `dir/some long file name ${i}.txt`);
    const batches = batchArgs(items);
    expect(batches.length).toBeGreaterThan(1);
    expect(batches.flat()).toEqual(items);
    for (const b of batches) expect(b.join(" ").length).toBeLessThan(16_000);
  });
  it("gives an oversized single item its own batch", () => {
    expect(batchArgs(["a", "x".repeat(20_000), "b"])).toEqual([["a"], ["x".repeat(20_000)], ["b"]]);
  });
});

describe("stagePaths / unstagePaths (FR-506, FR-507)", () => {
  it("stages 500 mixed-name rows in few git invocations and status matches git (AC10)", async () => {
    const d = await repo();
    await writeFile(d, "base.txt", "b");
    await commit(d, "base");
    const rows: BulkRow[] = [];
    for (let i = 0; i < 500; i++) {
      const name = [`plain ${i}.txt`, `héllo wörld ${i}.txt`, `[g${i}].txt`, `dir with space/sub ${i}/f.txt`, `日本-${i}.md`][i % 5]!;
      await writeFile(d, name, String(i));
      rows.push({ path: name, section: "untracked" });
    }
    const spawnsBefore = _getSpawnCountForTests();
    const res = await stagePaths(d, rows);
    // 1 status before, <=a few add batches, 1 status after: never one spawn per file.
    expect(_getSpawnCountForTests() - spawnsBefore).toBeLessThan(15);
    expect(res.changed.length).toBe(500);
    expect(res.unchanged).toEqual([]);
    const st = await porcelain(d);
    expect(st.length).toBe(500);
    expect(st.every((l) => l.startsWith("A  "))).toBe(true);
  });

  it("treats glob-looking names literally: staging [ab].txt never stages a.txt", async () => {
    const d = await repo();
    await writeFile(d, "base.txt", "b");
    await commit(d, "base");
    await writeFile(d, "[ab].txt", "1");
    await writeFile(d, "a.txt", "2");
    await stagePaths(d, [{ path: "[ab].txt", section: "untracked" }]);
    expect(await porcelain(d)).toEqual(["?? a.txt", "A  [ab].txt"]);
    if (!win) {
      await writeFile(d, "*.md", "3");
      await writeFile(d, "z.md", "4");
      await stagePaths(d, [{ path: "*.md", section: "untracked" }]);
      expect(await porcelain(d)).toContain("?? z.md");
    }
  });

  it("reports ineligible rows with reasons and never touches them (FR-506)", async () => {
    const d = await repo();
    await writeFile(d, "c.txt", "base\n");
    await writeFile(d, "s.txt", "s\n");
    await commit(d, "base");
    await git(d, ["checkout", "-q", "-b", "other"]);
    await writeFile(d, "c.txt", "other\n");
    await commit(d, "other");
    await git(d, ["checkout", "-q", "main"]);
    await writeFile(d, "c.txt", "main\n");
    await commit(d, "main");
    await git(d, ["merge", "other"]).catch(() => {});
    await writeFile(d, "s.txt", "edited\n");
    await writeFile(d, "u.txt", "u\n");
    const res = await stagePaths(d, [
      { path: "c.txt", section: "unstaged" },
      { path: "s.txt", section: "staged" },
      { path: "gone.txt", section: "unstaged" },
      { path: "u.txt", section: "untracked" },
    ]);
    expect(res.changed).toEqual(["u.txt"]);
    expect(res.skipped.map((s) => s.path).sort()).toEqual(["c.txt", "gone.txt", "s.txt"]);
    expect((await porcelain(d)).some((l) => l.startsWith(" M s.txt"))).toBe(true);
  });

  it("a mixed row stages the whole file; unstage acts on the staged row only", async () => {
    const d = await repo();
    await writeFile(d, "m.txt", "1\n");
    await commit(d, "base");
    await writeFile(d, "m.txt", "2\n");
    await git(d, ["add", "m.txt"]);
    await writeFile(d, "m.txt", "3\n");
    const un = await unstagePaths(d, [{ path: "m.txt", section: "mixed" }]);
    expect(un.skipped.length).toBe(1);
    expect(un.changed).toEqual([]);
    const st = await stagePaths(d, [{ path: "m.txt", section: "mixed" }]);
    expect(st.changed).toEqual(["m.txt"]);
    expect(await porcelain(d)).toEqual(["M  m.txt"]);
  });

  it("unstages a staged rename as a pair, and works on an unborn HEAD", async () => {
    const d = await repo();
    await writeFile(d, "old.txt", "keep me\nmore lines\neven more\nand more\n");
    await commit(d, "base");
    await git(d, ["mv", "old.txt", "new.txt"]);
    const res = await unstagePaths(d, [{ path: "new.txt", section: "staged" }]);
    expect(res.changed).toEqual(["new.txt"]);
    expect(await porcelain(d)).toEqual([" D old.txt", "?? new.txt"]);

    const fresh = await repo();
    await writeFile(fresh, "a.txt", "a");
    await git(fresh, ["add", "a.txt"]);
    const r2 = await unstagePaths(fresh, [{ path: "a.txt", section: "staged" }]);
    expect(r2.changed).toEqual(["a.txt"]);
    expect(await porcelain(fresh)).toEqual(["?? a.txt"]);
    expect(await fs.readFile(path.join(fresh, "a.txt"), "utf8")).toBe("a");
  });

  it("a git failure throws BulkStagingError listing what did not change", async () => {
    const d = await repo();
    await writeFile(d, "base.txt", "b");
    await commit(d, "base");
    await writeFile(d, "a.txt", "1");
    await writeFile(d, "b.txt", "2");
    await fs.writeFile(path.join(d, ".git", "index.lock"), "");
    let err: unknown;
    try {
      await stagePaths(d, [
        { path: "a.txt", section: "untracked" },
        { path: "b.txt", section: "untracked" },
      ]);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(BulkStagingError);
    expect((err as BulkStagingError).unchanged.sort()).toEqual(["a.txt", "b.txt"]);
    expect((err as BulkStagingError).changed).toEqual([]);
  });

  it("runs as one mutation-queue entry (waits behind a queued mutation)", async () => {
    const d = await repo();
    await writeFile(d, "base.txt", "b");
    await commit(d, "base");
    await writeFile(d, "q.txt", "q");
    let release!: () => void;
    const blocker = _enqueueGitTaskForTests(() => new Promise<void>((r) => (release = r)));
    let done = false;
    const p = stagePaths(d, [{ path: "q.txt", section: "untracked" }]).then(() => (done = true));
    await new Promise((r) => setTimeout(r, 300));
    expect(done).toBe(false);
    release();
    await blocker;
    await p;
    expect(done).toBe(true);
  });
});
