// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect } from "vitest";
import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as path from "node:path";
import { runGit, runGitBuffer, runGitAllowingExitCodes, runGitWithInput } from "../src/gitProcess";
import { runNetworkGitProcess } from "../src/fetch";
import { GitCommandError, GitCommandTimeoutError, OperationCancelledError } from "../src/errors";
import { git, initRepo, writeFile, commit, cleanup, makeTempDir } from "./testRepo";

/**
 * specs/online-sync-security-flags.md / 2026-09-18 cross-phase online-sync audit, Fix 3: standing
 * regression guard proving `GitCommandError`/`GitCommandTimeoutError`/`OperationCancelledError` are
 * "safe by construction" — no `.message`, `.args`, or `.stderr` on ANY error these types' shared
 * constructors (`errors.ts`) produce can ever carry an unredacted `://user:pass@`-style credential,
 * regardless of which of this package's FIVE spawn-task functions (`runGitTask`, `runGitBufferTask`,
 * `runGitAllowingExitCodesTask`, `runGitWithInputTask`, `runNetworkGitProcess`) constructed it, and
 * regardless of whether that construction site itself remembers to redact anything.
 *
 * Before this fix, only `runNetworkGitProcess()` (used by `fetchRemote()`/`push()`/`clone()`)
 * pre-redacted `stderr` before constructing an error, and `clone.ts` separately patched `.message`
 * post-hoc in its own catch block specifically because it noticed this gap for its OWN case. The
 * other four spawn-task functions in `gitProcess.ts` built `GitCommandError`/`GitCommandTimeoutError`
 * directly, with no redaction at all — not exploitable today (no current call site passes a
 * credentialed URL into those four), but a trap for any future one (this module's own `RunOptions`
 * doc comment names a future "Remotes panel" as the exact trigger). Moving redaction into the shared
 * error constructors themselves closes that gap for every construction site, present and future.
 *
 * Two complementary techniques, mirroring `noNetworkCalls.test.ts`'s own black-box precedent (real
 * spawned processes, not mocks, wherever practical):
 *  - "constructor-level" describe block below: deterministic, parameterized direct tests of the
 *    three error constructors, independent of any spawn path — the most direct proof of "safe by
 *    construction."
 *  - "real spawn, every task function" describe block below: each of the five spawn-task functions
 *    is invoked directly with a credentialed URL as a literal argv element, forcing a REAL git
 *    process to fail (an unrecognized subcommand), and the resulting thrown error is inspected —
 *    proving the actual production code path comes out redacted, not just the constructor in
 *    isolation. A real `GitCommandTimeoutError` (via `runGit`'s hang-script/`timeoutMs` technique,
 *    mirroring `gitProcess.test.ts`'s own precedent) covers the one error shape that has no
 *    `.stderr` at all, so `.message`/`.args` are the ONLY fields that could ever leak for it.
 */

const CREDENTIAL_URL = "https://ghp_SECRETTOKEN1234567890@github.com/org/repo.git";
const REDACTED_URL = "https://***@github.com/org/repo.git";

