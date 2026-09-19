// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect, afterEach, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { clone } from "../src/clone";
import { classifyGitNetworkError } from "../src/networkErrorClassification";
import {
  CloneDestinationIsSymlinkError,
  GitCommandError,
  InvalidArgumentError,
  OperationCancelledError,
  UnsupportedGitVersionError,
} from "../src/errors";
import { _resetGitExecutablePathCacheForTests, _resetGitVersionCacheForTests } from "../src/gitProcess";
import { git, initRepo, makeTempDir, writeFile, commit, cleanup, fileExists } from "./testRepo";

function findPathEnvKey(): string {
  return Object.keys(process.env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
}

// Lets a single test simulate a single lstat() call racing ahead of the real filesystem state
// (see the TOCTOU regression test below) without disturbing every other test's real fs.lstat
// behavior. vi.hoisted() is required because vi.mock()'s factory is hoisted above this file's own
// top-level statements, so a plain `let` here would still be in its temporal dead zone when the
// factory first runs.
const raceLstatOnce = vi.hoisted(() => ({ current: null as null | (() => Promise<never>) }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    lstat: (...args: Parameters<typeof actual.lstat>) => {
      if (raceLstatOnce.current) {
        const override = raceLstatOnce.current;
        raceLstatOnce.current = null;
        return override();
      }
      return actual.lstat(...args);
    },
  };
});

/**
 * specs/online-sync-clone.md FR-352 through FR-355/FR-357. Exercised against real local bare
 * fixture repos (never real network hosts), mirroring `fetch.test.ts`'s/`push.test.ts`'s own
 * convention — a fixture reachable by local path exercises the exact same `clone()` code path a
 * real host would, with no internet or credentials needed. See the credential-failure describe
 * block below for the one exception (a real, loopback-only HTTP 401 challenge, same technique
 * `fetch.test.ts`'s own FR-325 block uses).
 */

const cleanupDirs: string[] = [];
afterEach(async () => {
  while (cleanupDirs.length) await cleanup(cleanupDirs.pop()!);
});

async function makeBareRemoteWithCommit(): Promise<{ bareDir: string; sha: string }> {
  const seedDir = await initRepo();
  cleanupDirs.push(seedDir);
  await writeFile(seedDir, "a.txt", "hello\n");
  const sha = await commit(seedDir, "base");

  const bareDir = await initRepo({ bare: true });
  cleanupDirs.push(bareDir);
  await git(seedDir, ["remote", "add", "origin", bareDir]);
  await git(seedDir, ["push", "-q", "origin", "main"]);
  return { bareDir, sha };
}

describe("clone() input validation", () => {
  it("rejects with InvalidArgumentError for an empty/whitespace-only URL, making no filesystem or git call at all", async () => {
    const parent = await makeTempDir();
    cleanupDirs.push(parent);
    const dest = path.join(parent, "dest");
    await expect(clone("", dest)).rejects.toBeInstanceOf(InvalidArgumentError);
    await expect(clone("   ", dest)).rejects.toBeInstanceOf(InvalidArgumentError);
    expect(await fileExists(dest)).toBe(false);
  });

  it("rejects with InvalidArgumentError for an empty/whitespace-only destination", async () => {
    await expect(clone("https://example.invalid/o/r.git", "")).rejects.toBeInstanceOf(InvalidArgumentError);
    await expect(clone("https://example.invalid/o/r.git", "   ")).rejects.toBeInstanceOf(InvalidArgumentError);
  });
});

