// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  planIgnore,
  ignorePaths,
  ignoreAndStopTracking,
  buildIgnoreRule,
  escapeIgnorePattern,
  appendIgnoreRules,
  _setIgnoreBeforeRenameHookForTests,
  _setIgnoreAfterWriteHookForTests,
  _checkIgnoreForTests,
} from "../src/ignore";
import { IgnoreFileChangedError, IgnorePlanChangedError, IgnoreUntrackError, IgnoreWriteError, InvalidArgumentError } from "../src/errors";
import { Repository } from "../src/index";
import { git, initRepo, writeFile, commit, cleanup, makeTempDir, fileExists } from "./testRepo";

const dirs: string[] = [];
afterEach(async () => {
  _setIgnoreBeforeRenameHookForTests(null);
  _setIgnoreAfterWriteHookForTests(null);
  while (dirs.length) await cleanup(dirs.pop()!);
});

async function repo(): Promise<string> {
  const d = await initRepo();
  dirs.push(d);
  await git(d, ["config", "core.autocrlf", "false"]);
  return d;
}

async function status(d: string): Promise<string> {
  return (await git(d, ["status", "--porcelain=v1", "--untracked-files=all"])).stdout;
}

async function isIgnored(d: string, p: string): Promise<boolean> {
  try {
    await git(d, ["check-ignore", "-q", "--no-index", "--", p]);
    return true;
  } catch {
    return false;
  }
}

const win = process.platform === "win32";

describe("rule building (FR-494, FR-496)", () => {
  it("builds anchored name, extension and directory rules", () => {
    expect(buildIgnoreRule("sub/file.txt", false, "name", "").rule).toBe("/sub/file.txt");
    expect(buildIgnoreRule("a.tar.gz", false, "extension", "").rule).toBe("*.gz");
    expect(buildIgnoreRule("build/out/x.js", false, "directory", "").rule).toBe("/build/out/");
    expect(buildIgnoreRule("a/b/c.txt", false, "name", "a/b").rule).toBe("/c.txt");
    expect(buildIgnoreRule("a/b/c.txt", false, "directory", "a").rule).toBe("/b/");
  });

  it("refuses extension for dotfiles and extensionless names, directory for root files", () => {
    expect(buildIgnoreRule(".env", false, "extension", "").code).toBe("no-extension");
    expect(buildIgnoreRule("Makefile", false, "extension", "").code).toBe("no-extension");
    expect(buildIgnoreRule("file.", false, "extension", "").code).toBe("no-extension");
    expect(buildIgnoreRule("x.txt", false, "directory", "").code).toBe("no-parent-directory");
    expect(buildIgnoreRule(".env.local", false, "extension", "").rule).toBe("*.local");
  });

  it("refuses CR, LF and NUL names without producing a rule", () => {
    for (const bad of ["a\nb.txt", "a\rb.txt", "a\0b.txt"]) {
      const r = buildIgnoreRule(bad, false, "name", "");
      expect(r.rule).toBeUndefined();
      expect(r.code).toBe("unrepresentable-name");
    }
  });

  it("escapes special characters and a trailing space; never emits a backslash path separator", () => {
    expect(escapeIgnorePattern("x[1].txt")).toBe("x\\[1\\].txt");
    expect(escapeIgnorePattern("we*rd?.txt")).toBe("we\\*rd\\?.txt");
    expect(escapeIgnorePattern("#a")).toBe("\\#a");
    expect(escapeIgnorePattern("!b")).toBe("\\!b");
    expect(escapeIgnorePattern("a b ")).toBe("a b\\ ");
    expect(buildIgnoreRule("dir/sub/f.txt", false, "name", "").rule).not.toContain("\\");
  });

  it("every escaped rule matches exactly its file under real git (AC4)", async () => {
    const d = await repo();
    const names = ["#a", "!b", "a b ", "x[1].txt", "we*rd.txt", "héllo wörld.txt", "日本語.md", ...(win ? [] : ["back\\slash.txt"]), "q?.txt"];
    for (const n of names) {
      const rule = buildIgnoreRule(n, false, "name", "").rule!;
      await fs.writeFile(path.join(d, ".git", "info", "exclude"), rule + "\n");
      expect(await isIgnored(d, n), `rule ${rule} must match ${JSON.stringify(n)}`).toBe(true);
      for (const sib of ["a", "b", "x1.txt", "xx.txt", "weird.txt", "q1.txt", "a b", "#", "!"]) {
        if (sib !== n) expect(await isIgnored(d, sib), `${rule} must not match ${sib}`).toBe(false);
      }
    }
  });
});

