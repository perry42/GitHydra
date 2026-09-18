// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect, vi } from "vitest";

/**
 * security-review (Phase 5/Clone, Critical, 2026-09-18; superseded/generalized 2026-09-18 by the
 * cross-phase online-sync audit's Fix 3): unlike `fetchRemote()`/`push()`, whose argv only ever
 * carries a pre-configured remote *name*, `clone()`'s argv holds the caller-supplied `url` as a
 * literal positional value. `runNetworkGitProcess()`'s own `GitCommandError`/`GitCommandTimeoutError`/
 * `OperationCancelledError` construction (`git ${args.join(" ")} ...`, `gitProcess.ts`) therefore
 * could leak a credential embedded directly in `url` (`https://ghp_xxx@github.com/o/r.git`,
 * discouraged but real) verbatim — even for `GitCommandTimeoutError`/`OperationCancelledError`, which
 * have no `.stderr` field at all (a caller reading only `.message`, exactly what
 * `useCloneAction.ts`'s no-`stderr` fallback branch does, would render the raw token).
 *
 * `clone.ts` originally closed this with its own bespoke, clone-specific `.message`-patching catch
 * block (`redactCredentialsFromErrorMessage()`). The 2026-09-18 cross-phase audit's Fix 3 replaced
 * that with a more general fix: `GitCommandError`/`GitCommandTimeoutError`/`OperationCancelledError`
 * now redact `.message`, `.args`, AND `.stderr` in their OWN constructors (`errors.ts`), so every
 * construction site across the whole package — not just `clone()`'s — is safe by construction. This
 * file's premise moves with it: `.args` is no longer expected to carry the raw credential once an
 * error object has been constructed (it's redacted at construction time, same as `.message`), so
 * this test now asserts on the RAW args `clone()` actually handed to `runNetworkGitProcess()` (via
 * this mock's own parameter) to prove the credential really was in play, rather than reading it back
 * off the (now-redacted) `.args` property afterward. See `gitCommandErrorRedaction.test.ts` for the
 * standing, construction-site-agnostic regression guard the audit also asked for.
 *
 * Deliberately its own file, mirroring `fetchErrorRedaction.test.ts`'s own precedent: mocking
 * `../src/fetch` at module scope must be in place before `clone.ts` (which imports
 * `runNetworkGitProcess` from it) is first loaded, and doing that in a file shared with
 * `clone.test.ts`'s real-fixture describe blocks would break every one of them.
 *
 * A real, deterministic end-to-end `GitCommandTimeoutError` (an actually-hung child process racing a
 * real timeout) is NOT exercised here: `runNetworkGitProcess()` (`fetch.ts`) hardcodes
 * `DEFAULT_GIT_TIMEOUT_MS` (120_000ms) with no way for any caller — including `clone()` — to
 * override it for one invocation, and threading a shorter override through would mean modifying
 * `fetch.ts`'s shared, already-shipped/reviewed network harness (also used by `fetchRemote()`/
 * `push()`), which is out of scope for this fix. Directly constructing/throwing the exact error
 * shapes a real timeout (and a real non-timeout failure with empty stderr) would produce, from a
 * mocked `runNetworkGitProcess()`, exercises the identical redaction-at-construction path a real one
 * would hit — deterministically, with no 2-minute real-time wait and no real hung process to clean up.
 */

vi.mock("../src/fetch", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/fetch")>();
  return {
    ...actual,
    runNetworkGitProcess: vi.fn(),
  };
});

const { runNetworkGitProcess } = await import("../src/fetch");
const { clone } = await import("../src/clone");
const { GitCommandError, GitCommandTimeoutError, OperationCancelledError } = await import("../src/errors");
const { makeTempDir, cleanup, fileExists } = await import("./testRepo");
const path = await import("node:path");

const CREDENTIAL_URL = "https://ghp_SECRETTOKEN1234567890@github.com/org/repo.git";
const REDACTED_URL = "https://***@github.com/org/repo.git";

