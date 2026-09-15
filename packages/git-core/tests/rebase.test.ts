// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect, afterEach } from "vitest";
import * as path from "node:path";
import { rebaseCommitOnto } from "../src/rebase";
import { Repository } from "../src/index";
import { abortInProgressOperation } from "../src/conflicts";
import { GitCommandError, OperationAlreadyInProgressError } from "../src/errors";
import { getRepositoryState } from "../src/repository";
import { git, initRepo, writeFile, commit, cleanup, fileExists } from "./testRepo";

/**
 * specs/drag-commit-menu.md's git-core surface for FR-298: `rebaseCommitOnto()` — always `git
 * rebase <newBaseSha>` against current HEAD, git's plain non-interactive form. Same fast-forward/
 * real-replay/already-in-progress-refusal coverage as merge.test.ts's FR-297 counterpart.
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

describe("rebaseCommitOnto (FR-298): no-op fast-forward path", () => {
  it("when HEAD is already an ancestor of the new base, fast-forwards HEAD onto it with nothing to replay (AC8)", async () => {
    const dir = await makeRepo();
    await writeFile(dir, "a.txt", "base\n");
    const baseSha = await commit(dir, "base");
    await git(dir, ["checkout", "-q", "-b", "feature"]);
    await writeFile(dir, "a.txt", "feature change\n");
    const featureSha = await commit(dir, "feature change");
    await git(dir, ["checkout", "-q", "main"]); // main == baseSha, an ancestor of feature.

    await rebaseCommitOnto(dir, featureSha);

    const state = await getRepositoryState(dir);
    expect(state.inProgressOperation).toBeNull();
    expect(state.headSha).toBe(featureSha); // pure fast-forward, no replayed commits.
    expect(state.headSha).not.toBe(baseSha);
  });
});

describe("rebaseCommitOnto (FR-298): real replay path", () => {
  it("on a diverged pair, replays HEAD's unique commits onto the new base, preserving their content (AC8)", async () => {
    const dir = await makeRepo();
    await writeFile(dir, "a.txt", "base\n");
    await commit(dir, "base");
    await git(dir, ["checkout", "-q", "-b", "feature"]);
    await writeFile(dir, "b.txt", "feature-b\n");
    const preRebaseFeatureSha = await commit(dir, "feature: add b.txt");
    const preRebaseDiff = (await git(dir, ["show", preRebaseFeatureSha, "--format=", "--"])).stdout;
    await git(dir, ["checkout", "-q", "main"]);
    await writeFile(dir, "c.txt", "main-c\n");
    const mainSha = await commit(dir, "main: add c.txt");
    await git(dir, ["checkout", "-q", "feature"]);

    await rebaseCommitOnto(dir, mainSha);

    const state = await getRepositoryState(dir);
    expect(state.inProgressOperation).toBeNull();
    expect(state.headSha).not.toBe(preRebaseFeatureSha); // replayed as a NEW commit, not reused.

    const { stdout: parentRaw } = await git(dir, ["log", "-1", "--format=%P", "HEAD"]);
    expect(parentRaw.trim()).toBe(mainSha); // replayed directly onto the new base.

    const { stdout: subjectRaw } = await git(dir, ["log", "-1", "--format=%s", "HEAD"]);
    expect(subjectRaw.trim()).toBe("feature: add b.txt"); // message preserved.

    const replayedDiff = (await git(dir, ["show", "HEAD", "--format=", "--"])).stdout;
    expect(replayedDiff).toBe(preRebaseDiff); // content matches the pre-rebase diff exactly.

    expect((await git(dir, ["show", "HEAD:c.txt"])).stdout).toBe("main-c\n"); // main's content carried through.
  });
});

describe("rebaseCommitOnto (FR-298): conflict pause, indistinguishable in the return value from any other outcome", () => {
  it("rejects with a plain GitCommandError, leaving rebase-merge/conflicted state discoverable only via a fresh RepositoryState read (FR-298)", async () => {
    const dir = await makeRepo();
    await writeFile(dir, "a.txt", "base\n");
    await commit(dir, "base");
    await git(dir, ["checkout", "-q", "-b", "feature"]);
    await writeFile(dir, "a.txt", "feature change\n");
    await commit(dir, "feature change");
    await git(dir, ["checkout", "-q", "main"]);
    await writeFile(dir, "a.txt", "main change\n");
    const mainSha = await commit(dir, "main change");
    await git(dir, ["checkout", "-q", "feature"]);

    await expect(rebaseCommitOnto(dir, mainSha)).rejects.toBeInstanceOf(GitCommandError);

    const state = await getRepositoryState(dir);
    expect(state.inProgressOperation).toBe("rebase");
    const detail = state.inProgressOperationDetail;
    if (detail?.kind !== "rebase") throw new Error("expected rebase detail");
    expect(detail.originalBranch).toBe("feature");
    expect(detail.ontoSha).toBe(mainSha);
    expect(detail.currentCommitSubject).toBe("feature change");

    await abortInProgressOperation(dir, "rebase");
  });
});

describe("rebaseCommitOnto (FR-298): already-in-progress refusal", () => {
  it("refuses up front, making no `git rebase` call, when another operation is already in progress — error names the requested action correctly", async () => {
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
    // Leave a real merge genuinely mid-conflict, unrelated to the rebase we're about to attempt.
    await git(dir, ["merge", "-q", "feature"]).catch(() => {});
    const preState = await getRepositoryState(dir);
    expect(preState.inProgressOperation).toBe("merge");
    expect(await fileExists(path.join(dir, ".git", "MERGE_HEAD"))).toBe(true);

    let caught: unknown;
    try {
      await rebaseCommitOnto(dir, otherSha);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(OperationAlreadyInProgressError);
    const typed = caught as OperationAlreadyInProgressError;
    expect(typed.operation).toBe("merge");
    expect(typed.requestedAction).toBe("rebase");
    expect(typed.message).toMatch(/^Cannot rebase:/);

    // Nothing beyond the pre-existing merge's own state changed — no rebase-merge/ dir appeared.
    const postState = await getRepositoryState(dir);
    expect(postState.inProgressOperation).toBe("merge");
    expect(await fileExists(path.join(dir, ".git", "rebase-merge"))).toBe(false);

    await abortInProgressOperation(dir, "merge");
  });

  it("refuses a second rebase on top of a rebase already paused on conflict", async () => {
    const dir = await makeRepo();
    await writeFile(dir, "a.txt", "base\n");
    await commit(dir, "base");
    await git(dir, ["checkout", "-q", "-b", "feature"]);
    await writeFile(dir, "a.txt", "feature change\n");
    await commit(dir, "feature change");
    await git(dir, ["checkout", "-q", "main"]);
    await writeFile(dir, "a.txt", "main change\n");
    const mainSha = await commit(dir, "main change");
    await git(dir, ["checkout", "-q", "feature"]);
    await expect(rebaseCommitOnto(dir, mainSha)).rejects.toBeInstanceOf(GitCommandError); // pauses.

    await expect(rebaseCommitOnto(dir, mainSha)).rejects.toBeInstanceOf(OperationAlreadyInProgressError);

    await abortInProgressOperation(dir, "rebase");
  });
});

describe("Repository facade (rebaseCommitOnto)", () => {
  it("round-trips a no-op fast-forward rebase through the Repository facade", async () => {
    const dir = await makeRepo();
    await writeFile(dir, "a.txt", "base\n");
    await commit(dir, "base");
    await git(dir, ["checkout", "-q", "-b", "feature"]);
    await writeFile(dir, "a.txt", "feature change\n");
    const featureSha = await commit(dir, "feature change");
    await git(dir, ["checkout", "-q", "main"]);

    const repo = await Repository.open(dir);
    await repo.rebaseCommitOnto(featureSha);
    await repo.refreshState();
    expect(repo.getState().inProgressOperation).toBeNull();
    expect(repo.getState().headSha).toBe(featureSha);
  });

  it("refuses with a bare-repository error", async () => {
    const dir = await initRepo({ bare: true });
    cleanupDirs.push(dir);
    const repo = await Repository.open(dir);

    await expect(repo.rebaseCommitOnto("deadbeef")).rejects.toThrow(/bare repository/);
  });
});