describe("clone() (FR-352/AC1): reachable local bare fixture", () => {
  it("produces a real working-tree checkout at the chosen destination", async () => {
    const { bareDir, sha } = await makeBareRemoteWithCommit();
    const parent = await makeTempDir();
    cleanupDirs.push(parent);
    const dest = path.join(parent, "cloned-repo");

    const result = await clone(bareDir, dest);
    expect(result.path).toBe(path.resolve(dest));

    // A real working tree exists with the remote's content checked out. CRLF-tolerant, matching
    // `staging.test.ts`'s/`stash.test.ts`'s own precedent: a machine-wide `core.autocrlf=true`
    // (common on Windows) rewrites LF -> CRLF on `git clone`'s own checkout, irrelevant to what
    // this test is actually verifying (that the remote's real content landed on disk).
    expect(await fileExists(path.join(dest, "a.txt"))).toBe(true);
    const content = await fs.readFile(path.join(dest, "a.txt"), "utf8");
    expect(content.replace(/\r\n/g, "\n")).toBe("hello\n");

    const { stdout: headSha } = await git(dest, ["rev-parse", "HEAD"]);
    expect(headSha.trim()).toBe(sha);

    // The remote is named "origin" (no --origin flag ever passed) and tracking is wired up.
    const { stdout: remoteUrl } = await git(dest, ["remote", "get-url", "origin"]);
    expect(remoteUrl.trim()).toBe(bareDir);
    const { stdout: upstream } = await git(dest, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "main@{u}"]);
    expect(upstream.trim()).toBe("origin/main");
  });

  it("clones into a destination that does not exist yet, creating exactly that directory", async () => {
    const { bareDir } = await makeBareRemoteWithCommit();
    const parent = await makeTempDir();
    cleanupDirs.push(parent);
    const dest = path.join(parent, "brand-new-dir");
    expect(await fileExists(dest)).toBe(false);

    await clone(bareDir, dest);
    expect(await fileExists(path.join(dest, ".git"))).toBe(true);
  });

  it("clones successfully into a pre-existing, already-empty destination directory", async () => {
    const { bareDir } = await makeBareRemoteWithCommit();
    const parent = await makeTempDir();
    cleanupDirs.push(parent);
    const dest = path.join(parent, "pre-existing-empty");
    await fs.mkdir(dest);

    await clone(bareDir, dest);
    expect(await fileExists(path.join(dest, ".git"))).toBe(true);
  });

  // code-review pass (2026-09-20), Fix 1: `git clone <repo> level1/level2` succeeds against real
  // git even when NEITHER `level1` NOR `level2` exists yet — verified directly (git 2.31.1) — but
  // this module's old non-recursive `fs.mkdir` threw a raw ENOENT for the identical case, which the
  // surrounding catch didn't special-case, so `git clone` was never even invoked. `{recursive:true}`
  // fixes this; see clone.ts's own FR-355 doc comment for the full before/after contract.
  it("clones into a destination with missing intermediate parent directories, creating all of them (matching real git)", async () => {
    const { bareDir } = await makeBareRemoteWithCommit();
    const parent = await makeTempDir();
    cleanupDirs.push(parent);
    const dest = path.join(parent, "level1", "level2", "level3-cloned-repo");
    expect(await fileExists(path.join(parent, "level1"))).toBe(false);

    await clone(bareDir, dest);
    expect(await fileExists(path.join(dest, ".git"))).toBe(true);
    expect(await fileExists(path.join(dest, "a.txt"))).toBe(true);
  });

  it("clones into a destination whose immediate parent already exists but grandparent does not, creating only the missing levels", async () => {
    const { bareDir } = await makeBareRemoteWithCommit();
    const parent = await makeTempDir();
    cleanupDirs.push(parent);
    const existingMid = path.join(parent, "existing-mid");
    await fs.mkdir(existingMid);
    const dest = path.join(existingMid, "missing-leaf-dir", "cloned-repo");

    await clone(bareDir, dest);
    expect(await fileExists(path.join(dest, ".git"))).toBe(true);
    // The pre-existing ancestor itself is untouched, not recreated or altered.
    expect(await fs.readdir(existingMid)).toEqual(["missing-leaf-dir"]);
  });

  // code-review pass (2026-09-20), Fix 1 regression guard: proves `{recursive:true}` didn't
  // silently reopen the FR-355 "only ever delete what THIS call created" guarantee for the new
  // multi-level-creation case — a failed clone whose destination required creating several new
  // directories must clean up the ENTIRE subtree it created, not just the leaf, while leaving any
  // pre-existing ancestor completely alone.
  it("a genuine clone failure into a destination requiring several newly-created parent directories removes the ENTIRE subtree this call created, leaving the pre-existing ancestor alone", async () => {
    const parent = await makeTempDir();
    cleanupDirs.push(parent);
    const existingAncestor = path.join(parent, "pre-existing-ancestor");
    await fs.mkdir(existingAncestor);
    const dest = path.join(existingAncestor, "new1", "new2", "new3-cloned-repo");
    const nonexistentRemote = path.join(parent, "does-not-exist.git");

    await expect(clone(nonexistentRemote, dest)).rejects.toBeInstanceOf(GitCommandError);

    // Everything this call created (new1, and everything under it) is gone...
    expect(await fileExists(path.join(existingAncestor, "new1"))).toBe(false);
    // ...but the ancestor directory that already existed before this call is left alone.
    expect(await fileExists(existingAncestor)).toBe(true);
    expect(await fs.readdir(existingAncestor)).toEqual([]);
  });

  it("cancelling a clone into a destination with missing intermediate parents removes the entire subtree this call created", async () => {
    const { bareDir } = await makeBareRemoteWithCommit();
    const parent = await makeTempDir();
    cleanupDirs.push(parent);
    const dest = path.join(parent, "cancel-new1", "cancel-new2", "cancel-dest");

    const controller = new AbortController();
    const clonePromise = clone(bareDir, dest, { signal: controller.signal });
    controller.abort();
    await expect(clonePromise).rejects.toBeInstanceOf(OperationCancelledError);

    expect(await fileExists(path.join(parent, "cancel-new1"))).toBe(false);
    // The pre-existing temp-dir parent itself is untouched.
    expect(await fileExists(parent)).toBe(true);
  });

  it("reports incremental progress events while cloning", async () => {
    const { bareDir } = await makeBareRemoteWithCommit();
    const parent = await makeTempDir();
    cleanupDirs.push(parent);
    const dest = path.join(parent, "progress-repo");

    const events: { raw: string }[] = [];
    await clone(bareDir, dest, { onProgress: (event) => events.push({ raw: event.raw }) });
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((e) => typeof e.raw === "string")).toBe(true);
  });
});