describe("clone()'s thrown error .message redacts a credential embedded in the clone URL (security-review, Phase 5/Clone, Critical)", () => {
  it("redacts the credential out of a GitCommandTimeoutError's .message, which carries no .stderr at all", async () => {
    const parent = await makeTempDir();
    try {
      const dest = path.join(parent, "dest-timeout");
      let rawArgsSeenByMock: readonly string[] = [];
      vi.mocked(runNetworkGitProcess).mockImplementationOnce(async (args) => {
        rawArgsSeenByMock = args;
        throw new GitCommandTimeoutError(args, 120_000);
      });

      let caught: unknown;
      try {
        await clone(CREDENTIAL_URL, dest);
      } catch (err) {
        caught = err;
      }

      // Not a vacuous pass: prove the raw argv `clone()` actually handed to
      // `runNetworkGitProcess()` really did carry the credential (this is exactly what the
      // constructor interpolates via `args.join(" ")`, `errors.ts`) before asserting it never
      // survives on the constructed error object.
      expect(rawArgsSeenByMock.join(" ")).toContain("ghp_SECRETTOKEN1234567890");

      expect(caught).toBeInstanceOf(GitCommandTimeoutError);
      const err = caught as InstanceType<typeof GitCommandTimeoutError>;
      // `GitCommandTimeoutError`'s own constructor (errors.ts) now redacts `.args` too, not just
      // `.message` — every field that could ever surface the credential.
      expect(err.args.join(" ")).not.toContain("ghp_SECRETTOKEN1234567890");
      expect(err.args.join(" ")).toContain(REDACTED_URL);
      expect(err.message).not.toContain("ghp_SECRETTOKEN1234567890");
      expect(err.message).toContain(REDACTED_URL);
      // `instanceof`/`.name` are preserved — callers (`main.ts`'s `serializeError()`,
      // `useCloneAction.ts`) branch on both.
      expect(err.name).toBe("GitCommandTimeoutError");
    } finally {
      await cleanup(parent);
    }
  });

  it("redacts the credential out of a GitCommandError's .message even when .stderr happens to be empty", async () => {
    const parent = await makeTempDir();
    try {
      const dest = path.join(parent, "dest-empty-stderr");
      vi.mocked(runNetworkGitProcess).mockImplementationOnce(async (args) => {
        throw new GitCommandError(`git ${args.join(" ")} exited with code 1: `, args, 1, "");
      });

      let caught: unknown;
      try {
        await clone(CREDENTIAL_URL, dest);
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(GitCommandError);
      const err = caught as InstanceType<typeof GitCommandError>;
      expect(err.message).not.toContain("ghp_SECRETTOKEN1234567890");
      expect(err.message).toContain(REDACTED_URL);
      // `.stderr` was already empty going in — confirms this isn't a false-pass because `.stderr`
      // itself carried something to redact.
      expect(err.stderr).toBe("");
      expect(err.name).toBe("GitCommandError");
    } finally {
      await cleanup(parent);
    }
  });

  it("also redacts the credential out of an OperationCancelledError's .message (every error path through the catch block, not just git-failure ones)", async () => {
    const parent = await makeTempDir();
    try {
      const dest = path.join(parent, "dest-cancelled");
      vi.mocked(runNetworkGitProcess).mockImplementationOnce(async (args) => {
        throw new OperationCancelledError(args);
      });

      let caught: unknown;
      try {
        await clone(CREDENTIAL_URL, dest);
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(OperationCancelledError);
      const err = caught as InstanceType<typeof OperationCancelledError>;
      expect(err.message).not.toContain("ghp_SECRETTOKEN1234567890");
      expect(err.message).toContain(REDACTED_URL);

      // FR-355: the directory clone() itself created for this failed attempt is still cleaned up —
      // the redaction fix must not have disturbed that existing cleanup behavior.
      expect(await fileExists(dest)).toBe(false);
    } finally {
      await cleanup(parent);
    }
  });
});
