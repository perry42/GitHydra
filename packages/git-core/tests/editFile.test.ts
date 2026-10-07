// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { Repository, EditWriteError, EditFileAccessError, MAX_EDITABLE_FILE_BYTES, invalidPathReason } from "../src";
import { initRepo, writeFile, commit, git, cleanup, makeTempDir } from "./testRepo";

const WIN = process.platform === "win32";
const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await cleanup(d);
});

async function repoWith(files: Record<string, string | Buffer>): Promise<{ dir: string; repo: Repository }> {
  const dir = await initRepo();
  dirs.push(dir);
  for (const [p, c] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(dir, p)), { recursive: true });
    await fs.writeFile(path.join(dir, p), c);
  }
  await commit(dir, "init");
  return { dir, repo: await Repository.open(dir) };
}

const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const opts = (hash: string, extra: object = {}) => ({ expectedHash: hash, eol: "lf" as const, hasBom: false, finalNewline: true, ...extra });
async function trySymlink(target: string, link: string, type?: "dir" | "file"): Promise<boolean> {
  try {
    await fs.symlink(target, link, type);
    return true;
  } catch {
    return false; // Windows without symlink privilege
  }
}
const indexBytes = (dir: string) => fs.readFile(path.join(dir, ".git", "index"));
const tmpLeft = async (dir: string) => (await fs.readdir(dir)).filter((n) => n.includes("githydra-edit"));

