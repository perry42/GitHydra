// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getDiscardPreview, DISCARD_PREVIEW_ROW_LIMIT } from "../src/discardPreview";
import { TooManyFilesError } from "../src/errors";
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
const byPath = (rows: Awaited<ReturnType<typeof getDiscardPreview>>) => Object.fromEntries(rows.map((r) => [r.path, r]));

describe("getDiscardPreview (FR-521)", () => {
  it("counts +/- for modified and deleted files, marks binary, and never reads untracked files", async () => {
    const d = await repo();
    await writeFile(d, "m.txt", "a\nb\nc\n");
    await writeFile(d, "gone.txt", "1\n2\n3\n4\n");
    await fs.writeFile(path.join(d, "bin.dat"), Buffer.from([0, 1, 2, 3, 0, 255]));
    await commit(d, "base");
    await writeFile(d, "m.txt", "a\nB\nc\nd\n");
    await fs.rm(path.join(d, "gone.txt"));
    await fs.writeFile(path.join(d, "bin.dat"), Buffer.from([9, 0, 8, 0, 7]));
    await writeFile(d, "new.txt", "x\ny\n");
    const r = byPath(await getDiscardPreview(d, ["m.txt", "gone.txt", "bin.dat", "new.txt"]));
    expect(r["m.txt"]).toMatchObject({ status: "modified", added: 2, removed: 1, binary: false });
    expect(r["gone.txt"]).toMatchObject({ status: "deleted", added: 0, removed: 4, binary: false });
    expect(r["bin.dat"]).toMatchObject({ added: null, removed: null, binary: true });
    expect(r["new.txt"]).toMatchObject({ status: "untracked", added: null, removed: null, binary: false });
  });

  it("treats a glob-named file literally", async () => {
    const d = await repo();
    await writeFile(d, "[a].txt", "1\n");
    await writeFile(d, "a.txt", "1\n");
    await commit(d, "base");
    await writeFile(d, "[a].txt", "1\n2\n");
    await writeFile(d, "a.txt", "1\n2\n3\n4\n");
    const r = byPath(await getDiscardPreview(d, ["[a].txt"]));
    expect(r["[a].txt"]).toMatchObject({ added: 1, removed: 0 });
  });

  it("gives a null row for a path that is not a current row, an escaping path, or a duplicate, and never throws", async () => {
    const d = await repo();
    await writeFile(d, "k.txt", "1\n");
    await commit(d, "base");
    const rows = await getDiscardPreview(d, ["k.txt", "../outside.txt", "nope.txt", "k.txt"]);
    expect(rows.map((x) => x.path)).toEqual(["k.txt", "../outside.txt", "nope.txt"]);
    for (const x of rows) expect(x).toMatchObject({ status: "unknown", added: null, removed: null, binary: false });
  });

  it("reports a staged-then-edited file by its worktree-against-index change, and a staged rename as unknown", async () => {
    const d = await repo();
    await writeFile(d, "r.txt", "one\ntwo\nthree\nfour\nfive\n");
    await commit(d, "base");
    await git(d, ["mv", "r.txt", "r2.txt"]);
    await writeFile(d, "r2.txt", "one\ntwo\nthree\nfour\nfive\nsix\n");
    const r = byPath(await getDiscardPreview(d, ["r2.txt", "r.txt"]));
    expect(r["r2.txt"]).toMatchObject({ added: 1, removed: 0 });
    expect(r["r.txt"]).toMatchObject({ status: "unknown", added: null });
  });

  it("works on an unborn HEAD", async () => {
    const d = await repo();
    await writeFile(d, "a.txt", "1\n");
    await git(d, ["add", "a.txt"]);
    await writeFile(d, "a.txt", "1\n2\n");
    await writeFile(d, "b.txt", "x\n");
    const r = byPath(await getDiscardPreview(d, ["a.txt", "b.txt"]));
    expect(r["a.txt"]).toMatchObject({ added: 1, removed: 0 });
    expect(r["b.txt"]).toMatchObject({ status: "untracked", added: null });
  });

  it("refuses more than the row cap before reading anything", async () => {
    const d = await repo();
    const many = Array.from({ length: DISCARD_PREVIEW_ROW_LIMIT + 1 }, (_, i) => `f${i}.txt`);
    await expect(getDiscardPreview(d, many)).rejects.toBeInstanceOf(TooManyFilesError);
  });
});
