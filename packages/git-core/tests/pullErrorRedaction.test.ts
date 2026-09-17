// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect, afterEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";

/**
 * security review follow-up (2026-09-18, on `specs/online-sync-pull.md`'s Phase 3): mirrors
 * `fetchErrorRedaction.test.ts`'s own regression exactly, but driven through `pull()` end-to-end
 * rather than `fetchRemote()` directly. `fetchErrorRedaction.test.ts` already proves
 * `fetchRemote()`'s own thrown `GitCommandError` is redacted at construction — this file proves
 * that guarantee actually reaches a `pull()` caller unchanged: `pull()` never catches, rewraps, or
 * re-stringifies the error its one internal `fetchRemote()` call rejects with (see `pull.ts` —
 * that `await fetchRemote(...)` call has no surrounding try/catch at all), so nothing in the chain
 * from `pull()` through `Repository.pull()` to a future IPC layer could reintroduce a credential
 * leak by, say, wrapping it in a new `Error("Pull failed: " + err.message)`. Today that holds by
 * inspection alone; this test makes it a mechanical regression guard instead.
 *
 * Deliberately its own file, mirroring `fetchErrorRedaction.test.ts`'s/`noNetworkCalls.test.ts`'s
 * own precedent: mocking `node:child_process` at module scope must be in place before
 * `gitProcess.ts` (which imports `spawn` from it) is first loaded, and doing that in a file shared
 * with other describe blocks would affect every other test in that file.
 */

const FAKE_STDERR =
  "fatal: Authentication failed for 'http://user:supersecrettoken@127.0.0.1:1/o/private.git/'\n";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: (command: string, args: readonly string[], ...rest: unknown[]) => {
      // Only intercept the one call this test cares about (`git fetch ...`, `pull()`'s own single
      // internal fetch) — every other spawn `pull()` itself makes beforehand (`symbolic-ref`,
      // `config --get` for branch.main.remote/merge, `rev-parse` for HEAD) and every spawn this
      // test's own fixture setup makes (`init`, `config`) must still run against real git,
      // unmodified.
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
 * actually uses — identical to `fetchErrorRedaction.test.ts`'s own helper of the same name. Emits
 * one fixed, fully-controlled stderr chunk (with a real embedded credential in it) and closes with
 * a non-zero code — deterministic, no real git process ever spawned for this one call.
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

const { pull } = await import("../src/pull");
const { GitCommandError } = await import("../src/errors");
const { git, initRepo, writeFile, commit, cleanup } = await import("./testRepo");

const cleanupDirs: string[] = [];
afterEach(async () => {
  while (cleanupDirs.length) await cleanup(cleanupDirs.pop()!);
});

describe("pull()'s propagated GitCommandError redacts credentials, end-to-end through its internal fetchRemote() call", () => {
  it("never surfaces the raw credential in either .message or .stderr, even when the underlying git fetch's own stderr does", async () => {
    const dir = await initRepo();
    cleanupDirs.push(dir);
    await writeFile(dir, "a.txt", "1\n");
    await commit(dir, "base");
    // A real, configured upstream is required for pull() to ever reach its internal
    // fetchRemote() call at all (FR-341) — the remote itself never needs to actually exist,
    // since the mock above intercepts the `git fetch` spawn before any real network attempt.
    await git(dir, ["config", "branch.main.remote", "origin"]);
    await git(dir, ["config", "branch.main.merge", "refs/heads/main"]);

    let caught: unknown;
    try {
      await pull(dir);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(GitCommandError);
    const err = caught as GitCommandError;
    expect(err.message).not.toContain("supersecrettoken");
    expect(err.stderr).not.toContain("supersecrettoken");
    // Not a vacuous pass: the raw fixture really did carry the credential (asserted here so a
    // future edit that silently changes `FAKE_STDERR` can't make this pass by accident), and the
    // redacted placeholder is present in both fields in its place — proving this is genuinely the
    // SAME already-redacted error `fetchRemote()` itself threw, passed through by `pull()`
    // unmodified, not a re-stringified or newly-constructed one that happens to also be safe.
    expect(FAKE_STDERR).toContain("supersecrettoken");
    expect(err.message).toContain("http://***@127.0.0.1:1/o/private.git/");
    expect(err.stderr).toContain("http://***@127.0.0.1:1/o/private.git/");
  });
});
