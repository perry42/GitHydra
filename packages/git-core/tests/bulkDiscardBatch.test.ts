// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { bulkDiscard, discardAllChanges, planDiscardAll, getBulkDiscardFingerprints } from "../src/bulkDiscard";
import { getDiscardFingerprint, getDiscardFingerprints } from "../src/discardGuard";
import { BULK_DISCARD_ROW_LIMIT, STALE_BATCH_PATH_LIMIT, StaleBatchError, TooManyFilesError } from "../src/errors";
import { _getSpawnCountForTests } from "../src/gitProcess";
import { git, initRepo, writeFile, commit, cleanup, fileExists } from "./testRepo";

const LF = String.fromCharCode(10);
const CRLF = String.fromCharCode(13, 10);
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

describe("batched fingerprints equal the one-file fingerprints", () => {
  it("tracked, mixed, untracked, deleted, nested and glob-named files all agree", async () => {
    const d = await repo();
    for (const p of ["a.txt", "dir/b.txt", "[x].txt", "unié.txt", "del.txt", "mix.txt"]) await writeFile(d, p, `orig ${p}\n`);
    await commit(d, "base");
    await writeFile(d, "a.txt", "edit\n");
    await writeFile(d, "dir/b.txt", "edit\n");
    await writeFile(d, "[x].txt", "edit\n");
    await writeFile(d, "unié.txt", "edit\n");
    await fs.rm(path.join(d, "del.txt"));
    await writeFile(d, "mix.txt", "staged\n");
    await git(d, ["add", "mix.txt"]);
    await writeFile(d, "mix.txt", "staged then edited\n");
    await writeFile(d, "new.txt", "u");
    await writeFile(d, "newdir/n.txt", "u");

    const items = [
      ...["a.txt", "dir/b.txt", "[x].txt", "unié.txt", "del.txt", "mix.txt"].map((p) => ({ path: p, kind: "tracked" as const })),
      { path: "new.txt", kind: "untracked" as const },
      { path: "newdir/n.txt", kind: "untracked" as const },
    ];
    const batch = await getDiscardFingerprints(d, items);
    for (const it of items) {
      const o = batch.get(it.path)!;
      expect(o.ok).toBe(true);
      expect(o.ok && o.fingerprint).toBe(await getDiscardFingerprint(d, it.path, it.kind));
    }
  });

  it("agrees on an unborn HEAD", async () => {
    const d = await repo();
    await writeFile(d, "s.txt", "staged\n");
    await git(d, ["add", "s.txt"]);
    await writeFile(d, "u.txt", "u");
    const items = [
      { path: "s.txt", kind: "tracked" as const },
      { path: "u.txt", kind: "untracked" as const },
    ];
    const batch = await getDiscardFingerprints(d, items);
    for (const it of items) {
      const o = batch.get(it.path)!;
      expect(o.ok && o.fingerprint).toBe(await getDiscardFingerprint(d, it.path, it.kind));
    }
  });

  it("reports an unsafe row without failing the others", async () => {
    const d = await repo();
    await writeFile(d, "ok.txt", "x");
    await commit(d, "base");
    await writeFile(d, "ok.txt", "y");
    const r = await getBulkDiscardFingerprints(d, [
      { path: "ok.txt", section: "unstaged" },
      { path: "../escape.txt", section: "unstaged" },
    ]);
    expect("expectedFingerprint" in r[0]!).toBe(true);
    expect("error" in r[1]!).toBe(true);
  });
});

