// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { spawn } from "node:child_process";
import {
  copyIgnoredIntoExisting,
  listIgnoredForExisting,
  resolveDestinationWorktree,
  type ExistingListing,
  type ExistingRow,
} from "../src/worktreeCopyExisting";
import { copyCollisionKey, escapeDisplayName, strongestExistingReason } from "../src/worktreeCopyExistingPure";
import { validateCopyPath, runsCodeWhenOpened, changesGitBehaviour } from "../src/worktreeCopyPure";
import { sameFileIdentity, realCopyFs, type CopyFs } from "../src/worktreeCopyFs";
import { _setWorktreeRunnerForTests, type WorktreeRunner } from "../src/worktreeRunner";
import { runGit, runGitAllowingExitCodes, spawnGit, type GitChildProcess } from "../src/gitProcess";
import { git, makeTempDir, snapshotTree, writeFile, fileExists, commit, tryMakeDirLink } from "./testRepo";
import { addLinkedWorktree, cleanupCopyFixtures, makeCopyFixture, SENTINEL, track, type CopyFixture } from "./worktreeCopyKit";

afterEach(async () => {
  _setWorktreeRunnerForTests(null);
  delete process.env.GIT_DIR;
  delete process.env.GIT_WORK_TREE;
  delete process.env.GIT_INDEX_FILE;
  await cleanupCopyFixtures();
});

const posix = process.platform !== "win32";
const read = async (p: string) => (await fs.readFile(p, "utf8")).split("\r\n").join("\n");

async function listOk(f: CopyFixture, destId: string | null, source = f.repo, opts: Parameters<typeof listIgnoredForExisting>[3] = {}): Promise<Extract<ExistingListing, { status: "ok" }>> {
  const r = await listIgnoredForExisting(f.repo, source, destId, opts);
  if (r.status !== "ok") throw new Error(`listing failed: ${r.reason}`);
  return r;
}
const rowOf = (l: { rows: ExistingRow[] }, id: string): ExistingRow => {
  const r = l.rows.find((x) => x.id === id);
  if (!r) throw new Error(`no row ${id}: ${l.rows.map((x) => x.id).join(",")}`);
  return r;
};
const skipped = (o: { results: { outcome: string; reason?: string; path: string }[] }) => Object.fromEntries(o.results.filter((r) => r.outcome === "skipped").map((r) => [r.path, r.reason]));

async function copyAll(f: CopyFixture, l: Extract<ExistingListing, { status: "ok" }>, ids: string[], opts: Parameters<typeof copyIgnoredIntoExisting>[5] = {}) {
  return copyIgnoredIntoExisting(f.repo, l.manifest, ids, { destId: l.destination.id, boundRoot: l.destination.root }, opts);
}

