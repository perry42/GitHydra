// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect, afterEach } from "vitest";
import * as path from "node:path";
import { mergeCommit } from "../src/merge";
import { Repository } from "../src/index";
import { abortInProgressOperation } from "../src/conflicts";
import { GitCommandError, OperationAlreadyInProgressError } from "../src/errors";
import { getRepositoryState } from "../src/repository";
import { git, initRepo, writeFile, commit, cleanup, fileExists } from "./testRepo";

/**
 * specs/drag-commit-menu.md's git-core surface for FR-297: `mergeCommit()` — always `git merge
 * <otherSha>` against current HEAD. Covers the fast-forward/real-merge/already-in-progress-refusal
 * paths the parent task asked for, plus the FR-297 "a clean fast-forward, a real merge commit, and
 * a paused conflict are all indistinguishable in this call's own return value" contract.
 */

const cleanupDirs: string[] = [];
afterEach(async () => {
  while (cleanupDirs.length) await cleanup(cleanupDirs.pop()!);
});

async function makeRepo(): Promise<string> {
  const dir = await initRepo();
  cleanupDirs.push(dir);
  return dir;
}

describe("mergeCommit (FR-297): fast-forward path", () => {
  it("when the other commit is a descendant of HEAD, fast-forwards HEAD to it with no merge commit created (AC7)", async () => {
    const dir = await makeRepo();
    await writeFile(dir, "a.txt", "base\n");
    const baseSha = await commit(dir, "base");
    await git(dir, ["checkout", "-q", "-b", "feature"]);
    await writeFile(dir, "a.txt", "feature change\n");
    const featureSha = await commit(dir, "feature change");
    await git(dir, ["checkout", "-q", "main"]);

    await mergeCommit(dir, featureSha);

    const state = await getRepositoryState(dir);
    expect(state.inProgressOperation).toBeNull();
    expect(state.headSha).toBe(featureSha); // fast-forwarded exactly onto it, not a new commit.

    const { stdout: parentsRaw } = await git(dir, ["log", "-1", "--format=%P", "HEAD"]);
    expect(parentsRaw.trim()).toBe(baseSha); // single parent -> no merge commit was created.
  });
});

describe("mergeCommit (FR-297): real merge commit path", () => {
  it("on a diverged pair, creates a real 2-parent merge commit whose parents are the pre-merge HEAD and the merged-in commit (AC7)", async () => {
    const dir = await makeRepo();
    await writeFile(dir, "a.txt", "base\n");
    await commit(dir, "base");
    await git(dir, ["checkout", "-q", "-b", "feature"]);
    await writeFile(dir, "b.txt", "feature-only\n");
    const featureSha = await commit(dir, "feature change");
    await git(dir, ["checkout", "-q", "main"]);
    await writeFile(dir, "c.txt", "main-only\n");
    const mainSha = await commit(dir, "main change");

    await mergeCommit(dir, featureSha);

    const state = await getRepositoryState(dir);
    expect(state.inProgressOperation).toBeNull();
    expect(state.headSha).not.toBe(mainSha);
    expect(state.headSha).not.toBe(featureSha);

    const { stdout: parentsRaw } = await git(dir, ["log", "-1", "--format=%P", "HEAD"]);
    const parents = parentsRaw.trim().split(" ");
    expect(parents).toEqual([mainSha, featureSha]);

    // Both sides' content actually present after the merge.
    expect((await git(dir, ["show", "HEAD:b.txt"])).stdout).toBe("feature-only\n");
    expect((await git(dir, ["show", "HEAD:c.txt"])).stdout).toBe("main-only\n");
  });
});

describe("mergeCommit (FR-297): conflict pause, indistinguishable in the return value from any other outcome", () => {
  it("rejects with a plain GitCommandError, leaving MERGE_HEAD/conflicted state discoverable only via a fresh RepositoryState read (FR-297)", async () => {
    const dir = await makeRepo();
    await writeFile(dir, "a.txt", "base\n");
    await commit(dir, "base");
    await git(dir, ["checkout", "-q", "-b", "feature"]);
    await writeFile(dir, "a.txt", "feature change\n");
    const featureSha = await commit(dir, "feature change");
    await git(dir, ["checkout", "-q", "main"]);
    await writeFile(dir, "a.txt", "main change\n");
    await commit(dir, "main change");

    await expect(mergeCommit(dir, featureSha)).rejects.toBeInstanceOf(GitCommandError);

    const state = await getRepositoryState(dir);
    expect(state.inProgressOperation).toBe("merge");
    const detail = state.inProgressOperationDetail;
    if (detail?.kind !== "merge") throw new Error("expected merge detail");
    expect(detail.mergeHeadSha).toBe(featureSha);
    expect(detail.mergeHeadSubject).toBe("feature change");

    await abortInProgressOperation(dir, "merge");
  });
});

