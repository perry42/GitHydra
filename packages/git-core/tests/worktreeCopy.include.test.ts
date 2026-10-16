// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { listIgnoredCandidates } from "../src/worktreeCopy";
import { readWorktreeInclude, sanitizeIncludeText, classifyIncludePattern } from "../src/worktreeInclude";
import { realCopyFs } from "../src/worktreeCopyFs";
import { decideInitialTicks, secretTickedPaths } from "../src/worktreeCopyPure";
import { buildCopyManifest } from "../src/worktreeCopyEngine";
import { _setWorktreeRunnerForTests } from "../src/worktreeRunner";
import { writeFile, snapshotTree } from "./testRepo";
import { cleanupCopyFixtures, makeCopyFixture, patchStat, spyingRunner } from "./worktreeCopyKit";

afterEach(async () => {
  _setWorktreeRunnerForTests(null);
  await cleanupCopyFixtures();
});

async function withInclude(content: string | Buffer) {
  const f = await makeCopyFixture();
  await writeFile(f.repo, "src/new.ts", "untracked, NOT ignored\n");
  await writeFile(f.repo, "foo.pem", "untracked, NOT ignored\n");
  await fs.writeFile(path.join(f.repo, ".worktreeinclude"), content);
  return f;
}
const okResult = async (f: { repo: string }, opts = {}) => {
  const r = await readWorktreeInclude(f.repo, f.repo, opts);
  if (r.status !== "ok") throw new Error(`expected ok, got ${JSON.stringify(r)}`);
  return r;
};