describe("pure rules (FR-630 fold, hygiene, display, tags)", () => {
  it("folds NFD(lower(upper(NFC))) so the long s, Kelvin sign and sharp s collide", () => {
    expect(copyCollisionKey("ſ.log")).toBe(copyCollisionKey("s.log"));
    expect(copyCollisionKey("K/x")).toBe(copyCollisionKey("k/x"));
    expect(copyCollisionKey("Straße")).toBe(copyCollisionKey("STRASSE"));
    expect(copyCollisionKey("café")).toBe(copyCollisionKey("café"));
    expect(copyCollisionKey("a/B")).not.toBe(copyCollisionKey("a/b/c"));
  });

  it("refuses Cf and default-ignorable code points, including a .git look-alike", () => {
    for (const bad of [".g‌it/config", "a​b", "a­b", "﻿a", "a⁠b", "a\u{E0041}b", "x️"]) {
      expect(validateCopyPath(bad)).toEqual({ ok: false, reason: expect.any(String) });
    }
    expect(validateCopyPath(".g‌it")).toEqual({ ok: false, reason: "git-directory" });
    expect(validateCopyPath("a​b")).toEqual({ ok: false, reason: "invisible-format" });
    expect(validateCopyPath("café/中文.txt").ok).toBe(true);
  });

  it("L3: git and tool behaviour files are run-code names; node_modules copies are not tagged", () => {
    for (const n of [".gitattributes", ".gitignore", ".gitmodules", ".lfsconfig", ".yarnrc", ".pnpmfile.cjs", ".npmrc", ".rvmrc"]) expect(runsCodeWhenOpened(n)).toBe(true);
    expect(runsCodeWhenOpened("pkg/.gitignore")).toBe(true);
    expect(runsCodeWhenOpened("node_modules/")).toBe(false);
    expect(runsCodeWhenOpened("node_modules/x/.gitignore")).toBe(false);
    expect(changesGitBehaviour(".gitignore")).toBe(true);
    expect(changesGitBehaviour("a/.gitattributes")).toBe(true);
    expect(changesGitBehaviour(".env")).toBe(false);
  });

  it("escapes control, bidi and format characters and truncates in the middle", () => {
    expect(escapeDisplayName("a‮b\nc​d")).toBe("aU+202EbU+000AcU+200Bd");
    const long = escapeDisplayName("x".repeat(500));
    expect(long.length).toBe(120);
    expect(long).toContain("...");
    expect(escapeDisplayName("short")).toBe("short");
  });

  it("orders reasons: inside another repository > link > tracked > already exists", () => {
    expect(strongestExistingReason(["already-exists", "tracked-in-destination", "destination-link", "inside-another-repository"])).toBe("inside-another-repository");
    expect(strongestExistingReason(["already-exists", "tracked-in-destination", "destination-link"])).toBe("destination-link");
    expect(strongestExistingReason(["already-exists", "tracked-in-destination"])).toBe("tracked-in-destination");
    expect(strongestExistingReason(["already-exists"])).toBe("already-exists");
    expect(strongestExistingReason([])).toBeNull();
  });

  it("L4: size+mtime alone only counts when the inode is 0 on both sides", () => {
    const a = { dev: 1n, ino: 5n, size: 3n, mtimeNs: 9n };
    expect(sameFileIdentity(a, { ...a })).toBe(true);
    expect(sameFileIdentity(a, { ...a, ino: 6n })).toBe(false);
    expect(sameFileIdentity(a, { ...a, dev: 2n })).toBe(false);
    expect(sameFileIdentity(a, { ...a, mtimeNs: 10n })).toBe(false);
    expect(sameFileIdentity({ ...a, ino: 0n }, { ...a, ino: 0n })).toBe(true);
    expect(sameFileIdentity({ ...a, ino: 0n }, a)).toBe(false);
  });
});