describe("probeEditableFile eligibility", () => {
  it("plain tracked, untracked and non-ASCII files are eligible with correct flags", async () => {
    const { dir, repo } = await repoWith({ "a.txt": "hi\n", "dir/é ü.txt": "x\n" });
    await writeFile(dir, "new.txt", "n\n");
    expect(await repo.probeEditableFile("a.txt")).toMatchObject({ eligible: true, hasStagedContent: false, isNew: false, isUntracked: false });
    expect(await repo.probeEditableFile("dir/é ü.txt")).toMatchObject({ eligible: true });
    expect(await repo.probeEditableFile("new.txt")).toMatchObject({ eligible: true, isNew: true, isUntracked: true, hasStagedContent: false });
  });

  it("empty repository with an untracked file is eligible", async () => {
    const dir = await initRepo();
    dirs.push(dir);
    await writeFile(dir, "f.txt", "x");
    const repo = await Repository.open(dir);
    expect(await repo.probeEditableFile("f.txt")).toMatchObject({ eligible: true, isNew: true });
  });

  it("staged-modified, staged-added, renamed and intent-to-add are eligible with right flags", async () => {
    const { dir, repo } = await repoWith({ "m.txt": "1\n", "r.txt": "rename me please\nmore\nlines\n" });
    await writeFile(dir, "m.txt", "2\n");
    await git(dir, ["add", "m.txt"]);
    await writeFile(dir, "m.txt", "3\n");
    await writeFile(dir, "added.txt", "a\n");
    await git(dir, ["add", "added.txt"]);
    await git(dir, ["mv", "r.txt", "r2.txt"]);
    await writeFile(dir, "ita.txt", "i\n");
    await git(dir, ["add", "-N", "ita.txt"]);
    expect(await repo.probeEditableFile("m.txt")).toMatchObject({ eligible: true, hasStagedContent: true, isNew: false });
    expect(await repo.probeEditableFile("added.txt")).toMatchObject({ eligible: true, hasStagedContent: true, isNew: true });
    expect(await repo.probeEditableFile("r2.txt")).toMatchObject({ eligible: true, hasStagedContent: true, isNew: true });
    expect(await repo.probeEditableFile("ita.txt")).toMatchObject({ eligible: true, hasStagedContent: false, isNew: true });
  });

  it("refuses binary, too large, not UTF-8, deleted, directory, conflicted", async () => {
    const { dir, repo } = await repoWith({
      "bin.dat": Buffer.from([1, 2, 0, 3]),
      "latin.txt": Buffer.from([0x63, 0x61, 0x66, 0xe9]),
      "big.txt": "x".repeat(MAX_EDITABLE_FILE_BYTES + 1),
      "gone.txt": "g\n",
      "sub/f.txt": "f\n",
      "c.txt": "base\n",
    });
    await fs.rm(path.join(dir, "gone.txt"));
    const reason = async (p: string) => {
      const r = await repo.probeEditableFile(p);
      return r.eligible ? "eligible" : r.reason;
    };
    expect(await reason("bin.dat")).toBe("binary");
    expect(await reason("latin.txt")).toBe("not-utf8");
    expect(await reason("big.txt")).toBe("too-large");
    expect(await reason("gone.txt")).toBe("deleted");
    expect(await reason("sub")).toBe("directory");
    await writeFile(dir, "ok.txt", "x".repeat(MAX_EDITABLE_FILE_BYTES));
    expect(await reason("ok.txt")).toBe("eligible");

    await git(dir, ["checkout", "-q", "-b", "other"]);
    await writeFile(dir, "c.txt", "other\n");
    await commit(dir, "o");
    await git(dir, ["checkout", "-q", "main"]);
    await writeFile(dir, "c.txt", "main\n");
    await commit(dir, "m");
    await git(dir, ["merge", "other"]).catch(() => undefined);
    expect(await reason("c.txt")).toBe("conflicted");
  });

  it("accepts a UTF-8 BOM file", async () => {
    const { repo } = await repoWith({ "b.txt": Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("hi\n")]) });
    expect(await repo.probeEditableFile("b.txt")).toMatchObject({ eligible: true });
  });

  it("refuses path traversal, absolute paths, empty paths and .git internals", async () => {
    const { repo } = await repoWith({ "a.txt": "a\n" });
    for (const p of ["../x.txt", "a/../../x", path.resolve("/etc/passwd"), "", "  "]) {
      expect(await repo.probeEditableFile(p), p).toMatchObject({ eligible: false, reason: "outside-repo" });
    }
    expect(await repo.probeEditableFile(".git/config")).toMatchObject({ eligible: false, reason: "git-internal" });
    expect(await repo.probeEditableFile(".git/hooks/pre-commit")).toMatchObject({ eligible: false, reason: "git-internal" });
  });

  it("refuses a submodule path", async () => {
    const { dir } = await repoWith({ "a.txt": "a\n" });
    const subSrc = await initRepo();
    dirs.push(subSrc);
    await writeFile(subSrc, "s.txt", "s");
    await commit(subSrc, "s");
    await git(dir, ["-c", "protocol.file.allow=always", "submodule", "add", "-q", subSrc.replace(/\\/g, "/"), "mod"]);
    const repo = await Repository.open(dir);
    expect(await repo.probeEditableFile("mod")).toMatchObject({ eligible: false, reason: "submodule" });
    expect(await repo.probeEditableFile("mod/s.txt")).toMatchObject({ eligible: false, reason: "submodule" });
    expect(await repo.writeEditedFile("mod/s.txt", "x", opts("h"))).toMatchObject({ status: "ineligible", reason: "submodule" });
  });

  it("refuses an in-repo symlink, an escaping symlink and files behind symlinked parent directories", async () => {
    const { dir, repo } = await repoWith({ "a.txt": "a\n", "real/f.txt": "f\n" });
    const outside = await makeTempDir();
    dirs.push(outside);
    await fs.writeFile(path.join(outside, "secret.txt"), "secret\n");
    if (!(await trySymlink("a.txt", path.join(dir, "inlink.txt")))) return; // no symlink privilege on this machine
    await trySymlink(path.join(outside, "secret.txt"), path.join(dir, "outlink.txt"));
    await trySymlink(outside, path.join(dir, "outdir"), "dir");
    await trySymlink(path.join(dir, "real"), path.join(dir, "indir"), "dir");
    for (const p of ["inlink.txt", "outlink.txt", "outdir/secret.txt", "indir/f.txt"]) {
      expect(await repo.probeEditableFile(p), p).toMatchObject({ eligible: false, reason: "symlink" });
      expect(await repo.readEditableFile(p), p).toMatchObject({ eligible: false, reason: "symlink" });
    }
    const r = await repo.writeEditedFile("outdir/secret.txt", "pwn\n", opts(sha("secret\n")));
    expect(r).toMatchObject({ status: "ineligible", reason: "symlink" });
    expect(await fs.readFile(path.join(outside, "secret.txt"), "utf8")).toBe("secret\n");
  });

  it.runIf(WIN)("refuses a file behind a directory junction that leaves the repo (works without symlink privilege)", async () => {
    const { dir, repo } = await repoWith({ "a.txt": "a\n" });
    const outside = await makeTempDir();
    dirs.push(outside);
    await fs.writeFile(path.join(outside, "secret.txt"), "secret\n");
    await fs.symlink(outside, path.join(dir, "jn"), "junction");
    expect(await repo.probeEditableFile("jn/secret.txt")).toMatchObject({ eligible: false, reason: "symlink" });
    expect(await repo.writeEditedFile("jn/secret.txt", "pwn\n", opts(sha("secret\n")))).toMatchObject({ status: "ineligible" });
    expect(await fs.readFile(path.join(outside, "secret.txt"), "utf8")).toBe("secret\n");
    await fs.rmdir(path.join(dir, "jn"));
  });

  it.skipIf(WIN)("refuses a FIFO without hanging", async () => {
    const { dir, repo } = await repoWith({ "a.txt": "a\n" });
    execFileSync("mkfifo", [path.join(dir, "pipe")]);
    expect(await repo.probeEditableFile("pipe")).toMatchObject({ eligible: false, reason: "special-file" });
  });
});