describe("readWorktreeInclude (FR-631)", () => {
  it("is absent when there is no file", async () => {
    const f = await makeCopyFixture();
    expect(await readWorktreeInclude(f.repo, f.repo)).toEqual({ status: "absent" });
  });

  it("never lists a non-ignored untracked file that merely matches, and never selects an ignored file the file does not name", async () => {
    const f = await withInclude(".env\n*.pem\nsrc/*.ts\n");
    const r = await okResult(f);
    expect(r.matchedFiles).toEqual([".env"]);
    expect(r.matchedFiles).not.toContain(".cache/x");
    expect(r.matchedFiles).not.toContain("foo.pem");
    expect(r.matchedFiles).not.toContain("src/new.ts");
  });

  it("runs the two listings with -i, with neither --directory nor (for -X) --exclude-standard, from a private temp file", async () => {
    const f = await withInclude(".env\n");
    const { runner, spawned } = spyingRunner();
    _setWorktreeRunnerForTests(runner);
    const tmpBefore = (await fs.readdir(os.tmpdir())).filter((n) => n.startsWith("githydra-include-"));
    await okResult(f);
    const ls = spawned.map((a) => a.slice(a.indexOf("ls-files")));
    expect(ls).toHaveLength(2);
    for (const a of ls) {
      expect(a).toContain("-i");
      expect(a).toContain("-o");
      expect(a).not.toContain("--directory");
    }
    const withX = ls.find((a) => a.includes("-X"))!;
    expect(withX).not.toContain("--exclude-standard");
    const tmp = withX[withX.indexOf("-X") + 1]!;
    expect(path.isAbsolute(tmp)).toBe(true);
    expect(tmp.startsWith(f.repo)).toBe(false);
    expect(ls.find((a) => !a.includes("-X"))).toContain("--exclude-standard");
    expect(spawned.every((a) => a.includes("core.fsmonitor=false"))).toBe(true);
    const tmpAfter = (await fs.readdir(os.tmpdir())).filter((n) => n.startsWith("githydra-include-"));
    expect(tmpAfter).toEqual(tmpBefore);
  });

  it("handles CRLF, a BOM, comments, negation and trailing spaces", async () => {
    const f = await withInclude("\ufeff# comment\r\n.env\r\n*.log\r\n!src/b.log\r\n.cache/x   \r\n\r\n");
    const r = await okResult(f);
    expect(r.matchedFiles.sort()).toEqual([".cache/x", ".env"]);
    expect(r.skipped).toEqual([]);
  });

  it("accepts a root-anchored /.env", async () => {
    const f = await withInclude("/.env\n");
    expect((await okResult(f)).matchedFiles).toEqual([".env"]);
    expect(classifyIncludePattern("/.env")).toBeNull();
  });

  it("rejects .., C:\\ and \\\\server patterns with a reason and keeps the rest", async () => {
    const f = await withInclude("../secret\n.env\nC:\\Users\\x\\.ssh\nc:/x\n\\\\server\\share\n!../x\n//abs\na/../b\n");
    const r = await okResult(f);
    expect(r.matchedFiles).toEqual([".env"]);
    expect(r.skipped.map((s) => [s.line, s.reason])).toEqual([
      [1, "parent-directory-segment"],
      [3, "absolute-path"],
      [4, "absolute-path"],
      [5, "absolute-path"],
      [6, "parent-directory-segment"],
      [7, "absolute-path"],
      [8, "parent-directory-segment"],
    ]);
    expect(sanitizeIncludeText("a\0b\n").skipped[0]!.reason).toBe("invalid-character");
  });

  it("refuses more than 64 KB and more than 1000 lines while reading", async () => {
    const big = await withInclude(`${"a".repeat(64 * 1024)}x\n`);
    expect(await readWorktreeInclude(big.repo, big.repo)).toEqual({ status: "refused", reason: "too-large" });
    const exactly = await withInclude(`${"#".repeat(64 * 1024 - 1)}\n`);
    expect((await readWorktreeInclude(exactly.repo, exactly.repo)).status).toBe("ok");
    const many = await withInclude("a\n".repeat(1001));
    expect(await readWorktreeInclude(many.repo, many.repo)).toEqual({ status: "refused", reason: "too-many-lines" });
    const thousand = await withInclude("a\n".repeat(1000));
    expect((await readWorktreeInclude(thousand.repo, thousand.repo)).status).toBe("ok");
  });

  it("enforces the size cap even when lstat reports a small file (cap applies while reading)", async () => {
    const f = await withInclude("x\n".repeat(10));
    const lying = { ...realCopyFs, lstat: async (p: string) => patchStat(await realCopyFs.lstat(p), { size: 1n }) };
    // identity then differs from the handle's fstat, which is also a refusal
    const r = await readWorktreeInclude(f.repo, f.repo, { fs: lying });
    expect(r.status).toBe("refused");
    const r2 = await readWorktreeInclude(f.repo, f.repo, { maxBytes: 5 });
    expect(r2).toEqual({ status: "refused", reason: "too-large" });
  });

  it("refuses a symlinked file (injected fs) and a swap detected at open", async () => {
    const f = await withInclude(".env\n");
    const asLink = { ...realCopyFs, lstat: async (p: string) => patchStat(await realCopyFs.lstat(p), { isSymbolicLink: () => true, isFile: () => false }) };
    expect(await readWorktreeInclude(f.repo, f.repo, { fs: asLink })).toEqual({ status: "refused", reason: "symlink" });
    const eloop = { ...realCopyFs, open: async () => { throw Object.assign(new Error("loop"), { code: "ELOOP" }); } };
    expect(await readWorktreeInclude(f.repo, f.repo, { fs: eloop })).toEqual({ status: "refused", reason: "symlink" });
    const notFile = { ...realCopyFs, lstat: async (p: string) => patchStat(await realCopyFs.lstat(p), { isFile: () => false }) };
    expect((await readWorktreeInclude(f.repo, f.repo, { fs: notFile })).status).toBe("refused");
  });

  it("refuses a real symlink where one can be created", async (ctx) => {
    const f = await makeCopyFixture();
    await fs.writeFile(path.join(f.parent, "elsewhere"), ".env\n");
    try {
      await fs.symlink(path.join(f.parent, "elsewhere"), path.join(f.repo, ".worktreeinclude"), "file");
    } catch {
      return ctx.skip();
    }
    expect(await readWorktreeInclude(f.repo, f.repo)).toEqual({ status: "refused", reason: "symlink" });
  });

  it("directory rows match only when every file under them is named; sub-paths do not select the whole row", async () => {
    const f = await withInclude(".cache/\n.cache/x\n");
    const listing = await listIgnoredCandidates(f.repo, f.repo);
    if (listing.status !== "ok") throw new Error("listing");
    const all = await okResult(f, { candidates: listing.candidates });
    expect(all.matchedRows).toContain(".cache/");
    await fs.writeFile(path.join(f.repo, ".worktreeinclude"), ".cache/x\n");
    const partial = await okResult(f, { candidates: listing.candidates });
    expect(partial.matchedFiles).toEqual([".cache/x"]);
    expect(partial.matchedRows).not.toContain(".cache/");
  });

  it("** matches everything ignored but the budget ticks nothing; run-code and secrets are never pre-ticked", async () => {
    const f = await withInclude("**\n");
    const listing = await listIgnoredCandidates(f.repo, f.repo);
    if (listing.status !== "ok") throw new Error("listing");
    const r = await okResult(f, { candidates: listing.candidates });
    expect(r.matchedFiles).toEqual(expect.arrayContaining([".env", ".cache/x", "node_modules/pkg/index.js"]));
    expect(decideInitialTicks({ candidates: listing.candidates, record: null, includeMatches: r.matchedRows }).ticked).toEqual([]);
    // a narrower file: run-code (.vscode/) and secret (.env) rows are excluded, the log seeds
    await fs.writeFile(path.join(f.repo, ".worktreeinclude"), ".env\n.vscode/\n*.log\n");
    const n = await okResult(f, { candidates: listing.candidates });
    const t = decideInitialTicks({ candidates: listing.candidates, record: null, includeMatches: n.matchedRows });
    expect(t.ticked).toEqual(["src/b.log"]);
    expect(t.secretsInInclude).toEqual([".env"]);
  });

  it("falls back to the collapsed listing when the file-level listing overflows", async () => {
    const f = await withInclude("node_modules/\n.env\n");
    const r = await okResult(f, { maxRows: 5 });
    expect(r.matchedFiles).toEqual(expect.arrayContaining([".env"]));
  });

  it("writes nothing into the repo or .git (AC1)", async () => {
    const f = await withInclude(".env\n");
    const before = await snapshotTree(f.repo);
    await okResult(f);
    expect(await snapshotTree(f.repo)).toEqual(before);
  });
});

