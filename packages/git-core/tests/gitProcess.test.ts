import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  runGit,
  withFsmonitorNeutralized,
  NEUTRALIZE_LOCAL_HOOK_CONFIG,
  _resetGitExecutablePathCacheForTests,
  _resolveGitExecutablePathForTests,
  _resetGitQueueForTests,
  _enqueueGitTaskForTests,
} from "../src/gitProcess";
import { GitNotFoundError } from "../src/errors";
import { git, initRepo, writeFile, commit, makeTempDir, cleanup, fileExists } from "./testRepo";

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

// Regression: CRITICAL 1 from the security review — the `core.fsmonitor` hook-execution vector
// was originally guarded only on `getWorkingDirectoryStatus()`'s `status` call, but every
// command that refreshes working-tree/index state (diff against the worktree/index, add,
// restore, clean, commit) is equally exposed. `withFsmonitorNeutralized()` is the single
// shared helper all of those call sites now use — see its doc comment in `src/gitProcess.ts`.
describe("withFsmonitorNeutralized", () => {
  it("prepends the -c core.fsmonitor=false override, ahead of the rest of argv", () => {
    expect(withFsmonitorNeutralized(["status", "--porcelain=v1"])).toEqual([
      "-c",
      "core.fsmonitor=false",
      "status",
      "--porcelain=v1",
    ]);
  });

  it("is a fixed prefix, not a mutation of the input array", () => {
    const input = ["add", "--", "file.txt"];
    const result = withFsmonitorNeutralized(input);
    expect(input).toEqual(["add", "--", "file.txt"]); // untouched
    expect(result).toEqual([...NEUTRALIZE_LOCAL_HOOK_CONFIG, "add", "--", "file.txt"]);
  });

  it("[vulnerability demonstration] plain `git add`, unguarded, DOES execute a malicious core.fsmonitor command", async () => {
    // Positive control, mirroring workingDirStatus.test.ts's for `status`: proves this isn't
    // hypothetical for a command this PR newly guards (`add`), not just `status`.
    const dir = await initRepo();
    cleanupDirs.push(dir);
    await writeFile(dir, "a.txt", "1");
    await commit(dir, "first");

    const outsideDir = await makeTempDir();
    cleanupDirs.push(outsideDir);
    const markerPath = `${outsideDir.replace(/\\/g, "/")}/PWNED_MARKER`;
    const scriptPath = `${outsideDir.replace(/\\/g, "/")}/fsmonitor-marker.sh`;
    await writeFile(outsideDir, "fsmonitor-marker.sh", `#!/bin/sh\necho PWNED > "${markerPath}"\n`);
    await git(dir, ["config", "core.fsmonitor", scriptPath]);
    await writeFile(dir, "b.txt", "new");

    expect(await fileExists(markerPath)).toBe(false);
    // Plain, unguarded `git add` — no -c override — the same shape `stageFile()` used before this fix.
    await git(dir, ["add", "b.txt"]);
    expect(await fileExists(markerPath)).toBe(true);
  });

  it("runGit(withFsmonitorNeutralized([...])) does NOT execute the same malicious command", async () => {
    const dir = await initRepo();
    cleanupDirs.push(dir);
    await writeFile(dir, "a.txt", "1");
    await commit(dir, "first");

    const outsideDir = await makeTempDir();
    cleanupDirs.push(outsideDir);
    const markerPath = `${outsideDir.replace(/\\/g, "/")}/PWNED_MARKER`;
    const scriptPath = `${outsideDir.replace(/\\/g, "/")}/fsmonitor-marker.sh`;
    await writeFile(outsideDir, "fsmonitor-marker.sh", `#!/bin/sh\necho PWNED > "${markerPath}"\n`);
    await git(dir, ["config", "core.fsmonitor", scriptPath]);
    await writeFile(dir, "b.txt", "new");

    expect(await fileExists(markerPath)).toBe(false);
    await runGit(withFsmonitorNeutralized(["add", "--", "b.txt"]), { cwd: dir });
    expect(await fileExists(markerPath)).toBe(false);
  });
});

// Regression: HIGH from the security review — glob-magic pathspec characters (bracket
// character classes in particular, since `*`/`?`/`:` aren't legal Windows filename
// characters) must be interpreted literally by every command this module runs.
describe("GIT_LITERAL_PATHSPECS", () => {
  it("[vulnerability demonstration] without GIT_LITERAL_PATHSPECS, a bracket pathspec glob-matches an unrelated file", async () => {
    const dir = await initRepo();
    cleanupDirs.push(dir);
    await writeFile(dir, "a.txt", "1");
    await commit(dir, "first");
    await writeFile(dir, "a.txt", "2");

    // Plain, unguarded git (testRepo.ts's `git()` helper never sets GIT_LITERAL_PATHSPECS).
    // "[a].txt" as a glob is a bracket character class matching the single character "a" —
    // i.e. it matches the real file "a.txt", even though no file literally named "[a].txt" exists.
    await git(dir, ["add", "--", "[a].txt"]);
    const { stdout } = await git(dir, ["status", "--porcelain=v1"]);
    expect(stdout).toContain("M  a.txt"); // glob-matched and staged, despite the literal name mismatch
  });

  it("runGit (GIT_LITERAL_PATHSPECS=1 via safeEnv) treats the same bracket pathspec literally instead", async () => {
    const dir = await initRepo();
    cleanupDirs.push(dir);
    await writeFile(dir, "a.txt", "1");
    await commit(dir, "first");
    await writeFile(dir, "a.txt", "2");

    // No file literally named "[a].txt" exists, so a literal-pathspec `git add` must fail
    // to match anything, rather than silently glob-matching "a.txt".
    await expect(runGit(["add", "--", "[a].txt"], { cwd: dir })).rejects.toThrow();
    const { stdout } = await git(dir, ["status", "--porcelain=v1"]);
    expect(stdout).toContain(" M a.txt"); // still unstaged — "[a].txt" did NOT match it
  });
});

