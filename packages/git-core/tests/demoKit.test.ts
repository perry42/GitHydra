// SPDX-License-Identifier: GPL-3.0-or-later
// Guards the dev-only manual testing kit (scripts/demo, docs/manual-testing/README.md): every scenario must really build the git state its description promises.
// No Electron is launched. Big scenarios are scaled down via GITHYDRA_DEMO_SCALE (set below unless the caller overrides it).
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

process.env.GITHYDRA_DEMO_SCALE ??= "0.05";

/* eslint-disable @typescript-eslint/no-explicit-any */
let scenarios: any[];
let buildScenario: any, verifyScenario: any;
let tick: any, assertSafeDir: any, isDemoRepo: any, inspect: any;
let root: string;
const built = new Map<string, any>();

beforeAll(async () => {
  // dynamic imports: lib.mjs reads GITHYDRA_DEMO_SCALE at load time
  ({ scenarios } = await import("../../../scripts/demo/scenarios/index.mjs" as string));
  ({ buildScenario, verifyScenario } = await import("../../../scripts/demo/build.mjs" as string));
  ({ tick } = await import("../../../scripts/demo/tick.mjs" as string));
  ({ assertSafeDir, isDemoRepo, inspect } = await import("../../../scripts/demo/lib.mjs" as string));
  root = fs.mkdtempSync(path.join(os.tmpdir(), "githydra-demo-test-"));
  // Building is the slow part (hundreds of git spawns); do it once and let each test assert one claim.
  for (const sc of scenarios) built.set(sc.name, buildScenario(sc, path.join(root, sc.name)));
}, 240_000);