describe("bulk discard cost and limits", () => {
  it("22 files: spawn count stays flat per file and every file is discarded", async () => {
    const d = await repo();
    for (let i = 0; i < 12; i++) await writeFile(d, `t${i}.txt`, `orig ${i}\n`);
    await commit(d, "base");
    for (let i = 0; i < 12; i++) await writeFile(d, `t${i}.txt`, `edited ${i}\n`);
    for (let i = 0; i < 10; i++) await writeFile(d, `u${i}.txt`, "u");

    const t0 = Date.now();
    const s0 = _getSpawnCountForTests();
    const plan = await planDiscardAll(d);
    const planSpawns = _getSpawnCountForTests() - s0;
    const res = await discardAllChanges(d, { rows: [...plan.tracked, ...plan.untracked], includeUntracked: true });
    const total = _getSpawnCountForTests() - s0;
    const ms = Date.now() - t0;
    console.log(`discard-all of 22 files: ${ms} ms, ${planSpawns} spawns planning, ${total} spawns total`);

    expect(res.status).toBe("complete");
    expect(res.discarded.length).toBe(22);
    expect(await fileExists(path.join(d, "u0.txt"))).toBe(false);
    // status + 2x(ls-files + ls-tree) for the plan; the guarded pass is ~2 per file (backup + restore) plus a few batched refreshes.
    expect(planSpawns).toBeLessThanOrEqual(8);
    expect(total).toBeLessThanOrEqual(30);
  });

  it("rejects more than the row limit with TooManyFilesError before reading anything", async () => {
    const d = await repo();
    const rows = Array.from({ length: BULK_DISCARD_ROW_LIMIT + 1 }, (_, i) => ({ path: `f${i}.txt`, section: "unstaged" as const, expectedFingerprint: "x" }));
    const before = _getSpawnCountForTests();
    await expect(bulkDiscard(d, rows)).rejects.toBeInstanceOf(TooManyFilesError);
    await expect(discardAllChanges(d, { rows, includeUntracked: true })).rejects.toMatchObject({ code: "TOO_MANY_FILES", limit: BULK_DISCARD_ROW_LIMIT });
    await expect(getBulkDiscardFingerprints(d, rows)).rejects.toBeInstanceOf(TooManyFilesError);
    expect(_getSpawnCountForTests()).toBe(before);
  });

  it("StaleBatchError bounds its paths and message", () => {
    const all = Array.from({ length: 50 }, (_, i) => `p${i}.txt`);
    const e = new StaleBatchError(all);
    expect(e.paths.length).toBe(STALE_BATCH_PATH_LIMIT);
    expect(e.totalCount).toBe(50);
    expect(e.message).toContain("and 30 more");
    expect(e.message).not.toContain("p49.txt");
    expect(e.code).toBe("STALE_DIFF");
    expect(new StaleBatchError(["only.txt"]).message).not.toContain("more");
  });

  it("a stale batch (changed after planning) still changes nothing", async () => {
    const d = await repo();
    for (let i = 0; i < 5; i++) await writeFile(d, `t${i}.txt`, `orig ${i}\n`);
    await commit(d, "base");
    for (let i = 0; i < 5; i++) await writeFile(d, `t${i}.txt`, `edited ${i}\n`);
    const plan = await planDiscardAll(d);
    await writeFile(d, "t3.txt", "changed behind the dialog\n");
    await expect(discardAllChanges(d, { rows: plan.tracked, includeUntracked: false })).rejects.toBeInstanceOf(StaleBatchError);
    for (let i = 0; i < 5; i++) expect(await fs.readFile(path.join(d, `t${i}.txt`), "utf8")).toBe(i === 3 ? "changed behind the dialog\n" : `edited ${i}\n`);
  });
});

describe("batched safety copies", () => {
  it("each backup blob holds the exact pre-discard bytes (no autocrlf rewrite), for odd names and untracked files", async () => {
    const d = await repo();
    await git(d, ["config", "core.autocrlf", "true"]);
    const names = ["sp ace.txt", "unié 中.txt", "[g].txt", "-dash.txt"];
    for (const n of names) await writeFile(d, n, "orig" + LF);
    await commit(d, "base");
    const edited = "line1" + CRLF + "line2" + CRLF;
    for (const n of names) await fs.writeFile(path.join(d, n), edited + n);
    await fs.writeFile(path.join(d, "fresh.txt"), "untracked" + CRLF);
    const plan = await planDiscardAll(d);
    const res = await discardAllChanges(d, { rows: [...plan.tracked, ...plan.untracked], includeUntracked: true });
    expect(res.status).toBe("complete");
    expect(res.backups.length).toBe(names.length + 1);
    for (const b of res.backups) {
      expect(b.backup.oid).toMatch(/^[0-9a-f]{40,64}$/);
      const blob = (await git(d, ["cat-file", "blob", b.backup.oid!])).stdout;
      expect(blob).toBe(b.path === "fresh.txt" ? "untracked" + CRLF : edited + b.path);
    }
  });
});
