// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { buildCopyManifest, copyFromManifest, type CopyManifest } from "../src/worktreeCopyEngine";
import { Repository } from "../src/index";
import { git, makeTempDir, seedBareRepo, snapshotTree, writeFile, fileExists, commit } from "./testRepo";
import { addLinkedWorktree, cleanupCopyFixtures, makeCopyFixture, SENTINEL, track, tryMakeDirLink, type CopyFixture } from "./worktreeCopyKit";

afterEach(cleanupCopyFixtures);

async function manifestOf(f: CopyFixture, source = f.repo): Promise<CopyManifest> {
  const r = await buildCopyManifest(f.repo, source);
  if (r.status !== "ok") throw new Error(`manifest: ${r.reason}`);
  return r.manifest;
}
const read = async (p: string) => (await fs.readFile(p, "utf8")).split("\r\n").join("\n");
const skippedReasons = (o: { results: { outcome: string; reason?: string; path: string }[] }) => Object.fromEntries(o.results.filter((r) => r.outcome === "skipped").map((r) => [r.path, r.reason]));
const posix = process.platform !== "win32";

describe("manifest (FR-643 phase 1)", () => {
  it("records files with identity per row, a random token, and the source worktree id", async () => {
    const f = await makeCopyFixture();
    const linked = await addLinkedWorktree(f, "wt", "feat");
    await writeFile(linked, "n.log", "123");
    const m = await manifestOf(f, linked);
    expect(m.sourceWorktreeId).toBe("wt");
    expect(m.rows.map((r) => [r.id, r.fileCount, r.bytes])).toEqual([["n.log", 1, 3]]);
    expect(m.repoKey).toBeNull();
    expect(m.token.length).toBeGreaterThan(20);
    expect((await manifestOf(f, linked)).token).not.toBe(m.token);
    const main = await manifestOf(f);
    expect(main.sourceWorktreeId).toBeNull();
    const cache = main.rows.find((r) => r.id === ".cache/")!;
    expect(cache).toMatchObject({ isDirectory: true, fileCount: 2, bytes: 5 });
    expect(cache.fileIndexes.map((i) => main.files[i]!.path)).toEqual([".cache/x", ".cache/y"]);
    expect(JSON.parse(JSON.stringify(main))).toEqual(main);
  });

  it("a row with more files than the copy limit is disabled rather than half-listed", async () => {
    const f = await makeCopyFixture();
    const r = await buildCopyManifest(f.repo, f.repo, { rowMaxFiles: 100 });
    expect(r.status).toBe("ok");
    const big = await makeCopyFixture();
    for (let i = 0; i < 4; i++) await writeFile(big.repo, `many/${i}.log`, "x");
    await fs.appendFile(path.join(big.repo, ".gitignore"), "many/\n");
    const tight = await buildCopyManifest(big.repo, big.repo, { rowMaxFiles: 3 });
    if (tight.status !== "ok") throw new Error("expected ok");
    expect(tight.manifest.rows.find((x) => x.id === "many/")).toMatchObject({ disabledReason: "too-many-files", fileCount: 0 });
  });

  it("bare repository and zero ignored files give no rows", async () => {
    const b = await seedBareRepo();
    track(b.parent);
    const r = await buildCopyManifest(b.bare, b.bare);
    expect(r.status === "ok" && r.manifest.rows).toEqual([]);
    const f = await makeCopyFixture();
    const clean = await addLinkedWorktree(f, "clean", "clean");
    const m = await manifestOf(f, clean);
    expect(m.rows).toEqual([]);
    const dest = await addLinkedWorktree(f, "d0", "d0");
    const out = await copyFromManifest(m, [], dest);
    expect(out).toMatchObject({ status: "done", totals: { copied: 0, skipped: 0 } });
  });
});