describe("classification against an existing destination (FR-652)", () => {
  it("an existing file is disabled `already exists` and a forced attempt leaves its content unchanged", async () => {
    const f = await makeCopyFixture();
    const dest = await addLinkedWorktree(f, "dest", "feat");
    await writeFile(dest, "src/b.log", "dest content\n");
    const l = await listOk(f, "dest");
    expect(rowOf(l, "src/b.log")).toMatchObject({ disabledReason: "already-exists", copyableCount: 0, existingCount: 1, fileCount: 1 });
    const out = await copyAll(f, l, ["src/b.log"]);
    expect(out.status).toBe("done");
    expect(out.totals.copied).toBe(0);
    expect(skipped(out)).toEqual({ "src/b.log": "already-exists" });
    expect(await read(path.join(dest, "src/b.log"))).toBe("dest content\n");
  });

  it("a directory row with 3 files where 1 exists copies 2 and reports 1 (`1 of 3 already exist`)", async () => {
    const f = await makeCopyFixture();
    await writeFile(f.repo, ".cache/z", "zzz\n");
    const dest = await addLinkedWorktree(f, "dest", "feat");
    await writeFile(dest, ".cache/x", "mine\n");
    const l = await listOk(f, "dest");
    const row = rowOf(l, ".cache/");
    expect(row).toMatchObject({ disabledReason: null, fileCount: 3, copyableCount: 2, existingCount: 1 });
    const out = await copyAll(f, l, [".cache/"]);
    expect(out.totals).toMatchObject({ copied: 2, skipped: 1 });
    expect(skipped(out)).toEqual({ ".cache/x": "already-exists" });
    expect(await read(path.join(dest, ".cache/x"))).toBe("mine\n");
    expect(await read(path.join(dest, ".cache/y"))).toBe("yy\n");
    expect(await read(path.join(dest, ".cache/z"))).toBe("zzz\n");
  });

  it("a tracked destination file that is IGNORED in the source is never overwritten (must pass on every OS)", async () => {
    const f = await makeCopyFixture();
    const dest = await addLinkedWorktree(f, "dest", "feat");
    await writeFile(dest, "data/keep.log", "tracked in dest\n");
    await git(dest, ["add", "-f", "data/keep.log"]);
    await commit(dest, "track a log");
    await writeFile(f.repo, "data/keep.log", "ignored in source\n");
    const l = await listOk(f, "dest");
    expect(rowOf(l, "data/")).toMatchObject({ disabledReason: "tracked-in-destination" });
    const out = await copyAll(f, l, ["data/"]);
    expect(skipped(out)).toEqual({ "data/keep.log": "tracked-in-destination" });
    expect(await read(path.join(dest, "data/keep.log"))).toBe("tracked in dest\n");
    // Deleted from the working tree but still tracked (sparse / skip-worktree style): still refused.
    await fs.rm(path.join(dest, "data/keep.log"));
    await git(dest, ["update-index", "--skip-worktree", "data/keep.log"]);
    const again = await listOk(f, "dest");
    expect(rowOf(again, "data/").disabledReason).toBe("tracked-in-destination");
    const out2 = await copyAll(f, again, ["data/"]);
    expect(out2.totals.copied).toBe(0);
    expect(await fileExists(path.join(dest, "data/keep.log"))).toBe(false);
  });

  it("case and Unicode-normalisation collisions with an existing sibling are `already exists`", async () => {
    const f = await makeCopyFixture();
    await writeFile(f.repo, "Cfg/A.log", "1\n");
    await writeFile(f.repo, "ſ.log", "2\n");
    const dest = await addLinkedWorktree(f, "dest", "feat");
    await writeFile(dest, "cfg/other.txt", "x\n");
    await writeFile(dest, "s.log", "x\n");
    const l = await listOk(f, "dest");
    expect(rowOf(l, "Cfg/").disabledReason).toBe("already-exists");
    expect(rowOf(l, "ſ.log").disabledReason).toBe("already-exists");
    const out = await copyAll(f, l, ["Cfg/", "ſ.log"]);
    expect(out.totals.copied).toBe(0);
    expect(await read(path.join(dest, "s.log"))).toBe("x\n");
  });

  it("a regular file where a parent directory is needed is `already exists`", async () => {
    const f = await makeCopyFixture();
    await writeFile(f.repo, "deep/inner.log", "1\n");
    const dest = await addLinkedWorktree(f, "dest", "feat");
    await writeFile(dest, "deep", "a file\n");
    const l = await listOk(f, "dest");
    expect(rowOf(l, "deep/").disabledReason).toBe("already-exists");
    expect((await copyAll(f, l, ["deep/"])).totals.copied).toBe(0);
    expect(await read(path.join(dest, "deep"))).toBe("a file\n");
  });

  it("a destination parent that is a link resolving outside: nothing written outside, row `destination folder is a link`", async () => {
    const f = await makeCopyFixture();
    await writeFile(f.repo, "out/payload.log", `data ${SENTINEL}\n`);
    const dest = await addLinkedWorktree(f, "dest", "feat");
    const outside = track(await makeTempDir());
    const before = await snapshotTree(outside);
    if (!(await tryMakeDirLink(outside, path.join(dest, "out")))) {
      console.warn("skipped: this account cannot create symlinks or junctions");
      return;
    }
    const l = await listOk(f, "dest");
    expect(rowOf(l, "out/").disabledReason).toBe("destination-link");
    const out = await copyAll(f, l, ["out/"]);
    expect(out.totals.copied).toBe(0);
    expect(skipped(out)).toEqual({ "out/payload.log": "destination-parent-link" });
    expect(await snapshotTree(outside)).toEqual(before);
  });

  it("an untracked nested clone below the destination root is `inside another repository` and nothing is created in it", async () => {
    const f = await makeCopyFixture();
    await writeFile(f.repo, "ext/lib/x.log", "1\n");
    await writeFile(f.repo, "ext/lib/sub/y.log", "1\n");
    const dest = await addLinkedWorktree(f, "dest", "feat");
    await git(dest, ["init", "-q", path.join(dest, "ext/lib")]);
    const before = await snapshotTree(path.join(dest, "ext"));
    const l = await listOk(f, "dest");
    expect(rowOf(l, "ext/")).toMatchObject({ disabledReason: "inside-another-repository", copyableCount: 0 });
    const out = await copyAll(f, l, ["ext/"]);
    expect(out.totals.copied).toBe(0);
    expect(Object.values(skipped(out))).toEqual(["inside-another-repository", "inside-another-repository"]);
    expect(await snapshotTree(path.join(dest, "ext"))).toEqual(before);
  });

  it("a path inside a destination submodule (an unpopulated gitlink) is refused", async () => {
    const f = await makeCopyFixture();
    await writeFile(f.repo, "mods/sub/x.log", "1\n");
    const dest = await addLinkedWorktree(f, "dest", "feat");
    const head = (await git(dest, ["rev-parse", "HEAD"])).stdout.trim();
    await git(dest, ["update-index", "--add", "--cacheinfo", `160000,${head},mods/sub`]);
    await fs.mkdir(path.join(dest, "mods/sub"), { recursive: true });
    const l = await listOk(f, "dest");
    expect(rowOf(l, "mods/").disabledReason).toBe("inside-another-repository");
    expect((await copyAll(f, l, ["mods/"])).totals.copied).toBe(0);
    expect(await fileExists(path.join(dest, "mods/sub/x.log"))).toBe(false);
  });

  it("symlinks in the source stay disabled", async () => {
    const f = await makeCopyFixture();
    await addLinkedWorktree(f, "dest", "feat");
    const target = path.join(f.repo, "src/a.txt");
    try {
      await fs.symlink(target, path.join(f.repo, "link.log"), "file");
    } catch {
      console.warn("skipped: this account cannot create symlinks");
      return;
    }
    const l = await listOk(f, "dest");
    expect(rowOf(l, "link.log").disabledReason).toBe("symbolic-link");
  });

  it("copies into a fresh destination, keeps a 0600 file 0600, and leaves the source and its .git untouched", async () => {
    const f = await makeCopyFixture();
    const dest = await addLinkedWorktree(f, "dest", "feat");
    if (posix) await fs.chmod(path.join(f.repo, ".env"), 0o600);
    const srcBefore = await snapshotTree(f.repo);
    const destBefore = await snapshotTree(dest);
    const l = await listOk(f, "dest");
    const out = await copyAll(f, l, [".env", ".cache/"]);
    expect(out.status).toBe("done");
    expect(out.totals.copied).toBe(3);
    expect(await read(path.join(dest, ".env"))).toBe(`KEY=${SENTINEL}\n`);
    if (posix) expect((await fs.stat(path.join(dest, ".env"))).mode & 0o777).toBe(0o600);
    expect(await snapshotTree(f.repo)).toEqual(srcBefore);
    const destAfter = await snapshotTree(dest);
    const added = destAfter.filter((x) => !destBefore.includes(x)).map((x) => x.split(" ")[1]);
    expect(added.sort()).toEqual([".cache", ".cache/x", ".cache/y", ".env"]);
    expect(destBefore.filter((x) => !destAfter.includes(x))).toEqual([]);
  });

  it("the main worktree is a valid destination from a linked-worktree source", async () => {
    const f = await makeCopyFixture();
    const linked = await addLinkedWorktree(f, "wt", "feat");
    await writeFile(linked, "only-here.log", "hi\n");
    const l = await listOk(f, null, linked);
    expect(l.destination.id).toBeNull();
    expect(l.source.id).toBe("wt");
    expect(rowOf(l, "only-here.log").disabledReason).toBeNull();
    const out = await copyAll(f, l, ["only-here.log"]);
    expect(out.totals.copied).toBe(1);
    expect(await read(path.join(f.repo, "only-here.log"))).toBe("hi\n");
  });

  it("the main worktree of a repo using --separate-git-dir is resolved without commondir/..", async () => {
    const f = await makeCopyFixture();
    const linked = await addLinkedWorktree(f, "wt", "feat");
    const r = await resolveDestinationWorktree(f.repo, null, linked);
    expect(r.ok).toBe(true);
  });

  it("lists the file tags: secret, runs code, changes git, large", async () => {
    const f = await makeCopyFixture();
    await fs.appendFile(path.join(f.repo, ".gitignore"), "sub/.gitignore\n");
    await writeFile(f.repo, "sub/.gitignore", "*\n");
    await addLinkedWorktree(f, "dest", "feat");
    const l = await listOk(f, "dest");
    expect(rowOf(l, ".env").secret).toBe(true);
    expect(rowOf(l, ".vscode/").runsCode).toBe(true);
    expect(rowOf(l, "node_modules/").large).toBe(true);
    expect(rowOf(l, "sub/")).toMatchObject({ changesGit: true, runsCode: true });
  });
});