describe("check-ignore path handling (FR-499)", () => {
  it("treats magic-looking and glob-looking names literally", async () => {
    const d = await repo();
    await fs.writeFile(path.join(d, ".git", "info", "exclude"), [String.raw`/\:(glob)\*`, String.raw`/\[ab\].txt`, ""].join(String.fromCharCode(10)));
    const m = await _checkIgnoreForTests(d, [":(glob)*", "[ab].txt", "a.txt", "x"]);
    expect(m.get(":(glob)*")).toMatchObject({ negated: false, line: 1 });
    expect(m.get("[ab].txt")).toMatchObject({ negated: false, line: 2 });
    expect(m.get("a.txt")).toBeNull();
    expect(m.get("x")).toBeNull();
  });
});

describe("appendIgnoreRules fidelity (FR-498, AC3)", () => {
  it("keeps BOM and CRLF, adds one CRLF line", () => {
    const orig = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("a\r\nb\r\n")]);
    const r = appendIgnoreRules(orig, ["/x"]);
    expect(r.bytes.equals(Buffer.concat([orig, Buffer.from("/x\r\n")]))).toBe(true);
  });
  it("adds the missing final newline in the dominant EOL", () => {
    expect(appendIgnoreRules(Buffer.from("a\r\nb"), ["/x"]).bytes.toString()).toBe("a\r\nb\r\n/x\r\n");
    expect(appendIgnoreRules(Buffer.from("a\nb"), ["/x"]).bytes.toString()).toBe("a\nb\n/x\n");
  });
  it("empty file gets LF, no BOM; BOM-only file keeps its BOM", () => {
    expect(appendIgnoreRules(Buffer.alloc(0), ["/x"]).bytes.toString()).toBe("/x\n");
    const bomOnly = Buffer.from([0xef, 0xbb, 0xbf]);
    expect(appendIgnoreRules(bomOnly, ["/x"]).bytes.equals(Buffer.concat([bomOnly, Buffer.from("/x\n")]))).toBe(true);
  });
  it("identical line (trailing CR ignored) is present and bytes are returned untouched", () => {
    const orig = Buffer.from("/x\r\nfoo\r\n");
    const r = appendIgnoreRules(orig, ["/x"]);
    expect(r.present).toEqual(["/x"]);
    expect(r.bytes).toBe(orig);
  });
});

