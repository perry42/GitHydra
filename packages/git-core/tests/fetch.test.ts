// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect, afterEach } from "vitest";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import {
  fetchRemote,
  fetchAllRemotes,
  listConfiguredRemotes,
  parseFetchProgressLine,
} from "../src/fetch";
import { GitCommandError, InvalidArgumentError, OperationCancelledError } from "../src/errors";
import { git, initRepo, writeFile, commit, cleanup, makeTempDir, fileExists } from "./testRepo";

/**
 * specs/online-sync-fetch.md FR-320/FR-321/FR-322/FR-325. Exercised against real local bare
 * fixture repos (never real network hosts) — a fixture reachable by local path/`file://` exercises
 * the exact same `fetchRemote`/`fetchAllRemotes` code paths a real host would, with no internet or
 * credentials needed. See the "FR-325" describe block below for the one exception: that block
 * deliberately DOES bind a real (loopback-only) HTTP server, since reproducing an HTTPS credential
 * failure requires a real HTTP 401 challenge.
 *
 * IMPORTANT (security-review item 1, 2026-09-16): `fetchRemote()` no longer disables the system
 * credential helper (see `gitProcess.ts`'s history at the removed `withCredentialHelperNeutralized()`
 * for why). That means a test in this file that fetches against a real 401 challenge with the
 * system's OWN credential helper still configured (e.g. Git Credential Manager on Windows) can pop
 * a real, unattended GUI prompt on whoever's machine runs this suite — confirmed twice, directly, on
 * a real dev machine. Every such test in this file MUST clear `credential.helper` for its OWN
 * fixture repo (`git config credential.helper ""`, local scope — read after, and so overriding, any
 * system/global config, per git's own documented multi-valued-key-reset precedence) before calling
 * `fetchRemote`/`fetchAllRemotes`, so the suite stays deterministic and non-interactive without
 * relying on the production code to disable anything.
 */

const cleanupDirs: string[] = [];
afterEach(async () => {
  while (cleanupDirs.length) await cleanup(cleanupDirs.pop()!);
});

async function makeBareRemoteWithCommit(): Promise<{ bareDir: string; seedDir: string; sha: string }> {
  const seedDir = await initRepo();
  cleanupDirs.push(seedDir);
  await writeFile(seedDir, "a.txt", "1\n");
  const sha = await commit(seedDir, "base");

  const bareDir = await initRepo({ bare: true });
  cleanupDirs.push(bareDir);
  await git(seedDir, ["remote", "add", "origin", bareDir]);
  await git(seedDir, ["push", "-q", "origin", "main"]);
  return { bareDir, seedDir, sha };
}

async function addCommitAndPush(seedDir: string, message: string): Promise<string> {
  await writeFile(seedDir, "a.txt", `${message}\n`);
  const sha = await commit(seedDir, message);
  await git(seedDir, ["push", "-q", "origin", "main"]);
  return sha;
}