afterAll(() => {
  if (root) fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

const text = (file: string) => fs.readFileSync(file, "utf8");
const countOf = (s: string, needle: string) => s.split(needle).length - 1;

describe("demo kit scenarios build the state their description claims", () => {
  it("has a unique name, summary and tryText for every scenario", () => {
    const names = scenarios.map((s) => s.name);
    expect(new Set(names).size).toBe(names.length);
    for (const s of scenarios) {
      expect(s.summary, s.name).toBeTruthy();
      expect(s.tryText.length, s.name).toBeGreaterThan(80);
    }
  });

  it("covers every scenario the docs promise", () => {
    const required = ["merge-conflict-multi", "rebase-conflict", "cherry-pick-conflict", "delete-modify-conflict", "rename-add-conflict", "binary-only-conflict", "crlf-conflict", "long-file-conflict", "many-conflicts", "diff3-conflict", "conflict-with-big-line", "partly-staged-edits", "edit-misc", "many-files", "multi-tab", "live-refresh", "stash-heavy", "big-history", "detached-head", "submodule-present", "empty-repo", "worktree", "recovery-draft", "clean-repo"];
    expect(required.filter((n) => !scenarios.some((s) => s.name === n))).toEqual([]);
  });

  // one test per scenario, built once in beforeAll
  for (const name of [
    "merge-conflict-multi", "rebase-conflict", "cherry-pick-conflict", "delete-modify-conflict", "rename-add-conflict", "binary-only-conflict", "crlf-conflict", "long-file-conflict", "many-conflicts", "diff3-conflict", "conflict-with-big-line", "partly-staged-edits", "edit-misc", "many-files", "stash-heavy", "big-history", "detached-head", "submodule-present", "empty-repo", "worktree", "recovery-draft", "clean-repo", "multi-tab", "live-refresh",
  ]) {
    it(`${name}: git state matches its expect block`, () => {
      const sc = scenarios.find((s) => s.name === name);
      expect(verifyScenario(sc, built.get(name))).toEqual([]);
    });
  }

  it("merge-conflict-multi: merge1.txt has two conflict blocks and logo.bin is unmerged", () => {
    const r = built.get("merge-conflict-multi").repo;
    expect(countOf(text(path.join(r, "merge1.txt")), "<<<<<<<")).toBe(2);
    expect(fs.existsSync(path.join(r, "logo.bin"))).toBe(true);
  });

  it("many-conflicts: exactly 30 conflict blocks", () => {
    const r = built.get("many-conflicts").repo;
    const total = fs.readdirSync(r).filter((f) => /^f\d\d\.txt$/.test(f)).reduce((n, f) => n + countOf(text(path.join(r, f)), "<<<<<<<"), 0);
    expect(total).toBe(30);
  });

  it("crlf-conflict: conflicted file keeps CRLF line endings", () => {
    expect(text(path.join(built.get("crlf-conflict").repo, "windows.txt"))).toContain("\r\n");
  });

  it("diff3-conflict: markers include a base section", () => {
    expect(text(path.join(built.get("diff3-conflict").repo, "d.txt"))).toContain("|||||||");
  });

  it("long-file-conflict: three far-apart blocks", () => {
    const body = text(path.join(built.get("long-file-conflict").repo, "long.txt"));
    expect(countOf(body, "<<<<<<<")).toBe(3);
  });

  it("conflict-with-big-line: a conflicted line is at least 200KB", () => {
    const longest = Math.max(...text(path.join(built.get("conflict-with-big-line").repo, "huge-line.txt")).split("\n").map((l) => l.length));
    expect(longest).toBeGreaterThanOrEqual(200_000);
  });

  it("edit-misc: the three size-cap files straddle the 1MB edit cap and 2MB diff cap", () => {
    const r = built.get("edit-misc").repo;
    const size = (f: string) => fs.statSync(path.join(r, f)).size;
    expect(size("size-0.9MB.txt")).toBeLessThan(1024 * 1024);
    expect(size("size-1.5MB.txt")).toBeGreaterThan(1024 * 1024);
    expect(size("size-1.5MB.txt")).toBeLessThan(2 * 1024 * 1024);
    expect(size("size-2.5MB.txt")).toBeGreaterThan(2 * 1024 * 1024);
  });

  it("edit-misc: latin1.txt is not valid UTF-8", () => {
    const bytes = fs.readFileSync(path.join(built.get("edit-misc").repo, "latin1.txt"));
    expect(() => new TextDecoder("utf-8", { fatal: true }).decode(bytes)).toThrow();
  });

  it("partly-staged-edits: partly.txt is both staged and unstaged", () => {
    const r = built.get("partly-staged-edits").repo;
    const status = (cwd: string) => inspect(cwd, ["staged", "unstaged"]);
    expect(status(r)).toEqual({ staged: 2, unstaged: 3 });
  });

  it("worktree: the opened repo is a linked worktree (.git is a file)", () => {
    expect(fs.statSync(path.join(built.get("worktree").repo, ".git")).isFile()).toBe(true);
  });

  it("detached-head: the extra commit is not on any branch", () => {
    const r = built.get("detached-head").repo;
    const { execFileSync } = require("node:child_process") as typeof import("node:child_process");
    const branches = execFileSync("git", ["branch", "--contains", "HEAD", "--format=%(refname:short)"], { cwd: r }).toString().trim();
    expect(branches.split("\n").filter((l) => l && !l.startsWith("(")) ).toEqual([]);
  });
});

describe("demo kit safety", () => {
  it("assertSafeDir refuses a path outside the OS temp dir", () => {
    expect(() => assertSafeDir(path.parse(process.cwd()).root + "githydra-demo-outside")).toThrow(/temp/i);
  });

  it("assertSafeDir refuses the GitHydra checkout itself", () => {
    expect(() => assertSafeDir(path.resolve(__dirname, "..", "..", ".."))).toThrow();
  });

  it("tick refuses a git repo that this kit did not create", () => {
    const foreign = fs.mkdtempSync(path.join(os.tmpdir(), "githydra-demo-foreign-"));
    try {
      const { execFileSync } = require("node:child_process") as typeof import("node:child_process");
      execFileSync("git", ["init", "-q"], { cwd: foreign });
      expect(isDemoRepo(foreign)).toBe(false);
      expect(() => tick(foreign, "commit")).toThrow(/marker|refusing/i);
    } finally {
      fs.rmSync(foreign, { recursive: true, force: true });
    }
  });

  it("tick merge-start on multi-tab's third repo leaves an in-progress merge, and merge-abort clears it", () => {
    const c = buildScenario(scenarios.find((s) => s.name === "multi-tab"), path.join(root, "tick-multi-tab")).extra[1];
    tick(c, "merge-start");
    expect(inspect(c, ["operation", "unmerged"])).toEqual({ operation: "merge", unmerged: 1 });
    tick(c, "merge-abort");
    expect(inspect(c, ["operation", "changed"])).toEqual({ operation: "none", changed: 0 });
  });

  it("every other tick action runs on live-refresh without throwing", () => {
    const r = buildScenario(scenarios.find((s) => s.name === "live-refresh"), path.join(root, "tick-live-refresh")).repo;
    for (const a of ["branch", "commit", "dirty", "stash", "tag", "checkout"]) expect(() => tick(r, a), a).not.toThrow();
  });
});