describe("mergeCommit (FR-297): already-in-progress refusal", () => {
  it("refuses up front, making no `git merge` call, when another operation is already in progress — error names the requested action correctly", async () => {
    const dir = await makeRepo();
    await writeFile(dir, "a.txt", "base\n");
    await commit(dir, "base");
    await git(dir, ["checkout", "-q", "-b", "feature"]);
    await writeFile(dir, "a.txt", "feature change\n");
    const featureSha = await commit(dir, "feature change");
    await git(dir, ["checkout", "-q", "-b", "other"]);
    await writeFile(dir, "a.txt", "other change\n");
    const otherSha = await commit(dir, "other change");
    await git(dir, ["checkout", "-q", "main"]);
    await writeFile(dir, "a.txt", "main change\n");
    await commit(dir, "main change");
    // Leave a real cherry-pick genuinely mid-conflict, unrelated to the merge we're about to attempt.
    await git(dir, ["cherry-pick", otherSha]).catch(() => {});
    const preState = await getRepositoryState(dir);
    expect(preState.inProgressOperation).toBe("cherry-pick");
    expect(await fileExists(path.join(dir, ".git", "CHERRY_PICK_HEAD"))).toBe(true);

    let caught: unknown;
    try {
      await mergeCommit(dir, featureSha);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(OperationAlreadyInProgressError);
    const typed = caught as OperationAlreadyInProgressError;
    expect(typed.operation).toBe("cherry-pick");
    expect(typed.requestedAction).toBe("merge");
    expect(typed.message).toMatch(/^Cannot merge:/);
    expect(typed.message).not.toMatch(/cherry-pick:/); // never mislabeled as cherry-pick's own refusal wording.

    // Nothing beyond the pre-existing cherry-pick's own state changed — no MERGE_HEAD appeared.
    const postState = await getRepositoryState(dir);
    expect(postState.inProgressOperation).toBe("cherry-pick");
    expect(await fileExists(path.join(dir, ".git", "MERGE_HEAD"))).toBe(false);

    await abortInProgressOperation(dir, "cherry-pick");
  });

  it("refuses a second merge on top of a merge already paused on conflict", async () => {
    const dir = await makeRepo();
    await writeFile(dir, "a.txt", "base\n");
    await commit(dir, "base");
    await git(dir, ["checkout", "-q", "-b", "feature"]);
    await writeFile(dir, "a.txt", "feature change\n");
    const featureSha = await commit(dir, "feature change");
    await git(dir, ["checkout", "-q", "main"]);
    await writeFile(dir, "a.txt", "main change\n");
    await commit(dir, "main change");
    await expect(mergeCommit(dir, featureSha)).rejects.toBeInstanceOf(GitCommandError); // pauses.

    await expect(mergeCommit(dir, featureSha)).rejects.toBeInstanceOf(OperationAlreadyInProgressError);

    await abortInProgressOperation(dir, "merge");
  });
});

describe("Repository facade (mergeCommit)", () => {
  it("round-trips a fast-forward merge through the Repository facade", async () => {
    const dir = await makeRepo();
    await writeFile(dir, "a.txt", "base\n");
    await commit(dir, "base");
    await git(dir, ["checkout", "-q", "-b", "feature"]);
    await writeFile(dir, "a.txt", "feature change\n");
    const featureSha = await commit(dir, "feature change");
    await git(dir, ["checkout", "-q", "main"]);

    const repo = await Repository.open(dir);
    await repo.mergeCommit(featureSha);
    await repo.refreshState();
    expect(repo.getState().inProgressOperation).toBeNull();
    expect(repo.getState().headSha).toBe(featureSha);
  });

  it("refuses with a bare-repository error", async () => {
    const dir = await initRepo({ bare: true });
    cleanupDirs.push(dir);
    const repo = await Repository.open(dir);

    await expect(repo.mergeCommit("deadbeef")).rejects.toThrow(/bare repository/);
  });
});
