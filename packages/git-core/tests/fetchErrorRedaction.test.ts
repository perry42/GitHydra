// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect, afterEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";

/**
 * security-review item 2 (2026-09-16, `specs/online-sync-security-flags.md`): `fetch.ts`'s
 * `runFetchProcess()` used to build a rejected `GitCommandError` from RAW, unredacted `stderr`.
 * `fetchRemote()` is directly exported, so any future caller reading `err.message`/`err.stderr`
 * instead of routing through `classifyGitNetworkError()` (which separately redacts, but only on
 * that one path) could silently reintroduce a credential leak. The fix redacts at construction —
 * this file proves it, by injecting a synthetic, fully-controlled stderr chunk through a mocked
 * `node:child_process.spawn`, since real git (2.31.1.windows.1, verified directly while writing
 * this) already strips userinfo from every real fatal message shape this module's own tests could
 * otherwise provoke — see `fetch.test.ts`'s note next to this file's own describe block for that
 * finding. Defense-in-depth for a different git version/transport/output shape that doesn't behave
 * the same way is exactly why `redactGitCredentials()` must run here regardless.
 *
 * Deliberately its own file, mirroring `noNetworkCalls.test.ts`'s own precedent: mocking
 * `node:child_process` at module scope must be in place before `gitProcess.ts` (which imports
 * `spawn` from it) is first loaded, and doing that in a file shared with other describe blocks
 * would affect every other test in that file.
 */

const FAKE_STDERR =
  "fatal: Authentication failed for 'http://user:supersecrettoken@127.0.0.1:1/o/private.git/'\n";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: (command: string, args: readonly string[], ...rest: unknown[]) => {
      // Only intercept the one call this test cares about (`git fetch ...`) — every other spawn
      // this test's own fixture setup makes (`init`, `config`, `remote add`) must still run
      // against real git, unmodified.
      if (Array.isArray(args) && args.includes("fetch")) {
        return makeFakeFetchChildProcess();
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (actual.spawn as any)(command, args, ...rest);
    },
  };
});

/**
 * A minimal stand-in for the real `ChildProcessByStdio` shape `fetch.ts`'s `runFetchProcess()`
 * actually uses: `.stdout`/`.stderr` readable streams, `.once("exit", ...)` (via `EventEmitter`),
 * and a `"close"` event carrying the exit code. Emits one fixed, fully-controlled stderr chunk
 * (with a real embedded credential in it) and closes with a non-zero code — deterministic, no real
 * git process ever spawned for this one call.
 */
function makeFakeFetchChildProcess() {
  const stdout = new Readable({ read() {} });
  const stderr = new Readable({ read() {} });
  const child = new EventEmitter() as EventEmitter & {
    stdout: Readable;
    stderr: Readable;
    kill: (signal?: string) => boolean;
  };
  child.stdout = stdout;
  child.stderr = stderr;
  child.kill = () => true;

  // Deferred so `runFetchProcess()` has already attached its `"data"`/`"close"` listeners (it does
  // so synchronously, right after spawning) before any of this fires.
  setImmediate(() => {
    stderr.push(FAKE_STDERR);
    stderr.push(null);
    stdout.push(null);
    child.emit("close", 128);
    child.emit("exit");
  });

  return child;
}

const { fetchRemote } = await import("../src/fetch");
const { GitCommandError } = await import("../src/errors");
const { initRepo, cleanup } = await import("./testRepo");

const cleanupDirs: string[] = [];
afterEach(async () => {
  while (cleanupDirs.length) await cleanup(cleanupDirs.pop()!);
});

describe("fetchRemote()'s GitCommandError redacts credentials at construction (security-review item 2)", () => {
  it("never surfaces the raw credential in either .message or .stderr, even when the underlying git process's own stderr does", async () => {
    const dir = await initRepo();
    cleanupDirs.push(dir);

    let caught: unknown;
    try {
      await fetchRemote(dir, "origin");
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(GitCommandError);
    const err = caught as GitCommandError;
    expect(err.message).not.toContain("supersecrettoken");
    expect(err.stderr).not.toContain("supersecrettoken");
    // Not a vacuous pass: the raw fixture really did carry the credential (asserted here so a
    // future edit that silently changes `FAKE_STDERR` can't make this pass by accident), and the
    // redacted placeholder is present in both fields in its place.
    expect(FAKE_STDERR).toContain("supersecrettoken");
    expect(err.message).toContain("http://***@127.0.0.1:1/o/private.git/");
    expect(err.stderr).toContain("http://***@127.0.0.1:1/o/private.git/");
  });
});