describe("clone() (FR-353/AC2): destination already contains files", () => {
  it("refuses with git's real reason surfaced verbatim; no partial content is created beyond what already existed", async () => {
    const { bareDir } = await makeBareRemoteWithCommit();
    const parent = await makeTempDir();
    cleanupDirs.push(parent);
    const dest = path.join(parent, "nonempty");
    await fs.mkdir(dest);
    await fs.writeFile(path.join(dest, "existing.txt"), "pre-existing content\n", "utf8");

    let caught: unknown;
    try {
      await clone(bareDir, dest);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(GitCommandError);
    expect((caught as GitCommandError).stderr).toMatch(/already exists and is not an empty directory/i);

    // Nothing beyond what already existed: the pre-existing file is untouched, and no .git
    // directory (or any other clone artifact) was created inside it.
    const entries = await fs.readdir(dest);
    expect(entries).toEqual(["existing.txt"]);
    expect(await fs.readFile(path.join(dest, "existing.txt"), "utf8")).toBe("pre-existing content\n");
  });
});

describe("clone() (FR-355/AC3): cancelling mid-clone cleans up ONLY a directory GitHydra itself created", () => {
  it("AC3: cancelling a clone into a not-yet-existing destination removes exactly that directory, leaving nothing on disk", async () => {
    const { bareDir } = await makeBareRemoteWithCommit();
    const parent = await makeTempDir();
    cleanupDirs.push(parent);
    const dest = path.join(parent, "cancelled-new-dir");
    expect(await fileExists(dest)).toBe(false);

    const controller = new AbortController();
    const clonePromise = clone(bareDir, dest, { signal: controller.signal });
    controller.abort();
    await expect(clonePromise).rejects.toBeInstanceOf(OperationCancelledError);

    // The directory GitHydra itself created moments earlier is gone — nothing left behind.
    expect(await fileExists(dest)).toBe(false);
  });

  it("AC4: cancelling a clone into a destination with unrelated pre-existing content never deletes that content", async () => {
    const { bareDir } = await makeBareRemoteWithCommit();
    const parent = await makeTempDir();
    cleanupDirs.push(parent);
    const dest = path.join(parent, "cancelled-pre-existing");
    await fs.mkdir(dest);
    await fs.writeFile(path.join(dest, "unrelated.txt"), "do not delete me\n", "utf8");

    const controller = new AbortController();
    const clonePromise = clone(bareDir, dest, { signal: controller.signal });
    controller.abort();
    await expect(clonePromise).rejects.toThrow();

    // The directory itself, and its unrelated pre-existing content, must still be there —
    // regardless of whether this specific attempt resolved as a genuine cancellation or as git's
    // own near-instant "not empty" refusal racing the abort; either way, GitHydra did not create
    // this directory and must never delete it.
    expect(await fileExists(dest)).toBe(true);
    expect(await fs.readFile(path.join(dest, "unrelated.txt"), "utf8")).toBe("do not delete me\n");
  });

  it("a genuine (non-cancellation) clone failure into a destination GitHydra created also removes the empty directory it created", async () => {
    const parent = await makeTempDir();
    cleanupDirs.push(parent);
    const dest = path.join(parent, "failed-clone-dir");
    const nonexistentRemote = path.join(parent, "does-not-exist.git");

    await expect(clone(nonexistentRemote, dest)).rejects.toBeInstanceOf(GitCommandError);
    expect(await fileExists(dest)).toBe(false);
  });
});

describe("clone() (FR-357): credential failure reuses Phase 1's exact classification/redaction", () => {
  function startFakeGitHost(
    handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
  ): Promise<{ url: string; close: () => Promise<void> }> {
    return new Promise((resolve, reject) => {
      const server = http.createServer(handler);
      server.on("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const { port } = server.address() as AddressInfo;
        resolve({
          url: `http://127.0.0.1:${port}`,
          close: () => new Promise<void>((res) => server.close(() => res())),
        });
      });
    });
  }

  it(
    "AC5: a credential failure on a private-repo-shaped URL classifies identically to fetch/push's own https-auth-failed outcome",
    async () => {
      const server = await startFakeGitHost((req, res) => {
        res.writeHead(401, { "WWW-Authenticate": 'Basic realm="git-test"' });
        res.end("auth required\n");
      });
      // Clone happens before any repository (and therefore any repo-local git config) exists at
      // `destination` — unlike `fetch.test.ts`'s FR-325 block, there is no already-initialized
      // fixture repo to scope a local `git config credential.helper ""` override to. The
      // documented `GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_n`/`GIT_CONFIG_VALUE_n` environment-variable
      // mechanism (git >= 2.31, this package's own MIN_GIT_VERSION floor) achieves the identical
      // effect — overriding `credential.helper` for exactly this test process's own child git
      // invocations, restored in `finally` — without the PRODUCT code (`clone.ts`) disabling the
      // credential helper itself, which is precisely the mistake FR-325's own history (gitProcess.ts)
      // documents as having been reverted for `fetchRemote()` (it permanently broke real private-repo
      // authentication). Verified directly (see this repo's git-core-engineer investigation) that
      // this environment override reliably reproduces the exact deterministic, fast, non-interactive
      // failure this test asserts on, with no GUI credential prompt.
      const originalEnv = {
        GIT_CONFIG_COUNT: process.env.GIT_CONFIG_COUNT,
        GIT_CONFIG_KEY_0: process.env.GIT_CONFIG_KEY_0,
        GIT_CONFIG_VALUE_0: process.env.GIT_CONFIG_VALUE_0,
      };
      process.env.GIT_CONFIG_COUNT = "1";
      process.env.GIT_CONFIG_KEY_0 = "credential.helper";
      process.env.GIT_CONFIG_VALUE_0 = "";
      try {
        const parent = await makeTempDir();
        cleanupDirs.push(parent);
        const dest = path.join(parent, "private-repo-clone");

        const started = Date.now();
        let caught: unknown;
        try {
          await clone(`${server.url}/o/private.git`, dest);
        } catch (err) {
          caught = err;
        }
        const elapsedMs = Date.now() - started;

        expect(caught).toBeInstanceOf(GitCommandError);
        const classified = classifyGitNetworkError((caught as GitCommandError).stderr);
        expect(classified.kind).toBe("https-auth-failed");
        // Same generous-but-bounded ceiling `fetch.test.ts`'s identical FR-325 test uses — well
        // under the ~25-30s a real, unanswered credential-helper GUI prompt would take.
        expect(elapsedMs).toBeLessThan(10_000);

        // The directory GitHydra itself created for this failed attempt is cleaned up too (not
        // just cancellation — see the FR-355 describe block above).
        expect(await fileExists(dest)).toBe(false);
      } finally {
        for (const [key, value] of Object.entries(originalEnv)) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
        await server.close();
      }
    },
    15000,
  );
});

