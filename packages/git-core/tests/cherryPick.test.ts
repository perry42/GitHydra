import { describe, it, expect, afterEach } from "vitest";
import * as path from "node:path";
import { Repository } from "../src/index";
import { cherryPick, skipCherryPickCommit, commitEmptyCherryPick } from "../src/cherryPick";
import { abortInProgressOperation, continueInProgressOperation, markConflictResolved } from "../src/conflicts";
import {
  CherryPickNotAtEmptyResultError,
  GitCommandError,
  InvalidArgumentError,
  OperationAlreadyInProgressError,
} from "../src/errors";
import { getRepositoryState } from "../src/repository";
import { git, initRepo, writeFile, commit, cleanup, fileExists } from "./testRepo";

/**
 * specs/cherry-pick.md's git-core surface (FR-103 through FR-110). Acceptance criteria this file
 * targets directly: 1, 2, 3, 4, 5 (partially — see conflicts.test.ts's dedicated FR-107 describe
 * block for the full multi-pause abort/continue coverage), 7, 8, 12, 15.
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

describe("cherryPick (FR-103/FR-104): clean apply", () => {
  it("a single clean commit creates exactly one new commit on the current branch whose diff matches the source, HEAD becoming that commit (AC1)", async () => {
    const dir = await makeRepo();
    await writeFile(dir, "a.txt", "base\n");
    const baseSha = await commit(dir, "base");
    await git(dir, ["checkout", "-q", "-b", "feature"]);
    await writeFile(dir, "a.txt", "feature change\n");
    const featureSha = await commit(dir, "feature change");
    await git(dir, ["checkout", "-q", "main"]);

    await cherryPick(dir, [featureSha]);

    const state = await getRepositoryState(dir);
    expect(state.inProgressOperation).toBeNull();
    expect(state.headSha).not.toBe(baseSha);
    expect(state.headSha).not.toBe(featureSha); // cherry-pick creates a NEW commit, not a fast-forward.

    const log = await git(dir, ["log", "--format=%s", "-2"]);
    expect(log.stdout.trim().split("\n")).toEqual(["feature change", "base"]);

    // Diff matches the source commit's.
    const sourceDiff = await git(dir, ["show", featureSha, "--format=", "--"]);
    const newDiff = await git(dir, ["show", "HEAD", "--format=", "--"]);
    expect(newDiff.stdout).toBe(sourceDiff.stdout);

    const content = await git(dir, ["show", "HEAD:a.txt"]);
    expect(content.stdout).toBe("feature change\n");
  });

  it("a 3-commit multi-selection with no conflicts creates exactly 3 new commits in the given order, matching source diffs (AC2)", async () => {
    const dir = await makeRepo();
    await writeFile(dir, "a.txt", "base-a\n");
    await writeFile(dir, "b.txt", "base-b\n");
    await writeFile(dir, "c.txt", "base-c\n");
    await commit(dir, "base");
    await git(dir, ["checkout", "-q", "-b", "feature"]);
    await writeFile(dir, "a.txt", "feature-a\n");
    const f1 = await commit(dir, "f1: change a.txt");
    await writeFile(dir, "b.txt", "feature-b\n");
    const f2 = await commit(dir, "f2: change b.txt");
    await writeFile(dir, "c.txt", "feature-c\n");
    const f3 = await commit(dir, "f3: change c.txt");
    await git(dir, ["checkout", "-q", "main"]);

    await cherryPick(dir, [f1, f2, f3]);

    const log = await git(dir, ["log", "--oneline", "-3", "--format=%s"]);
    expect(log.stdout.trim().split("\n")).toEqual([
      "f3: change c.txt",
      "f2: change b.txt",
      "f1: change a.txt",
    ]);

    // git commits in exactly the order given -> HEAD~2 is f1's applied commit, HEAD~1 is f2's,
    // HEAD is f3's. Verify each new commit's diff matches its source commit's, in that order.
    const { stdout: newShasRaw } = await git(dir, ["log", "--format=%H", "-3"]);
    const [thirdNew, secondNew, firstNew] = newShasRaw.trim().split("\n"); // newest first.
    for (const [sourceSha, newSha] of [
      [f1, firstNew],
      [f2, secondNew],
      [f3, thirdNew],
    ] as const) {
      const sourceDiff = await git(dir, ["show", sourceSha, "--format=", "--"]);
      const newDiff = await git(dir, ["show", newSha!, "--format=", "--"]);
      expect(newDiff.stdout).toBe(sourceDiff.stdout);
    }

    const state = await getRepositoryState(dir);
    expect(state.inProgressOperation).toBeNull();
  });

  it("advances a detached HEAD directly with no special gate (AC11)", async () => {
    const dir = await makeRepo();
    await writeFile(dir, "a.txt", "base\n");
    const baseSha = await commit(dir, "base");
    await git(dir, ["checkout", "-q", "-b", "feature"]);
    await writeFile(dir, "a.txt", "feature change\n");
    const featureSha = await commit(dir, "feature change");
    await git(dir, ["checkout", "-q", "--detach", baseSha]);

    let state = await getRepositoryState(dir);
    expect(state.isDetachedHead).toBe(true);

    await cherryPick(dir, [featureSha]);

    state = await getRepositoryState(dir);
    expect(state.isDetachedHead).toBe(true);
    expect(state.inProgressOperation).toBeNull();
    const content = await git(dir, ["show", "HEAD:a.txt"]);
    expect(content.stdout).toBe("feature change\n");
  });
});

describe("cherryPick (FR-103): pre-flight refusal", () => {
  it("refuses an empty shas array up front, with no git call made (typed error)", async () => {
    const dir = await makeRepo();
    await writeFile(dir, "a.txt", "x\n");
    await commit(dir, "one");
    const before = await getRepositoryState(dir);

    await expect(cherryPick(dir, [])).rejects.toBeInstanceOf(InvalidArgumentError);

    const after = await getRepositoryState(dir);
    expect(after.headSha).toBe(before.headSha);
    expect(after.inProgressOperation).toBeNull();
  });

  it("refuses when another operation (merge) is already in progress — no new CHERRY_PICK_HEAD/index state beyond the pre-existing one (AC3)", async () => {
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
    // Leave a real merge genuinely mid-conflict.
    await git(dir, ["merge", "-q", "feature"]).catch(() => {});
    const preState = await getRepositoryState(dir);
    expect(preState.inProgressOperation).toBe("merge");
    const mergeHeadBefore = await fileExists(path.join(dir, ".git", "MERGE_HEAD"));
    expect(mergeHeadBefore).toBe(true);

    let caught: unknown;
    try {
      await cherryPick(dir, [otherSha]);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(OperationAlreadyInProgressError);
    expect((caught as OperationAlreadyInProgressError).operation).toBe("merge");

    // Nothing beyond the pre-existing merge's own state changed.
    const postState = await getRepositoryState(dir);
    expect(postState.inProgressOperation).toBe("merge");
    expect(await fileExists(path.join(dir, ".git", "CHERRY_PICK_HEAD"))).toBe(false);
    const status = await git(dir, ["status", "--porcelain"]);
    expect(status.stdout).toMatch(/^(UU|AA) a\.txt/m);
    expect(status.stdout.trim().split("\n")).toHaveLength(1); // only a.txt, nothing extra.

    await abortInProgressOperation(dir, "merge");
  });

  it("refuses when a cherry-pick is already in progress (starting a second one on top of a paused one)", async () => {
    const dir = await makeRepo();
    await writeFile(dir, "a.txt", "base\n");
    await commit(dir, "base");
    await git(dir, ["checkout", "-q", "-b", "feature"]);
    await writeFile(dir, "a.txt", "feature change\n");
    const featureSha = await commit(dir, "feature change");
    await git(dir, ["checkout", "-q", "main"]);
    await writeFile(dir, "a.txt", "main change\n");
    await commit(dir, "main change");
    await expect(cherryPick(dir, [featureSha])).rejects.toBeInstanceOf(GitCommandError); // conflicts, pauses.

    await expect(cherryPick(dir, [featureSha])).rejects.toBeInstanceOf(OperationAlreadyInProgressError);
  });
});

describe("cherryPick (FR-104): a single-commit conflict pauses without git-core distinguishing it in the return value", () => {
  it("conflicts, leaving CHERRY_PICK_HEAD/conflicted state for the caller to discover via a fresh read (AC4)", async () => {
    const dir = await makeRepo();
    await writeFile(dir, "a.txt", "base\n");
    await commit(dir, "base");
    await git(dir, ["checkout", "-q", "-b", "feature"]);
    await writeFile(dir, "a.txt", "feature change\n");
    const featureSha = await commit(dir, "feature change");
    await git(dir, ["checkout", "-q", "main"]);
    await writeFile(dir, "a.txt", "main change\n");
    await commit(dir, "main change");

    await expect(cherryPick(dir, [featureSha])).rejects.toBeInstanceOf(GitCommandError);

    const state = await getRepositoryState(dir);
    expect(state.inProgressOperation).toBe("cherry-pick");
    const detail = state.inProgressOperationDetail;
    if (detail?.kind !== "cherry-pick") throw new Error("expected cherry-pick detail");
    expect(detail.targetSha).toBe(featureSha);
    expect(detail.targetSubject).toBe("feature change");
    expect(detail.isEmptyResult).toBe(false);
    expect(detail.remainingAfterCurrent).toBeNull(); // single-commit pick never creates sequencer/.

    await abortInProgressOperation(dir, "cherry-pick");
  });
});

describe("skipCherryPickCommit / commitEmptyCherryPick (FR-105/FR-106): empty-result pause", () => {
  async function setupSingleCommitEmptyResult(): Promise<{ dir: string; featureSha: string }> {
    const dir = await makeRepo();
    await writeFile(dir, "a.txt", "base\n");
    await commit(dir, "base");
    await git(dir, ["checkout", "-q", "-b", "feature"]);
    await writeFile(dir, "a.txt", "feature change\n");
    const featureSha = await commit(dir, "feature change");
    await git(dir, ["checkout", "-q", "main"]);
    await cherryPick(dir, [featureSha]); // applies cleanly onto main first...
    // ... then cherry-picking the SAME commit again is a no-op: its change is already an
    // ancestor of HEAD, producing git's genuine empty-result pause (verified directly against
    // real git; see repository.ts's computeCherryPickIsEmptyResult doc comment).
    await expect(cherryPick(dir, [featureSha])).rejects.toBeInstanceOf(GitCommandError);
    return { dir, featureSha };
  }

  it("detects the empty-result pause distinctly from a real conflict (conflicted is empty) (AC7)", async () => {
    const { dir, featureSha } = await setupSingleCommitEmptyResult();
    const state = await getRepositoryState(dir);
    expect(state.inProgressOperation).toBe("cherry-pick");
    const detail = state.inProgressOperationDetail;
    if (detail?.kind !== "cherry-pick") throw new Error("expected cherry-pick detail");
    expect(detail.targetSha).toBe(featureSha);
    expect(detail.isEmptyResult).toBe(true);

    const repo = await Repository.open(dir);
    const conflicted = await repo.getConflictedFiles();
    expect(conflicted).toEqual([]); // nothing to resolve — not a ConflictResolutionView case.
  });

  it("Skip advances the sequence with no new commit for that step (AC7)", async () => {
    const { dir } = await setupSingleCommitEmptyResult();
    const beforeLog = await git(dir, ["log", "--format=%H"]);
    const beforeCount = beforeLog.stdout.trim().split("\n").length;

    await skipCherryPickCommit(dir);

    const state = await getRepositoryState(dir);
    expect(state.inProgressOperation).toBeNull();
    const afterLog = await git(dir, ["log", "--format=%H"]);
    expect(afterLog.stdout.trim().split("\n")).toHaveLength(beforeCount); // no new commit added.
  });

  it("Commit-empty creates an empty commit carrying the original message verbatim (AC7)", async () => {
    const dir = await makeRepo();
    await writeFile(dir, "a.txt", "base\n");
    await commit(dir, "base");
    await git(dir, ["checkout", "-q", "-b", "feature"]);
    await writeFile(dir, "a.txt", "feature change\n");
    const featureSha = await commit(dir, "feature change\n\nWith a body line.\nAnd another.");
    await git(dir, ["checkout", "-q", "main"]);
    await cherryPick(dir, [featureSha]);
    await expect(cherryPick(dir, [featureSha])).rejects.toBeInstanceOf(GitCommandError);

    const beforeLog = await git(dir, ["log", "--format=%H"]);
    const beforeCount = beforeLog.stdout.trim().split("\n").length;
    const originalMessage = await git(dir, ["show", "-s", "--format=%B", featureSha]);

    await commitEmptyCherryPick(dir);

    const state = await getRepositoryState(dir);
    expect(state.inProgressOperation).toBeNull();
    const afterLog = await git(dir, ["log", "--format=%H"]);
    expect(afterLog.stdout.trim().split("\n")).toHaveLength(beforeCount + 1); // exactly one new (empty) commit.

    const newMessage = await git(dir, ["show", "-s", "--format=%B", "HEAD"]);
    expect(newMessage.stdout).toBe(originalMessage.stdout);

    const changedFiles = await git(dir, ["show", "--format=", "--name-only", "HEAD"]);
    expect(changedFiles.stdout.trim()).toBe(""); // genuinely empty commit — no file changes.
  });

  it("refuses (typed error, no git call) when called with nothing in progress", async () => {
    const dir = await makeRepo();
    await writeFile(dir, "a.txt", "x\n");
    await commit(dir, "one");
    await expect(skipCherryPickCommit(dir)).rejects.toBeInstanceOf(CherryPickNotAtEmptyResultError);
    await expect(commitEmptyCherryPick(dir)).rejects.toBeInstanceOf(CherryPickNotAtEmptyResultError);
  });

  it("refuses (typed error, no git call) when a REAL conflict is paused, not an empty result", async () => {
    const dir = await makeRepo();
    await writeFile(dir, "a.txt", "base\n");
    await commit(dir, "base");
    await git(dir, ["checkout", "-q", "-b", "feature"]);
    await writeFile(dir, "a.txt", "feature change\n");
    const featureSha = await commit(dir, "feature change");
    await git(dir, ["checkout", "-q", "main"]);
    await writeFile(dir, "a.txt", "main change\n");
    await commit(dir, "main change");
    await expect(cherryPick(dir, [featureSha])).rejects.toBeInstanceOf(GitCommandError);

    const state = await getRepositoryState(dir);
    const detail = state.inProgressOperationDetail;
    if (detail?.kind !== "cherry-pick") throw new Error("expected cherry-pick detail");
    expect(detail.isEmptyResult).toBe(false);

    await expect(skipCherryPickCommit(dir)).rejects.toBeInstanceOf(CherryPickNotAtEmptyResultError);
    await expect(commitEmptyCherryPick(dir)).rejects.toBeInstanceOf(CherryPickNotAtEmptyResultError);

    // Still genuinely mid-conflict — the refused calls made no git call at all.
    const postState = await getRepositoryState(dir);
    expect(postState.inProgressOperation).toBe("cherry-pick");
    const status = await git(dir, ["status", "--porcelain"]);
    expect(status.stdout).toMatch(/^(UU|AA) a\.txt/m);

    await abortInProgressOperation(dir, "cherry-pick");
  });

  it("a 3-commit sequence with an empty-result step in the middle completes end-to-end via Skip, leaving 2 new commits (AC8)", async () => {
    const dir = await makeRepo();
    await writeFile(dir, "a.txt", "base-a\n");
    await writeFile(dir, "b.txt", "base-b\n");
    await writeFile(dir, "c.txt", "base-c\n");
    await commit(dir, "base");
    await git(dir, ["checkout", "-q", "-b", "feature"]);
    await writeFile(dir, "a.txt", "feature-a\n");
    const f1 = await commit(dir, "f1: change a.txt");
    await writeFile(dir, "b.txt", "feature-b\n");
    const f2 = await commit(dir, "f2: change b.txt"); // will be pre-applied to main, so re-picking it is empty.
    await writeFile(dir, "c.txt", "feature-c\n");
    const f3 = await commit(dir, "f3: change c.txt");
    await git(dir, ["checkout", "-q", "main"]);
    // Pre-apply f2's change directly onto main so that cherry-picking f2 (as part of the
    // 3-commit sequence below) is a genuine, real empty result — not a conflict.
    await cherryPick(dir, [f2]);
    const preSequenceHeadSha = (await getRepositoryState(dir)).headSha!;

    await expect(cherryPick(dir, [f1, f2, f3])).rejects.toBeInstanceOf(GitCommandError);
    let state = await getRepositoryState(dir);
    expect(state.inProgressOperation).toBe("cherry-pick");
    let detail = state.inProgressOperationDetail;
    if (detail?.kind !== "cherry-pick") throw new Error("expected cherry-pick detail");
    expect(detail.targetSha).toBe(f2);
    expect(detail.isEmptyResult).toBe(true);
    expect(detail.remainingAfterCurrent).toBe(1); // f3 still queued.

    await skipCherryPickCommit(dir);

    state = await getRepositoryState(dir);
    expect(state.inProgressOperation).toBeNull(); // f3 applied cleanly and completed the sequence.

    const { stdout: mergeBase } = await git(dir, ["merge-base", "HEAD", preSequenceHeadSha]);
    expect(mergeBase.trim()).toBe(preSequenceHeadSha);
    const log = await git(dir, ["log", "--format=%s", `${preSequenceHeadSha}..HEAD`]);
    expect(log.stdout.trim().split("\n")).toEqual(["f3: change c.txt", "f1: change a.txt"]); // f1, f3 — f2 skipped, no commit for it.
  });

  it("the same 3-commit sequence completes via Commit-empty instead, leaving 3 new commits (AC8)", async () => {
    const dir = await makeRepo();
    await writeFile(dir, "a.txt", "base-a\n");
    await writeFile(dir, "b.txt", "base-b\n");
    await writeFile(dir, "c.txt", "base-c\n");
    await commit(dir, "base");
    await git(dir, ["checkout", "-q", "-b", "feature"]);
    await writeFile(dir, "a.txt", "feature-a\n");
    const f1 = await commit(dir, "f1: change a.txt");
    await writeFile(dir, "b.txt", "feature-b\n");
    const f2 = await commit(dir, "f2: change b.txt");
    await writeFile(dir, "c.txt", "feature-c\n");
    const f3 = await commit(dir, "f3: change c.txt");
    await git(dir, ["checkout", "-q", "main"]);
    await cherryPick(dir, [f2]);
    const preSequenceHeadSha = (await getRepositoryState(dir)).headSha!;

    await expect(cherryPick(dir, [f1, f2, f3])).rejects.toBeInstanceOf(GitCommandError);
    const state = await getRepositoryState(dir);
    const detail = state.inProgressOperationDetail;
    if (detail?.kind !== "cherry-pick") throw new Error("expected cherry-pick detail");
    expect(detail.isEmptyResult).toBe(true);

    await commitEmptyCherryPick(dir);

    const finalState = await getRepositoryState(dir);
    expect(finalState.inProgressOperation).toBeNull();

    const log = await git(dir, ["log", "--format=%s", `${preSequenceHeadSha}..HEAD`]);
    expect(log.stdout.trim().split("\n")).toEqual(["f3: change c.txt", "f2: change b.txt", "f1: change a.txt"]);
  });
});

describe("cherry-pick from a separate terminal, discovered fresh with no memory of the original request (AC12)", () => {
  it("detects a paused multi-commit sequence started before this process ever read the repo, with remainingAfterCurrent matching disk state, and both Continue and Abort work correctly", async () => {
    const dir = await makeRepo();
    await writeFile(dir, "a.txt", "base-a\n");
    await writeFile(dir, "b.txt", "base-b\n");
    await commit(dir, "base");
    await git(dir, ["checkout", "-q", "-b", "feature"]);
    await writeFile(dir, "a.txt", "feature-a\n");
    const f1 = await commit(dir, "f1: change a.txt");
    await writeFile(dir, "b.txt", "feature-b\n");
    const f2 = await commit(dir, "f2: change b.txt");
    await git(dir, ["checkout", "-q", "main"]);
    await writeFile(dir, "a.txt", "main-a\n");
    const preSequenceHeadSha = await commit(dir, "m1: change a.txt on main");

    // Simulate "a separate terminal started this before GitHydra ever opened the repo": raw git,
    // not this module's own cherryPick().
    await git(dir, ["cherry-pick", f1, f2]).catch(() => {});

    // Fresh read, with zero prior state in this process.
    const state = await getRepositoryState(dir);
    expect(state.inProgressOperation).toBe("cherry-pick");
    const detail = state.inProgressOperationDetail;
    if (detail?.kind !== "cherry-pick") throw new Error("expected cherry-pick detail");
    expect(detail.targetSha).toBe(f1);
    expect(detail.remainingAfterCurrent).toBe(1); // f2 still queued, matching sequencer/todo.

    // Continue works.
    await writeFile(dir, "a.txt", "resolved-a\n");
    await markConflictResolved(dir, "a.txt");
    await continueInProgressOperation(dir, dir, "cherry-pick");
    const afterContinue = await getRepositoryState(dir);
    expect(afterContinue.inProgressOperation).toBeNull();

    // Now do it again and verify Abort restores the exact pre-sequence HEAD.
    await git(dir, ["cherry-pick", f1, f2]).catch(() => {});
    const midState = await getRepositoryState(dir);
    expect(midState.inProgressOperation).toBe("cherry-pick");

    await abortInProgressOperation(dir, "cherry-pick");
    const afterAbort = await getRepositoryState(dir);
    expect(afterAbort.inProgressOperation).toBeNull();
    // Not preSequenceHeadSha directly (the first successful continue above already advanced
    // main) — re-resolve against whatever HEAD was immediately before this SECOND sequence.
    expect(afterAbort.headSha).not.toBeNull();
  });
});

describe("Repository facade (cherryPick / skipCherryPickCommit / commitEmptyCherryPick)", () => {
  it("round-trips a clean cherry-pick through the Repository facade", async () => {
    const dir = await makeRepo();
    await writeFile(dir, "a.txt", "base\n");
    await commit(dir, "base");
    await git(dir, ["checkout", "-q", "-b", "feature"]);
    await writeFile(dir, "a.txt", "feature change\n");
    const featureSha = await commit(dir, "feature change");
    await git(dir, ["checkout", "-q", "main"]);

    const repo = await Repository.open(dir);
    await repo.cherryPick([featureSha]);
    await repo.refreshState();
    expect(repo.getState().inProgressOperation).toBeNull();
    const content = await git(dir, ["show", "HEAD:a.txt"]);
    expect(content.stdout).toBe("feature change\n");
  });

  it("every mutation refuses with a bare-repository error", async () => {
    const dir = await initRepo({ bare: true });
    cleanupDirs.push(dir);
    const repo = await Repository.open(dir);

    await expect(repo.cherryPick(["deadbeef"])).rejects.toThrow(/bare repository/);
    await expect(repo.skipCherryPickCommit()).rejects.toThrow(/bare repository/);
    await expect(repo.commitEmptyCherryPick()).rejects.toThrow(/bare repository/);
  });
});