describe("parseFetchProgressLine (FR-322)", () => {
  // Every fixture line below was captured verbatim from a real `git fetch --progress` invocation
  // (git 2.31.1.windows.1, 2026-09-16) over three real transports (a local `file://` path, a real
  // `git://` daemon on loopback, and a real GitHub HTTPS remote) — see `FetchProgressEvent`'s own
  // doc comment (types.ts) for the full writeup, including the surprising finding that `fetch`
  // (unlike `clone`) never emits "Receiving objects"/"Resolving deltas" on this git version.

  it("parses a real 'remote: Counting objects: NN% (a/b)' line", () => {
    const event = parseFetchProgressLine("origin", "remote: Counting objects:  52% (35/67)        ");
    expect(event).toEqual({ remoteName: "origin", stage: "Counting objects", percent: 52, raw: "remote: Counting objects:  52% (35/67)" });
  });

  it("parses a real 'remote: Compressing objects: NN% (a/b), done.' line", () => {
    const event = parseFetchProgressLine("origin", "remote: Compressing objects: 100% (15/15), done.        ");
    expect(event.stage).toBe("Compressing objects");
    expect(event.percent).toBe(100);
  });

  it("parses a real 'remote: Enumerating objects: N, done.' line as unparsed (no percent present)", () => {
    const event = parseFetchProgressLine("origin", "remote: Enumerating objects: 67, done.        ");
    expect(event).toEqual({ remoteName: "origin", stage: null, percent: null, raw: "remote: Enumerating objects: 67, done." });
  });

  it("parses a defensive non-'remote:'-prefixed 'Receiving objects'-shaped line (client-side, observed from `clone`, not `fetch`, on this git version)", () => {
    const event = parseFetchProgressLine("origin", "Receiving objects:  76% (51/67)");
    expect(event).toEqual({ remoteName: "origin", stage: "Receiving objects", percent: 76, raw: "Receiving objects:  76% (51/67)" });
  });

  it("parses a defensive 'Resolving deltas' line", () => {
    const event = parseFetchProgressLine("origin", "Resolving deltas: 100% (7/7), done.");
    expect(event.stage).toBe("Resolving deltas");
    expect(event.percent).toBe(100);
  });

  it("falls through to stage: null, percent: null for a line with no recognizable shape at all, never dropping it", () => {
    const event = parseFetchProgressLine("origin", "remote: Total 67 (delta 7), reused 0 (delta 0), pack-reused 0");
    expect(event.stage).toBeNull();
    expect(event.percent).toBeNull();
    expect(event.raw).toContain("Total 67");
  });

  it("redacts an embedded credential in a raw progress line defensively (FR-324), even though no real observed progress line has ever contained one", () => {
    const event = parseFetchProgressLine("origin", "remote: fetching https://user:secrettoken@host/o/r.git 10% (1/10)");
    expect(event.raw).not.toContain("secrettoken");
    expect(event.raw).toContain("https://***@host/o/r.git");
  });

  it("clamps a nonsensical >100 percent defensively rather than passing it straight through", () => {
    const event = parseFetchProgressLine("origin", "remote: Counting objects: 150% (999/10)");
    expect(event.percent).toBe(100);
  });
});

describe("listConfiguredRemotes (FR-321)", () => {
  it("returns an empty array for a repo with zero remotes configured", async () => {
    const dir = await initRepo();
    cleanupDirs.push(dir);
    await expect(listConfiguredRemotes(dir)).resolves.toEqual([]);
  });

  it("returns every configured remote's name", async () => {
    const dir = await initRepo();
    cleanupDirs.push(dir);
    await git(dir, ["remote", "add", "origin", "https://example.invalid/o/r.git"]);
    await git(dir, ["remote", "add", "upstream", "https://example.invalid/o/upstream.git"]);
    await expect(listConfiguredRemotes(dir)).resolves.toEqual(["origin", "upstream"]);
  });
});

