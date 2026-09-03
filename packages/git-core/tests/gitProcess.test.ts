import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import {
  runGit,
  withFsmonitorNeutralized,
  NEUTRALIZE_LOCAL_HOOK_CONFIG,
  _resetGitExecutablePathCacheForTests,
  _resolveGitExecutablePathForTests,
  _resetGitQueueForTests,
  _enqueueGitTaskForTests,
  _timeoutSigkillGraceMsForTests,
} from "../src/gitProcess";
import { GitNotFoundError, GitCommandTimeoutError } from "../src/errors";
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

// Security-review follow-up (HIGH): `RunOptions.signal` was declared and threaded into
// `spawn()`, but nothing ever supplied one and there was no timeout-based kill either — so a
// bounded git invocation that never emits `close`/`error` (a real, in-scope threat: a
// hostile/broken repository hook, since GitHydra opens ANY repo per CLAUDE.md) would hang
// forever, and — worse, now that mutating calls are serialized by `enqueueGitTask`'s FIFO queue
// — would wedge every subsequently queued mutation behind it permanently. `armTimeout()` (see its
// doc comment, and `DEFAULT_GIT_TIMEOUT_MS`'s) fixes this: every bounded invocation without a
// caller-supplied `signal` now gets an internal one, armed on a timer.
//
// These tests use a real, genuinely-hanging child process (a shell script that spins forever) —
// not a mock — with `opts.timeoutMs` overridden to a small value so the suite doesn't have to
// wait out the real (2 minute) default to prove the behavior.
describe("bounded-invocation timeout (hung child process)", () => {
  afterEach(() => {
    _resetGitQueueForTests();
  });

  /** A shell script that never exits — simulates a hostile/broken repo hook. Requires no chmod
   * on Windows (git-for-windows' shebang-based hook/script execution works off the file content
   * alone, same precedent as commitChanges.test.ts's pre-commit hook fixture). */
  function writeHangScript(dir: string, name: string): string {
    const scriptPath = path.join(dir, name);
    fs.writeFileSync(scriptPath, "#!/bin/sh\nwhile true; do sleep 1; done\n", { mode: 0o755 });
    try {
      fs.chmodSync(scriptPath, 0o755);
    } catch {
      /* chmod is a no-op-ish on Windows; the shebang alone is enough for git-for-windows to run it */
    }
    return scriptPath;
  }

  /**
   * Installs a fake `git` executable — a POSIX shell script standing in for the real binary,
   * resolved via `resolveGitExecutablePath()`'s normal PATH search — that traps and ignores
   * SIGTERM (`trap '' TERM`) and, while alive, keeps appending to `heartbeatPath` roughly every
   * 100ms. Unlike `writeHangScript()` (used as a *hook* invoked by a real `git` process, i.e. a
   * grandchild of the code under test), this script IS the direct child `armTimeout()` binds and
   * later tries to force-kill — required to actually exercise the SIGKILL escalation path itself,
   * since killing a parent process on POSIX does not recursively kill its own children/grandchildren.
   *
   * POSIX-only by nature: relies on real SIGTERM/SIGKILL signal semantics and shebang-based direct
   * execution, neither of which apply on Windows (see `TIMEOUT_SIGKILL_GRACE_MS`'s doc comment —
   * `child.kill()` there is unconditionally forceful on the very first call, so there is no
   * signal-trapping case to defend against in the first place). Callers must gate use of this
   * behind `it.skipIf(process.platform === "win32")`.
   */
  function installSignalTrappingFakeGit(fakeGitDir: string, heartbeatPath: string): void {
    const heartbeatPosix = heartbeatPath.split(path.sep).join("/");
    const scriptPath = path.join(fakeGitDir, "git");
    fs.writeFileSync(
      scriptPath,
      `#!/bin/sh\ntrap '' TERM\nwhile true; do printf x >> "${heartbeatPosix}"; sleep 0.1; done\n`,
      { mode: 0o755 },
    );
    fs.chmodSync(scriptPath, 0o755);
  }

  it("[regression] a bounded invocation that never settles is killed and rejects with GitCommandTimeoutError, well under the real default timeout", async () => {
    const dir = await initRepo();
    cleanupDirs.push(dir);
    await writeFile(dir, "a.txt", "1");
    await commit(dir, "first");

    // core.fsmonitor is invoked mid-`status`/`diff`/`add` (before this module's own
    // fsmonitor-neutralizing guard is applied, since this test calls runGit() directly with raw
    // args) — an easy, realistic way to make a real `git` child process hang indefinitely.
    const hangScript = writeHangScript(dir, "hang-fsmonitor.sh");
    await git(dir, ["config", "core.fsmonitor", hangScript.split(path.sep).join("/")]);
    await writeFile(dir, "a.txt", "2");

    const start = Date.now();
    let caught: unknown;
    try {
      await runGit(["status", "--porcelain=v1"], { cwd: dir, timeoutMs: 300 });
    } catch (err) {
      caught = err;
    }
    const elapsedMs = Date.now() - start;

    expect(caught).toBeInstanceOf(GitCommandTimeoutError);
    expect((caught as GitCommandTimeoutError).timeoutMs).toBe(300);
    expect((caught as GitCommandTimeoutError).args).toEqual(["status", "--porcelain=v1"]);
    // Proves this actually came from the 300ms override, not a coincidental fast real failure —
    // and, more importantly, that we never waited anywhere near the real default (120s).
    expect(elapsedMs).toBeLessThan(5000);
  }, 15000);

  it("[regression] a timed-out mutatesRepository task does not wedge the FIFO queue — the next queued mutation still runs", async () => {
    const dir = await initRepo();
    cleanupDirs.push(dir);
    await writeFile(dir, "a.txt", "1");
    await commit(dir, "first");
    await writeFile(dir, "a.txt", "2");
    await git(dir, ["add", "a.txt"]);

    // Hang inside a pre-commit hook specifically (as opposed to the fsmonitor vector above):
    // verified this hangs BEFORE git takes .git/index.lock, so killing it leaves no stale lock
    // behind to confound this test's actual assertion (that the QUEUE advances) with the
    // separate, already-documented residual risk of a stale lock file surviving a kill that
    // happens to land while a lock IS held (see DEFAULT_GIT_TIMEOUT_MS's doc comment).
    const { stdout: hooksDirRaw } = await git(dir, ["rev-parse", "--git-path", "hooks"]);
    const hooksDir = path.resolve(dir, hooksDirRaw.trim());
    await fs.promises.mkdir(hooksDir, { recursive: true });
    writeHangScript(hooksDir, "pre-commit");

    await writeFile(dir, "b.txt", "new file");

    const events: string[] = [];
    const hungCommit = runGit(["commit", "-q", "-m", "should hang in pre-commit"], {
      cwd: dir,
      mutatesRepository: true,
      timeoutMs: 300,
    }).then(
      () => events.push("commit:unexpectedly-resolved"),
      (err) => {
        events.push(`commit:rejected:${(err as Error).name}`);
        throw err;
      },
    );
    const queuedAdd = runGit(withFsmonitorNeutralized(["add", "--", "b.txt"]), {
      cwd: dir,
      mutatesRepository: true,
    }).then((r) => {
      events.push("add:resolved");
      return r;
    });

    await expect(hungCommit).rejects.toBeInstanceOf(GitCommandTimeoutError);
    // Must resolve on its own — if the timed-out task had wedged the queue, this would hang for
    // the remainder of the test's own timeout instead of ever settling.
    await expect(queuedAdd).resolves.toBeDefined();

    // And FIFO order was still respected: the hung task's rejection was observed before the
    // queued task's resolution, not the other way around.
    expect(events).toEqual(["commit:rejected:GitCommandTimeoutError", "add:resolved"]);

    const { stdout } = await git(dir, ["status", "--porcelain=v1"]);
    expect(stdout).toContain("A  b.txt");
  }, 15000);

  it("does not arm its own timer when the caller already supplies a signal — an aborting caller-supplied signal still cancels the call", async () => {
    const dir = await initRepo();
    cleanupDirs.push(dir);

    const controller = new AbortController();
    const promise = runGit(["status"], { cwd: dir, signal: controller.signal, timeoutMs: 300 });
    controller.abort();

    await expect(promise).rejects.toThrow();
    // Specifically NOT our own typed timeout error — the caller owns cancellation here, and
    // `armTimeout()` must not have raced its own 300ms timer against this explicit abort.
    await expect(promise).rejects.not.toBeInstanceOf(GitCommandTimeoutError);
  });

  // Security-review follow-up (HIGH, third pass on this same surface): the SIGKILL-escalation
  // callback used to check `boundChild.killed` before force-killing. `ChildProcess.killed` only
  // reflects that a kill signal was successfully *delivered*, not that the process actually
  // exited — so a process that traps/ignores SIGTERM (a real, in-scope hostile-hook pattern, e.g.
  // `trap '' TERM; while true; do sleep 1; done`) flips `.killed` to `true` the instant the
  // primary (SIGTERM-equivalent) kill is sent, well before it ever exits, if it ever does — which
  // made the `if (boundChild && !boundChild.killed)` guard false and skipped the SIGKILL entirely.
  // The hostile process then ran forever, undetected, contradicting this module's own documented
  // guarantee that SIGKILL "guarantees the OS process itself is eventually reaped even in that
  // case." Fixed by tracking the child's own `"exit"` event instead of `.killed`.
  //
  // `writeHangScript()` above cannot exercise this: it has no signal trap, so it dies on the very
  // first (primary) kill and never reaches the escalation branch at all — which is exactly why
  // this regression shipped undetected the first time.
  //
  // POSIX-only: see `installSignalTrappingFakeGit()`'s doc comment for why.
  it.skipIf(process.platform === "win32")(
    "[regression] SIGKILL escalation force-kills a process that traps/ignores the primary kill signal, not just one that already honored it",
    async () => {
      const dir = await initRepo();
      cleanupDirs.push(dir);

      const fakeGitDir = await makeTempDir();
      cleanupDirs.push(fakeGitDir);
      const heartbeatDir = await makeTempDir();
      cleanupDirs.push(heartbeatDir);
      const heartbeatPath = path.join(heartbeatDir, "heartbeat");
      fs.writeFileSync(heartbeatPath, "");
      installSignalTrappingFakeGit(fakeGitDir, heartbeatPath);

      const pathKey = findPathKey();
      const savedPath = process.env[pathKey];
      const savedExecPath = process.env.GIT_EXEC_PATH;
      process.env[pathKey] = fakeGitDir; // ONLY our fake git resolvable — never the real one
      delete process.env.GIT_EXEC_PATH;
      _resetGitExecutablePathCacheForTests();

      try {
        let caught: unknown;
        try {
          await runGit(["status"], { cwd: dir, timeoutMs: 300 });
        } catch (err) {
          caught = err;
        }
        expect(caught).toBeInstanceOf(GitCommandTimeoutError);

        // The task settling does NOT mean the process actually died (see armTimeout()'s doc
        // comment) — our fake git traps and ignores the primary kill, so at this point it is
        // still alive and writing its heartbeat. Confirm that's really true before asserting
        // anything about escalation, so this test can't pass by accident (e.g. if the fake git
        // never started at all).
        const heartbeatRightAfterTimeout = fs.readFileSync(heartbeatPath, "utf8").length;
        expect(heartbeatRightAfterTimeout).toBeGreaterThan(0);

        // Wait out the real SIGKILL-escalation grace period, plus margin for the OS to actually
        // reap the process once SIGKILL is sent.
        const graceMs = _timeoutSigkillGraceMsForTests();
        await new Promise((resolve) => setTimeout(resolve, graceMs + 2000));
        const heartbeatAfterGrace = fs.readFileSync(heartbeatPath, "utf8").length;

        // Confirm the heartbeat has actually stopped growing (not just slowed), by sampling
        // again after a further pause.
        await new Promise((resolve) => setTimeout(resolve, 1000));
        const heartbeatLater = fs.readFileSync(heartbeatPath, "utf8").length;

        // With the regression present, the trapping process is never SIGKILLed and keeps
        // appending forever; fixed, it's force-killed shortly after the grace period and the
        // heartbeat stops growing for good.
        expect(heartbeatLater).toBe(heartbeatAfterGrace);
      } finally {
        process.env[pathKey] = savedPath;
        if (savedExecPath === undefined) delete process.env.GIT_EXEC_PATH;
        else process.env.GIT_EXEC_PATH = savedExecPath;
        _resetGitExecutablePathCacheForTests();
        // Safety net only, not part of the assertion: if this test's own escalation-under-test
        // somehow failed to fire (e.g. a real regression, or this test running against a build
        // that predates the fix), the trapping process would otherwise survive as an orphan on
        // the machine running the suite. `fakeGitDir` is a fresh temp dir unique to this one
        // test run, so it's a safe, specific match for `pkill -f`. Best-effort: `pkill` may not
        // exist on every POSIX environment, and there is normally nothing left to match anyway
        // once the fix under test has already force-killed it.
        try {
          execFileSync("pkill", ["-9", "-f", fakeGitDir], { stdio: "ignore" });
        } catch {
          /* nothing to clean up, or no pkill available — not a test failure either way */
        }
      }
    },
    20000,
  );
});
