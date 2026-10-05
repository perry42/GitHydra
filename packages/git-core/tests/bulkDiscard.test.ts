// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { readFileSync } from "node:fs";
import { bulkDiscard, discardAllChanges, planDiscardAll, getBulkDiscardFingerprints, type BulkDiscardRow } from "../src/bulkDiscard";
import { _setDiscardAfterCheckHookForTests, BULK_DISCARD_CHUNK } from "../src/discardGuard";
import { InvalidArgumentError, StaleBatchError } from "../src/errors";
import { git, initRepo, writeFile, commit, cleanup, makeTempDir, fileExists } from "./testRepo";

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

async function rowsFor(d: string, specs: Array<[string, BulkDiscardRow["section"]]>): Promise<BulkDiscardRow[]> {
  const fps = await getBulkDiscardFingerprints(d, specs.map(([p, s]) => ({ path: p, section: s })));
  return fps.map((f) => {
    if ("error" in f) throw new Error(f.error);
    return f;
  });
}

async function seed(): Promise<string> {
  const d = await repo();
  for (let i = 0; i < 12; i++) await writeFile(d, `t${i}.txt`, `orig ${i}\n`);
  await writeFile(d, "keep.txt", "keep\n");
  await commit(d, "base");
  return d;
}

describe("bulkDiscard (FR-508, AC11)", () => {
  it("discards exactly the 20 listed tracked + untracked rows and nothing else", async () => {
    const d = await seed();
    const specs: Array<[string, BulkDiscardRow["section"]]> = [];
    for (let i = 0; i < 12; i++) {
      await writeFile(d, `t${i}.txt`, `edited ${i}\n`);
      specs.push([`t${i}.txt`, "unstaged"]);
    }
    for (let i = 0; i < 8; i++) {
      await writeFile(d, `new ${i}.txt`, "u");
      specs.push([`new ${i}.txt`, "untracked"]);
    }
    await writeFile(d, "keep.txt", "my edit\n");
    await writeFile(d, "untouched-untracked.txt", "u");
    const res = await bulkDiscard(d, await rowsFor(d, specs));
    expect(res.status).toBe("complete");
    expect(res.discarded.length).toBe(20);
    expect(res.backups.length).toBe(20);
    for (let i = 0; i < 12; i++) expect(await fs.readFile(path.join(d, `t${i}.txt`), "utf8")).toBe(`orig ${i}\n`);
    for (let i = 0; i < 8; i++) expect(await fileExists(path.join(d, `new ${i}.txt`))).toBe(false);
    expect(await fs.readFile(path.join(d, "keep.txt"), "utf8")).toBe("my edit\n");
    expect(await fileExists(path.join(d, "untouched-untracked.txt"))).toBe(true);
  });

  it("one stale fingerprint refuses the whole batch with STALE_DIFF naming the path; nothing changes", async () => {
    const d = await seed();
    await writeFile(d, "t0.txt", "edited 0\n");
    await writeFile(d, "t1.txt", "edited 1\n");
    await writeFile(d, "new.txt", "u");
    const rows = await rowsFor(d, [["t0.txt", "unstaged"], ["t1.txt", "unstaged"], ["new.txt", "untracked"]]);
    await writeFile(d, "t1.txt", "edited externally after the dialog opened\n");
    let err: unknown;
    try {
      await bulkDiscard(d, rows);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(StaleBatchError);
    expect((err as StaleBatchError).code).toBe("STALE_DIFF");
    expect((err as StaleBatchError).paths).toEqual(["t1.txt"]);
    expect((err as Error).message).toContain("t1.txt");
    expect(await fs.readFile(path.join(d, "t0.txt"), "utf8")).toBe("edited 0\n");
    expect(await fs.readFile(path.join(d, "t1.txt"), "utf8")).toBe("edited externally after the dialog opened\n");
    expect(await fileExists(path.join(d, "new.txt"))).toBe(true);
  });

  it("a row that moved category since the confirmation (externally staged) is stale", async () => {
    const d = await seed();
    await writeFile(d, "t0.txt", "edited 0\n");
    const rows = await rowsFor(d, [["t0.txt", "unstaged"]]);
    await git(d, ["add", "t0.txt"]);
    await expect(bulkDiscard(d, rows)).rejects.toBeInstanceOf(StaleBatchError);
    expect(await fs.readFile(path.join(d, "t0.txt"), "utf8")).toBe("edited 0\n");
  });

  it("no bulk path discards without a fingerprint: missing or empty fingerprints throw before anything runs", async () => {
    const d = await seed();
    await writeFile(d, "t0.txt", "edited 0\n");
    await writeFile(d, "new.txt", "u");
    const noFp = [{ path: "t0.txt", section: "unstaged" }] as unknown as BulkDiscardRow[];
    await expect(bulkDiscard(d, noFp)).rejects.toBeInstanceOf(InvalidArgumentError);
    await expect(bulkDiscard(d, [{ path: "t0.txt", section: "unstaged", expectedFingerprint: "" }])).rejects.toBeInstanceOf(InvalidArgumentError);
    await expect(discardAllChanges(d, { rows: noFp, includeUntracked: true })).rejects.toBeInstanceOf(InvalidArgumentError);
    // A good row next to a bad one: the bad one still blocks the entire call.
    const good = await rowsFor(d, [["new.txt", "untracked"]]);
    await expect(bulkDiscard(d, [...good, ...noFp])).rejects.toBeInstanceOf(InvalidArgumentError);
    expect(await fs.readFile(path.join(d, "t0.txt"), "utf8")).toBe("edited 0\n");
    expect(await fileExists(path.join(d, "new.txt"))).toBe(true);
  });

  it("source never runs git clean / checkout / reset for discards", () => {
    const src = readFileSync(path.join(__dirname, "..", "src", "bulkDiscard.ts"), "utf8");
    expect(src).not.toMatch(/["']clean["']/);
    expect(src).not.toMatch(/["']checkout["']/);
    expect(src).not.toMatch(/["']reset["']/);
    expect(src).not.toMatch(/\brunGit\b/);
  });

  it("skips directories and symlinked-parent rows with a reason; the rest proceed", async () => {
    const d = await seed();
    await writeFile(d, "t0.txt", "edited 0\n");
    const outside = await makeTempDir();
    dirs.push(outside);
    await writeFile(outside, "f.txt", "x");
    let linked = true;
    try {
      await fs.symlink(outside, path.join(d, "lnk"), "junction");
    } catch {
      linked = false;
    }
    await fs.mkdir(path.join(d, "somedir"));
    const good = await rowsFor(d, [["t0.txt", "unstaged"]]);
    const extra: BulkDiscardRow[] = [
      { path: "somedir", section: "untracked", expectedFingerprint: "x" },
      { path: "nested/", section: "untracked", expectedFingerprint: "x" },
    ];
    if (linked) extra.push({ path: "lnk/f.txt", section: "untracked", expectedFingerprint: "x" });
    const res = await bulkDiscard(d, [...good, ...extra]);
    expect(res.discarded).toEqual(["t0.txt"]);
    expect(res.skipped.map((s) => s.path).sort()).toEqual(extra.map((e) => e.path).sort());
    expect(res.skipped.every((s) => s.reason.length > 0)).toBe(true);
    if (linked) expect(await fileExists(path.join(outside, "f.txt"))).toBe(true);
  });

  it("a restore that fails reports nothing discarded and every row not attempted; the files stay as they were", async () => {
    const d = await seed();
    for (let i = 0; i < 3; i++) await writeFile(d, `t${i}.txt`, `edited ${i}\n`);
    const rows = await rowsFor(d, [["t0.txt", "unstaged"], ["t1.txt", "unstaged"], ["t2.txt", "unstaged"]]);
    let calls = 0;
    _setDiscardAfterCheckHookForTests(async () => {
      // Lock the index just before the chunk's `git restore` so it fails.
      if (++calls === 2) await fs.writeFile(path.join(d, ".git", "index.lock"), "");
    });
    const res = await bulkDiscard(d, rows);
    await fs.rm(path.join(d, ".git", "index.lock"), { force: true });
    expect(res.status).toBe("partial");
    expect(res.discarded).toEqual([]);
    expect(res.failed?.path).toBe("t0.txt");
    expect(res.notAttempted).toEqual(["t1.txt", "t2.txt"]);
    for (let i = 0; i < 3; i++) expect(await fs.readFile(path.join(d, `t${i}.txt`), "utf8")).toBe(`edited ${i}\n`);
  });

  it("a failure in a later chunk keeps the earlier chunk discarded and reports the rest as not attempted", async () => {
    const d = await repo();
    const n = BULK_DISCARD_CHUNK + 5;
    for (let i = 0; i < n; i++) await writeFile(d, `f${String(i).padStart(2, "0")}.txt`, `orig ${i}\n`);
    await commit(d, "base");
    const specs: Array<[string, BulkDiscardRow["section"]]> = [];
    for (let i = 0; i < n; i++) {
      const name = `f${String(i).padStart(2, "0")}.txt`;
      await writeFile(d, name, `edited ${i}\n`);
      specs.push([name, "unstaged"]);
    }
    const rows = await rowsFor(d, specs);
    let calls = 0;
    _setDiscardAfterCheckHookForTests(async () => {
      if (++calls === BULK_DISCARD_CHUNK + 1) await fs.writeFile(path.join(d, ".git", "index.lock"), "");
    });
    const res = await bulkDiscard(d, rows);
    await fs.rm(path.join(d, ".git", "index.lock"), { force: true });
    expect(res.status).toBe("partial");
    expect(res.discarded.length).toBe(BULK_DISCARD_CHUNK);
    expect(res.failed?.path).toBe(`f${BULK_DISCARD_CHUNK}.txt`);
    expect(res.notAttempted.length).toBe(4);
    expect(await fs.readFile(path.join(d, "f00.txt"), "utf8")).toBe("orig 0\n");
    expect(await fs.readFile(path.join(d, `f${BULK_DISCARD_CHUNK}.txt`), "utf8")).toBe(`edited ${BULK_DISCARD_CHUNK}\n`);
  });

  it("a file edited after the safety copy but before the restore is refused and left alone", async () => {
    const d = await seed();
    for (let i = 0; i < 3; i++) await writeFile(d, `t${i}.txt`, `edited ${i}\n`);
    const rows = await rowsFor(d, [["t0.txt", "unstaged"], ["t1.txt", "unstaged"], ["t2.txt", "unstaged"]]);
    let calls = 0;
    _setDiscardAfterCheckHookForTests(async () => {
      if (++calls === 3) await fs.writeFile(path.join(d, "t1.txt"), "edited in the race window\n");
    });
    const res = await bulkDiscard(d, rows);
    expect(res.status).toBe("partial");
    expect(res.failed).toMatchObject({ path: "t1.txt", code: "STALE_DIFF" });
    expect(await fs.readFile(path.join(d, "t1.txt"), "utf8")).toBe("edited in the race window\n");
    // Rows before the changed one are still discarded; the changed one and everything after are not touched.
    expect(res.discarded).toEqual(["t0.txt"]);
    expect(res.notAttempted).toEqual(["t2.txt"]);
    expect(await fs.readFile(path.join(d, "t0.txt"), "utf8")).toBe("orig 0\n");
    expect(await fs.readFile(path.join(d, "t2.txt"), "utf8")).toBe("edited 2\n");
  });

  it("a mixed row loses only its unstaged part", async () => {
    const d = await seed();
    await writeFile(d, "t0.txt", "staged\n");
    await git(d, ["add", "t0.txt"]);
    await writeFile(d, "t0.txt", "unstaged\n");
    await bulkDiscard(d, await rowsFor(d, [["t0.txt", "mixed"]]));
    expect(await fs.readFile(path.join(d, "t0.txt"), "utf8")).toBe("staged\n");
    expect((await git(d, ["status", "--porcelain=v1"])).stdout).toBe("M  t0.txt\n");
  });
});

describe("planDiscardAll / discardAllChanges (FR-509, AC12)", () => {
  it("plans counts, leaves untracked alone unless flagged, keeps staged content, never touches rows outside the snapshot", async () => {
    const d = await seed();
    await writeFile(d, "t0.txt", "edited 0\n");
    await writeFile(d, "t1.txt", "staged 1\n");
    await git(d, ["add", "t1.txt"]);
    await writeFile(d, "t1.txt", "unstaged 1\n");
    await writeFile(d, "t2.txt", "staged only\n");
    await git(d, ["add", "t2.txt"]);
    await writeFile(d, "u1.txt", "u");
    await writeFile(d, "u2.txt", "u");

    const plan = await planDiscardAll(d);
    expect(plan.counts).toEqual({ trackedReset: 2, untrackedDeleted: 2 });
    expect(plan.tracked.map((r) => r.section).sort()).toEqual(["mixed", "unstaged"]);

    await writeFile(d, "late-untracked.txt", "u");
    const res = await discardAllChanges(d, { rows: [...plan.tracked, ...plan.untracked], includeUntracked: false });
    expect(res.status).toBe("complete");
    expect(res.skipped.map((s) => s.path).sort()).toEqual(["u1.txt", "u2.txt"]);
    expect(await fs.readFile(path.join(d, "t0.txt"), "utf8")).toBe("orig 0\n");
    expect(await fs.readFile(path.join(d, "t1.txt"), "utf8")).toBe("staged 1\n");
    expect(await fs.readFile(path.join(d, "t2.txt"), "utf8")).toBe("staged only\n");
    expect(await fileExists(path.join(d, "u1.txt"))).toBe(true);
    expect(await fileExists(path.join(d, "late-untracked.txt"))).toBe(true);
    expect((await git(d, ["status", "--porcelain=v1"])).stdout).toContain("M  t1.txt");

    const res2 = await discardAllChanges(d, { rows: plan.untracked, includeUntracked: true });
    expect(res2.discarded.sort()).toEqual(["u1.txt", "u2.txt"]);
    expect(await fileExists(path.join(d, "late-untracked.txt"))).toBe(true);
  });

  it("a file edited after the plan was taken refuses the whole discard-all", async () => {
    const d = await seed();
    await writeFile(d, "t0.txt", "edited 0\n");
    await writeFile(d, "t1.txt", "edited 1\n");
    const plan = await planDiscardAll(d);
    await writeFile(d, "t1.txt", "edited again\n");
    await expect(discardAllChanges(d, { rows: plan.tracked, includeUntracked: false })).rejects.toBeInstanceOf(StaleBatchError);
    expect(await fs.readFile(path.join(d, "t0.txt"), "utf8")).toBe("edited 0\n");
  });

  it("skips conflicted paths and nested repositories in the plan", async () => {
    const d = await repo();
    await writeFile(d, "c.txt", "base\n");
    await commit(d, "base");
    await git(d, ["checkout", "-q", "-b", "other"]);
    await writeFile(d, "c.txt", "other\n");
    await commit(d, "other");
    await git(d, ["checkout", "-q", "main"]);
    await writeFile(d, "c.txt", "main\n");
    await commit(d, "main");
    await git(d, ["merge", "other"]).catch(() => {});
    const nested = path.join(d, "nested");
    await fs.mkdir(nested);
    await git(nested, ["init", "-q"]);
    await writeFile(nested, "f.txt", "x");
    await git(nested, ["add", "."]);
    await git(nested, ["commit", "-q", "-m", "x"]);
    const plan = await planDiscardAll(d);
    expect(plan.counts).toEqual({ trackedReset: 0, untrackedDeleted: 0 });
    expect(plan.skipped.map((s) => s.path).sort()).toEqual(["c.txt", "nested/"]);
  });
});