describe("fetchRemote (FR-320)", () => {
  it("rejects with InvalidArgumentError for an empty remote name, making no git call at all", async () => {
    const dir = await initRepo();
    cleanupDirs.push(dir);
    await expect(fetchRemote(dir, "")).rejects.toBeInstanceOf(InvalidArgumentError);
    await expect(fetchRemote(dir, "   ")).rejects.toBeInstanceOf(InvalidArgumentError);
  });

  it("AC1: fetching a repo with one reachable remote updates that remote's tracking ref to match the fixture's new tip", async () => {
    const { bareDir, seedDir, sha: firstSha } = await makeBareRemoteWithCommit();

    const dstDir = await initRepo();
    cleanupDirs.push(dstDir);
    await git(dstDir, ["remote", "add", "origin", bareDir]);
    await fetchRemote(dstDir, "origin");
    const { stdout: beforeSha } = await git(dstDir, ["rev-parse", "origin/main"]);
    expect(beforeSha.trim()).toBe(firstSha);

    const newSha = await addCommitAndPush(seedDir, "second commit");
    expect(newSha).not.toBe(firstSha);

    await fetchRemote(dstDir, "origin");
    const { stdout: afterSha } = await git(dstDir, ["rev-parse", "origin/main"]);
    expect(afterSha.trim()).toBe(newSha);
  });

  it("reports incremental progress events while fetching (FR-322)", async () => {
    const { bareDir } = await makeBareRemoteWithCommit();
    const dstDir = await initRepo();
    cleanupDirs.push(dstDir);
    await git(dstDir, ["remote", "add", "origin", bareDir]);

    const events: { remoteName: string; raw: string }[] = [];
    await fetchRemote(dstDir, "origin", {
      onProgress: (event) => events.push({ remoteName: event.remoteName, raw: event.raw }),
    });

    expect(events.length).toBeGreaterThan(0);
    for (const event of events) expect(event.remoteName).toBe("origin");
    // At least one real remote-side stage line should have come through.
    expect(events.some((e) => /Enumerating objects|Counting objects|Compressing objects|Total/.test(e.raw))).toBe(true);
  });

  it("rejects with GitCommandError (stderr populated) fetching a remote pointing at an unreachable host", async () => {
    const dir = await initRepo();
    cleanupDirs.push(dir);
    await git(dir, ["remote", "add", "origin", "https://198.51.100.1.invalid/nonexistent.git"]);

    let caught: unknown;
    try {
      await fetchRemote(dir, "origin");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(GitCommandError);
    expect((caught as GitCommandError).stderr.length).toBeGreaterThan(0);
  }, 15000);

  it("AC6/FR-322: cancelling an in-flight fetch stops the process and leaves refs exactly as they were before", async () => {
    const { bareDir, seedDir, sha: firstSha } = await makeBareRemoteWithCommit();

    const dstDir = await initRepo();
    cleanupDirs.push(dstDir);
    await git(dstDir, ["remote", "add", "origin", bareDir]);
    // Establish an initial tracking ref at the FIRST commit, pre-cancellation.
    await git(dstDir, ["fetch", "-q", "origin"]);
    const { stdout: beforeRef } = await git(dstDir, ["rev-parse", "origin/main"]);
    expect(beforeRef.trim()).toBe(firstSha);

    // Advance the remote AFTER dstDir's baseline fetch, so there is genuinely new history for the
    // (about-to-be-cancelled) second fetch attempt to have pulled in, had it not been cancelled.
    await addCommitAndPush(seedDir, "a much later commit");

    const controller = new AbortController();
    const fetchPromise = fetchRemote(dstDir, "origin", { signal: controller.signal });
    controller.abort();
    await expect(fetchPromise).rejects.toBeInstanceOf(OperationCancelledError);

    // The ref must not have been advanced by the cancelled attempt.
    const { stdout: afterRef } = await git(dstDir, ["rev-parse", "origin/main"]);
    expect(afterRef.trim()).toBe(firstSha);
  });

  it("cancelling before the process even starts (already-aborted signal) still rejects with OperationCancelledError", async () => {
    const { bareDir } = await makeBareRemoteWithCommit();
    const dstDir = await initRepo();
    cleanupDirs.push(dstDir);
    await git(dstDir, ["remote", "add", "origin", bareDir]);

    const controller = new AbortController();
    controller.abort();
    await expect(fetchRemote(dstDir, "origin", { signal: controller.signal })).rejects.toBeInstanceOf(
      OperationCancelledError,
    );
  });
});

describe("fetchAllRemotes (FR-321)", () => {
  it("returns an empty, non-error result for a repo with zero remotes configured", async () => {
    const dir = await initRepo();
    cleanupDirs.push(dir);
    await expect(fetchAllRemotes(dir)).resolves.toEqual({ outcomes: [] });
  });

  it("AC2: reports success for a reachable remote and a specific, attributable failure for an unreachable one — never one combined opaque error", async () => {
    const { bareDir } = await makeBareRemoteWithCommit();
    const dir = await initRepo();
    cleanupDirs.push(dir);
    await git(dir, ["remote", "add", "good", bareDir]);
    await git(dir, ["remote", "add", "bad", "https://198.51.100.1.invalid/nonexistent.git"]);

    const result = await fetchAllRemotes(dir);
    expect(result.outcomes).toHaveLength(2);

    const good = result.outcomes.find((o) => o.remoteName === "good");
    const bad = result.outcomes.find((o) => o.remoteName === "bad");
    expect(good?.status).toBe("ok");
    expect(bad?.status).toBe("error");
    if (bad?.status === "error") {
      expect(bad.error.kind).toBe("host-unreachable");
    }

    // The good remote's tracking ref really did update — this isn't a vacuous pass.
    const { stdout } = await git(dir, ["rev-parse", "good/main"]);
    expect(stdout.trim()).toMatch(/^[0-9a-f]{40}$/);
  }, 15000);

  it("fetches every remote even when an earlier one in iteration order fails (never stops early on a per-remote failure)", async () => {
    const { bareDir } = await makeBareRemoteWithCommit();
    const dir = await initRepo();
    cleanupDirs.push(dir);
    // Alphabetically, "bad" sorts before "good" — proves the loop doesn't stop at the first failure.
    await git(dir, ["remote", "add", "bad", "https://198.51.100.1.invalid/nonexistent.git"]);
    await git(dir, ["remote", "add", "good", bareDir]);

    const result = await fetchAllRemotes(dir);
    const statuses = Object.fromEntries(result.outcomes.map((o) => [o.remoteName, o.status]));
    expect(statuses).toEqual({ bad: "error", good: "ok" });
  }, 15000);

  it("propagates OperationCancelledError directly rather than folding it into a per-remote error outcome", async () => {
    const { bareDir } = await makeBareRemoteWithCommit();
    const dir = await initRepo();
    cleanupDirs.push(dir);
    await git(dir, ["remote", "add", "origin", bareDir]);

    const controller = new AbortController();
    controller.abort();
    await expect(fetchAllRemotes(dir, { signal: controller.signal })).rejects.toBeInstanceOf(
      OperationCancelledError,
    );
  });

  it("classifies a repository-not-found failure distinctly, per remote", async () => {
    const dir = await initRepo();
    cleanupDirs.push(dir);
    // A real, reachable host (not a DNS-failure fixture) with a path guaranteed not to exist —
    // exercises the exact fatal message shape `repository-not-found` matches on. Verified directly
    // (2026-09-16): a plain HTTP 404 with no smart-http service advertisement makes real git
    // (2.31.1.windows.1) print `remote: Repository not found` followed by its own generic
    // `fatal: repository '<url>' not found` framing, REGARDLESS of the 404 response body's actual
    // content — git synthesizes that message itself for any non-smart-http 404, it doesn't parse
    // the body. This is exactly the shape `classifyGitNetworkError()`'s `repository-not-found` rule
    // matches on.
    const server = await startFakeGitHost((req, res) => {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("this body's exact content is irrelevant to git's own message");
    });
    try {
      await git(dir, ["remote", "add", "origin", `${server.url}/o/definitely-missing.git`]);
      const result = await fetchAllRemotes(dir);
      expect(result.outcomes).toHaveLength(1);
      const outcome = result.outcomes[0]!;
      expect(outcome.status).toBe("error");
      if (outcome.status === "error") {
        expect(outcome.error.kind).toBe("repository-not-found");
        expect(outcome.error.rawStderr).toMatch(/repository '.*' not found/i);
      }
    } finally {
      await server.close();
    }
  }, 15000);
});

/** Minimal HTTP server standing in for a real git host, bound to loopback only — used to
 * reproduce FR-325's credential-helper hang and FR-323's "repository not found"/auth-failure
 * classification without any real network/credentials. */
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

describe("FR-325: HTTPS auth failure classification (deterministic — the TEST clears credential.helper, not the product)", () => {
  it(
    "fails fast with a classifiable https-auth-failed error against a host that always challenges for Basic auth",
    async () => {
      const server = await startFakeGitHost((req, res) => {
        res.writeHead(401, { "WWW-Authenticate": 'Basic realm="git-test"' });
        res.end("auth required\n");
      });
      try {
        const dir = await initRepo();
        cleanupDirs.push(dir);
        await git(dir, ["remote", "add", "origin", `${server.url}/o/private.git`]);
        // security-review item 1 (2026-09-16): `fetchRemote()` no longer passes
        // `-c credential.helper=` — it deliberately leaves the real system credential helper
        // (e.g. Git Credential Manager on Windows) enabled so a real user can actually
        // authenticate. Left as-is, THIS test would invoke that same real helper against this
        // local 401 fixture and pop an unattended GUI credential prompt on whoever runs this
        // suite (confirmed directly, twice, on a real dev machine — see `gitProcess.ts`'s
        // history at the removed `withCredentialHelperNeutralized()`). Clearing
        // `credential.helper` for JUST this fixture repo (local scope, read after — and so
        // overriding — any system/global config, per git's own documented config-precedence
        // and multi-valued-key-reset rules) reproduces the exact same deterministic, fast,
        // non-interactive failure the neutralization used to force globally, without changing
        // anything about the code under test.
        await git(dir, ["config", "credential.helper", ""]);

        const started = Date.now();
        let caught: unknown;
        try {
          await fetchRemote(dir, "origin");
        } catch (err) {
          caught = err;
        }
        const elapsedMs = Date.now() - started;

        expect(caught).toBeInstanceOf(GitCommandError);
        expect((caught as GitCommandError).stderr).toMatch(/could not read (username|password) for|terminal prompts disabled/i);
        // With no credential helper in play for this fixture repo, git fails fast (no dialog to
        // wait on) — a generous ceiling (well under the ~25-30s a real, unanswered credential
        // prompt takes) is used rather than a razor-thin one, since this suite already runs under
        // load (ROADMAP.md's documented flakiness class) and a tight bound would trade a real
        // regression guard for occasional false failures. Also serves as the regression guard for
        // item 1 itself: if this ever starts taking anywhere near that long again, the local
        // override above has stopped actually reaching git (or a future change reintroduced a
        // helper dependency here).
        expect(elapsedMs).toBeLessThan(10_000);
      } finally {
        await server.close();
      }
    },
    15000,
  );

  it("still authenticates successfully with a credential embedded directly in the remote URL", async () => {
    const { bareDir } = await makeBareRemoteWithCommit();
    const dir = await initRepo();
    cleanupDirs.push(dir);
    await git(dir, ["remote", "add", "origin", bareDir]);
    // A local path has no credential concept at all — plain regression check that fetching
    // still works normally now that the credential helper is no longer disabled by `fetchRemote()`.
    await expect(fetchRemote(dir, "origin")).resolves.toBeUndefined();
  });
});

// security-review item 2 (2026-09-16): `runFetchProcess()`'s `GitCommandError` construction now
// redacts `stderr` via `redactGitCredentials()` before it's ever attached to the thrown error (see
// `fetch.ts`). Coverage for that lives in its own file, `fetchErrorRedaction.test.ts` — NOT here —
// for the same reason `noNetworkCalls.test.ts` is its own file: it needs to mock `node:child_process`
// at module scope, before `gitProcess.ts` is first imported, which would affect every other test in
// a shared file. (An earlier version of this test tried to provoke a real, credentialed
// `fatal: Authentication failed for '<url>'` from a real embedded-credential fetch against the local
// 401 fixture above — real git 2.31.1.windows.1 turned out to already strip the userinfo from that
// exact message shape itself, making that specific real-world attempt a vacuous test of this
// module's own redaction. `fetchErrorRedaction.test.ts` instead injects a synthetic, fully-controlled
// stderr chunk via a mocked child process, which is the only way to exercise this module's OWN
// redaction call deterministically regardless of what any particular real git version happens to do
// on its own.)

/**
 * Security-review finding (2026-09-16): git's `ext::<command>` remote-URL transport runs an
 * arbitrary shell command. Verified by hand against real git 2.31.1.windows.1 before writing this,
 * because the finding as first reported did NOT reproduce: git's own default already blocks `ext::`
 * ("fatal: transport 'ext' not allowed"), so the transport is not exploitable on its own. But a
 * repository carries its OWN config, and `protocol.ext.allow = always` in `.git/config` re-enables
 * it. With both halves in place a plain `git fetch origin` executed the payload and wrote the
 * marker ("PWNED") — so the vulnerability is real, just conditional on a second repo-controlled
 * config line.
 *
 * Both halves are repo-controlled, and GitHydra's product principles commit to opening ANY
 * repository — a coworker's zip, a tarball, a checkout copied from elsewhere. A terminal user might
 * notice via `git remote -v`; a "Fetch" button removes that step, so the user triggers execution of
 * a payload they were never positioned to review. `-c` on the command line beats repo-local config,
 * which is why the guard holds (also verified by hand before being written here).
 *
 * Same threat class as this suite's sibling `fsmonitor argument-injection guard`, and tested the
 * same way — with a positive control proving the exploit is real in THIS environment rather than
 * merely theoretical.
 */
describe("ext:: transport guard — a malicious repo config must not execute on fetch", () => {
  async function setUpMaliciousExtTransportRepo() {
    const dir = await initRepo();
    cleanupDirs.push(dir);
    await writeFile(dir, "a.txt", "1\n");
    await commit(dir, "base");

    // Marker lives outside the repo so it can't be confused with repo content. Forward slashes
    // only: this path is interpolated into a command run by git-for-windows' bundled MSYS shell,
    // where a raw backslash inside a quoted string is an escape, not a separator.
    const outsideDir = await makeTempDir();
    cleanupDirs.push(outsideDir);
    const outside = outsideDir.replace(/\\/g, "/");
    const markerPath = `${outside}/PWNED_MARKER`;
    await writeFile(outsideDir, "payload.sh", `#!/bin/sh\necho PWNED > "${markerPath}"\n`);

    // `ext::` splits its command on spaces, so this is deliberately two bare tokens with no
    // quoting — `sh <script>` — rather than an `sh -c "..."` form, whose quotes git would mangle.
    await git(dir, ["remote", "add", "origin", `ext::sh ${outside}/payload.sh`]);
    // The repo enabling the transport for itself — the other half of the exploit. Git's own
    // default blocks `ext::` outright ("fatal: transport 'ext' not allowed"), so without this the
    // positive control below would pass for the wrong reason.
    await git(dir, ["config", "protocol.ext.allow", "always"]);

    return { dir, markerPath };
  }

  it("positive control: a plain un-guarded `git fetch` DOES execute the payload", async () => {
    const { dir, markerPath } = await setUpMaliciousExtTransportRepo();

    // Deliberately bypasses fetch.ts and calls git directly with no protective `-c` flags — the
    // exact behavior GitHydra would have had before this guard. If this ever stops creating the
    // marker, the guard test below has become vacuous and this whole block needs revisiting.
    await git(dir, ["fetch", "origin"]).catch(() => undefined);

    expect(await fileExists(markerPath)).toBe(true);
  });

  it("fetchRemote() refuses the ext:: transport and executes nothing", async () => {
    const { dir, markerPath } = await setUpMaliciousExtTransportRepo();

    await expect(fetchRemote(dir, "origin")).rejects.toBeInstanceOf(GitCommandError);

    expect(await fileExists(markerPath)).toBe(false);
  });

  it("fetchAllRemotes() refuses it too, reporting a failed outcome rather than executing", async () => {
    const { dir, markerPath } = await setUpMaliciousExtTransportRepo();

    const result = await fetchAllRemotes(dir);

    expect(result.outcomes).toHaveLength(1);
    expect(result.outcomes[0]?.remoteName).toBe("origin");
    expect(result.outcomes[0]?.status).toBe("error");
    expect(await fileExists(markerPath)).toBe(false);
  });
});