describe("`not ignored in <B>` (AC 21)", () => {
  it("tags a file ignored in the source but not in the destination, never disables the row, and a failing check only drops the tag", async () => {
    const f = await makeCopyFixture();
    const dest = await addLinkedWorktree(f, "dest", "feat");
    await writeFile(dest, ".gitignore", "node_modules/\n*.log\n.cache/\n.vscode/\n");
    await commit(dest, "stop ignoring .env");
    const l = await listOk(f, "dest");
    expect(rowOf(l, ".env")).toMatchObject({ notIgnoredInDestination: true, disabledReason: null, secret: true });
    expect(rowOf(l, ".cache/").notIgnoredInDestination).toBe(false);
    expect(rowOf(l, "src/b.log").notIgnoredInDestination).toBe(false);

    const failing: WorktreeRunner = {
      run: (a, o) => runGit(a, o),
      runAllowing: (a, o, allowed) => runGitAllowingExitCodes(a, o, allowed),
      spawn: (a, o) => spawnGit(a, o),
      runInput: () => Promise.reject(new Error("boom")),
    };
    _setWorktreeRunnerForTests(failing);
    const l2 = await listOk(f, "dest");
    expect(rowOf(l2, ".env")).toMatchObject({ notIgnoredInDestination: false, disabledReason: null });
    expect(l2.rows.length).toBe(l.rows.length);
  });
});