describe("copy into a real new worktree (AC 1, 9, 10)", () => {
  it("copies the selected rows byte-identically; the source and .git are untouched; the new worktree holds only tracked files plus the copy", async () => {
    const f = await makeCopyFixture();
    const dest = await addLinkedWorktree(f, "new", "feature");
    const m = await manifestOf(f);
    const before = await snapshotTree(f.repo);
    const out = await copyFromManifest(m, [".env", ".cache/", ".vscode/"], dest);
    expect(out.status).toBe("done");
    expect(out.totals).toMatchObject({ copied: 4, skipped: 0 });
    expect(await read(path.join(dest, ".env"))).toBe(`KEY=${SENTINEL}\n`);
    expect(await read(path.join(dest, ".cache", "y"))).toBe("yy\n");
    expect(await fileExists(path.join(dest, "node_modules"))).toBe(false);
    expect(await fileExists(path.join(dest, "src", "b.log"))).toBe(false);
    expect(await snapshotTree(f.repo)).toEqual(before);
    const { stdout } = await git(dest, ["status", "--porcelain", "--ignored"]);
    expect(stdout).not.toContain("a.txt");
  });

  it("a tracked file keeps the target branch's content when a pattern matches it and an ignored sibling (must pass on every OS)", async () => {
    const f = await makeCopyFixture();
    // The source's tracked src/a.txt differs locally; the new worktree has the committed content.
    await fs.writeFile(path.join(f.repo, "src", "a.txt"), "LOCAL EDIT\n");
    const dest = await addLinkedWorktree(f, "new", "feature");
    const m = await manifestOf(f);
    expect(m.files.some((x) => x.path === "src/a.txt")).toBe(false);
    const out = await copyFromManifest(m, ["src/b.log", "src/a.txt"], dest);
    expect(skippedReasons(out)).toEqual({ "src/a.txt": "not-in-manifest" });
    expect(await read(path.join(dest, "src", "a.txt"))).toBe("tracked\n");
    expect(await read(path.join(dest, "src", "b.log"))).toBe("log\n");
  });

  it("an ignored source file that the target branch TRACKS is not overwritten", async () => {
    const f = await makeCopyFixture();
    await git(f.repo, ["checkout", "-q", "-b", "other"]);
    await fs.writeFile(path.join(f.repo, "config.local"), "branch version\n");
    await git(f.repo, ["add", "-f", "config.local"]);
    await git(f.repo, ["commit", "-q", "-m", "track config.local"]);
    await git(f.repo, ["checkout", "-q", "main"]);
    await fs.writeFile(path.join(f.repo, "config.local"), "local secret version\n");
    const dest = await addLinkedWorktree(f, "new", "feature").catch(() => "");
    expect(dest).not.toBe("");
    await git(dest, ["checkout", "-q", "other"]).catch(async () => git(dest, ["reset", "-q", "--hard", "other"]));
    const m = await manifestOf(f);
    const out = await copyFromManifest(m, ["config.local"], dest);
    expect(skippedReasons(out)).toEqual({ "config.local": "tracked-in-destination" });
    expect(await read(path.join(dest, "config.local"))).toBe("branch version\n");
  });

  it("an existing destination file is not overwritten and is reported", async () => {
    const f = await makeCopyFixture();
    const dest = await addLinkedWorktree(f, "new", "feature");
    await fs.writeFile(path.join(dest, ".env"), "DEST\n");
    const out = await copyFromManifest(await manifestOf(f), [".env"], dest);
    expect(skippedReasons(out)).toEqual({ ".env": "already-exists" });
    expect(await read(path.join(dest, ".env"))).toBe("DEST\n");
  });

  it.runIf(posix)("a 0600 file stays 0600", async () => {
    const f = await makeCopyFixture();
    await fs.chmod(path.join(f.repo, ".env"), 0o600);
    const dest = await addLinkedWorktree(f, "new", "feature");
    await copyFromManifest(await manifestOf(f), [".env"], dest);
    expect((await fs.stat(path.join(dest, ".env"))).mode & 0o777).toBe(0o600);
  });

  it("a destination parent that is a link resolving outside writes zero bytes outside", async (ctx) => {
    const f = await makeCopyFixture();
    const dest = await addLinkedWorktree(f, "new", "feature");
    const outside = track(await makeTempDir());
    await fs.writeFile(path.join(outside, "keep.txt"), "outside\n");
    if (!(await tryMakeDirLink(outside, path.join(dest, ".cache")))) return ctx.skip();
    const before = await snapshotTree(outside);
    const out = await copyFromManifest(await manifestOf(f), [".cache/", ".env"], dest);
    expect(skippedReasons(out)).toEqual({ ".cache/x": "destination-parent-link", ".cache/y": "destination-parent-link" });
    expect(await snapshotTree(outside)).toEqual(before);
    expect(await read(path.join(dest, ".env"))).toBe(`KEY=${SENTINEL}\n`);
  });

  it("refuses a requested file swapped for a symlink after enumeration (real link where possible)", async (ctx) => {
    const f = await makeCopyFixture();
    const dest = await addLinkedWorktree(f, "new", "feature");
    const m = await manifestOf(f);
    const target = path.join(f.parent, "target-secret");
    await fs.writeFile(target, SENTINEL);
    await fs.rm(path.join(f.repo, ".env"));
    try {
      await fs.symlink(target, path.join(f.repo, ".env"), "file");
    } catch {
      return ctx.skip();
    }
    const out = await copyFromManifest(m, [".env"], dest);
    expect(skippedReasons(out)).toEqual({ ".env": "source-symlink" });
    expect(await fileExists(path.join(dest, ".env"))).toBe(false);
  });

  it("a file changed, deleted or replaced after review is skipped 'changed since you reviewed'", async () => {
    const f = await makeCopyFixture();
    const dest = await addLinkedWorktree(f, "new", "feature");
    const m = await manifestOf(f);
    await fs.appendFile(path.join(f.repo, ".env"), "MORE\n");
    await fs.rm(path.join(f.repo, "src", "b.log"));
    const out = await copyFromManifest(m, [".env", "src/b.log", ".cache/"], dest);
    expect(skippedReasons(out)).toEqual({ ".env": "changed-since-review", "src/b.log": "changed-since-review" });
    expect(out.results.find((r) => r.path === ".env" && r.outcome === "skipped")).toMatchObject({ message: "changed since you reviewed" });
    expect(await fileExists(path.join(dest, ".env"))).toBe(false);
    expect(await read(path.join(dest, ".cache", "x"))).toBe("x\n");
  });

  it("a planted .vscode/tasks.json added to a directory row after review is NOT copied", async () => {
    const f = await makeCopyFixture();
    const dest = await addLinkedWorktree(f, "new", "feature");
    const m = await manifestOf(f);
    await writeFile(f.repo, ".vscode/tasks.json", '{"tasks":[{"command":"evil"}]}');
    const out = await copyFromManifest(m, [".vscode/"], dest);
    expect(out.results.map((r) => r.path)).toEqual([".vscode/settings.json"]);
    expect(await fileExists(path.join(dest, ".vscode", "tasks.json"))).toBe(false);
    // and the requested-but-unlisted path itself is refused
    expect(skippedReasons(await copyFromManifest(m, [".vscode/tasks.json"], dest))).toEqual({ ".vscode/tasks.json": "not-in-manifest" });
  });

  it("refuses paths outside the fresh set: tracked, '..', absolute, created after enumeration", async () => {
    const f = await makeCopyFixture();
    const dest = await addLinkedWorktree(f, "new", "feature");
    const m = await manifestOf(f);
    await writeFile(f.repo, "late.log", "late");
    const out = await copyFromManifest(m, ["src/a.txt", "../outside", path.resolve("/etc/passwd"), "late.log"], dest);
    expect(Object.values(skippedReasons(out))).toEqual(["not-in-manifest", "not-in-manifest", "not-in-manifest", "not-in-manifest"]);
    expect(await fileExists(path.join(dest, "late.log"))).toBe(false);
  });

  it("refuses a destination that is not a worktree folder", async () => {
    const f = await makeCopyFixture();
    const m = await manifestOf(f);
    const plain = track(await makeTempDir());
    expect(await copyFromManifest(m, [".env"], plain)).toMatchObject({ status: "refused", reason: "destination-invalid" });
    expect(await copyFromManifest(m, [".env"], f.repo)).toMatchObject({ status: "refused" });
  });

  it("a destination swapped to another worktree between validation and copy is refused with zero bytes written", async () => {
    const f = await makeCopyFixture();
    const validated = await addLinkedWorktree(f, "validated", "b1");
    const swapped = await addLinkedWorktree(f, "swapped", "b2");
    const m = await manifestOf(f);
    const before = await snapshotTree(swapped);
    const expectedDestReal = await fs.realpath(validated);
    const out = await copyFromManifest(m, [".env", ".cache/"], swapped, { expectedDestReal });
    expect(out).toMatchObject({ status: "refused", reason: "destination-invalid" });
    expect(await snapshotTree(swapped)).toEqual(before);
    expect((await copyFromManifest(m, [".env"], validated, { expectedDestReal })).totals.copied).toBe(1);
  });

  it("collisions by case or Unicode form are skipped, wherever the filesystem folds them", async () => {
    const f = await makeCopyFixture();
    await git(f.repo, ["checkout", "-q", "-b", "other"]);
    await writeFile(f.repo, "Doc.txt", "tracked on other");
    await git(f.repo, ["add", "Doc.txt"]);
    await git(f.repo, ["commit", "-q", "-m", "doc"]);
    await git(f.repo, ["checkout", "-q", "main"]);
    await fs.appendFile(path.join(f.repo, ".gitignore"), "doc.TXT\n");
    await writeFile(f.repo, "doc.TXT", "ignored local");
    const dest = path.join(f.worktreesDir, "other");
    await fs.mkdir(f.worktreesDir, { recursive: true });
    await git(f.repo, ["worktree", "add", "-q", dest, "other"]);
    const out = await copyFromManifest(await manifestOf(f), ["doc.TXT"], dest);
    expect(skippedReasons(out)["doc.TXT"]).toBe("tracked-in-destination");
    expect(await read(path.join(dest, "Doc.txt"))).toBe("tracked on other");
  });

  it("is reachable from Repository with a typed outcome and no content in it", async () => {
    const f = await makeCopyFixture();
    const dest = await addLinkedWorktree(f, "new", "feature");
    const repo = await Repository.open(f.repo);
    const built = await repo.buildCopyManifest(f.repo);
    if (built.status !== "ok") throw new Error("manifest");
    const out = await repo.copyFromManifest(built.manifest, [".env"], dest);
    expect(JSON.stringify(out)).not.toContain(SENTINEL);
    expect(out.totals.copied).toBe(1);
  });
});
