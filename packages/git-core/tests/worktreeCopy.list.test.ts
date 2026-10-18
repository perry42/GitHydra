// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { listIgnoredCandidates } from "../src/worktreeCopy";
import { _setWorktreeRunnerForTests } from "../src/worktreeRunner";
import { Repository } from "../src/index";
import { git, seedBareRepo, writeFile, snapshotTree } from "./testRepo";
import { addLinkedWorktree, cleanupCopyFixtures, fakeSpawnRunner, isAlive, makeCopyFixture, track, waitUntil } from "./worktreeCopyKit";

afterEach(async () => {
  _setWorktreeRunnerForTests(null);
  await cleanupCopyFixtures();
});

const ok = async (repo: string, src: string, opts = {}) => {
  const r = await listIgnoredCandidates(repo, src, opts);
  if (r.status !== "ok") throw new Error(`listing failed: ${r.reason}`);
  return r;
};

describe("listIgnoredCandidates (FR-626)", () => {
  it("lists git's own ignored set with directory rows, counts, sizes and tags; never tracked or non-ignored files", async () => {
    const f = await makeCopyFixture();
    await writeFile(f.repo, "src/new.ts", "untracked, not ignored\n");
    await writeFile(f.repo, "foo.pem", "untracked, not ignored\n");
    const before = await snapshotTree(f.repo);
    const { candidates, bare } = await ok(f.repo, f.repo);
    expect(bare).toBe(false);
    expect(candidates.map((c) => c.path)).toEqual([".cache/", ".env", ".vscode/", "node_modules/", "src/b.log"]);
    const cache = candidates.find((c) => c.path === ".cache/")!;
    expect(cache).toMatchObject({ isDirectory: true, fileCount: 2, bytes: 5, sizeComputed: true });
    expect(candidates.find((c) => c.path === ".env")).toMatchObject({ secret: true, fileCount: 1, bytes: Buffer.byteLength(`KEY=SENTINEL-SECRET-CONTENT-7f3a\n`) });
    expect(candidates.find((c) => c.path === ".vscode/")).toMatchObject({ runsCode: true });
    expect(candidates.find((c) => c.path === "node_modules/")).toMatchObject({ large: true });
    // AC1: reading the list leaves the source tree and .git byte-identical.
    expect(await snapshotTree(f.repo)).toEqual(before);
  });

  it("works when the source is itself a linked worktree, and lists that worktree's files only", async () => {
    const f = await makeCopyFixture();
    const linked = await addLinkedWorktree(f, "linked", "feature");
    await writeFile(linked, "local.log", "l\n");
    const { candidates } = await ok(f.repo, linked);
    expect(candidates.map((c) => c.path)).toEqual(["local.log"]);
  });

  it("refuses a directory that is not a worktree of this repository", async () => {
    const f = await makeCopyFixture();
    const other = await makeCopyFixture();
    expect(await listIgnoredCandidates(f.repo, other.repo)).toEqual({ status: "failed", reason: "not-a-worktree" });
    expect(await listIgnoredCandidates(f.repo, path.join(f.parent, "nope"))).toEqual({ status: "failed", reason: "not-a-worktree" });
  });

  it("a bare repository or a repo with zero ignored files lists nothing", async () => {
    const b = await seedBareRepo();
    track(b.parent);
    expect(await listIgnoredCandidates(b.bare, b.bare)).toEqual({ status: "ok", candidates: [], bare: true });
    const f = await makeCopyFixture();
    const clean = await addLinkedWorktree(f, "clean", "clean");
    expect(await listIgnoredCandidates(f.repo, clean)).toEqual({ status: "ok", candidates: [], bare: false });
  });

  it("flags a nested repository directory as disabled", async () => {
    const f = await makeCopyFixture();
    await git(f.repo, ["init", "-q", path.join(f.repo, "nested")]);
    await writeFile(f.repo, "nested/f.txt", "n\n");
    const { candidates } = await ok(f.repo, f.repo);
    expect(candidates.find((c) => c.path === "nested/")).toMatchObject({ disabledReason: "nested-repository" });
  });

  it("disables a symlink row without following it", async (ctx) => {
    const f = await makeCopyFixture();
    try {
      await fs.symlink(path.join(f.repo, "src", "a.txt"), path.join(f.repo, "config.local"), "file");
    } catch {
      return ctx.skip();
    }
    const { candidates } = await ok(f.repo, f.repo);
    expect(candidates.find((c) => c.path === "config.local")).toMatchObject({ disabledReason: "symbolic-link" });
  });

  it("walk caps fall back to 'size not computed'", async () => {
    const f = await makeCopyFixture();
    const { candidates } = await ok(f.repo, f.repo, { walkMaxEntries: 1 });
    const cache = candidates.find((c) => c.path === ".cache/")!;
    expect(cache.sizeComputed).toBe(false);
    expect(cache.bytes).toBeNull();
  });

  it("kills a listing child that exceeds the timeout", async () => {
    const f = await makeCopyFixture();
    const { runner, children } = fakeSpawnRunner("setInterval(()=>{},1000)");
    _setWorktreeRunnerForTests(runner);
    const r = await listIgnoredCandidates(f.repo, f.repo, { timeoutMs: 300 });
    expect(r).toEqual({ status: "failed", reason: "timeout" });
    expect(await waitUntil(() => !isAlive(children[0]!.pid))).toBe(true);
  });

  it("truncates stdout over the cap to 'too many files' and kills the child", async () => {
    const f = await makeCopyFixture();
    const { runner, children } = fakeSpawnRunner("const b=Buffer.alloc(1<<20,97);const t=setInterval(()=>process.stdout.write(b),1);setTimeout(()=>clearInterval(t),20000)");
    _setWorktreeRunnerForTests(runner);
    const r = await listIgnoredCandidates(f.repo, f.repo, { maxStdoutBytes: 2 * 1024 * 1024, timeoutMs: 8000 });
    expect(r).toEqual({ status: "failed", reason: "too-many-files" });
    expect(await waitUntil(() => !isAlive(children[0]!.pid))).toBe(true);
  });

  it("caps the row count", async () => {
    const f = await makeCopyFixture();
    const r = await listIgnoredCandidates(f.repo, f.repo, { maxRows: 2 });
    expect(r).toEqual({ status: "failed", reason: "too-many-files" });
  });

  it("is reachable from Repository", async () => {
    const f = await makeCopyFixture();
    const repo = await Repository.open(f.repo);
    const r = await repo.listIgnoredCandidates(f.repo);
    expect(r.status).toBe("ok");
  });
});