describe("ignorePaths against real repos", () => {
  it("name/extension/directory write one anchored rule to the root .gitignore (AC1)", async () => {
    const d = await repo();
    await writeFile(d, "keep.txt", "k");
    await commit(d, "base");
    await writeFile(d, "app.log", "x");
    await writeFile(d, "sub/dir/file.txt", "x");
    await writeFile(d, "build/out.js", "x");

    const r1 = await ignorePaths(d, { paths: ["sub/dir/file.txt"], scope: "name", target: "root" });
    expect(r1.rows[0]).toMatchObject({ outcome: "written", rule: "/sub/dir/file.txt", file: ".gitignore" });
    const r2 = await ignorePaths(d, { paths: ["app.log"], scope: "extension", target: "root" });
    expect(r2.rows[0]).toMatchObject({ outcome: "written", rule: "*.log" });
    const r3 = await ignorePaths(d, { paths: ["build/out.js"], scope: "directory", target: "root" });
    expect(r3.rows[0]).toMatchObject({ outcome: "written", rule: "/build/" });

    expect(await fs.readFile(path.join(d, ".gitignore"), "utf8")).toBe("/sub/dir/file.txt\n*.log\n/build/\n");
    expect((await status(d)).trim()).toBe("?? .gitignore");
    expect(r1.files[0]).toMatchObject({ file: ".gitignore", created: true, rules: ["/sub/dir/file.txt"] });
  });

  it("nearest writes into a/b/.gitignore relative to a/b; with none it creates the root file (AC2)", async () => {
    const d = await repo();
    await writeFile(d, "a/b/.gitignore", "old\n");
    await writeFile(d, "a/b/c/x.txt", "x");
    await writeFile(d, "other/y.txt", "y");
    await commit(d, "base");
    await writeFile(d, "a/b/c/new.txt", "x");
    await writeFile(d, "other/new.txt", "x");

    const r = await ignorePaths(d, { paths: ["a/b/c/new.txt"], scope: "name", target: "nearest" });
    expect(r.rows[0]).toMatchObject({ outcome: "written", rule: "/c/new.txt", file: "a/b/.gitignore" });
    expect(await fs.readFile(path.join(d, "a/b/.gitignore"), "utf8")).toBe("old\n/c/new.txt\n");

    const r2 = await ignorePaths(d, { paths: ["other/new.txt"], scope: "name", target: "nearest" });
    expect(r2.rows[0]).toMatchObject({ outcome: "written", rule: "/other/new.txt", file: ".gitignore" });
    expect(await fileExists(path.join(d, ".gitignore"))).toBe(true);
    expect(await fileExists(path.join(d, "other/.gitignore"))).toBe(false);
  });

  it("exclude target leaves .gitignore alone and adds nothing to status (AC2)", async () => {
    const d = await repo();
    await writeFile(d, "base.txt", "b");
    await commit(d, "base");
    await writeFile(d, "secret.env", "s");
    const r = await ignorePaths(d, { paths: ["secret.env"], scope: "name", target: "exclude" });
    expect(r.rows[0]).toMatchObject({ outcome: "written", file: ".git/info/exclude" });
    expect(await fileExists(path.join(d, ".gitignore"))).toBe(false);
    expect(await fs.readFile(path.join(d, ".git", "info", "exclude"), "utf8")).toContain("/secret.env\n");
    expect(await status(d)).toBe("");
    expect(r.files[0]!.sharedWithOtherWorktrees).toBe(false);
  });

  it("in a linked worktree the exclude is the shared one and is flagged as shared (AC2)", async () => {
    const d = await repo();
    await writeFile(d, "base.txt", "b");
    await commit(d, "base");
    const wt = path.join(await makeTempDir(), "wt");
    dirs.push(path.dirname(wt));
    await git(d, ["worktree", "add", "-q", wt, "-b", "side"]);
    await writeFile(wt, "n.tmp", "x");
    const r = await ignorePaths(wt, { paths: ["n.tmp"], scope: "name", target: "exclude" });
    expect(r.rows[0]!.outcome).toBe("written");
    expect(r.files[0]!.sharedWithOtherWorktrees).toBe(true);
    expect(await fs.readFile(path.join(d, ".git", "info", "exclude"), "utf8")).toContain("/n.tmp\n");
    expect(await status(wt)).toBe("");
  });

  it("keeps BOM and CRLF of a real file when appending (AC3)", async () => {
    const d = await repo();
    await writeFile(d, "base.txt", "b");
    await commit(d, "base");
    const orig = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("*.o\r\nnode_modules/")]);
    await fs.writeFile(path.join(d, ".gitignore"), orig);
    await commit(d, "ignore file");
    await writeFile(d, "x.tmp", "x");
    await ignorePaths(d, { paths: ["x.tmp"], scope: "name", target: "root" });
    const after = await fs.readFile(path.join(d, ".gitignore"));
    expect(after.equals(Buffer.concat([orig, Buffer.from("\r\n/x.tmp\r\n")]))).toBe(true);
  });

  it("repeat of an identical rule is a no-op reporting already-in (AC3)", async () => {
    const d = await repo();
    await writeFile(d, "base.txt", "b");
    await commit(d, "base");
    // Tracked file so it stays in the request even after being ignored; --no-index still sees the rule.
    await writeFile(d, "t.log", "x");
    await commit(d, "t");
    await fs.writeFile(path.join(d, ".gitignore"), "/other\n/t.log\n");
    const before = await fs.readFile(path.join(d, ".gitignore"));
    const r = await ignorePaths(d, { paths: ["t.log"], scope: "name", target: "root" });
    expect(r.rows[0]).toMatchObject({ outcome: "already-in", file: ".gitignore" });
    expect((await fs.readFile(path.join(d, ".gitignore"))).equals(before)).toBe(true);
    expect(r.files[0]!.rules).toEqual([]);
  });

  it("an empty and a no-trailing-newline target each gain exactly one line", async () => {
    const d = await repo();
    await writeFile(d, "base.txt", "b");
    await commit(d, "base");
    await fs.writeFile(path.join(d, ".gitignore"), "");
    await writeFile(d, "a.tmp", "x");
    await ignorePaths(d, { paths: ["a.tmp"], scope: "name", target: "root" });
    expect(await fs.readFile(path.join(d, ".gitignore"), "utf8")).toBe("/a.tmp\n");
    await fs.writeFile(path.join(d, ".gitignore"), "keep");
    await writeFile(d, "b.tmp", "x");
    await ignorePaths(d, { paths: ["b.tmp"], scope: "name", target: "root" });
    expect(await fs.readFile(path.join(d, ".gitignore"), "utf8")).toBe("keep\n/b.tmp\n");
  });

  it("real files with special names get a rule that matches only them; siblings stay untracked (AC4)", async () => {
    const d = await repo();
    await writeFile(d, "base.txt", "b");
    await commit(d, "base");
    const names = ["#a", "!b", "x[1].txt", "héllo wörld.txt", "日本語.md", ...(win ? [] : ["we*rd.txt", ":(glob)*", "*.txt", "a b "])];
    for (const n of names) await writeFile(d, n, "x");
    await writeFile(d, "x1.txt", "x");
    await writeFile(d, "sibling.md", "x");
    for (const n of names) {
      const r = await ignorePaths(d, { paths: [n], scope: "name", target: "exclude" });
      expect(r.rows[0]!.outcome, n).toBe("written");
    }
    const st = (await status(d)).trim().split("\n").sort();
    expect(st).toEqual(["?? sibling.md", "?? x1.txt"]);
  });

  it.skipIf(win)("a name with a newline is refused with a reason and nothing is written (AC4)", async () => {
    const d = await repo();
    await writeFile(d, "base.txt", "b");
    await commit(d, "base");
    await writeFile(d, "bad\nname.txt", "x");
    const r = await ignorePaths(d, { paths: ["bad\nname.txt"], scope: "name", target: "root" });
    expect(r.rows[0]).toMatchObject({ outcome: "refused", reasonCode: "unrepresentable-name" });
    expect(await fileExists(path.join(d, ".gitignore"))).toBe(false);
  });

  it("a path ignored by another file reports already-ignored with source:line and writes nothing (AC5)", async () => {
    const d = await repo();
    await writeFile(d, "base.txt", "b");
    await commit(d, "base");
    await fs.writeFile(path.join(d, ".gitignore"), "node_modules/\n*.log\n");
    await commit(d, "ignore");
    await writeFile(d, "t.log", "x");
    await git(d, ["add", "-f", "t.log"]);
    await git(d, ["commit", "-q", "-m", "force"]);
    // tracked file already matched by *.log (--no-index)
    const r = await ignorePaths(d, { paths: ["t.log"], scope: "name", target: "exclude" });
    expect(r.rows[0]).toMatchObject({ outcome: "already-ignored", tracked: true });
    expect(r.rows[0]!.ignoredBy).toMatchObject({ source: ".gitignore", line: 2, pattern: "*.log" });
    expect(await fileExists(path.join(d, ".git", "info", "exclude"))).toBe(true);
    expect(await fs.readFile(path.join(d, ".git", "info", "exclude"), "utf8")).not.toContain("t.log");
  });

  it("a later ! rule that still wins gives an honest still-not-ignored (AC5)", async () => {
    const d = await repo();
    await writeFile(d, "base.txt", "b");
    await fs.writeFile(path.join(d, ".gitignore"), "*.log\n!keep.log\n");
    await commit(d, "base");
    await writeFile(d, "keep.log", "x");
    const r = await ignorePaths(d, { paths: ["keep.log"], scope: "name", target: "exclude" });
    expect(r.rows[0]).toMatchObject({ outcome: "still-not-ignored" });
    expect(r.rows[0]!.ignoredBy).toMatchObject({ source: ".gitignore", line: 2 });
  });

  it("bulk: shared extension is one rule, one write; directory scope dedupes directories", async () => {
    const d = await repo();
    await writeFile(d, "base.txt", "b");
    await commit(d, "base");
    await writeFile(d, "a.log", "x");
    await writeFile(d, "sub/b.log", "x");
    await writeFile(d, "d1/x.txt", "x");
    await writeFile(d, "d1/y.txt", "x");
    await writeFile(d, "d2/z.txt", "x");
    const r = await ignorePaths(d, { paths: ["a.log", "sub/b.log"], scope: "extension", target: "root" });
    expect(r.rows.map((x) => x.outcome)).toEqual(["written", "written"]);
    expect(await fs.readFile(path.join(d, ".gitignore"), "utf8")).toBe("*.log\n");
    const r2 = await ignorePaths(d, { paths: ["d1/x.txt", "d1/y.txt", "d2/z.txt"], scope: "directory", target: "root" });
    expect(r2.files[0]!.rules).toEqual(["/d1/", "/d2/"]);
    expect(await fs.readFile(path.join(d, ".gitignore"), "utf8")).toBe("*.log\n/d1/\n/d2/\n");
  });

  it("re-reads once when the file changes during the write, then fails writing nothing", async () => {
    const d = await repo();
    await writeFile(d, "base.txt", "b");
    await fs.writeFile(path.join(d, ".gitignore"), "one\n");
    await commit(d, "base");
    await writeFile(d, "n.tmp", "x");
    let calls = 0;
    _setIgnoreBeforeRenameHookForTests(async (abs) => {
      if (calls++ === 0) await fs.writeFile(abs, "one\nconcurrent\n");
    });
    await ignorePaths(d, { paths: ["n.tmp"], scope: "name", target: "root" });
    expect(await fs.readFile(path.join(d, ".gitignore"), "utf8")).toBe("one\nconcurrent\n/n.tmp\n");

    await writeFile(d, "m.tmp", "x");
    let n = 0;
    _setIgnoreBeforeRenameHookForTests(async (abs) => {
      await fs.writeFile(abs, `changed${n++}\n`);
    });
    await expect(ignorePaths(d, { paths: ["m.tmp"], scope: "name", target: "root" })).rejects.toBeInstanceOf(IgnoreFileChangedError);
    expect(await fs.readFile(path.join(d, ".gitignore"), "utf8")).toBe("changed1\n");
    const leftovers = (await fs.readdir(d)).filter((f) => f.includes("githydra"));
    expect(leftovers).toEqual([]);
  });
});

