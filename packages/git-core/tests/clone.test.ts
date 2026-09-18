// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { clone } from "../src/clone";
import { classifyGitNetworkError } from "../src/networkErrorClassification";
import { GitCommandError, InvalidArgumentError, OperationCancelledError } from "../src/errors";
import { git, initRepo, makeTempDir, writeFile, commit, cleanup, fileExists } from "./testRepo";

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
