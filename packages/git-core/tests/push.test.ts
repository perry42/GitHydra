// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect, afterEach } from "vitest";
import { push } from "../src/push";
import { classifyGitNetworkError } from "../src/networkErrorClassification";
import { GitCommandError, InvalidArgumentError, OperationCancelledError } from "../src/errors";
import { git, initRepo, writeFile, commit, cleanup } from "./testRepo";

/**
 * specs/online-sync-push.md FR-344 through FR-350. Exercised against real local bare fixture
 * repos (never real network hosts), mirroring `pull.test.ts`'s/`fetch.test.ts`'s own convention —
 * a fixture reachable by local path exercises the exact same `push()` code path a real host would,
 * with no internet or credentials needed.
 */

const cleanupDirs: string[] = [];
afterEach(async () => {
  while (cleanupDirs.length) await cleanup(cleanupDirs.pop()!);
});

/** A bare remote seeded with one commit on `main`, plus a clone-shaped working repo tracking it
 * (checked out on `main`, `branch.main.remote`/`.merge` already configured by the checkout — the
 * "already tracked" precondition FR-344's tests need). */
async function makeRemoteAndClone(): Promise<{ bareDir: string; cloneDir: string; baseSha: string }> {
  const seedDir = await initRepo();
  cleanupDirs.push(seedDir);
  await writeFile(seedDir, "a.txt", "base\n");
  const baseSha = await commit(seedDir, "base");

  const bareDir = await initRepo({ bare: true });
  cleanupDirs.push(bareDir);
  await git(seedDir, ["remote", "add", "origin", bareDir]);
  await git(seedDir, ["push", "-q", "origin", "main"]);

  const cloneDir = await initRepo();
  cleanupDirs.push(cloneDir);
  await git(cloneDir, ["remote", "add", "origin", bareDir]);
  await git(cloneDir, ["fetch", "-q", "origin"]);
  await git(cloneDir, ["checkout", "-q", "-b", "main", "origin/main"]);
  return { bareDir, cloneDir, baseSha };
}

describe("push() input validation", () => {
  it("rejects with InvalidArgumentError for an empty remote name, making no git call at all", async () => {
    const dir = await initRepo();
    cleanupDirs.push(dir);
    await writeFile(dir, "a.txt", "1\n");
    await commit(dir, "base");
    await expect(push(dir, "", "main")).rejects.toBeInstanceOf(InvalidArgumentError);
    await expect(push(dir, "   ", "main")).rejects.toBeInstanceOf(InvalidArgumentError);
  });

  it("rejects with InvalidArgumentError for an empty local branch name, making no git call at all", async () => {
    const dir = await initRepo();
    cleanupDirs.push(dir);
    await writeFile(dir, "a.txt", "1\n");
    await commit(dir, "base");
    await git(dir, ["remote", "add", "origin", "https://example.invalid/o/r.git"]);
    await expect(push(dir, "origin", "")).rejects.toBeInstanceOf(InvalidArgumentError);
  });

  it("rejects with InvalidArgumentError for a local branch that does not exist, making no push attempt", async () => {
    const dir = await initRepo();
    cleanupDirs.push(dir);
    await writeFile(dir, "a.txt", "1\n");
    await commit(dir, "base");
    await git(dir, ["remote", "add", "origin", "https://example.invalid/o/r.git"]);
    await expect(push(dir, "origin", "does-not-exist")).rejects.toBeInstanceOf(InvalidArgumentError);
  });

  it("rejects a branch name starting with '-' as InvalidArgumentError, never reaching a git push call", async () => {
    const dir = await initRepo();
    cleanupDirs.push(dir);
    await writeFile(dir, "a.txt", "1\n");
    await commit(dir, "base");
    await git(dir, ["remote", "add", "origin", "https://example.invalid/o/r.git"]);
    await expect(push(dir, "origin", "-evilbranch")).rejects.toBeInstanceOf(InvalidArgumentError);
  });
});

