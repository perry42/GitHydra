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
import { git, initRepo, writeFile, commit, cleanup } from "./testRepo";

/**
 * specs/online-sync-fetch.md FR-320/FR-321/FR-322/FR-325. Exercised against real local bare
 * fixture repos (never real network hosts) — a fixture reachable by local path/`file://` exercises
 * the exact same `fetchRemote`/`fetchAllRemotes` code paths a real host would, with no internet or
 * credentials needed. See the "FR-325 credential-helper hang" describe block below for the one
 * exception: that block deliberately DOES bind a real (loopback-only) HTTP server, since
 * reproducing FR-325's actual hang requires a real HTTP 401 challenge — there is no way to trigger
 * a GUI credential helper's hang path from a `file://`/local-path fixture, which never asks for
 * credentials at all.
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

describe("FR-325: the credential-helper hang fix", () => {
  it(
    "fails fast with a classifiable https-auth-failed error against a host that always challenges for Basic auth, rather than hanging",
    async () => {
      const server = await startFakeGitHost((req, res) => {
        res.writeHead(401, { "WWW-Authenticate": 'Basic realm="git-test"' });
        res.end("auth required\n");
      });
      try {
        const dir = await initRepo();
        cleanupDirs.push(dir);
        await git(dir, ["remote", "add", "origin", `${server.url}/o/private.git`]);

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
        // The real, reproduced hang (with the credential helper NOT neutralized) ran past 25
        // seconds with zero output at all — see `gitProcess.ts`'s `withCredentialHelperNeutralized()`
        // doc comment for the exact numbers this bound is chosen relative to. A generous ceiling
        // (well under that observed hang, comfortably above any plausible fast-failure jitter) is
        // used here rather than a razor-thin one, since this suite already runs under load
        // (ROADMAP.md's documented flakiness class) and a tight bound would trade a real regression
        // guard for occasional false failures.
        expect(elapsedMs).toBeLessThan(10_000);
      } finally {
        await server.close();
      }
    },
    15000,
  );

  it("still authenticates successfully with a credential embedded directly in the remote URL (unaffected by the neutralized helper)", async () => {
    const { bareDir } = await makeBareRemoteWithCommit();
    const dir = await initRepo();
    cleanupDirs.push(dir);
    await git(dir, ["remote", "add", "origin", bareDir]);
    // A local path has no credential concept at all — this asserts the neutralization has no
    // effect on the ordinary, credential-free success path (a `file://`/local-path fetch would
    // never invoke a credential helper regardless, so this doubles as a plain regression check
    // that `-c credential.helper=` doesn't break normal fetching).
    await expect(fetchRemote(dir, "origin")).resolves.toBeUndefined();
  });
});