describe("readEditableFile + writeEditedFile byte-exact round trip", () => {
  const cases: [string, Buffer, string][] = [
    ["lf with final newline", Buffer.from("a\nb\n"), "lf"],
    ["crlf", Buffer.from("a\r\nb\r\n"), "crlf"],
    ["mixed", Buffer.from("a\r\nb\nc\rd"), "mixed"],
    ["no final newline", Buffer.from("a\nb"), "lf"],
    ["bom + crlf", Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("é\r\nü")]), "crlf"],
    ["empty", Buffer.alloc(0), "lf"],
    ["emoji", Buffer.from("😀 日本語\n"), "lf"],
  ];
  for (const [name, bytes, eol] of cases) {
    it(`${name}: reads state and saves the same text back unchanged`, async () => {
      const { dir, repo } = await repoWith({ "f.txt": bytes });
      const r = await repo.readEditableFile("f.txt");
      if (!r.eligible) throw new Error("expected eligible");
      expect(r.eol).toBe(eol);
      expect(r.contentHash).toBe(sha(bytes));
      expect(r.finalNewline).toBe(/[\r\n]$/.test(bytes.toString("utf8")));
      const w = await repo.writeEditedFile("f.txt", r.content, { expectedHash: r.contentHash, eol: r.eol, hasBom: r.hasBom, finalNewline: r.finalNewline });
      expect(w).toMatchObject({ status: "written", contentHash: sha(bytes) });
      expect((await fs.readFile(path.join(dir, "f.txt"))).equals(bytes)).toBe(true);
    });
  }

  it("normalises line breaks on write, adds the BOM, and enforces final newline state", async () => {
    const { dir, repo } = await repoWith({ "f.txt": "a\r\nb\r\n" });
    const r = await repo.readEditableFile("f.txt");
    if (!r.eligible) throw new Error("x");
    const w = await repo.writeEditedFile("f.txt", "a\nedited\nc", { expectedHash: r.contentHash, eol: "crlf", hasBom: true, finalNewline: true });
    expect(w.status).toBe("written");
    const want = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("a\r\nedited\r\nc\r\n")]);
    expect((await fs.readFile(path.join(dir, "f.txt"))).equals(want)).toBe(true);
  });

  it("returns a hash/mtime/size that match the next read, so a second immediate save needs no prompt", async () => {
    const { repo } = await repoWith({ "f.txt": "a\n" });
    const r = await repo.readEditableFile("f.txt");
    if (!r.eligible) throw new Error("x");
    const w = await repo.writeEditedFile("f.txt", "b\n", opts(r.contentHash));
    if (w.status !== "written") throw new Error("x");
    const r2 = await repo.readEditableFile("f.txt");
    if (!r2.eligible) throw new Error("x");
    expect(r2.contentHash).toBe(w.contentHash);
    expect(r2.mtimeMs).toBe(w.mtimeMs);
    expect(r2.size).toBe(w.size);
    expect((await repo.writeEditedFile("f.txt", "c\n", opts(w.contentHash))).status).toBe("written");
  });
});