describe("rows are classified by what is INSIDE them (MED-2)", () => {
  async function dirsFixture(include: string) {
    const f = await withInclude(include);
    await fs.appendFile(path.join(f.repo, ".gitignore"), "local/\ntools/\nplain/\n");
    await writeFile(f.repo, "local/.env", `K=${"v"}\n`);
    await writeFile(f.repo, "local/a.txt", "a\n");
    await writeFile(f.repo, "tools/.vscode/tasks.json", "{}");
    await writeFile(f.repo, "tools/b.txt", "b\n");
    await writeFile(f.repo, "plain/c.txt", "c\n");
    return f;
  }
  it(".worktreeinclude naming a directory that holds a secret or run-code file seeds nothing from it", async () => {
    const f = await dirsFixture("local/\ntools/\nplain/\n");
    const listing = await listIgnoredCandidates(f.repo, f.repo);
    if (listing.status !== "ok") throw new Error("listing");
    const by = Object.fromEntries(listing.candidates.map((c) => [c.path, c]));
    expect(by["local/"]).toMatchObject({ secret: true, runsCode: false });
    expect(by["tools/"]).toMatchObject({ secret: false, runsCode: true });
    expect(by["plain/"]).toMatchObject({ secret: false, runsCode: false });
    const r = await okResult(f, { candidates: listing.candidates });
    expect(r.matchedRows).toEqual(expect.arrayContaining(["local/", "tools/", "plain/"]));
    const t = decideInitialTicks({ candidates: listing.candidates, record: null, includeMatches: r.matchedRows });
    expect(t.ticked).toEqual(["plain/"]);
    expect(t.secretsInInclude).toContain("local/");
  });
  it("a remembered directory that later gains an id_rsa is a secret row in the manifest, so the line warns", async () => {
    const f = await dirsFixture("");
    await fs.appendFile(path.join(f.repo, ".gitignore"), "config/\n");
    await writeFile(f.repo, "config/app.json", "{}");
    const before = await buildCopyManifest(f.repo, f.repo);
    if (before.status !== "ok") throw new Error("manifest");
    expect(before.manifest.rows.find((r) => r.id === "config/")).toMatchObject({ secret: false });
    await writeFile(f.repo, "config/id_rsa", "KEY");
    const after = await buildCopyManifest(f.repo, f.repo);
    if (after.status !== "ok") throw new Error("manifest");
    const row = after.manifest.rows.find((r) => r.id === "config/")!;
    expect(row.secret).toBe(true);
    expect(after.manifest.rows.find((r) => r.id === "tools/")).toMatchObject({ runsCode: true, secret: false });
    const t = decideInitialTicks({ candidates: after.manifest.rows.map((r) => ({ path: r.path, isDirectory: true, fileCount: r.fileCount, bytes: r.bytes, secret: r.secret, runsCode: r.runsCode })), record: { v: 1, paths: ["config/"], at: 1 }, includeMatches: [] });
    expect(t.ticked).toEqual(["config/"]);
    expect(secretTickedPaths([{ path: "config/", isDirectory: true, fileCount: 2, bytes: 1, secret: true }], t.ticked)).toEqual(["config/"]);
  });
});
