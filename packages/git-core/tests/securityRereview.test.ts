// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { guardedBulkDiscard, guardedUnlinkUntracked, getDiscardFingerprint, _setDiscardAfterCheckHookForTests } from "../src/discardGuard";
import { bulkDiscard } from "../src/bulkDiscard";
import { planIgnore, ignorePaths, ignoreAndStopTracking } from "../src/ignore";
import { stagePaths, unstagePaths } from "../src/bulkStaging";
import { BULK_STAGE_ROW_LIMIT, IGNORE_ROW_LIMIT, InvalidArgumentError, StaleDiffError, TooManyFilesError } from "../src/errors";
import { git, initRepo, writeFile, commit, cleanup, fileExists } from "./testRepo";

const dirs: string[] = [];
afterEach(async () => {
  _setDiscardAfterCheckHookForTests(null);
  while (dirs.length) await cleanup(dirs.pop()!);
});

async function repo(): Promise<string> {
  const d = await initRepo();
  dirs.push(d);
  await git(d, ["config", "core.autocrlf", "false"]);
  return d;
}

async function trackedEdited(d: string, n: number): Promise<{ path: string; kind: "tracked"; expectedFingerprint: string }[]> {
  for (let i = 0; i < n; i++) await writeFile(d, `t${i}.txt`, `orig ${i}\n`);
  await commit(d, "base");
  for (let i = 0; i < n; i++) await writeFile(d, `t${i}.txt`, `edited ${i}\n`);
  return Promise.all(Array.from({ length: n }, async (_, i) => ({ path: `t${i}.txt`, kind: "tracked" as const, expectedFingerprint: await getDiscardFingerprint(d, `t${i}.txt`, "tracked") })));
}

describe("M1/L1: re-read per sub-batch, git side compared with the first read", () => {
  it("a change landing after the safety copy stops at that row; earlier sub-batches are discarded, the failed row keeps its edit and has no reported backup", async () => {
    const d = await repo();
    const rows = await trackedEdited(d, 12);
    let fired = false;
    _setDiscardAfterCheckHookForTests(async () => {
      if (fired) return;
      fired = true;
      await writeFile(d, "t11.txt", "changed behind our back\n");
    });
    const res = await guardedBulkDiscard(d, rows);
    expect(res.failed?.path).toBe("t11.txt");
    expect(res.failed?.error).toBeInstanceOf(StaleDiffError);
    expect(res.discarded.length).toBe(11);
    expect(await fs.readFile(path.join(d, "t11.txt"), "utf8")).toBe("changed behind our back\n");
    expect(await fs.readFile(path.join(d, "t0.txt"), "utf8")).toBe("orig 0\n");
    expect(res.backups.map((b) => b.path)).not.toContain("t11.txt");
    expect(res.backups.length).toBe(11);
  });

  it("an index change between the first and second git-side read is treated as stale and nothing in that sub-batch is discarded", async () => {
    const d = await repo();
    const rows = await trackedEdited(d, 3);
    let fired = false;
    _setDiscardAfterCheckHookForTests(async () => {
      if (fired) return;
      fired = true;
      await git(d, ["add", "t1.txt"]);
    });
    const res = await guardedBulkDiscard(d, rows);
    expect(res.failed?.error).toBeInstanceOf(StaleDiffError);
    expect(res.discarded).toEqual([]);
    for (let i = 0; i < 3; i++) expect(await fs.readFile(path.join(d, `t${i}.txt`), "utf8")).toBe(`edited ${i}\n`);
  });
});

