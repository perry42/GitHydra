// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createCommit } from "../src/commitChanges";
import {
  InvalidArgumentError,
  NothingStagedError,
  MissingCommitIdentityError,
  CommitHookRejectedError,
} from "../src/errors";
import { git, initRepo, writeFile, commit, cleanup, fileExists, setUpMaliciousFsmonitorRepo } from "./testRepo";

const cleanupDirs: string[] = [];
afterEach(async () => {
  while (cleanupDirs.length) await cleanup(cleanupDirs.pop()!);
});

/** Temporarily set/delete process.env entries for the duration of `fn`, then restore exactly. */
async function withEnv<T>(overrides: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const previous: Record<string, string | undefined> = {};
  for (const key of Object.keys(overrides)) previous[key] = process.env[key];
  try {
    for (const [key, value] of Object.entries(overrides)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

describe("createCommit", () => {
  it("creates a commit from staged content, verified via `git log -1`", async () => {
    const dir = await initRepo();
    cleanupDirs.push(dir);
    await writeFile(dir, "a.txt", "1");
    await commit(dir, "base");
    await writeFile(dir, "a.txt", "2");
    await git(dir, ["add", "a.txt"]);

    const result = await createCommit(dir, { subject: "Second commit", body: "with a body" });
    expect(result.sha).toMatch(/^[0-9a-f]{40}$/);

    const { stdout } = await git(dir, ["log", "-1", "--pretty=%H%n%s%n%b"]);
    const [sha, subject] = stdout.split("\n");
    expect(sha).toBe(result.sha);
    expect(subject).toBe("Second commit");
    expect(stdout).toContain("with a body");
  });

  it("creates the very first commit on an unborn branch", async () => {
    const dir = await initRepo();
    cleanupDirs.push(dir);
    await writeFile(dir, "a.txt", "1");
    await git(dir, ["add", "a.txt"]);

    const result = await createCommit(dir, { subject: "Initial commit" });
    const { stdout } = await git(dir, ["rev-parse", "HEAD"]);
    expect(stdout.trim()).toBe(result.sha);
  });

  it("clears staged content after committing", async () => {
    const dir = await initRepo();
    cleanupDirs.push(dir);
    await writeFile(dir, "a.txt", "1");
    await git(dir, ["add", "a.txt"]);
    await createCommit(dir, { subject: "First" });

    const { stdout } = await git(dir, ["status", "--porcelain=v1"]);
    expect(stdout).toBe("");
  });

  it("rejects an empty subject with InvalidArgumentError, without touching git at all", async () => {
    const dir = await initRepo();
    cleanupDirs.push(dir);
    await writeFile(dir, "a.txt", "1");
    await git(dir, ["add", "a.txt"]);

    await expect(createCommit(dir, { subject: "   " })).rejects.toBeInstanceOf(InvalidArgumentError);
    const { stdout } = await git(dir, ["status", "--porcelain=v1"]);
    expect(stdout).toContain("A  a.txt"); // still staged — nothing was committed
  });

  it("throws NothingStagedError when the index matches HEAD", async () => {
    const dir = await initRepo();
    cleanupDirs.push(dir);
    await writeFile(dir, "a.txt", "1");
    await commit(dir, "base");
    // Unstaged edit only — nothing staged.
    await writeFile(dir, "a.txt", "2");

    await expect(createCommit(dir, { subject: "Should not commit" })).rejects.toBeInstanceOf(
      NothingStagedError,
    );
  });

  it("throws NothingStagedError on a completely clean repo", async () => {
    const dir = await initRepo();
    cleanupDirs.push(dir);
    await writeFile(dir, "a.txt", "1");
    await commit(dir, "base");

    await expect(createCommit(dir, { subject: "Should not commit" })).rejects.toBeInstanceOf(
      NothingStagedError,
    );
  });

  it("throws MissingCommitIdentityError when user.name/user.email are unset anywhere git would read them from", async () => {
    const dir = await initRepo();
    cleanupDirs.push(dir);
    await writeFile(dir, "a.txt", "1");
    await git(dir, ["add", "a.txt"]);

    const missingIdentityEnv = {
      // Isolate identity resolution to just this repo's (empty) local config: ignore any
      // global/system git config on the machine running this test, and make sure no
      // GIT_AUTHOR_*/GIT_COMMITTER_* env vars leak in and satisfy identity instead.
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: path.join(dir, "does-not-exist-global-gitconfig"),
      GIT_AUTHOR_NAME: undefined,
      GIT_AUTHOR_EMAIL: undefined,
      GIT_COMMITTER_NAME: undefined,
      GIT_COMMITTER_EMAIL: undefined,
      HOME: dir,
      USERPROFILE: dir,
    };

    await withEnv(missingIdentityEnv, async () => {
      let caught: unknown;
      try {
        await createCommit(dir, { subject: "Should not commit" });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(MissingCommitIdentityError);
      expect((caught as MissingCommitIdentityError).missing.sort()).toEqual(["email", "name"]);
    });
  });

  it("throws CommitHookRejectedError when a pre-commit hook rejects the commit, preserving stderr", async () => {
    const dir = await initRepo();
    cleanupDirs.push(dir);
    await writeFile(dir, "a.txt", "1");
    await commit(dir, "base");
    await writeFile(dir, "a.txt", "2");
    await git(dir, ["add", "a.txt"]);

    const { stdout: hooksDirRaw } = await git(dir, ["rev-parse", "--git-path", "hooks"]);
    const hooksDir = path.resolve(dir, hooksDirRaw.trim());
    await fs.mkdir(hooksDir, { recursive: true });
    const hookPath = path.join(hooksDir, "pre-commit");
    await fs.writeFile(hookPath, '#!/bin/sh\necho "rejected by test pre-commit hook" 1>&2\nexit 1\n', {
      mode: 0o755,
    });
    await fs.chmod(hookPath, 0o755).catch(() => {
      /* chmod is a no-op-ish on Windows; the shebang alone is enough for git-for-windows to run it */
    });

    let caught: unknown;
    try {
      await createCommit(dir, { subject: "Should be rejected" });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(CommitHookRejectedError);
    expect((caught as CommitHookRejectedError).stderr).toContain("rejected by test pre-commit hook");

    // And nothing was actually committed.
    const { stdout } = await git(dir, ["log", "--oneline"]);
    expect(stdout.trim().split("\n")).toHaveLength(1); // only "base"
  });
});

// Regression: CRITICAL 1 — `git commit` refreshes the index/working tree of a possibly-
// untrusted repo just like `status`/`diff`/`add`/`restore` do, so it needs the same
// `core.fsmonitor` neutralization.
describe("fsmonitor argument-injection guard", () => {
  it("createCommit does NOT execute a malicious core.fsmonitor command", async () => {
    const { dir, markerPath } = await setUpMaliciousFsmonitorRepo(cleanupDirs);
    await writeFile(dir, "a.txt", "2");
    // Stage via the raw, unguarded fixture helper (deliberately separate from the library
    // under test) — that `git add` itself trips the hook, so reset the marker before the
    // assertion below, which is only about `createCommit`'s own behavior.
    await git(dir, ["add", "a.txt"]);
    await fs.rm(markerPath, { force: true });
    expect(await fileExists(markerPath)).toBe(false);

    const result = await createCommit(dir, { subject: "Second commit" });

    expect(result.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(await fileExists(markerPath)).toBe(false);
  });
});