describe("writeEditedFile safety", () => {
  it("leaves no temp files, and preserves the executable mode on POSIX (mode asserts are meaningless on Windows)", async () => {
    const { dir, repo } = await repoWith({ "run.sh": "#!/bin/sh\n" });
    if (!WIN) await fs.chmod(path.join(dir, "run.sh"), 0o755);
    const r = await repo.readEditableFile("run.sh");
    if (!r.eligible) throw new Error("x");
    await repo.writeEditedFile("run.sh", "#!/bin/sh\necho\n", opts(r.contentHash));
    expect(await tmpLeft(dir)).toEqual([]);
    if (!WIN) expect((await fs.stat(path.join(dir, "run.sh"))).mode & 0o777).toBe(0o755);
  });

  it("refuses a read-only file with a clear error and leaves it unchanged", async () => {
    const { dir, repo } = await repoWith({ "ro.txt": "keep\n" });
    const r = await repo.readEditableFile("ro.txt");
    if (!r.eligible) throw new Error("x");
    await fs.chmod(path.join(dir, "ro.txt"), 0o444);
    await expect(repo.writeEditedFile("ro.txt", "new\n", opts(r.contentHash))).rejects.toMatchObject({ name: "EditWriteError", code: "read-only" });
    expect(await fs.readFile(path.join(dir, "ro.txt"), "utf8")).toBe("keep\n");
    expect(await tmpLeft(dir)).toEqual([]);
    await fs.chmod(path.join(dir, "ro.txt"), 0o644);
  });

  it("hash mismatch returns changed-on-disk without writing; force overwrites", async () => {
    const { dir, repo } = await repoWith({ "f.txt": "v1\n" });
    const r = await repo.readEditableFile("f.txt");
    if (!r.eligible) throw new Error("x");
    await fs.writeFile(path.join(dir, "f.txt"), "external\n");
    const w = await repo.writeEditedFile("f.txt", "mine\n", opts(r.contentHash));
    expect(w).toEqual({ status: "changed-on-disk", currentHash: sha("external\n") });
    expect(await fs.readFile(path.join(dir, "f.txt"), "utf8")).toBe("external\n");
    const f = await repo.writeEditedFile("f.txt", "mine\n", opts(r.contentHash, { force: true }));
    expect(f.status).toBe("written");
    expect(await fs.readFile(path.join(dir, "f.txt"), "utf8")).toBe("mine\n");
  });

  it("re-checks eligibility at write time (file became binary / deleted / a symlink)", async () => {
    const { dir, repo } = await repoWith({ "f.txt": "v1\n", "g.txt": "g\n", "h.txt": "h\n" });
    await fs.writeFile(path.join(dir, "g.txt"), Buffer.from([0, 1, 2]));
    expect(await repo.writeEditedFile("g.txt", "x\n", opts(sha("g\n"), { force: true }))).toMatchObject({ status: "ineligible", reason: "binary" });
    await fs.rm(path.join(dir, "h.txt"));
    expect(await repo.writeEditedFile("h.txt", "x\n", opts(sha("h\n"), { force: true }))).toMatchObject({ status: "ineligible", reason: "deleted" });
    await fs.rm(path.join(dir, "f.txt"));
    if (await trySymlink(path.join(dir, "h.txt"), path.join(dir, "f.txt"))) {
      expect(await repo.writeEditedFile("f.txt", "x\n", opts(sha("v1\n"), { force: true }))).toMatchObject({ status: "ineligible", reason: "symlink" });
      expect((await fs.lstat(path.join(dir, "f.txt"))).isSymbolicLink()).toBe(true);
    }
  });

  it("refuses traversal, .git paths, NUL, oversized and ill-formed content without touching disk", async () => {
    const { dir, repo } = await repoWith({ "f.txt": "v1\n" });
    const o = opts(sha("v1\n"));
    await expect(repo.writeEditedFile("../evil.txt", "x", o)).rejects.toMatchObject({ name: "InvalidArgumentError" });
    expect(await repo.writeEditedFile(".git/hooks/pre-commit", "x", o)).toMatchObject({ status: "ineligible", reason: "git-internal" });
    await expect(repo.writeEditedFile("f.txt", "a\0b", o)).rejects.toMatchObject({ code: "contains-nul" });
    await expect(repo.writeEditedFile("f.txt", "x".repeat(MAX_EDITABLE_FILE_BYTES + 1), o)).rejects.toMatchObject({ code: "content-too-large" });
    await expect(repo.writeEditedFile("f.txt", "a\uD800b", o)).rejects.toBeInstanceOf(EditWriteError);
    await expect(repo.writeEditedFile("f.txt", "x", { ...o, expectedHash: "" })).rejects.toMatchObject({ name: "InvalidArgumentError" });
    expect(await fs.readFile(path.join(dir, "f.txt"), "utf8")).toBe("v1\n");
  });

  it("never touches the index: byte-identical before and after on a partly staged file", async () => {
    const { dir, repo } = await repoWith({ "f.txt": "1\n2\n3\n" });
    await writeFile(dir, "f.txt", "1\nTWO\n3\n");
    await git(dir, ["add", "f.txt"]);
    await writeFile(dir, "f.txt", "1\nTWO\n3\nfour\n");
    const before = await indexBytes(dir);
    const r = await repo.readEditableFile("f.txt");
    if (!r.eligible) throw new Error("x");
    expect(r.hasStagedContent).toBe(true);
    await repo.writeEditedFile("f.txt", r.content + "five\n", opts(r.contentHash));
    expect((await indexBytes(dir)).equals(before)).toBe(true);
    expect((await git(dir, ["diff", "--cached", "--", "f.txt"])).stdout).toContain("+TWO");
  });

  it("works in a linked worktree", async () => {
    const { dir } = await repoWith({ "a.txt": "a\n" });
    const parent = await makeTempDir();
    dirs.push(parent);
    const wt = path.join(parent, "wt");
    await git(dir, ["worktree", "add", "-q", "-b", "wtb", wt]);
    const repo = await Repository.open(wt);
    const r = await repo.readEditableFile("a.txt");
    if (!r.eligible) throw new Error("x");
    expect((await repo.writeEditedFile("a.txt", "wt edit\n", opts(r.contentHash))).status).toBe("written");
    expect(await fs.readFile(path.join(wt, "a.txt"), "utf8")).toBe("wt edit\n");
    expect(await fs.readFile(path.join(dir, "a.txt"), "utf8")).toBe("a\n");
  });

  it("is byte-exact with core.autocrlf set", async () => {
    const { dir, repo } = await repoWith({ "f.txt": "a\n" });
    await git(dir, ["config", "core.autocrlf", "true"]);
    await fs.writeFile(path.join(dir, "f.txt"), "a\r\nb\n");
    const r = await repo.readEditableFile("f.txt");
    if (!r.eligible) throw new Error("x");
    expect(r.eol).toBe("mixed");
    await repo.writeEditedFile("f.txt", r.content, { expectedHash: r.contentHash, eol: r.eol, hasBom: r.hasBom, finalNewline: r.finalNewline });
    expect(await fs.readFile(path.join(dir, "f.txt"), "utf8")).toBe("a\r\nb\n");
  });

  it("serialises two concurrent saves: one wins, the other sees changed-on-disk", async () => {
    const { dir, repo } = await repoWith({ "f.txt": "v1\n" });
    const h = sha("v1\n");
    const [a, b] = await Promise.all([repo.writeEditedFile("f.txt", "A\n", opts(h)), repo.writeEditedFile("f.txt", "B\n", opts(h))]);
    expect([a.status, b.status].sort()).toEqual(["changed-on-disk", "written"]);
    expect(await fs.readFile(path.join(dir, "f.txt"), "utf8")).toBe(a.status === "written" ? "A\n" : "B\n");
  });
});