describe("L4/L5: backups and untracked outcomes", () => {
  it("an untracked row git no longer lists is skipped, left on disk and not counted as discarded", async () => {
    const d = await repo();
    await writeFile(d, "base.txt", "b");
    await commit(d, "base");
    await writeFile(d, "u.txt", "u");
    const fp = await getDiscardFingerprint(d, "u.txt", "untracked");
    await writeFile(d, ".gitignore", "u.txt\n");
    const res = await guardedBulkDiscard(d, [{ path: "u.txt", kind: "untracked", expectedFingerprint: fp }]);
    expect(res.discarded).toEqual([]);
    expect(res.skipped).toEqual(["u.txt"]);
    expect(res.failed).toBeNull();
    expect(await fileExists(path.join(d, "u.txt"))).toBe(true);
  });

  it("a worktree symlink is never followed for the safety copy", async () => {
    const d = await repo();
    await writeFile(d, "l.txt", "orig\n");
    await commit(d, "base");
    const outside = path.join(d, "..", `outside-${path.basename(d)}.txt`);
    await fs.writeFile(outside, "secret");
    try {
      await fs.rm(path.join(d, "l.txt"));
      try {
        await fs.symlink(outside, path.join(d, "l.txt"));
      } catch {
        return; // symlinks unavailable on this machine
      }
      const fp = await getDiscardFingerprint(d, "l.txt", "tracked");
      const res = await guardedBulkDiscard(d, [{ path: "l.txt", kind: "tracked", expectedFingerprint: fp }]);
      expect(res.discarded).toEqual(["l.txt"]);
      expect(res.backups[0]!.backup).toEqual({ oid: null, skipped: "not-a-regular-file" });
      expect(await fs.readFile(outside, "utf8")).toBe("secret");
      expect(await fs.readFile(path.join(d, "l.txt"), "utf8")).toBe("orig\n");
    } finally {
      await fs.rm(outside, { force: true });
    }
  });

  it("an untracked file behind a parent folder swapped for a link is never unlinked through it", async () => {
    const d = await repo();
    await writeFile(d, "base.txt", "b");
    await commit(d, "base");
    await writeFile(d, "sub/u.txt", "u");
    const fp = await getDiscardFingerprint(d, "sub/u.txt", "untracked");
    _setDiscardAfterCheckHookForTests(async () => {
      await fs.rename(path.join(d, "sub"), path.join(d, "sub_real"));
      await fs.symlink(path.join(d, "sub_real"), path.join(d, "sub"), "junction");
    });
    await guardedUnlinkUntracked(d, "sub/u.txt", { expectedFingerprint: fp }).catch(() => {});
    expect(await fs.readFile(path.join(d, "sub_real", "u.txt"), "utf8")).toBe("u");
  });
});

describe("L7: failure text carries no absolute paths", () => {
  it("a non-errno failure is reported generically", async () => {
    const d = await repo();
    const rows = await trackedEdited(d, 2);
    _setDiscardAfterCheckHookForTests(async () => {
      throw new Error(`boom at ${d}`);
    });
    const res = await bulkDiscard(d, rows.map((r) => ({ path: r.path, section: "unstaged" as const, expectedFingerprint: r.expectedFingerprint })));
    expect(res.failed).not.toBeNull();
    expect(res.failed!.message).not.toContain(d);
    expect(res.failed!.message).toContain("t0.txt");
    for (let i = 0; i < 2; i++) expect(await fs.readFile(path.join(d, `t${i}.txt`), "utf8")).toBe(`edited ${i}\n`);
  });
});

describe("L8 and required confirmation", () => {
  it("ignore analysis refuses more than IGNORE_ROW_LIMIT paths before reading anything", async () => {
    const d = await repo();
    const paths = Array.from({ length: IGNORE_ROW_LIMIT + 1 }, (_, i) => `f${i}.txt`);
    await expect(planIgnore(d, { paths, scope: "name", target: "root" })).rejects.toBeInstanceOf(TooManyFilesError);
    await expect(ignorePaths(d, { paths, scope: "name", target: "root" })).rejects.toMatchObject({ code: "TOO_MANY_FILES", limit: IGNORE_ROW_LIMIT });
  });

  it("stage/unstage are bounded too", async () => {
    const d = await repo();
    const rows = Array.from({ length: BULK_STAGE_ROW_LIMIT + 1 }, (_, i) => ({ path: `f${i}.txt`, section: "unstaged" as const }));
    await expect(stagePaths(d, rows)).rejects.toBeInstanceOf(TooManyFilesError);
    await expect(unstagePaths(d, rows.map((r) => ({ ...r, section: "staged" as const })))).rejects.toBeInstanceOf(TooManyFilesError);
  });

  it("ignoreAndStopTracking and ignorePaths(stopTracking) throw without expectedUntrackPaths and change nothing", async () => {
    const d = await repo();
    await writeFile(d, "t.log", "1");
    await commit(d, "base");
    await expect(ignoreAndStopTracking(d, { paths: ["t.log"], scope: "name", target: "root" })).rejects.toBeInstanceOf(InvalidArgumentError);
    await expect(ignorePaths(d, { paths: ["t.log"], scope: "name", target: "root", stopTracking: true })).rejects.toBeInstanceOf(InvalidArgumentError);
    expect(await fileExists(path.join(d, ".gitignore"))).toBe(false);
    expect((await git(d, ["ls-files"])).stdout).toContain("t.log");
  });
});