describe("push() (FR-344): already-tracked branch", () => {
  it("AC1: pushing a fast-forwardable local branch succeeds; the remote's ref matches the pushed tip and the local remote-tracking ref updates", async () => {
    const { bareDir, cloneDir, baseSha } = await makeRemoteAndClone();
    await writeFile(cloneDir, "a.txt", "second\n");
    const newSha = await commit(cloneDir, "second commit");
    expect(newSha).not.toBe(baseSha);

    const outcome = await push(cloneDir, "origin", "main");
    expect(outcome).toEqual({ kind: "pushed", remoteName: "origin", localBranch: "main", remoteBranch: "main", sha: newSha });

    const { stdout: remoteTip } = await git(bareDir, ["rev-parse", "main"]);
    expect(remoteTip.trim()).toBe(newSha);

    const { stdout: trackingRef } = await git(cloneDir, ["rev-parse", "origin/main"]);
    expect(trackingRef.trim()).toBe(newSha);
  });

  it("pushes a local branch that tracks a differently-named remote branch, using the configured upstream name (not the local name)", async () => {
    const { bareDir, cloneDir } = await makeRemoteAndClone();
    await git(cloneDir, ["checkout", "-q", "-b", "local-name"]);
    await git(cloneDir, ["config", "branch.local-name.remote", "origin"]);
    await git(cloneDir, ["config", "branch.local-name.merge", "refs/heads/remote-name"]);
    await writeFile(cloneDir, "a.txt", "renamed upstream\n");
    const sha = await commit(cloneDir, "renamed upstream change");

    const outcome = await push(cloneDir, "origin", "local-name");
    expect(outcome).toEqual({
      kind: "pushed",
      remoteName: "origin",
      localBranch: "local-name",
      remoteBranch: "remote-name",
      sha,
    });

    const { stdout: remoteTip } = await git(bareDir, ["rev-parse", "remote-name"]);
    expect(remoteTip.trim()).toBe(sha);
    // The remote's own "main" ref must be untouched — only "remote-name" was created/updated.
    const { stdout: mainStillBase } = await git(bareDir, ["rev-parse", "main"]);
    expect(mainStillBase.trim()).not.toBe(sha);
  });

  it("reports incremental progress events while pushing", async () => {
    const { cloneDir } = await makeRemoteAndClone();
    await writeFile(cloneDir, "a.txt", "second\n");
    await commit(cloneDir, "second commit");

    const events: { raw: string }[] = [];
    await push(cloneDir, "origin", "main", { onProgress: (event) => events.push({ raw: event.raw }) });
    expect(events.length).toBeGreaterThan(0);
  });

  it("cancelling an in-flight push stops the process and leaves the remote ref exactly as it was before", async () => {
    const { bareDir, cloneDir, baseSha } = await makeRemoteAndClone();
    await writeFile(cloneDir, "a.txt", "second\n");
    await commit(cloneDir, "second commit");

    const controller = new AbortController();
    const pushPromise = push(cloneDir, "origin", "main", { signal: controller.signal });
    controller.abort();
    await expect(pushPromise).rejects.toBeInstanceOf(OperationCancelledError);

    const { stdout: remoteTip } = await git(bareDir, ["rev-parse", "main"]);
    expect(remoteTip.trim()).toBe(baseSha);
  });
});

describe("push() (FR-345): no configured upstream yet", () => {
  it("AC2: publishes a brand-new local branch via --set-upstream; ahead/behind then computes correctly with zero manual config", async () => {
    const { bareDir, cloneDir } = await makeRemoteAndClone();
    await git(cloneDir, ["checkout", "-q", "-b", "feature"]);
    await writeFile(cloneDir, "feature.txt", "new file\n");
    const sha = await commit(cloneDir, "feature work");

    // Precondition: genuinely untracked before this call.
    await expect(git(cloneDir, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "feature@{u}"])).rejects.toThrow();

    const outcome = await push(cloneDir, "origin", "feature");
    expect(outcome).toEqual({ kind: "set-upstream", remoteName: "origin", localBranch: "feature", remoteBranch: "feature", sha });

    const { stdout: remoteTip } = await git(bareDir, ["rev-parse", "feature"]);
    expect(remoteTip.trim()).toBe(sha);

    // Zero manual config needed afterward: @{u} now resolves, and ahead/behind is computable.
    const { stdout: upstream } = await git(cloneDir, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "feature@{u}"]);
    expect(upstream.trim()).toBe("origin/feature");
    const { stdout: aheadBehind } = await git(cloneDir, ["rev-list", "--left-right", "--count", "feature...feature@{u}"]);
    expect(aheadBehind.trim()).toBe("0\t0");
  });

  it("re-points a branch tracked to a different remote to the newly-requested remote via --set-upstream", async () => {
    const { cloneDir } = await makeRemoteAndClone();
    const otherBareDir = await initRepo({ bare: true });
    cleanupDirs.push(otherBareDir);
    await git(cloneDir, ["remote", "add", "other", otherBareDir]);
    // "main" is already tracked to "origin" (from makeRemoteAndClone's checkout) — pushing to
    // "other" has no upstream configured FOR "other" specifically, so this takes the set-upstream
    // path even though the branch is tracked elsewhere.
    await writeFile(cloneDir, "a.txt", "for other remote\n");
    const sha = await commit(cloneDir, "for other remote");

    const outcome = await push(cloneDir, "other", "main");
    expect(outcome.kind).toBe("set-upstream");

    const { stdout: otherTip } = await git(otherBareDir, ["rev-parse", "main"]);
    expect(otherTip.trim()).toBe(sha);
    const { stdout: newUpstream } = await git(cloneDir, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "main@{u}"]);
    expect(newUpstream.trim()).toBe("other/main");
  });
});

