import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { runGit, _resetGitExecutablePathCacheForTests, _resolveGitExecutablePathForTests } from "../src/gitProcess";
import { GitNotFoundError } from "../src/errors";
import { makeTempDir, cleanup } from "./testRepo";

/** process.env's PATH key isn't guaranteed to be spelled "PATH" on Windows. */
function findPathKey(): string {
  return Object.keys(process.env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
}

const cleanupDirs: string[] = [];
afterEach(async () => {
  while (cleanupDirs.length) await cleanup(cleanupDirs.pop()!);
  // Every test in this file mutates process.env.PATH / GIT_EXEC_PATH and the module-level
  // resolution cache; always leave both pristine for every other test file that shares this
  // process, regardless of pass/fail.
  _resetGitExecutablePathCacheForTests();
});

describe("resolveGitExecutablePath (absolute-path git resolution)", () => {
  it("resolves git to an absolute path that actually exists on disk", () => {
    _resetGitExecutablePathCacheForTests();
    const resolved = _resolveGitExecutablePathForTests();
    expect(path.isAbsolute(resolved)).toBe(true);
    expect(fs.existsSync(resolved)).toBe(true);
  });

  it("runGit actually works end-to-end using the resolved absolute path (regression)", async () => {
    _resetGitExecutablePathCacheForTests();
    const { stdout } = await runGit(["--version"], { cwd: process.cwd() });
    expect(stdout).toMatch(/git version \d/);
  });

  it("caches the resolution: a later change to PATH does not affect an already-resolved path", () => {
    _resetGitExecutablePathCacheForTests();
    const first = _resolveGitExecutablePathForTests();

    const pathKey = findPathKey();
    const savedPath = process.env[pathKey];
    process.env[pathKey] = "";
    try {
      const second = _resolveGitExecutablePathForTests();
      expect(second).toBe(first);
    } finally {
      process.env[pathKey] = savedPath;
    }
  });

  it("throws a clear GitNotFoundError when git cannot be found anywhere on PATH and GIT_EXEC_PATH is unset", async () => {
    const emptyDir = await makeTempDir();
    cleanupDirs.push(emptyDir);

    const pathKey = findPathKey();
    const savedPath = process.env[pathKey];
    const savedExecPath = process.env.GIT_EXEC_PATH;
    process.env[pathKey] = emptyDir; // a real, existing directory containing no git binary
    delete process.env.GIT_EXEC_PATH;
    _resetGitExecutablePathCacheForTests();
    try {
      expect(() => _resolveGitExecutablePathForTests()).toThrow(GitNotFoundError);
      await expect(runGit(["--version"], { cwd: process.cwd() })).rejects.toThrow();
    } finally {
      process.env[pathKey] = savedPath;
      if (savedExecPath === undefined) delete process.env.GIT_EXEC_PATH;
      else process.env.GIT_EXEC_PATH = savedExecPath;
      _resetGitExecutablePathCacheForTests();
    }
  });

  it("resolves via GIT_EXEC_PATH's install layout even when PATH has no git on it", async () => {
    // Discover the real git binary first (via a clean resolution), so we can copy it into a
    // synthetic `<prefix>/bin/git[.exe]` layout alongside a `<prefix>/libexec/git-core` dir.
    _resetGitExecutablePathCacheForTests();
    const realGit = _resolveGitExecutablePathForTests();

    const prefix = await makeTempDir();
    cleanupDirs.push(prefix);
    const binDir = path.join(prefix, "bin");
    const execCoreDir = path.join(prefix, "libexec", "git-core");
    fs.mkdirSync(binDir, { recursive: true });
    fs.mkdirSync(execCoreDir, { recursive: true });
    const fakeGitBinary = path.join(binDir, path.basename(realGit));
    fs.copyFileSync(realGit, fakeGitBinary);
    if (process.platform !== "win32") fs.chmodSync(fakeGitBinary, 0o755);

    const pathKey = findPathKey();
    const savedPath = process.env[pathKey];
    const savedExecPath = process.env.GIT_EXEC_PATH;
    process.env[pathKey] = ""; // nothing resolvable via plain PATH search
    process.env.GIT_EXEC_PATH = execCoreDir;
    _resetGitExecutablePathCacheForTests();
    try {
      const resolved = _resolveGitExecutablePathForTests();
      expect(resolved).toBe(fakeGitBinary);
      expect(fs.existsSync(resolved)).toBe(true);
    } finally {
      process.env[pathKey] = savedPath;
      if (savedExecPath === undefined) delete process.env.GIT_EXEC_PATH;
      else process.env.GIT_EXEC_PATH = savedExecPath;
      _resetGitExecutablePathCacheForTests();
    }
  });
});
