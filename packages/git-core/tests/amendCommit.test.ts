// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { amendCommit } from "../src/commitChanges";
import {
  AmendBlockedByOperationError,
  InvalidArgumentError,
  MissingCommitIdentityError,
  NoCommitToAmendError,
  CommitHookRejectedError,
} from "../src/errors";
import { getRepositoryState } from "../src/repository";
import { git, initRepo, writeFile, commit, cleanup, fileExists, setUpMaliciousFsmonitorRepo } from "./testRepo";

/**
 * specs/amend-last-commit.md's git-core surface (FR-148 through FR-153). Acceptance criteria this
 * file targets directly: 2, 3, 4, 5, 9 (the git-core-testable subset; 1, 6, 7, 8, 10, 11 are
 * ui-graphics's/test-agent's to cover later).
 */

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

async function makeRepo(): Promise<string> {
  const dir = await initRepo();
  cleanupDirs.push(dir);
  return dir;
}

describe("amendCommit", () => {
  it("message-only amend with nothing staged produces a new HEAD SHA with the new subject but unchanged tree (AC2)", async () => {
    const dir = await makeRepo();
    await writeFile(dir, "a.txt", "1");
    const before = await commit(dir, "Original message");

    const result = await amendCommit(dir, { subject: "Fixed message" });

    expect(result.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(result.sha).not.toBe(before);

    const { stdout } = await git(dir, ["log", "-1", "--pretty=%H%n%s"]);
    const [sha, subject] = stdout.split("\n");
    expect(sha).toBe(result.sha);
    expect(subject).toBe("Fixed message");

    // Tree content is unchanged.
    const beforeTree = await git(dir, ["rev-parse", `${before}^{tree}`]);
    const afterTree = await git(dir, ["rev-parse", `${result.sha}^{tree}`]);
    expect(afterTree.stdout).toBe(beforeTree.stdout);

    // Only one commit exists — no second commit was created.
    const log = await git(dir, ["log", "--oneline"]);
    expect(log.stdout.trim().split("\n")).toHaveLength(1);
  });

  it("amend with staged content folds it into the same commit — no second commit created (AC3)", async () => {
    const dir = await makeRepo();
    await writeFile(dir, "a.txt", "1");
    const before = await commit(dir, "Original message");
    await writeFile(dir, "b.txt", "new file");
    await git(dir, ["add", "b.txt"]);

    const result = await amendCommit(dir, { subject: "Original message plus b" });

    expect(result.sha).not.toBe(before);
    const log = await git(dir, ["log", "--oneline"]);
    expect(log.stdout.trim().split("\n")).toHaveLength(1); // still exactly one commit

    const { stdout: subject } = await git(dir, ["log", "-1", "--pretty=%s"]);
    expect(subject.trim()).toBe("Original message plus b");

    const { stdout: content } = await git(dir, ["show", "HEAD:b.txt"]);
    expect(content).toBe("new file");

    // Nothing left staged afterward.
    const status = await git(dir, ["status", "--porcelain=v1"]);
    expect(status.stdout).toBe("");
  });

  it("rejects an empty subject with InvalidArgumentError, without touching git at all", async () => {
    const dir = await makeRepo();
    await writeFile(dir, "a.txt", "1");
    const before = await commit(dir, "Original message");

    await expect(amendCommit(dir, { subject: "   " })).rejects.toBeInstanceOf(InvalidArgumentError);

    const { stdout } = await git(dir, ["rev-parse", "HEAD"]);
    expect(stdout.trim()).toBe(before);
  });

  it("throws NoCommitToAmendError on an unborn HEAD, making no git commit --amend call (AC4)", async () => {
    const dir = await makeRepo();
    // No commits yet at all — not even a first commit.

    await expect(amendCommit(dir, { subject: "Should not amend" })).rejects.toBeInstanceOf(
      NoCommitToAmendError,
    );

    const state = await getRepositoryState(dir);
    expect(state.isUnbornHead).toBe(true);
    expect(state.headSha).toBeNull();
  });

  it("throws NoCommitToAmendError even when something is staged on an unborn HEAD", async () => {
    const dir = await makeRepo();
    await writeFile(dir, "a.txt", "1");
    await git(dir, ["add", "a.txt"]);

    await expect(amendCommit(dir, { subject: "Should not amend" })).rejects.toBeInstanceOf(
      NoCommitToAmendError,
    );
  });

  it("refuses when another operation (merge) is already in progress — no git commit --amend call made (AC5)", async () => {
    const dir = await makeRepo();
    await writeFile(dir, "a.txt", "base\n");
    await commit(dir, "base");
    await git(dir, ["checkout", "-q", "-b", "feature"]);
    await writeFile(dir, "a.txt", "feature change\n");
    await commit(dir, "feature change");
    await git(dir, ["checkout", "-q", "main"]);
    await writeFile(dir, "a.txt", "main change\n");
    const mainSha = await commit(dir, "main change");
    // Leave a real merge genuinely mid-conflict.
    await git(dir, ["merge", "-q", "feature"]).catch(() => {});
    const preState = await getRepositoryState(dir);
    expect(preState.inProgressOperation).toBe("merge");

    let caught: unknown;
    try {
      await amendCommit(dir, { subject: "Should not amend" });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AmendBlockedByOperationError);
    expect((caught as AmendBlockedByOperationError).operation).toBe("merge");

    // HEAD is unchanged, merge state is untouched.
    const { stdout } = await git(dir, ["rev-parse", "HEAD"]);
    expect(stdout.trim()).toBe(mainSha);
    expect(await fileExists(path.join(dir, ".git", "MERGE_HEAD"))).toBe(true);

    await git(dir, ["merge", "--abort"]);
  });

  it("throws MissingCommitIdentityError when user.name/user.email are unset anywhere git would read them from (AC-adjacent FR-150)", async () => {
    const dir = await makeRepo();
    await writeFile(dir, "a.txt", "1");
    await commit(dir, "Original message");

    const missingIdentityEnv = {
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: path.join(dir, "does-not-exist-global-gitconfig"),
      GIT_AUTHOR_NAME: undefined,
      GIT_AUTHOR_EMAIL: undefined,
      GIT_COMMITTER_NAME: undefined,
      GIT_COMMITTER_EMAIL: undefined,
      HOME: dir,
      USERPROFILE: dir,
    };

    // Clear the repo-local identity that `commit()`'s own fixture env would otherwise leave
    // unused (identity is resolved from git config, not the commit-time env, once the commit
    // already exists) — no local config was set to begin with, so this only needs the env swap.
    await withEnv(missingIdentityEnv, async () => {
      let caught: unknown;
      try {
        await amendCommit(dir, { subject: "Should not amend" });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(MissingCommitIdentityError);
      expect((caught as MissingCommitIdentityError).missing.sort()).toEqual(["email", "name"]);
    });
  });

  it("throws CommitHookRejectedError when a commit-msg hook rejects the amend, preserving stderr (AC9)", async () => {
    const dir = await makeRepo();
    await writeFile(dir, "a.txt", "1");
    const before = await commit(dir, "Original message");

    const { stdout: hooksDirRaw } = await git(dir, ["rev-parse", "--git-path", "hooks"]);
    const hooksDir = path.resolve(dir, hooksDirRaw.trim());
    await fs.mkdir(hooksDir, { recursive: true });
    const hookPath = path.join(hooksDir, "commit-msg");
    await fs.writeFile(hookPath, '#!/bin/sh\necho "rejected by test commit-msg hook" 1>&2\nexit 1\n', {
      mode: 0o755,
    });
    await fs.chmod(hookPath, 0o755).catch(() => {
      /* chmod is a no-op-ish on Windows; the shebang alone is enough for git-for-windows to run it */
    });

    let caught: unknown;
    try {
      await amendCommit(dir, { subject: "Should be rejected" });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(CommitHookRejectedError);
    expect((caught as CommitHookRejectedError).stderr).toContain("rejected by test commit-msg hook");

    // Nothing was actually amended — HEAD and its message are untouched.
    const { stdout } = await git(dir, ["log", "-1", "--pretty=%H%n%s"]);
    const [sha, subject] = stdout.split("\n");
    expect(sha).toBe(before);
    expect(subject).toBe("Original message");
  });

  it("amends correctly while HEAD is detached — updates HEAD directly, no branch ref involved, no special-casing needed", async () => {
    const dir = await makeRepo();
    await writeFile(dir, "a.txt", "1");
    const first = await commit(dir, "first");
    await writeFile(dir, "a.txt", "2");
    const second = await commit(dir, "second");
    await git(dir, ["checkout", "-q", second]);
    const state = await getRepositoryState(dir);
    expect(state.isDetachedHead).toBe(true);

    const result = await amendCommit(dir, { subject: "second, amended" });

    expect(result.sha).not.toBe(second);
    const { stdout: subject } = await git(dir, ["log", "-1", "--pretty=%s"]);
    expect(subject.trim()).toBe("second, amended");
    // The branch ref pointing at the old "second" commit is untouched (detached HEAD moved,
    // not any branch).
    const { stdout: mainTip } = await git(dir, ["rev-parse", "main"]);
    expect(mainTip.trim()).toBe(second);
    // Detached HEAD now resolves to the new amended commit, still detached.
    const afterState = await getRepositoryState(dir);
    expect(afterState.isDetachedHead).toBe(true);
    expect(afterState.headSha).toBe(result.sha);
    expect(first).toBeDefined(); // sanity: `first` unused beyond providing a real base commit
  });

  it("amends a merge commit (2+ parents) exactly like any other commit, with no special-cased block", async () => {
    const dir = await makeRepo();
    await writeFile(dir, "a.txt", "base\n");
    await commit(dir, "base");
    await git(dir, ["checkout", "-q", "-b", "feature"]);
    await writeFile(dir, "b.txt", "feature\n");
    await commit(dir, "feature change");
    await git(dir, ["checkout", "-q", "main"]);
    await writeFile(dir, "c.txt", "main\n");
    await commit(dir, "main change");
    await git(dir, ["merge", "-q", "--no-ff", "-m", "Merge feature into main", "feature"]);
    const { stdout: parentsRaw } = await git(dir, ["log", "-1", "--pretty=%P"]);
    expect(parentsRaw.trim().split(" ")).toHaveLength(2); // genuinely a merge commit

    const result = await amendCommit(dir, { subject: "Merge feature into main (amended)" });

    const { stdout } = await git(dir, ["log", "-1", "--pretty=%H%n%s%n%P"]);
    const [sha, subject, parents] = stdout.split("\n");
    expect(sha).toBe(result.sha);
    expect(subject).toBe("Merge feature into main (amended)");
    expect(parents.trim().split(" ")).toHaveLength(2); // still a merge commit, parents preserved
  });
});

// Regression: same fsmonitor-neutralization guard `createCommit` already gets — `git commit
// --amend` refreshes the index/working tree just like `commit`/`status`/`diff`/`add` do.
describe("fsmonitor argument-injection guard", () => {
  it("amendCommit does NOT execute a malicious core.fsmonitor command", async () => {
    const { dir, markerPath } = await setUpMaliciousFsmonitorRepo(cleanupDirs);
    await fs.rm(markerPath, { force: true });
    expect(await fileExists(markerPath)).toBe(false);

    const result = await amendCommit(dir, { subject: "Amended, still no fsmonitor exec" });

    expect(result.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(await fileExists(markerPath)).toBe(false);
  });
});