describe("fail-closed tracked check (M6, M7)", () => {
  const stageRunner = (script: string | null): WorktreeRunner => ({
    run: (a, o) => runGit(a, o),
    runAllowing: (a, o, allowed) => runGitAllowingExitCodes(a, o, allowed),
    spawn: (a, o) => {
      if (script !== null && a.includes("--stage")) return spawn(process.execPath, ["-e", script], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true }) as GitChildProcess;
      return spawnGit(a, o);
    },
  });

  it("git exiting non-zero fails the listing closed with tracked-check-failed", async () => {
    const f = await makeCopyFixture();
    await addLinkedWorktree(f, "dest", "feat");
    _setWorktreeRunnerForTests(stageRunner("process.exit(2)"));
    expect(await listIgnoredForExisting(f.repo, f.repo, "dest")).toMatchObject({ status: "failed", reason: "tracked-check-failed", destinationName: "dest" });
  });

  it("unparsable output fails closed", async () => {
    const f = await makeCopyFixture();
    await addLinkedWorktree(f, "dest", "feat");
    _setWorktreeRunnerForTests(stageRunner("process.stdout.write('garbage\\0')"));
    expect(await listIgnoredForExisting(f.repo, f.repo, "dest")).toMatchObject({ status: "failed", reason: "tracked-check-failed", destinationName: "dest" });
  });

  it("a timeout kills the child and fails closed", async () => {
    const f = await makeCopyFixture();
    await addLinkedWorktree(f, "dest", "feat");
    _setWorktreeRunnerForTests(stageRunner("setTimeout(()=>{},60000)"));
    const started = Date.now();
    expect(await listIgnoredForExisting(f.repo, f.repo, "dest", { gitTimeoutMs: 300 })).toMatchObject({ status: "failed", reason: "tracked-check-failed", destinationName: "dest" });
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it("output over the stdout cap fails closed", async () => {
    const f = await makeCopyFixture();
    await addLinkedWorktree(f, "dest", "feat");
    _setWorktreeRunnerForTests(stageRunner("process.stdout.write('x'.repeat(5000)); setTimeout(()=>{},60000)"));
    expect(await listIgnoredForExisting(f.repo, f.repo, "dest", { gitMaxBytes: 1000 })).toMatchObject({ status: "failed", reason: "tracked-check-failed", destinationName: "dest" });
  });

  it("asks per batch (2,000 paths at most) and an overall deadline leaves unreached rows disabled, never enabled", async () => {
    const f = await makeCopyFixture();
    for (let i = 0; i < 5; i++) await writeFile(f.repo, `bulk/f${i}.log`, "x");
    await addLinkedWorktree(f, "dest", "feat");
    const seen: string[][] = [];
    _setWorktreeRunnerForTests({
      run: (a, o) => runGit(a, o),
      runAllowing: (a, o, allowed) => runGitAllowingExitCodes(a, o, allowed),
      spawn: (a, o) => {
        if (a.includes("--stage")) seen.push([...a]);
        return spawnGit(a, o);
      },
    });
    const l = await listOk(f, "dest", f.repo, { gitBatchPaths: 2 });
    expect(l.rows.length).toBeGreaterThan(0);
    const stage = seen.map((a) => a.slice(a.indexOf("--") + 1));
    expect(stage.length).toBeGreaterThan(1);
    expect(stage.every((s) => s.length <= 2)).toBe(true);
    expect(seen[0]).toEqual(expect.arrayContaining(["ls-files", "-z", "--cached", "--stage", "--literal-pathspecs", "core.fsmonitor=false"]));

    const late = await listOk(f, "dest", f.repo, { classifyMs: -1 });
    expect(late.rows.filter((r) => r.disabledReason !== null).every((r) => r.disabledReason === "could-not-be-checked" || r.disabledReason === "nested-repository")).toBe(true);
    expect(late.rows.some((r) => r.disabledReason === "could-not-be-checked")).toBe(true);
    expect(late.rows.every((r) => r.disabledReason !== null || r.copyableCount > 0)).toBe(true);
  });

  it("an inherited GIT_DIR / GIT_WORK_TREE / GIT_INDEX_FILE does not change the answer", async () => {
    const f = await makeCopyFixture();
    const dest = await addLinkedWorktree(f, "dest", "feat");
    await writeFile(dest, "data/keep.log", "t\n");
    await git(dest, ["add", "-f", "data/keep.log"]);
    await commit(dest, "t");
    await writeFile(f.repo, "data/keep.log", "s\n");
    const other = track(await makeTempDir());
    await git(other, ["init", "-q"]);
    process.env.GIT_DIR = path.join(other, ".git");
    process.env.GIT_WORK_TREE = other;
    process.env.GIT_INDEX_FILE = path.join(other, ".git", "index");
    const l = await listOk(f, "dest");
    expect(rowOf(l, "data/").disabledReason).toBe("tracked-in-destination");
  });
});

describe("destination validation (AC 16)", () => {
  it("source == destination is refused; locked, missing and bare are refused before any listing", async () => {
    const f = await makeCopyFixture();
    const dest = await addLinkedWorktree(f, "dest", "feat");
    expect(await listIgnoredForExisting(f.repo, f.repo, null)).toEqual({ status: "failed", reason: "source-is-destination" });
    const linkedSelf = await listIgnoredForExisting(f.repo, dest, "dest");
    expect(linkedSelf).toEqual({ status: "failed", reason: "source-is-destination" });
    await git(f.repo, ["worktree", "lock", dest]);
    expect(await listIgnoredForExisting(f.repo, f.repo, "dest")).toEqual({ status: "failed", reason: "locked" });
    await git(f.repo, ["worktree", "unlock", dest]);
    const gone = await addLinkedWorktree(f, "gone", "gone-branch");
    await fs.rm(gone, { recursive: true, force: true });
    expect(await listIgnoredForExisting(f.repo, f.repo, "gone")).toEqual({ status: "failed", reason: "missing" });
    expect(await listIgnoredForExisting(f.repo, f.repo, "nope")).toEqual({ status: "failed", reason: "not-a-worktree" });
  });

  it("a forged gitdir back-link pointing at an unrelated folder is refused and the folder is not touched", async () => {
    const f = await makeCopyFixture();
    const dest = await addLinkedWorktree(f, "dest", "feat");
    const unrelated = track(await makeTempDir());
    await fs.writeFile(path.join(f.repo, ".git", "worktrees", "dest", "gitdir"), `${path.join(unrelated, ".git")}\n`);
    const before = await snapshotTree(dest);
    const r = await listIgnoredForExisting(f.repo, f.repo, "dest");
    expect(r.status).toBe("failed");
    if (r.status === "failed") expect(["not-a-worktree", "untrusted-list", "missing", "unsupported"]).toContain(r.reason);
    expect(await snapshotTree(dest)).toEqual(before);
  });

  it("a destination swapped for another folder between listing and copy is refused with zero bytes written", async () => {
    const f = await makeCopyFixture();
    const dest = await addLinkedWorktree(f, "dest", "feat");
    const l = await listOk(f, "dest");
    const parked = `${dest}-parked`;
    await fs.rename(dest, parked);
    await fs.mkdir(dest);
    const out = await copyAll(f, l, [".env"]);
    expect(out.status).toBe("refused");
    expect(await fileExists(path.join(dest, ".env"))).toBe(false);
    expect(await fs.readdir(dest)).toEqual([]);
  });

  it("a destination replaced by a link between listing and copy is refused", async () => {
    const f = await makeCopyFixture();
    const dest = await addLinkedWorktree(f, "dest", "feat");
    const l = await listOk(f, "dest");
    const parked = `${dest}-parked`;
    await fs.rename(dest, parked);
    const elsewhere = track(await makeTempDir());
    if (!(await tryMakeDirLink(elsewhere, dest))) {
      console.warn("skipped: this account cannot create symlinks or junctions");
      return;
    }
    const out = await copyAll(f, l, [".env"]);
    expect(out.status).toBe("refused");
    expect(await fs.readdir(elsewhere)).toEqual([]);
  });

  it("a destination turned into a non-worktree between listing and copy is refused with zero bytes written", async () => {
    const f = await makeCopyFixture();
    const dest = await addLinkedWorktree(f, "dest", "feat");
    const l = await listOk(f, "dest");
    await fs.rm(path.join(dest, ".git"));
    const out = await copyAll(f, l, [".env"]);
    expect(out).toMatchObject({ status: "refused", reason: "not-a-worktree" });
    expect(await fileExists(path.join(dest, ".env"))).toBe(false);
  });

  it("a bare repository is refused", async () => {
    const f = await makeCopyFixture();
    const bare = path.join(f.parent, "bare.git");
    await git(f.parent, ["clone", "-q", "--bare", f.repo, bare]);
    const r = await listIgnoredForExisting(bare, bare, null);
    expect(r.status).toBe("failed");
  });
});

describe("copy-time behaviour (FR-653, FR-657)", () => {
  it("a file added or modified after review is skipped `changed since you reviewed`; a planted file in a ticked directory row is reported, not copied", async () => {
    const f = await makeCopyFixture();
    const dest = await addLinkedWorktree(f, "dest", "feat");
    const l = await listOk(f, "dest");
    await writeFile(f.repo, ".vscode/tasks.json", '{"runOn":"folderOpen"}\n');
    await writeFile(f.repo, ".cache/x", "modified after review, longer\n");
    const out = await copyAll(f, l, [".vscode/", ".cache/"]);
    expect(skipped(out)[".vscode/tasks.json"]).toBe("changed-since-review");
    expect(skipped(out)[".cache/x"]).toBe("changed-since-review");
    expect(await fileExists(path.join(dest, ".vscode/tasks.json"))).toBe(false);
    expect(await fileExists(path.join(dest, ".cache/x"))).toBe(false);
    expect(await read(path.join(dest, ".cache/y"))).toBe("yy\n");
    expect(await read(path.join(dest, ".vscode/settings.json"))).toBe("{}\n");
  });

  it("the limit counts only enabled files: skipped ones do not trip it, and an over-limit selection is refused before anything is written", async () => {
    const f = await makeCopyFixture();
    const dest = await addLinkedWorktree(f, "dest", "feat");
    await writeFile(dest, ".cache/x", "exists\n");
    await writeFile(dest, ".cache/y", "exists\n");
    const l = await listOk(f, "dest");
    const ok = await copyAll(f, l, [".cache/"], { limits: { maxFiles: 1 } });
    expect(ok.status).toBe("done");
    const l2 = await listOk(f, "dest");
    const over = await copyAll(f, l2, [".env", "src/b.log"], { limits: { maxFiles: 1 } });
    expect(over).toMatchObject({ status: "refused", reason: "over-limit" });
    expect(await fileExists(path.join(dest, ".env"))).toBe(false);
  });

  it("a leaf another process creates mid-copy is reported `already exists`, never overwritten", async () => {
    const f = await makeCopyFixture();
    const dest = await addLinkedWorktree(f, "dest", "feat");
    const l = await listOk(f, "dest");
    const racy: CopyFs = {
      ...realCopyFs,
      open: async (p, flags, mode) => {
        if (p.startsWith(dest) && p.endsWith(".env")) await fs.writeFile(p, "someone else\n");
        return realCopyFs.open(p, flags, mode);
      },
    };
    const out = await copyAll(f, l, [".env"], { fs: racy });
    expect(skipped(out)).toEqual({ ".env": "already-exists" });
    expect(await read(path.join(dest, ".env"))).toBe("someone else\n");
  });

  it("M5: on Windows a parent whose realpath differs from the lexical path counts as a link", async () => {
    const f = await makeCopyFixture();
    const dest = await addLinkedWorktree(f, "dest", "feat");
    const l = await listOk(f, "dest");
    const placeholder: CopyFs = {
      ...realCopyFs,
      realpath: async (p) => {
        const real = await realCopyFs.realpath(p);
        return real.startsWith(dest) && real.toLowerCase().endsWith(`${path.sep}.cache`) ? path.join(path.dirname(real), "elsewhere") : real;
      },
    };
    const out = await copyAll(f, l, [".cache/"], { fs: placeholder, platform: "win32" });
    expect(out.totals.copied).toBe(0);
    expect(new Set(Object.values(skipped(out)))).toEqual(new Set(["destination-parent-link"]));
    expect(await fileExists(path.join(dest, ".cache/x"))).toBe(false);
  });

  it("M4: a destination nested inside the source (`A/.worktrees/B`) makes the ignored `.worktrees/` row `contains <B>`", async () => {
    const f = await makeCopyFixture();
    await fs.appendFile(path.join(f.repo, ".gitignore"), ".worktrees/\n");
    await commit(f.repo, "ignore nested worktrees");
    const nested = path.join(f.repo, ".worktrees", "B");
    await git(f.repo, ["worktree", "add", "-q", "-b", "nested-b", nested]);
    const before = await snapshotTree(nested);
    const l = await listOk(f, "B");
    expect(rowOf(l, ".worktrees/")).toMatchObject({ disabledReason: "contains-destination" });
    const out = await copyAll(f, l, [".worktrees/", ".env"]);
    expect(out.totals.copied).toBe(1);
    expect(await read(path.join(nested, ".env"))).toBe(`KEY=${SENTINEL}\n`);
    const after = await snapshotTree(nested);
    expect(after.filter((x) => !before.includes(x))).toHaveLength(1);
  });

  it("M4: a source inside the destination (A inside B) copies normally and never descends into the source", async () => {
    const f = await makeCopyFixture();
    const inner = path.join(f.repo, "inner-wt");
    await git(f.repo, ["worktree", "add", "-q", "-b", "inner", inner]);
    await writeFile(inner, "local.log", "mine\n");
    const l = await listOk(f, null, inner);
    expect(rowOf(l, "local.log").disabledReason).toBeNull();
    const out = await copyAll(f, l, ["local.log"]);
    expect(out.totals.copied).toBe(1);
    expect(await read(path.join(f.repo, "local.log"))).toBe("mine\n");
  });
});