describe("containment and eligibility (FR-499, FR-501, AC8)", () => {
  it("refuses traversal and absolute paths, and paths not in status", async () => {
    const d = await repo();
    await writeFile(d, "base.txt", "b");
    await commit(d, "base");
    await expect(ignorePaths(d, { paths: ["../x"], scope: "name", target: "root" })).rejects.toBeInstanceOf(InvalidArgumentError);
    await expect(ignorePaths(d, { paths: [path.resolve(d, "base.txt")], scope: "name", target: "root" })).rejects.toBeInstanceOf(InvalidArgumentError);
    const r = await ignorePaths(d, { paths: ["nonexistent.txt"], scope: "name", target: "root" });
    expect(r.rows[0]).toMatchObject({ outcome: "refused", reasonCode: "not-in-status" });
    expect(await fileExists(path.join(d, ".gitignore"))).toBe(false);
  });

  it("refuses a file under a symlinked parent folder; nothing written", async () => {
    const d = await repo();
    await writeFile(d, "base.txt", "b");
    await commit(d, "base");
    const outside = await makeTempDir();
    dirs.push(outside);
    await writeFile(outside, "f.txt", "x");
    try {
      await fs.symlink(outside, path.join(d, "lnk"), "junction");
    } catch {
      return;
    }
    const r = await ignorePaths(d, { paths: ["lnk/f.txt"], scope: "name", target: "root" });
    expect(r.rows[0]!.outcome).toBe("refused");
    expect(await fileExists(path.join(d, ".gitignore"))).toBe(false);
  });

  it("refuses a symlinked .gitignore and a symlinked info folder", async () => {
    const d = await repo();
    await writeFile(d, "base.txt", "b");
    await commit(d, "base");
    await writeFile(d, "n.tmp", "x");
    const outside = await makeTempDir();
    dirs.push(outside);
    await fs.writeFile(path.join(outside, "target"), "precious\n");
    try {
      await fs.symlink(path.join(outside, "target"), path.join(d, ".gitignore"), "file");
    } catch {
      return; // no symlink privilege
    }
    const r = await ignorePaths(d, { paths: ["n.tmp"], scope: "name", target: "root" });
    expect(r.rows[0]).toMatchObject({ outcome: "refused", reasonCode: "target-unsafe" });
    expect(await fs.readFile(path.join(outside, "target"), "utf8")).toBe("precious\n");

    await fs.rm(path.join(d, ".gitignore"));
    await fs.rm(path.join(d, ".git", "info"), { recursive: true, force: true });
    await fs.symlink(outside, path.join(d, ".git", "info"), "junction");
    const r2 = await ignorePaths(d, { paths: ["n.tmp"], scope: "name", target: "exclude" });
    expect(r2.rows[0]).toMatchObject({ outcome: "refused", reasonCode: "target-unsafe" });
    expect(await fileExists(path.join(outside, "exclude"))).toBe(false);
  });

  it("a glob-looking name operates on that literal file only", async () => {
    const d = await repo();
    await writeFile(d, "base.txt", "b");
    await commit(d, "base");
    await writeFile(d, "[ab].txt", "x");
    await writeFile(d, "a.txt", "x");
    await ignorePaths(d, { paths: ["[ab].txt"], scope: "name", target: "root" });
    expect((await status(d)).trim().split("\n").sort()).toEqual(["?? .gitignore", "?? a.txt"]);
  });

  it("refuses conflicted rows and submodule gitlinks", async () => {
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
    const r = await ignorePaths(d, { paths: ["c.txt"], scope: "name", target: "root" });
    expect(r.rows[0]).toMatchObject({ outcome: "refused", reasonCode: "conflicted" });

    const sub = await repo();
    await writeFile(sub, "s.txt", "s");
    await commit(sub, "s");
    const host = await repo();
    await writeFile(host, "h.txt", "h");
    await commit(host, "h");
    await git(host, ["-c", "protocol.file.allow=always", "submodule", "add", "-q", sub, "mod"]);
    const r2 = await ignorePaths(host, { paths: ["mod"], scope: "name", target: "root" });
    expect(r2.rows[0]).toMatchObject({ outcome: "refused", reasonCode: "submodule" });
  });

  it("a nested repo (untracked directory row) can be ignored by directory name", async () => {
    const d = await repo();
    await writeFile(d, "base.txt", "b");
    await commit(d, "base");
    const nested = path.join(d, "nested");
    await fs.mkdir(nested);
    await git(nested, ["init", "-q"]);
    await writeFile(nested, "f.txt", "x");
    await git(nested, ["add", "."]);
    await git(nested, ["commit", "-q", "-m", "x"]);
    const r = await ignorePaths(d, { paths: ["nested/"], scope: "name", target: "root" });
    expect(r.rows[0]).toMatchObject({ outcome: "written", rule: "/nested/" });
  });

  it("is refused on a bare repository", async () => {
    const bare = await initRepo({ bare: true });
    dirs.push(bare);
    const repository = await Repository.open(bare);
    await expect(repository.ignorePaths({ paths: ["x"], scope: "name", target: "root" })).rejects.toBeInstanceOf(InvalidArgumentError);
  });
});