describe("GitCommandError/GitCommandTimeoutError/OperationCancelledError are safe by construction (Fix 3)", () => {
  it("GitCommandError redacts .message, .args, and .stderr regardless of what's passed to its constructor", () => {
    const err = new GitCommandError(
      `git clone --progress ${CREDENTIAL_URL} /some/dest exited with code 128: fatal: Authentication failed for '${CREDENTIAL_URL}/'`,
      ["clone", "--progress", CREDENTIAL_URL, "/some/dest"],
      128,
      `fatal: Authentication failed for '${CREDENTIAL_URL}/'`,
    );

    expect(err.message).not.toContain("ghp_SECRETTOKEN1234567890");
    expect(err.message).toContain(REDACTED_URL);
    expect(err.args).not.toContain(CREDENTIAL_URL);
    expect(err.args).toContain(REDACTED_URL);
    expect(err.stderr).not.toContain("ghp_SECRETTOKEN1234567890");
    expect(err.stderr).toContain(REDACTED_URL);
    // Non-string fields untouched.
    expect(err.exitCode).toBe(128);
    expect(err.name).toBe("GitCommandError");
  });

  it("GitCommandError redacts even when only .args carries the credential (message/stderr credential-free)", () => {
    // Regression for the exact gap this fix closes: a caller that builds `message`/`stderr` safely
    // but still passes the raw credentialed argv straight through to `.args`.
    const err = new GitCommandError("git clone exited with code 1: some unrelated failure", [
      "clone",
      CREDENTIAL_URL,
      "/dest",
    ], 1, "some unrelated failure");

    expect(err.args).not.toContain(CREDENTIAL_URL);
    expect(err.args).toContain(REDACTED_URL);
  });

  it("GitCommandTimeoutError redacts .message and .args (it has no .stderr field at all)", () => {
    const err = new GitCommandTimeoutError(["clone", "--progress", CREDENTIAL_URL, "/dest"], 120_000);

    expect(err.message).not.toContain("ghp_SECRETTOKEN1234567890");
    expect(err.message).toContain(REDACTED_URL);
    expect(err.args).not.toContain(CREDENTIAL_URL);
    expect(err.args).toContain(REDACTED_URL);
    expect(err.timeoutMs).toBe(120_000);
    expect(err.name).toBe("GitCommandTimeoutError");
  });

  it("OperationCancelledError redacts .message and .args", () => {
    const err = new OperationCancelledError(["clone", "--progress", CREDENTIAL_URL, "/dest"]);

    expect(err.message).not.toContain("ghp_SECRETTOKEN1234567890");
    expect(err.message).toContain(REDACTED_URL);
    expect(err.args).not.toContain(CREDENTIAL_URL);
    expect(err.args).toContain(REDACTED_URL);
    expect(err.name).toBe("OperationCancelledError");
  });

  it("passes an argv/message/stderr with no credential through byte-for-byte unchanged", () => {
    const err = new GitCommandError(
      "git status exited with code 1: fatal: not a git repository",
      ["status", "--porcelain=v1"],
      1,
      "fatal: not a git repository",
    );
    expect(err.message).toBe("git status exited with code 1: fatal: not a git repository");
    expect(err.args).toEqual(["status", "--porcelain=v1"]);
    expect(err.stderr).toBe("fatal: not a git repository");
  });
});