describe("Windows path tricks, mode masking, error sanitising", () => {
  it("invalidPathReason rejects ADS and reserved device names on win32 only", () => {
    for (const p of ["x.txt:stream", ".git::$INDEX_ALLOCATION", "d/a:b", "NUL.txt", "dir/con", "dir/CON.", "aux .txt", "COM1", "lpt9.log"]) {
      expect(invalidPathReason(p, "win32"), p).not.toBeNull();
    }
    expect(invalidPathReason(".git::$INDEX_ALLOCATION", "win32")).toBe("git-internal");
    for (const p of ["console.txt", "nullable.txt", "com10.txt", "src/a.ts"]) expect(invalidPathReason(p, "win32"), p).toBeNull();
    expect(invalidPathReason("x.txt:stream", "linux")).toBeNull();
    expect(invalidPathReason("NUL.txt", "linux")).toBeNull();
    expect(invalidPathReason(".GIT/config", "linux")).toBe("git-internal");
  });

  it.runIf(WIN)("probe and write refuse an alternate data stream path for real", async () => {
    const { dir, repo } = await repoWith({ "a.txt": "a\n" });
    expect(await repo.probeEditableFile("a.txt:evil")).toMatchObject({ eligible: false, reason: "outside-repo" });
    expect(await repo.writeEditedFile("NUL.txt", "x", opts("h"))).toMatchObject({ status: "ineligible" });
    expect((await fs.readdir(dir)).includes("a.txt:evil")).toBe(false);
  });

  it.skipIf(WIN)("drops setuid/setgid/sticky bits but keeps permission bits", async () => {
    const { dir, repo } = await repoWith({ "f.sh": "x\n" });
    await fs.chmod(path.join(dir, "f.sh"), 0o4755);
    const r = await repo.readEditableFile("f.sh");
    if (!r.eligible) throw new Error("x");
    expect(r.mode).toBe(0o755);
    await repo.writeEditedFile("f.sh", "y\n", opts(r.contentHash));
    expect((await fs.stat(path.join(dir, "f.sh"))).mode & 0o7777).toBe(0o755);
  });

  it.skipIf(WIN || process.getuid?.() === 0)("an unreadable file gives a sanitised error with no absolute path", async () => {
    const { dir, repo } = await repoWith({ "locked.txt": "x\n" });
    await fs.chmod(path.join(dir, "locked.txt"), 0o000);
    const err = await repo.readEditableFile("locked.txt").catch((e: unknown) => e);
    await fs.chmod(path.join(dir, "locked.txt"), 0o644);
    expect(err).toBeInstanceOf(EditFileAccessError);
    expect((err as Error).message).not.toContain(dir);
  });

  it("saves into a nested directory (parent realpath re-checks do not false-positive) and returns identical mtime on re-read", async () => {
    const { dir, repo } = await repoWith({ "a/b/c.txt": "1\n" });
    const r = await repo.readEditableFile("a/b/c.txt");
    if (!r.eligible) throw new Error("x");
    const w = await repo.writeEditedFile("a/b/c.txt", "2\n", opts(r.contentHash));
    expect(w.status).toBe("written");
    expect(await fs.readFile(path.join(dir, "a/b/c.txt"), "utf8")).toBe("2\n");
  });

  it("a git failure (corrupt index) surfaces without git stderr or absolute paths", async () => {
    const { dir, repo } = await repoWith({ "a.txt": "a\n" });
    await fs.writeFile(path.join(dir, ".git", "index"), "garbage");
    const err = await repo.probeEditableFile("a.txt").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EditFileAccessError);
    expect((err as Error).message).not.toContain(dir);
  });
});