describe("push() (FR-346): non-fast-forward rejection", () => {
  it("AC3: a diverged remote rejects the push; classifyGitNetworkError reports push-rejected-non-fast-forward; the remote's ref is unchanged", async () => {
    const { bareDir, cloneDir, baseSha } = await makeRemoteAndClone();

    // Advance the remote from a second, independent pusher — cloneDir has no idea this happened.
    const otherPusher = await initRepo();
    cleanupDirs.push(otherPusher);
    await git(otherPusher, ["remote", "add", "origin", bareDir]);
    await git(otherPusher, ["fetch", "-q", "origin"]);
    await git(otherPusher, ["checkout", "-q", "-b", "main", "origin/main"]);
    await writeFile(otherPusher, "a.txt", "someone else's change\n");
    const remoteSha = await commit(otherPusher, "someone else's change");
    await git(otherPusher, ["push", "-q", "origin", "main"]);

    // cloneDir makes its own, divergent local commit without ever fetching the above.
    await writeFile(cloneDir, "b.txt", "local-only\n");
    await commit(cloneDir, "local-only change");

    let caught: unknown;
    try {
      await push(cloneDir, "origin", "main");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(GitCommandError);
    const classified = classifyGitNetworkError((caught as GitCommandError).stderr);
    expect(classified.kind).toBe("push-rejected-non-fast-forward");

    const { stdout: remoteTip } = await git(bareDir, ["rev-parse", "main"]);
    expect(remoteTip.trim()).toBe(remoteSha);
    expect(remoteTip.trim()).not.toBe(baseSha);
  });

  it("classifies the 'fetch first' shaped rejection (never-fetched remote-tracking ref) identically", async () => {
    const { bareDir } = await makeRemoteAndClone();

    const pusherA = await initRepo();
    cleanupDirs.push(pusherA);
    await git(pusherA, ["remote", "add", "origin", bareDir]);
    await git(pusherA, ["fetch", "-q", "origin"]);
    await git(pusherA, ["checkout", "-q", "-b", "main", "origin/main"]);
    await writeFile(pusherA, "a.txt", "pusher A change\n");
    await commit(pusherA, "pusher A change");
    await git(pusherA, ["push", "-q", "origin", "main"]);

    // pusherB never fetched at all — its own `origin/main` remote-tracking ref doesn't exist yet,
    // which real git reports as "(fetch first)" rather than "(non-fast-forward)".
    const pusherB = await initRepo();
    cleanupDirs.push(pusherB);
    await git(pusherB, ["remote", "add", "origin", bareDir]);
    await writeFile(pusherB, "a.txt", "1\n");
    await commit(pusherB, "base");
    await git(pusherB, ["config", "branch.main.remote", "origin"]);
    await git(pusherB, ["config", "branch.main.merge", "refs/heads/main"]);

    let caught: unknown;
    try {
      await push(pusherB, "origin", "main");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(GitCommandError);
    expect(classifyGitNetworkError((caught as GitCommandError).stderr).kind).toBe("push-rejected-non-fast-forward");
  });
});

describe("push() (FR-350): never pushes tags as a side effect", () => {
  it("does not push a locally-created tag when pushing a branch", async () => {
    const { bareDir, cloneDir } = await makeRemoteAndClone();
    await git(cloneDir, ["tag", "v1.0.0"]);
    await writeFile(cloneDir, "a.txt", "second\n");
    await commit(cloneDir, "second commit");

    await push(cloneDir, "origin", "main");

    await expect(git(bareDir, ["rev-parse", "refs/tags/v1.0.0"])).rejects.toThrow();
  });
});