describe("ignore and stop tracking (FR-500, AC6, AC7)", () => {
  async function trackedRepo(files: Record<string, string>): Promise<string> {
    const d = await repo();
    for (const [p, c] of Object.entries(files)) await writeFile(d, p, c);
    await commit(d, "base");
    return d;
  }

  it("ignore only keeps the file tracked", async () => {
    const d = await trackedRepo({ "t.log": "1", "keep.txt": "k" });
    const r = await ignorePaths(d, { paths: ["t.log"], scope: "name", target: "root" });
    expect(r.rows[0]).toMatchObject({ outcome: "written", tracked: true });
    expect(r.stopTracking).toBeNull();
    expect((await git(d, ["ls-files"])).stdout).toContain("t.log");
  });

  it("stop tracking stages a deletion and leaves the file on disk; the plan matches the result", async () => {
    const d = await trackedRepo({ "t.log": "1", "u.log": "2", "keep.txt": "k" });
    const plan = await planIgnore(d, { paths: ["t.log"], scope: "extension", target: "root", stopTracking: true });
    expect(plan.applied).toBe(false);
    expect(plan.stopTracking).toMatchObject({ paths: ["t.log"], count: 1, otherMatchesStillTracked: 1 });
    expect(await fileExists(path.join(d, ".gitignore"))).toBe(false);

    const r = await ignoreAndStopTracking(d, { paths: ["t.log"], scope: "extension", target: "root", expectedUntrackPaths: ["t.log"] });
    expect(r.stopTracking).toMatchObject({ paths: ["t.log"], count: 1, otherMatchesStillTracked: 1 });
    expect(await fs.readFile(path.join(d, "t.log"), "utf8")).toBe("1");
    const st = (await status(d)).trim().split("\n").sort();
    expect(st).toEqual(["?? .gitignore", "D  t.log"]);
    expect((await git(d, ["ls-files"])).stdout).toContain("u.log");
  });

  it("directory scope untracks every tracked file under it and no others", async () => {
    const d = await trackedRepo({ "build/a.js": "1", "build/deep/b.js": "2", "src/c.js": "3" });
    const r = await ignoreAndStopTracking(d, { paths: ["build/a.js"], scope: "directory", target: "root", expectedUntrackPaths: ["build/a.js", "build/deep/b.js"] });
    expect(r.stopTracking!.paths).toEqual(["build/a.js", "build/deep/b.js"]);
    expect((await git(d, ["ls-files"])).stdout.trim().split("\n").sort()).toEqual(["src/c.js"]);
    expect(await fileExists(path.join(d, "build/deep/b.js"))).toBe(true);
  });

  it("mixed rows are reported and their staged edits dropped; staged renames untrack the new path only", async () => {
    const d = await trackedRepo({ "m.log": "1\n", "old.log": "keep me\nmore\nlines\nhere\n" });
    await writeFile(d, "m.log", "2\n");
    await git(d, ["add", "m.log"]);
    await writeFile(d, "m.log", "3\n");
    await git(d, ["mv", "old.log", "new.log"]);
    const plan = await planIgnore(d, { paths: ["m.log", "new.log"], scope: "name", target: "root", stopTracking: true });
    expect(plan.stopTracking!.mixedRows).toEqual(["m.log"]);
    expect(plan.stopTracking!.renamedRows).toEqual([{ path: "new.log", oldPath: "old.log" }]);
    await ignoreAndStopTracking(d, { paths: ["m.log", "new.log"], scope: "name", target: "root", expectedUntrackPaths: ["m.log", "new.log"] });
    expect(await fs.readFile(path.join(d, "m.log"), "utf8")).toBe("3\n");
    const st = (await status(d)).trim().split("\n").sort();
    expect(st).toEqual(["?? .gitignore", "D  m.log", "D  old.log"]);
  });

  it("a failing untrack rolls the rule file back when its bytes are still ours (AC7)", async () => {
    const d = await trackedRepo({ "t.log": "1" });
    await fs.writeFile(path.join(d, ".git", "index.lock"), "");
    let err: unknown;
    try {
      await ignoreAndStopTracking(d, { paths: ["t.log"], scope: "name", target: "root", expectedUntrackPaths: ["t.log"] });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(IgnoreUntrackError);
    expect((err as IgnoreUntrackError).rolledBack).toBe(true);
    expect(await fileExists(path.join(d, ".gitignore"))).toBe(false);
    await fs.rm(path.join(d, ".git", "index.lock"));
    expect((await git(d, ["ls-files"])).stdout).toContain("t.log");
  });

  it("restores a pre-existing rule file's exact bytes on failure", async () => {
    const d = await trackedRepo({ "t.log": "1" });
    const orig = Buffer.from("a\r\nb");
    await fs.writeFile(path.join(d, ".gitignore"), orig);
    await commit(d, "gi");
    await fs.writeFile(path.join(d, ".git", "index.lock"), "");
    await expect(ignoreAndStopTracking(d, { paths: ["t.log"], scope: "name", target: "root", expectedUntrackPaths: ["t.log"] })).rejects.toBeInstanceOf(IgnoreUntrackError);
    expect((await fs.readFile(path.join(d, ".gitignore"))).equals(orig)).toBe(true);
  });

  it("does not roll back a rule file the user changed meanwhile and says so", async () => {
    const d = await trackedRepo({ "t.log": "1" });
    await fs.writeFile(path.join(d, ".git", "index.lock"), "");
    _setIgnoreAfterWriteHookForTests(async () => {
      await fs.appendFile(path.join(d, ".gitignore"), "user-edit\n");
    });
    await expect(ignoreAndStopTracking(d, { paths: ["t.log"], scope: "name", target: "root", expectedUntrackPaths: ["t.log"] })).rejects.toMatchObject({
      rolledBack: false,
      ruleFilesLeftModified: [".gitignore"],
    });
    expect(await fs.readFile(path.join(d, ".gitignore"), "utf8")).toBe("/t.log\nuser-edit\n");
  });
});

describe("security review follow-ups (L2, L3, L4, L5)", () => {
  async function trackedRepo(files: Record<string, string>): Promise<string> {
    const d = await repo();
    for (const [p, c] of Object.entries(files)) await writeFile(d, p, c);
    await commit(d, "base");
    return d;
  }

  it("L2: expectedUntrackPaths that no longer match throws IGNORE_PLAN_CHANGED and writes nothing", async () => {
    const d = await trackedRepo({ "a.log": "1", "keep.txt": "k" });
    const plan = await planIgnore(d, { paths: ["a.log"], scope: "extension", target: "root", stopTracking: true });
    const confirmed = plan.stopTracking!.paths;
    expect(confirmed).toEqual(["a.log"]);
    // Another tracked .log appears between the confirmation and the apply: the directory-wide set grows.
    await writeFile(d, "b.log", "2");
    await git(d, ["add", "b.log"]);
    await git(d, ["commit", "-m", "b"]);
    const req = { paths: ["a.log", "b.log"], scope: "extension" as const, target: "root" as const, stopTracking: true, expectedUntrackPaths: confirmed };
    let err: unknown;
    try {
      await ignorePaths(d, req);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(IgnorePlanChangedError);
    expect((err as IgnorePlanChangedError).code).toBe("IGNORE_PLAN_CHANGED");
    expect((err as IgnorePlanChangedError).expected).toEqual(["a.log"]);
    expect((err as IgnorePlanChangedError).actual).toEqual(["a.log", "b.log"]);
    expect(await fileExists(path.join(d, ".gitignore"))).toBe(false);
    expect((await git(d, ["ls-files"])).stdout).toContain("b.log");
  });

  it("L2: the confirmed set applies untouched; the error's lists are bounded", async () => {
    const d = await trackedRepo({ "a.log": "1", "keep.txt": "k" });
    const plan = await planIgnore(d, { paths: ["a.log"], scope: "extension", target: "root", stopTracking: true });
    const r = await ignorePaths(d, { paths: ["a.log"], scope: "extension", target: "root", stopTracking: true, expectedUntrackPaths: plan.stopTracking!.paths });
    expect(r.applied).toBe(true);
    expect((await git(d, ["ls-files"])).stdout).not.toContain("a.log");
    const many = Array.from({ length: 100 }, (_, i) => `f${i}`);
    const e = new IgnorePlanChangedError(many, []);
    expect(e.expected.length).toBe(20);
    expect(e.expectedCount).toBe(100);
  });

  it("L2: an empty expected set still guards a non-empty recomputed one", async () => {
    const d = await trackedRepo({ "a.log": "1" });
    await expect(
      ignorePaths(d, { paths: ["a.log"], scope: "name", target: "root", stopTracking: true, expectedUntrackPaths: [] }),
    ).rejects.toBeInstanceOf(IgnorePlanChangedError);
    expect(await fileExists(path.join(d, ".gitignore"))).toBe(false);
  });

  it("L3: a folder swapped for a link right before the rename is refused; nothing is written through it", async () => {
    const d = await repo();
    await writeFile(d, "base.txt", "b");
    await writeFile(d, "sub/.gitignore", "keepme\n");
    await commit(d, "base");
    await writeFile(d, "sub/f.tmp", "x");
    const outside = await makeTempDir();
    dirs.push(outside);
    await fs.writeFile(path.join(outside, ".gitignore"), "keepme\n");
    _setIgnoreBeforeRenameHookForTests(async () => {
      await fs.rename(path.join(d, "sub"), path.join(d, "sub-moved"));
      await fs.symlink(outside, path.join(d, "sub"), "junction");
    });
    let linked = true;
    let err: unknown;
    try {
      await ignorePaths(d, { paths: ["sub/f.tmp"], scope: "name", target: "nearest" });
    } catch (e) {
      err = e;
      if (!(e instanceof IgnoreWriteError)) linked = false;
    }
    if (!linked && !(err instanceof IgnoreWriteError)) {
      // Link creation is not permitted on this machine; the hook then threw before the swap, nothing to assert.
      return;
    }
    expect(err).toBeInstanceOf(IgnoreWriteError);
    expect(await fs.readFile(path.join(outside, ".gitignore"), "utf8")).toBe("keepme\n");
    expect((await fs.readdir(outside)).filter((f) => f.includes("githydra"))).toEqual([]);
  });

  it("L4: a raw fs failure surfaces as IgnoreWriteError with the errno and a repo-relative name, no absolute path", async () => {
    const d = await repo();
    await writeFile(d, "base.txt", "b");
    await commit(d, "base");
    await writeFile(d, "n.tmp", "x");
    _setIgnoreBeforeRenameHookForTests(async (abs) => {
      // Remove our temp file so the rename fails with ENOENT.
      for (const f of await fs.readdir(path.dirname(abs))) if (f.endsWith(".tmp") && f.includes("githydra")) await fs.rm(path.join(path.dirname(abs), f));
    });
    let err: unknown;
    try {
      await ignorePaths(d, { paths: ["n.tmp"], scope: "name", target: "root" });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(IgnoreWriteError);
    const e = err as IgnoreWriteError;
    expect(e.errno).toBe("ENOENT");
    expect(e.file).toBe(".gitignore");
    expect(e.message).toBe('Filesystem error on ".gitignore" (ENOENT).');
    expect(e.message).not.toContain(d);
  });

  it("L5: pathspec-magic and option-looking names go through check-ignore literally", async () => {
    const d = await repo();
    const rules = [String.raw`/\:(glob)x`, String.raw`/\:!x`, String.raw`/\:/x`, String.raw`/a\[1\].txt`, String.raw`/-x`, ""];
    await fs.writeFile(path.join(d, ".git", "info", "exclude"), rules.join("\n"));
    const names = [":(glob)x", ":!x", ":/x", "a[1].txt", "-x", "x", "a1.txt"];
    const m = await _checkIgnoreForTests(d, names);
    expect(names.map((n) => m.get(n)?.line ?? null)).toEqual([1, 2, 3, 4, 5, null, null]);
    for (const n of names.slice(0, 5)) expect(m.get(n)).toMatchObject({ negated: false });
  });

  it("L5: real files named `a[1].txt` and `-x` are ignored by exactly their own rule", async () => {
    const d = await repo();
    await writeFile(d, "base.txt", "b");
    await commit(d, "base");
    for (const n of ["a[1].txt", "a1.txt", "-x", "x"]) await writeFile(d, n, "u");
    const r = await ignorePaths(d, { paths: ["a[1].txt", "-x"], scope: "name", target: "root" });
    expect(r.rows.map((x) => x.outcome)).toEqual(["written", "written"]);
    expect(await status(d)).toContain("?? a1.txt");
    expect(await status(d)).toContain("?? x");
    expect(await status(d)).not.toContain("a[1].txt");
    expect(await status(d)).not.toContain("-x");
  });
});