describe("a file-level ignore rule inside an otherwise untracked directory (demo-repo regression)", () => {
  it("lists the file ONCE: git prints both `config/` and `config/local.json`, only the directory row is kept", async () => {
    const f = await makeCopyFixture();
    await writeFile(f.repo, ".gitignore", "config/local.json\n.vscode/\n.env\n");
    await git(f.repo, ["add", ".gitignore"]);
    await git(f.repo, ["commit", "-q", "-m", "ignore"]);
    await writeFile(f.repo, "config/local.json", '{ "a": 1 }\n');
    await writeFile(f.repo, ".vscode/settings.json", "{}\n");
    await writeFile(f.repo, ".env", "K=1\n");
    const { candidates } = await ok(f.repo, f.repo);
    const paths = candidates.map((c) => c.path);
    expect(paths.filter((p) => p.startsWith("config/"))).toEqual(["config/"]);
    expect(candidates.find((c) => c.path === "config/")).toMatchObject({ isDirectory: true, fileCount: 1 });
    expect(new Set(paths).size).toBe(paths.length);
  });

  it("the include match and the manifest count it once", async () => {
    const f = await makeCopyFixture();
    await writeFile(f.repo, ".gitignore", "config/local.json\n");
    await git(f.repo, ["add", ".gitignore"]);
    await git(f.repo, ["commit", "-q", "-m", "ignore"]);
    await writeFile(f.repo, "config/local.json", '{ "a": 1 }\n');
    await writeFile(f.repo, ".worktreeinclude", "config/local.json\n");
    const repo = await Repository.open(f.repo);
    const built = await repo.buildCopyManifest(f.repo);
    if (built.status !== "ok") throw new Error("manifest failed");
    const rows = built.manifest.rows.filter((r) => r.path.startsWith("config/"));
    expect(rows.map((r) => r.path)).toEqual(["config/"]);
    expect(built.manifest.files.filter((x) => x.path === "config/local.json")).toHaveLength(1);
    const listing = await listIgnoredCandidates(f.repo, f.repo);
    if (listing.status !== "ok") throw new Error("listing failed");
    const inc = await repo.readWorktreeInclude(f.repo, { candidates: listing.candidates });
    if (inc.status !== "ok") throw new Error("include failed");
    expect(inc.matchedRows.filter((p) => p.startsWith("config/"))).toEqual(["config/"]);
  });
});