// Regression: concurrent git invocations against the same repo were not serialized, so they
// raced for `.git/index.lock` and the loser surfaced a raw `GitCommandError` straight to the
// user instead of being queued behind the winner. See `enqueueGitTask`'s doc comment in
// `src/gitProcess.ts` for the full design rationale (single global FIFO queue, applied to every
// bounded run-to-completion invocation, deliberately excluding the long-lived `spawnGit` path).
describe("git invocation queue (index.lock race fix)", () => {
  afterEach(() => {
    _resetGitQueueForTests();
  });

  it("runs enqueued tasks strictly one at a time, in FIFO order (no overlap)", async () => {
    const events: string[] = [];

    const makeTask = (label: string, delayMs: number) => () =>
      new Promise<void>((resolve) => {
        events.push(`${label}:start`);
        setTimeout(() => {
          events.push(`${label}:end`);
          resolve();
        }, delayMs);
      });

    // Task "a" is deliberately the slowest and enqueued first — if tasks ran concurrently
    // instead of being queued, "b" and "c" (enqueued right after, synchronously) would start
    // before "a" finishes, interleaving the start/end markers below.
    const results = Promise.all([
      _enqueueGitTaskForTests(makeTask("a", 30)),
      _enqueueGitTaskForTests(makeTask("b", 10)),
      _enqueueGitTaskForTests(makeTask("c", 10)),
    ]);
    await results;

    expect(events).toEqual(["a:start", "a:end", "b:start", "b:end", "c:start", "c:end"]);
  });

  it("a rejected task does not wedge the queue — later tasks still run, in order", async () => {
    const events: string[] = [];

    const first = _enqueueGitTaskForTests(
      () =>
        new Promise<void>((_resolve, reject) => {
          events.push("first:start");
          setTimeout(() => {
            events.push("first:reject");
            reject(new Error("simulated git failure"));
          }, 10);
        }),
    );
    const second = _enqueueGitTaskForTests(
      () =>
        new Promise<void>((resolve) => {
          events.push("second:start");
          setTimeout(() => {
            events.push("second:end");
            resolve();
          }, 10);
        }),
    );

    await expect(first).rejects.toThrow("simulated git failure");
    await second;

    expect(events).toEqual(["first:start", "first:reject", "second:start", "second:end"]);
  });

  it("[regression] many concurrent runGit `add` calls against the same repo no longer race for index.lock", async () => {
    const dir = await initRepo();
    cleanupDirs.push(dir);
    await writeFile(dir, "seed.txt", "seed");
    await commit(dir, "seed");

    const fileCount = 20;
    const files = Array.from({ length: fileCount }, (_, i) => `concurrent-${i}.txt`);
    await Promise.all(files.map((f) => writeFile(dir, f, "new")));

    // Before the fix this was exactly the reported failure signature: fired concurrently
    // (not awaited one at a time), a subset would intermittently reject with a raw
    // `GitCommandError` — "Unable to create '.../.git/index.lock': File exists." — instead of
    // being queued behind whichever `git add` won the race.
    const outcomes = await Promise.allSettled(
      files.map((f) =>
        runGit(withFsmonitorNeutralized(["add", "--", f]), { cwd: dir, mutatesRepository: true }),
      ),
    );

    const failures = outcomes.filter((o) => o.status === "rejected");
    expect(failures).toEqual([]);

    const { stdout } = await git(dir, ["status", "--porcelain=v1"]);
    for (const f of files) {
      expect(stdout).toContain(`A  ${f}`);
    }
  });

  it("a plain read (no mutatesRepository) does NOT wait behind a slow queued mutation", async () => {
    const dir = await initRepo();
    cleanupDirs.push(dir);

    // Occupy the queue with a slow synthetic mutating task — deliberately much slower than any
    // real `git --version` spawn could plausibly take, even under heavy sandboxed-CI load, so a
    // race between the two is a reliable signal (not a tight, environment-sensitive timing bound).
    let mutationFinished = false;
    const slowMutation = _enqueueGitTaskForTests(
      () =>
        new Promise<void>((resolve) =>
          setTimeout(() => {
            mutationFinished = true;
            resolve();
          }, 2000),
        ),
    );

    // A real, unflagged read — must resolve on its own, without waiting for `slowMutation`.
    await runGit(["--version"], { cwd: dir });
    expect(mutationFinished).toBe(false); // the read won the race — it never queued behind the mutation.

    await slowMutation; // let the queue settle before the next test.
  }, 10000);
});
