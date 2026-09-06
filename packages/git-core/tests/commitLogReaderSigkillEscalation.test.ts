// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { CommitLogReader } from "../src";
import {
  _resetGitExecutablePathCacheForTests,
  _timeoutSigkillGraceMsForTests,
} from "../src/gitProcess";
import { OperationCancelledError } from "../src/errors";
import { initRepo, makeTempDir, cleanup } from "./testRepo";

/** process.env's PATH key isn't guaranteed to be spelled "PATH" on Windows. */
function findPathKey(): string {
  return Object.keys(process.env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
}

/**
 * specs/repo-open-feedback-fixes.md FR-197 claims (commitLog.ts's own
 * `CreateCommitLogReaderOptions.signal` doc comment, verbatim): a caller-supplied `signal` aborting
 * a `CommitLogReader`'s long-lived `git log` child process is "SIGKILL-escalated the same way (see
 * `ensureStarted()`)" as every other cancellable call in this package (`runGit`/`runGitBuffer`/etc.,
 * proved by gitProcess.test.ts's own "[FR-164] SIGKILL escalation force-kills a process that
 * traps/ignores the primary kill signal" test, using this exact fake-git-plus-heartbeat technique).
 *
 * Reading `CommitLogReader.ensureStarted()` directly shows this claim is false: it calls
 * `spawnGit(this.args, { cwd, signal })` with no `armTimeout()`/`armEscalation()` wiring at all —
 * `armEscalation` is a `gitProcess.ts`-internal helper never imported into `commitLog.ts`.
 * `CommitLogReader.close()` likewise only ever calls the unescalated default `child.kill()`.
 *
 * This test reproduces the exact same scenario gitProcess.test.ts's "[FR-164]" test proves is FIXED
 * for `runGit`, but against `CommitLogReader` (the process AC1/AC2's `startReader` cancellation
 * phase actually terminates) — a fake `git` that traps and ignores the primary kill signal, proven
 * alive via a growing heartbeat file. If this is genuinely "SIGKILL-escalated the same way",
 * aborting the reader's signal must stop the heartbeat for good within the same
 * `_timeoutSigkillGraceMsForTests()` grace window `runGit` uses. It does not — the process is an
 * orphan for the remainder of the test (and, in the real app, for the remainder of the process's
 * own lifetime, since nothing else ever revisits it).
 *
 * POSIX-only by nature (see gitProcess.test.ts's own `installSignalTrappingFakeGit()` doc comment):
 * relies on real SIGTERM-trapping shell semantics that don't apply on Windows, where `child.kill()`
 * is already unconditionally forceful on the very first call.
 */
describe("CommitLogReader signal cancellation — SIGKILL escalation claim (specs/repo-open-feedback-fixes.md FR-197)", () => {
  const cleanupDirs: string[] = [];
  afterEach(async () => {
    while (cleanupDirs.length) await cleanup(cleanupDirs.pop()!);
    _resetGitExecutablePathCacheForTests();
  });

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

  it.skipIf(process.platform === "win32")(
    "[BUG] aborting a CommitLogReader's signal never SIGKILL-escalates against a process that traps the primary kill signal — orphaned OS process survives past the same grace window runGit() honors",
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
        const controller = new AbortController();
        const reader = new CommitLogReader(dir, undefined, { signal: controller.signal });

        const pagePromise = reader.readPage(1);

        // Give the fake git a moment to actually start and begin heartbeating before cancelling —
        // otherwise this test could pass by accident (cancelling before anything ever spawned).
        await new Promise((resolve) => setTimeout(resolve, 200));
        const heartbeatBeforeCancel = fs.readFileSync(heartbeatPath, "utf8").length;
        expect(heartbeatBeforeCancel).toBeGreaterThan(0);

        controller.abort();
        await expect(pagePromise).rejects.toBeInstanceOf(OperationCancelledError);

        // The read settling does NOT mean the process actually died — our fake git traps and
        // ignores the primary kill, so at this point it is still alive and writing its heartbeat.
        const heartbeatRightAfterCancel = fs.readFileSync(heartbeatPath, "utf8").length;
        expect(heartbeatRightAfterCancel).toBeGreaterThan(heartbeatBeforeCancel);

        // Wait out the real SIGKILL-escalation grace period `runGit` honors, plus margin for the OS
        // to actually reap the process once SIGKILL is sent — exactly what gitProcess.test.ts's own
        // "[FR-164]" test waits out for `runGit`.
        const graceMs = _timeoutSigkillGraceMsForTests();
        await new Promise((resolve) => setTimeout(resolve, graceMs + 2000));
        const heartbeatAfterGrace = fs.readFileSync(heartbeatPath, "utf8").length;

        // Confirm the heartbeat has actually stopped growing (not just slowed), by sampling again
        // after a further pause.
        await new Promise((resolve) => setTimeout(resolve, 1000));
        const heartbeatLater = fs.readFileSync(heartbeatPath, "utf8").length;

        reader.close();

        // FAILING today: CommitLogReader has no SIGKILL escalation of its own (`ensureStarted()`
        // never calls `armEscalation()`/`armTimeout()`, unlike every `runGit`-backed call), so the
        // trapping process is never force-killed on caller cancellation — an orphaned OS process
        // that keeps appending to the heartbeat file forever. This assertion is what would pass if
        // the doc comment's "SIGKILL-escalated the same way" claim were actually implemented.
        expect(heartbeatAfterGrace).toBe(heartbeatLater);
      } finally {
        process.env[pathKey] = savedPath;
        if (savedExecPath === undefined) delete process.env.GIT_EXEC_PATH;
        else process.env.GIT_EXEC_PATH = savedExecPath;
        _resetGitExecutablePathCacheForTests();
        try {
          execFileSync("pkill", ["-9", "-f", fakeGitDir], { stdio: "ignore" });
        } catch {
          /* nothing to clean up, or no pkill available — not a test failure either way */
        }
      }
    },
    15000,
  );
});