describe("real spawn, every task function: no GitCommandError/GitCommandTimeoutError can leak a credential (Fix 3)", () => {
  const cleanupDirs: string[] = [];

  async function makeRepoWithCredentialedArgv(): Promise<string> {
    const dir = await initRepo();
    cleanupDirs.push(dir);
    await writeFile(dir, "a.txt", "1\n");
    await commit(dir, "base");
    return dir;
  }

  async function cleanupAll(): Promise<void> {
    while (cleanupDirs.length) await cleanup(cleanupDirs.pop()!);
  }

  it("runGit: an unrecognized-subcommand failure with a credentialed URL argv element never leaks it", async () => {
    const dir = await makeRepoWithCredentialedArgv();
    try {
      let caught: unknown;
      try {
        await runGit(["definitely-not-a-real-subcommand", CREDENTIAL_URL], { cwd: dir });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(GitCommandError);
      const err = caught as GitCommandError;
      expect(err.message).not.toContain("ghp_SECRETTOKEN1234567890");
      expect(err.args.join(" ")).not.toContain("ghp_SECRETTOKEN1234567890");
      expect(err.stderr).not.toContain("ghp_SECRETTOKEN1234567890");
    } finally {
      await cleanupAll();
    }
  });

  it("runGitBuffer: same guarantee for the Buffer-returning task function", async () => {
    const dir = await makeRepoWithCredentialedArgv();
    try {
      let caught: unknown;
      try {
        await runGitBuffer(["definitely-not-a-real-subcommand", CREDENTIAL_URL], { cwd: dir });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(GitCommandError);
      const err = caught as GitCommandError;
      expect(err.message).not.toContain("ghp_SECRETTOKEN1234567890");
      expect(err.args.join(" ")).not.toContain("ghp_SECRETTOKEN1234567890");
      expect(err.stderr).not.toContain("ghp_SECRETTOKEN1234567890");
    } finally {
      await cleanupAll();
    }
  });

  it("runGitAllowingExitCodes: same guarantee, with an exit code outside the allowed set", async () => {
    const dir = await makeRepoWithCredentialedArgv();
    try {
      let caught: unknown;
      try {
        await runGitAllowingExitCodes(["definitely-not-a-real-subcommand", CREDENTIAL_URL], { cwd: dir }, [0]);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(GitCommandError);
      const err = caught as GitCommandError;
      expect(err.message).not.toContain("ghp_SECRETTOKEN1234567890");
      expect(err.args.join(" ")).not.toContain("ghp_SECRETTOKEN1234567890");
      expect(err.stderr).not.toContain("ghp_SECRETTOKEN1234567890");
    } finally {
      await cleanupAll();
    }
  });

  it("runGitWithInput: same guarantee for the stdin-piping task function", async () => {
    const dir = await makeRepoWithCredentialedArgv();
    try {
      let caught: unknown;
      try {
        await runGitWithInput(["definitely-not-a-real-subcommand", CREDENTIAL_URL], { cwd: dir }, "irrelevant input");
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(GitCommandError);
      const err = caught as GitCommandError;
      expect(err.message).not.toContain("ghp_SECRETTOKEN1234567890");
      expect(err.args.join(" ")).not.toContain("ghp_SECRETTOKEN1234567890");
      expect(err.stderr).not.toContain("ghp_SECRETTOKEN1234567890");
    } finally {
      await cleanupAll();
    }
  });

  it("runNetworkGitProcess: same guarantee for the fetch/push/clone-shared network harness", async () => {
    const dir = await makeRepoWithCredentialedArgv();
    try {
      let caught: unknown;
      try {
        await runNetworkGitProcess(
          ["definitely-not-a-real-subcommand", CREDENTIAL_URL],
          dir,
          "origin",
          undefined,
          undefined,
        );
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(GitCommandError);
      const err = caught as GitCommandError;
      expect(err.message).not.toContain("ghp_SECRETTOKEN1234567890");
      expect(err.args.join(" ")).not.toContain("ghp_SECRETTOKEN1234567890");
      expect(err.stderr).not.toContain("ghp_SECRETTOKEN1234567890");
    } finally {
      await cleanupAll();
    }
  });

  /** Mirrors gitProcess.test.ts's own "bounded-invocation timeout (hung child process)" precedent:
   * a real, genuinely-hanging child process (a `core.fsmonitor` hook script that spins forever),
   * with `timeoutMs` overridden small so this doesn't have to wait out the real 2-minute default. */
  function writeHangScript(dir: string, name: string): string {
    const scriptPath = path.join(dir, name);
    fsSync.writeFileSync(scriptPath, "#!/bin/sh\nwhile true; do sleep 1; done\n", { mode: 0o755 });
    try {
      fsSync.chmodSync(scriptPath, 0o755);
    } catch {
      /* chmod is a no-op-ish on Windows; the shebang alone is enough for git-for-windows to run it */
    }
    return scriptPath;
  }

  it("a real GitCommandTimeoutError (no .stderr at all) never leaks a credential embedded in .args", async () => {
    const dir = await makeRepoWithCredentialedArgv();
    try {
      const hangScript = writeHangScript(dir, "hang-fsmonitor.sh");
      await git(dir, ["config", "core.fsmonitor", hangScript.split(path.sep).join("/")]);
      await writeFile(dir, "a.txt", "2\n");

      let caught: unknown;
      try {
        // A credentialed URL is not a realistic `status` argv element in production, but this
        // proves the constructor-level redaction applies unconditionally, not just for the
        // specific argv shapes today's call sites happen to produce.
        await runGit(["status", "--porcelain=v1", CREDENTIAL_URL], { cwd: dir, timeoutMs: 300 });
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(GitCommandTimeoutError);
      const err = caught as GitCommandTimeoutError;
      expect(err.message).not.toContain("ghp_SECRETTOKEN1234567890");
      expect(err.message).toContain(REDACTED_URL);
      expect(err.args.join(" ")).not.toContain("ghp_SECRETTOKEN1234567890");
      expect(err.args.join(" ")).toContain(REDACTED_URL);
    } finally {
      await cleanupAll();
    }
  }, 15_000);

  it("a real OperationCancelledError never leaks a credential embedded in .args", async () => {
    const parent = await makeTempDir();
    try {
      const controller = new AbortController();
      const promise = runGit(["clone", CREDENTIAL_URL, path.join(parent, "dest")], {
        cwd: parent,
        signal: controller.signal,
      });
      controller.abort();

      let caught: unknown;
      try {
        await promise;
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(OperationCancelledError);
      const err = caught as OperationCancelledError;
      expect(err.message).not.toContain("ghp_SECRETTOKEN1234567890");
      expect(err.args.join(" ")).not.toContain("ghp_SECRETTOKEN1234567890");
    } finally {
      await fs.rm(parent, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
    }
  });
});