describe("clone() (FR-352/AC7): a URL beginning with '-' is never misinterpreted as a git flag", () => {
  it("passes a dash-prefixed URL through --end-of-options; git treats it as a literal (nonexistent) repository, never as an unrecognized option", async () => {
    const parent = await makeTempDir();
    cleanupDirs.push(parent);
    const dest = path.join(parent, "dash-url-dest");

    let caught: unknown;
    try {
      await clone("-evil-looking-url", dest);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(GitCommandError);
    const stderr = (caught as GitCommandError).stderr;
    // Real git (see this repo's git-core-engineer investigation, git 2.31.1.windows.1): with
    // --end-of-options in place, this fails with "repository '-evil-looking-url' does not exist" —
    // proving the value was parsed as a positional URL argument. Without that protection, git
    // would instead fail with an "unknown option" / usage-text refusal, never reaching this
    // message at all.
    expect(stderr).toMatch(/repository '-evil-looking-url' does not exist/i);
    expect(stderr).not.toMatch(/unknown option/i);

    // GitHydra created this (now-empty, clone-never-started) destination and must clean it up on
    // this ordinary failure too.
    expect(await fileExists(dest)).toBe(false);
  });
});

/**
 * security-review (2026-09-18, cross-phase online-sync audit, HIGH): `clone()` invokes `git clone`
 * with `cwd = path.dirname(resolvedDestination)` — the PARENT of the destination, which can be
 * anywhere, including inside an existing, unrelated git repository. Git's own upward
 * directory-based config discovery then finds and applies that unrelated repo's *local*
 * `.git/config`, including `core.sshCommand`, which git executes as a shell command when connecting
 * via SSH — `identityProfile.test.ts`'s own positive-control test already proves this executes
 * unconditionally in this exact environment. `withAmbientSshCommandNeutralized()` (`gitProcess.ts`)
 * closes this by always pinning `core.sshCommand=ssh` for `clone()`'s own invocation.
 */
describe("clone() (security-review 2026-09-18, HIGH): never inherits an ambient parent directory's core.sshCommand", () => {
  it("always includes -c core.sshCommand=ssh immediately adjacent, in every clone-related spawn argv", async () => {
    const parent = await makeTempDir();
    cleanupDirs.push(parent);
    const dest = path.join(parent, "argv-ssh-check-dest");

    // Any failing clone surfaces the exact argv this module built, via GitCommandError.args —
    // a nonexistent local path is the simplest way to force a fast, deterministic failure.
    const nonexistentRemote = path.join(parent, "does-not-exist.git");
    let caught: unknown;
    try {
      await clone(nonexistentRemote, dest);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(GitCommandError);
    const args = (caught as GitCommandError).args;

    let foundAdjacentPair = false;
    for (let i = 0; i < args.length - 1; i++) {
      if (args[i] === "-c" && args[i + 1] === "core.sshCommand=ssh") {
        foundAdjacentPair = true;
        break;
      }
    }
    expect(foundAdjacentPair).toBe(true);
  });

  it(
    "a malicious core.sshCommand planted in an unrelated ANCESTOR repo of the destination is never executed during a clone into a subdirectory of it",
    async () => {
      // Mirrors the audit's own example: a real project the user has lying around on disk
      // (parentRepo), with a "vendor" subdirectory the user clones an unrelated dependency into —
      // exactly the shape `clone()`'s cwd = path.dirname(destination) exposes to git's own upward
      // config discovery.
      const parentRepo = await initRepo();
      cleanupDirs.push(parentRepo);
      const outsideDir = await makeTempDir();
      cleanupDirs.push(outsideDir);
      const markerPath = path.join(outsideDir, "PWNED_CLONE_SSH_MARKER.txt");
      await fs.rm(markerPath, { force: true }).catch(() => {});

      // Same technique identityProfile.test.ts's own positive-control test uses to prove
      // core.sshCommand really is shell-parsed by git in this environment — deliberately set
      // directly via a raw `git config` call (never through this package's own, safe,
      // applyIdentityProfile()), to prove the AMBIENT config itself would be dangerous if honored.
      const maliciousValue = `sh -c 'echo pwned > ${JSON.stringify(markerPath)}' #`;
      await git(parentRepo, ["config", "--local", "core.sshCommand", maliciousValue]);

      const vendorDir = path.join(parentRepo, "vendor");
      await fs.mkdir(vendorDir);
      const dest = path.join(vendorDir, "new-dep");

      // ssh://127.0.0.1:1 -- nothing listens on port 1, so the real ssh connection always fails
      // fast (connection refused), but if the ambient core.sshCommand WERE applied, its shell
      // command would already have run before git ever got as far as dialing out (same ordering
      // identityProfile.test.ts's positive control documents).
      let caught: unknown;
      try {
        await clone("ssh://127.0.0.1:1/nonexistent.git", dest);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeDefined(); // the clone itself still fails -- that part is expected.

      const markerExists = await fs
        .access(markerPath)
        .then(() => true)
        .catch(() => false);
      expect(markerExists).toBe(false); // ...but the ambient repo's malicious command never ran.
    },
    20_000,
  );
});

/**
 * security-review (2026-09-18, cross-phase online-sync audit, MEDIUM): destination existence is
 * tracked via `fs.mkdir` throwing `EEXIST`, but a pre-existing SYMLINK at `destination` also fails
 * `EEXIST` without ever being dereferenced — so, absent an explicit check, clone would proceed and
 * git would follow the symlink, writing the whole cloned repository into whatever it points at,
 * silently outside the folder the user chose.
 */
describe("clone() (security-review 2026-09-18, MEDIUM): refuses a pre-existing symlink at the destination path", () => {
  it("throws CloneDestinationIsSymlinkError without following the symlink or writing anything into its target", async () => {
    const { bareDir } = await makeBareRemoteWithCommit();
    const parent = await makeTempDir();
    cleanupDirs.push(parent);
    const elsewhereDir = await makeTempDir();
    cleanupDirs.push(elsewhereDir);
    const dest = path.join(parent, "symlink-dest");

    try {
      // "junction" works on Windows without administrator privileges/developer mode (unlike a
      // plain file/dir symlink, which this machine's own environment verifiably refuses with
      // EPERM absent elevation) and is reported as a symlink by fs.lstat, which is all
      // clone()'s own check relies on. Ignored entirely on POSIX (an ordinary symlink there).
      await fs.symlink(elsewhereDir, dest, "junction");
    } catch (err) {
      // Symlink creation itself isn't permitted in this environment (e.g. a locked-down CI
      // runner) — skip rather than fail on an environment limitation unrelated to what this test
      // verifies.
      if ((err as NodeJS.ErrnoException).code === "EPERM") return;
      throw err;
    }

    let caught: unknown;
    try {
      await clone(bareDir, dest);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(CloneDestinationIsSymlinkError);
    expect((caught as CloneDestinationIsSymlinkError).destination).toBe(path.resolve(dest));

    // Nothing was written into the symlink's target directory.
    expect(await fs.readdir(elsewhereDir)).toEqual([]);
    // The symlink itself was left completely alone — clone() never created/deleted it (it isn't
    // the thing FR-355's createdDestination tracking is about; this refusal happens before that
    // logic is ever reached).
    const lstat = await fs.lstat(dest);
    expect(lstat.isSymbolicLink()).toBe(true);
  });

  it("clones normally into a pre-existing, non-symlink empty destination (no regression)", async () => {
    const { bareDir } = await makeBareRemoteWithCommit();
    const parent = await makeTempDir();
    cleanupDirs.push(parent);
    const dest = path.join(parent, "real-empty-dir");
    await fs.mkdir(dest);

    await clone(bareDir, dest);
    expect(await fileExists(path.join(dest, ".git"))).toBe(true);
  });

  it("still refuses a symlink planted after the initial lstat check but before mkdir (TOCTOU window)", async () => {
    const { bareDir } = await makeBareRemoteWithCommit();
    const parent = await makeTempDir();
    cleanupDirs.push(parent);
    const elsewhereDir = await makeTempDir();
    cleanupDirs.push(elsewhereDir);
    const dest = path.join(parent, "raced-symlink-dest");

    try {
      await fs.symlink(elsewhereDir, dest, "junction");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EPERM") return;
      throw err;
    }

    // Simulate the race: the very first lstat (clone()'s pre-check) sees ENOENT, as if the
    // symlink hadn't been planted yet at that instant — even though it's actually already there
    // on disk (planted above). Every later lstat call (including the EEXIST-fallback re-check
    // this test exists to prove) sees the real filesystem state.
    raceLstatOnce.current = () => {
      const err = new Error("ENOENT (simulated race)") as NodeJS.ErrnoException;
      err.code = "ENOENT";
      return Promise.reject(err);
    };

    let caught: unknown;
    try {
      await clone(bareDir, dest);
    } catch (err) {
      caught = err;
    } finally {
      raceLstatOnce.current = null;
    }

    expect(caught).toBeInstanceOf(CloneDestinationIsSymlinkError);
    expect(await fs.readdir(elsewhereDir)).toEqual([]);
  });
});

/**
 * code-review pass (2026-09-20), Fix 2: `clone()` is uniquely reachable from GitHydra's landing
 * screen with ZERO repositories ever opened — every other network primitive (`fetchRemote()`/
 * `pull()`/`push()`) only becomes reachable after `Repository.open()`, which itself calls
 * `checkGitVersion()` first (see `repository.ts`'s `resolveRepositoryPaths()`). Nothing in
 * `clone()`'s own call path previously checked git's version before spawning `git clone`, even
 * though its own `--end-of-options` argument-injection defense (`withEndOfOptions()`, used to build
 * this call's argv) implicitly assumes it. See `clone.ts`'s own comment directly above its
 * `checkGitVersion()` call for the full ordering rationale (placed after the destination-safety
 * checks, immediately before the real `git clone` spawn).
 */
describe("clone() (code-review 2026-09-20, Fix 2): gated by checkGitVersion() before the real git clone spawn", () => {
  it("surfaces checkGitVersion()'s own UnsupportedGitVersionError when git cannot be resolved on PATH, and cleans up whatever it created for this attempt", async () => {
    const parent = await makeTempDir();
    cleanupDirs.push(parent);
    const dest = path.join(parent, "version-gated-dest");

    // Same technique repository.test.ts's/gitProcess.test.ts's own checkGitVersion()-failure tests
    // use: make `git` genuinely unresolvable (empty PATH, no GIT_EXEC_PATH), reset both of
    // gitProcess.ts's process-wide caches, then restore everything in `finally`.
    const pathKey = findPathEnvKey();
    const savedPath = process.env[pathKey];
    const savedExecPath = process.env.GIT_EXEC_PATH;
    const emptyBinDir = await makeTempDir();
    cleanupDirs.push(emptyBinDir);
    process.env[pathKey] = emptyBinDir;
    delete process.env.GIT_EXEC_PATH;
    _resetGitExecutablePathCacheForTests();
    _resetGitVersionCacheForTests();

    try {
      await expect(clone("https://example.invalid/o/r.git", dest)).rejects.toBeInstanceOf(
        UnsupportedGitVersionError,
      );
      // checkGitVersion() runs AFTER the destination-safety checks (see clone.ts's own ordering
      // comment) — so this attempt DID create `dest` before failing the version gate. That
      // directory must be cleaned up on this failure exactly like any other post-mkdir failure,
      // never left behind.
      expect(await fileExists(dest)).toBe(false);
    } finally {
      process.env[pathKey] = savedPath;
      if (savedExecPath === undefined) delete process.env.GIT_EXEC_PATH;
      else process.env.GIT_EXEC_PATH = savedExecPath;
      _resetGitExecutablePathCacheForTests();
      _resetGitVersionCacheForTests();
    }
  });
});

/**
 * code-review pass (2026-09-20), Fix 3: investigated whether `clone()` also needs
 * `withFsmonitorNeutralized()` (`gitProcess.ts`) — the `-c core.fsmonitor=false` guard
 * `status`/`diff`/`add`/`restore`/`clean`/`commit` already apply, for the same ambient-config-
 * execution threat class `withAmbientSshCommandNeutralized()` above exists for, just against a
 * different config key. Concluded NO — see the doc comment directly above `clone()`'s own
 * `const args = ...` (`clone.ts`) for the full reasoning (a fresh clone builds its index from
 * scratch, with no prior index state for fsmonitor to answer a question about). This describe
 * block is the permanent regression proof for that conclusion, in the same spirit as
 * `identityProfile.test.ts`'s own `core.sshCommand` positive control: it deliberately runs a
 * completely UNGUARDED, raw `git clone` (bypassing this package's own `clone()` entirely) to prove
 * the underlying git BEHAVIOR, not anything about this module's own code.
 */
describe("clone() (code-review 2026-09-20, Fix 3): does NOT need core.fsmonitor neutralization", () => {
  it(
    "a raw, unguarded git clone's checkout never executes an ambient ancestor repo's malicious core.fsmonitor, even though that SAME ambient repo's malicious core.sshCommand IS reachable from an equivalent unguarded call (positive control proving the harness/fixture can detect a real leak)",
    async () => {
      const { bareDir } = await makeBareRemoteWithCommit();

      const parentRepo = await initRepo();
      cleanupDirs.push(parentRepo);
      await writeFile(parentRepo, "x.txt", "x");
      await commit(parentRepo, "init");

      const outsideDir = await makeTempDir();
      cleanupDirs.push(outsideDir);
      const fsmonMarkerPath = `${outsideDir.replace(/\\/g, "/")}/PWNED_FSMON_CLONE_MARKER`;
      const fsmonScriptPath = `${outsideDir.replace(/\\/g, "/")}/fsmonitor-marker.sh`;
      await writeFile(outsideDir, "fsmonitor-marker.sh", `#!/bin/sh\necho PWNED_FSMON > "${fsmonMarkerPath}"\n`);
      await git(parentRepo, ["config", "--local", "core.fsmonitor", fsmonScriptPath]);

      const sshMarkerPath = `${outsideDir.replace(/\\/g, "/")}/PWNED_SSH_MARKER`;
      const maliciousSshValue = `sh -c 'echo PWNED_SSH > "${sshMarkerPath}"' #`;
      await git(parentRepo, ["config", "--local", "core.sshCommand", maliciousSshValue]);

      const vendorDir = path.join(parentRepo, "vendor");
      await fs.mkdir(vendorDir);

      // The actual scenario Fix 3 investigates: a full, real, RAW (unguarded — no -c overrides of
      // any kind) `git clone` against a real local bare remote, producing a complete real checkout
      // — exactly the step whose fsmonitor-consultation this test answers.
      const dest = path.join(vendorDir, "new-dep-fsmon-check");
      await git(vendorDir, ["clone", "--quiet", bareDir, dest]);
      expect(await fileExists(path.join(dest, ".git"))).toBe(true);
      expect(await fileExists(fsmonMarkerPath)).toBe(false);

      // Positive control, identical cwd shape (same ambient repo, same subdirectory): proves this
      // exact fixture/harness IS capable of demonstrating a leaked ambient config value actually
      // executing — a raw command run with cwd inside/under this SAME ambient repo really does pick
      // up and execute its malicious core.sshCommand — confirming the fsmonitor result above is a
      // genuine negative, not a harness limitation unable to observe hook execution at all.
      let caught: unknown;
      try {
        await git(vendorDir, ["ls-remote", "ssh://127.0.0.1:1/nonexistent.git"]);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeDefined(); // the ssh connection itself still fails, as expected
      expect(await fileExists(sshMarkerPath)).toBe(true);
    },
    20_000,
  );
});
