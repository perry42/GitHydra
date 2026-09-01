import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Repository } from "../src/index";
import { listStashes, getStashDiff, createStash, applyStash, popStash, dropStash, parseStashSubject } from "../src/stash";
import {
  NothingEligibleToStashError,
  StashOnUnbornHeadError,
  ConflictMarkersRemainError,
  PreExistingConflictError,
} from "../src/errors";
import { watchRepositoryRefs } from "../src/watcher";
import { getRepositoryState } from "../src/repository";
import { git, initRepo, writeFile, commit, cleanup, makeTempDir, fileExists } from "./testRepo";

const cleanupDirs: string[] = [];
afterEach(async () => {
  while (cleanupDirs.length) await cleanup(cleanupDirs.pop()!);
});

async function makeRepo(): Promise<string> {
  const dir = await initRepo();
  cleanupDirs.push(dir);
  // This suite compares exact file content (including trailing newlines) after stash
  // create/apply/pop round-trips. A machine-wide `core.autocrlf=true` (common on Windows, and
  // set in this dev environment) would otherwise silently rewrite LF to CRLF on checkout,
  // corrupting those comparisons independent of anything this module does — disable it locally
  // per test repo so this suite exercises stash's own content-preservation behavior, not the
  // ambient autocrlf setting.
  await git(dir, ["config", "core.autocrlf", "false"]);
  return dir;
}

function waitForChangeCount(
  getCount: () => number,
  times: number,
  timeoutMs: number,
  label: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      if (getCount() >= times) {
        resolve();
        return;
      }
      if (Date.now() - start > timeoutMs) {
        reject(new Error(`${label}: fired ${getCount()} time(s), expected >= ${times}, within ${timeoutMs}ms`));
        return;
      }
      setTimeout(check, 25);
    };
    check();
  });
}

describe("parseStashSubject", () => {
  it("parses git's default WIP message verbatim, extracting the branch", () => {
    const { message, branch } = parseStashSubject("WIP on main: a1b2c3d some subject");
    expect(message).toBe("WIP on main: a1b2c3d some subject");
    expect(branch).toBe("main");
  });

  it("parses a detached-HEAD default message with a null branch (the '(no branch)' sentinel)", () => {
    const { message, branch } = parseStashSubject("WIP on (no branch): a1b2c3d some subject");
    expect(message).toBe("WIP on (no branch): a1b2c3d some subject");
    expect(branch).toBeNull();
  });

  it("parses a custom message verbatim, stripping git's 'On <branch>:' wrapper, with a null branch", () => {
    const { message, branch } = parseStashSubject("On main: my custom message");
    expect(message).toBe("my custom message");
    expect(branch).toBeNull();
  });

  it("does not misparse a custom message that itself contains a colon (branch names can't contain ':', so the first colon is unambiguous)", () => {
    const { message, branch } = parseStashSubject("On feature/x: fix: something urgent");
    expect(message).toBe("fix: something urgent");
    expect(branch).toBeNull();
  });
});

describe("listStashes (FR-81)", () => {
  it("returns [] (not an error) for a repo with no stashes", async () => {
    const dir = await makeRepo();
    await writeFile(dir, "a.txt", "1\n");
    await commit(dir, "first");
    expect(await listStashes(dir)).toEqual([]);
  });

  it("lists a default-message stash with parsed branch/date/parentSha", async () => {
    const dir = await makeRepo();
    await writeFile(dir, "a.txt", "1\n");
    const c1 = await commit(dir, "first");
    await writeFile(dir, "a.txt", "2\n");
    await git(dir, ["stash", "push"]);

    const stashes = await listStashes(dir);
    expect(stashes).toHaveLength(1);
    expect(stashes[0]!.index).toBe(0);
    expect(stashes[0]!.ref).toBe("stash@{0}");
    expect(stashes[0]!.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(stashes[0]!.branch).toBe("main");
    expect(stashes[0]!.parentSha).toBe(c1);
    expect(stashes[0]!.message).toMatch(/^WIP on main: /);
    expect(stashes[0]!.date).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("orders multiple stashes stash@{0}-first (most recently created first)", async () => {
    const dir = await makeRepo();
    await writeFile(dir, "a.txt", "1\n");
    await commit(dir, "first");
    await writeFile(dir, "a.txt", "2\n");
    await git(dir, ["stash", "push", "-m", "first stash"]);
    await writeFile(dir, "a.txt", "3\n");
    await git(dir, ["stash", "push", "-m", "second stash"]);

    const stashes = await listStashes(dir);
    expect(stashes.map((s) => s.message)).toEqual(["second stash", "first stash"]);
    expect(stashes.map((s) => s.index)).toEqual([0, 1]);
  });

  it("returns a null branch and the verbatim custom message for a custom-message stash", async () => {
    const dir = await makeRepo();
    await writeFile(dir, "a.txt", "1\n");
    await commit(dir, "first");
    await writeFile(dir, "a.txt", "2\n");
    await git(dir, ["stash", "push", "-m", "my custom message"]);

    const stashes = await listStashes(dir);
    expect(stashes[0]!.message).toBe("my custom message");
    expect(stashes[0]!.branch).toBeNull();
  });

  it("returns a null branch for a stash created from a detached HEAD", async () => {
    const dir = await makeRepo();
    await writeFile(dir, "a.txt", "1\n");
    const c1 = await commit(dir, "first");
    await git(dir, ["checkout", "-q", c1]);
    await writeFile(dir, "a.txt", "2\n");
    await git(dir, ["stash", "push"]);

    const stashes = await listStashes(dir);
    expect(stashes[0]!.branch).toBeNull();
    expect(stashes[0]!.message).toMatch(/^WIP on \(no branch\): /);
  });
});

describe("createStash (FR-84)", () => {
  it("throws StashOnUnbornHeadError on a zero-commit repository (AC6)", async () => {
    const dir = await makeRepo();
    await expect(createStash(dir)).rejects.toBeInstanceOf(StashOnUnbornHeadError);
    expect(await listStashes(dir)).toEqual([]);
  });

  it("throws NothingEligibleToStashError on a clean working tree (AC5)", async () => {
    const dir = await makeRepo();
    await writeFile(dir, "a.txt", "1\n");
    await commit(dir, "first");
    await expect(createStash(dir)).rejects.toBeInstanceOf(NothingEligibleToStashError);
    expect(await listStashes(dir)).toEqual([]);
  });

  it("throws NothingEligibleToStashError when every changed path is conflicted (AC5)", async () => {
    const dir = await makeRepo();
    await writeFile(dir, "a.txt", "base\n");
    await commit(dir, "base");
    await git(dir, ["checkout", "-q", "-b", "feature"]);
    await writeFile(dir, "a.txt", "feature\n");
    await commit(dir, "feature change");
    await git(dir, ["checkout", "-q", "main"]);
    await writeFile(dir, "a.txt", "main\n");
    await commit(dir, "main change");
    await git(dir, ["merge", "-q", "feature"]).catch(() => {});

    await expect(createStash(dir)).rejects.toBeInstanceOf(NothingEligibleToStashError);
    expect(await listStashes(dir)).toEqual([]);
  });

  it("stashes every eligible file with git's own default message, leaving git status clean afterward (AC1)", async () => {
    const dir = await makeRepo();
    await writeFile(dir, "a.txt", "1\n");
    await writeFile(dir, "b.txt", "1\n");
    await commit(dir, "first");
    await writeFile(dir, "a.txt", "2\n"); // unstaged
    await writeFile(dir, "b.txt", "2\n");
    await git(dir, ["add", "b.txt"]); // staged

    const result = await createStash(dir);
    expect(result.ref).toBe("stash@{0}");
    expect(result.sha).toMatch(/^[0-9a-f]{40}$/);

    const { stdout: statusOut } = await git(dir, ["status", "--porcelain"]);
    expect(statusOut.trim()).toBe("");

    const stashes = await listStashes(dir);
    expect(stashes).toHaveLength(1);
    expect(stashes[0]!.message).toMatch(/^WIP on main: /);
  });

  it("stashing an explicit subset of files leaves unselected files' changes untouched (AC2)", async () => {
    const dir = await makeRepo();
    await writeFile(dir, "a.txt", "1\n");
    await writeFile(dir, "b.txt", "1\n");
    await commit(dir, "first");
    await writeFile(dir, "a.txt", "2\n");
    await writeFile(dir, "b.txt", "2\n");

    await createStash(dir, { paths: ["a.txt"] });

    expect(await fs.readFile(path.join(dir, "a.txt"), "utf8")).toBe("1\n"); // reverted (stashed)
    expect(await fs.readFile(path.join(dir, "b.txt"), "utf8")).toBe("2\n"); // untouched

    const diff = await getStashDiff(dir, 0);
    expect(diff.files.map((f) => f.path)).toEqual(["a.txt"]);
  });

  it("includeUntracked captures untracked files (AC3)", async () => {
    const dir = await makeRepo();
    await writeFile(dir, "a.txt", "1\n");
    await commit(dir, "first");
    await writeFile(dir, "new.txt", "shiny\n"); // untracked only, nothing else changed

    // Without includeUntracked, there is nothing eligible at all here.
    await expect(createStash(dir)).rejects.toBeInstanceOf(NothingEligibleToStashError);

    await createStash(dir, { includeUntracked: true });
    const status = await git(dir, ["status", "--porcelain"]);
    expect(status.stdout.trim()).toBe("");
    expect(await fileExists(path.join(dir, "new.txt"))).toBe(false);

    const diff = await getStashDiff(dir, 0);
    const untrackedEntry = diff.files.find((f) => f.path === "new.txt");
    expect(untrackedEntry).toBeDefined();
    expect(untrackedEntry!.isUntracked).toBe(true);
    expect(untrackedEntry!.diff.status).toBe("ok");

    await popStash(dir, 0);
    expect(await fileExists(path.join(dir, "new.txt"))).toBe(true);
    expect(await fs.readFile(path.join(dir, "new.txt"), "utf8")).toBe("shiny\n");
  });

  it("leaves an untracked file exactly as it was (still untracked) when includeUntracked is omitted (AC3)", async () => {
    const dir = await makeRepo();
    await writeFile(dir, "a.txt", "1\n");
    await commit(dir, "first");
    await writeFile(dir, "a.txt", "2\n");
    await writeFile(dir, "new.txt", "shiny\n");

    await createStash(dir); // default: includeUntracked false

    expect(await fileExists(path.join(dir, "new.txt"))).toBe(true);
    const status = await git(dir, ["status", "--porcelain"]);
    expect(status.stdout).toContain("?? new.txt");
    expect(await fs.readFile(path.join(dir, "a.txt"), "utf8")).toBe("1\n"); // reverted, stashed

    const diff = await getStashDiff(dir, 0);
    expect(diff.files.some((f) => f.path === "new.txt")).toBe(false);
  });

  it("uses the exact custom message, never git's default WIP text (AC4)", async () => {
    const dir = await makeRepo();
    await writeFile(dir, "a.txt", "1\n");
    await commit(dir, "first");
    await writeFile(dir, "a.txt", "2\n");
    await createStash(dir, { message: "my exact message" });

    const { stdout } = await git(dir, ["stash", "list"]);
    expect(stdout).toContain("my exact message");
    expect(stdout).not.toContain("WIP on");

    const stashes = await listStashes(dir);
    expect(stashes[0]!.message).toBe("my exact message");
  });

  it("refuses the whole operation (typed error, not a raw git error) when any path anywhere is conflicted, even one excluded from the requested pathspec", async () => {
    const dir = await makeRepo();
    await writeFile(dir, "a.txt", "base\n");
    await writeFile(dir, "b.txt", "base\n");
    await commit(dir, "base");
    await git(dir, ["checkout", "-q", "-b", "feature"]);
    await writeFile(dir, "a.txt", "feature\n");
    await commit(dir, "feature change");
    await git(dir, ["checkout", "-q", "main"]);
    await writeFile(dir, "a.txt", "main\n");
    await commit(dir, "main change");
    await git(dir, ["merge", "-q", "feature"]).catch(() => {});
    // a.txt is now conflicted. Add an ordinary unstaged change to b.txt alongside it — real git
    // itself refuses ANY `git stash push` while a.txt remains conflicted, even restricted to
    // b.txt's pathspec (verified directly), so this must surface our typed refusal, not attempt
    // a partial stash of just b.txt.
    await writeFile(dir, "b.txt", "changed\n");

    await expect(createStash(dir, { paths: ["a.txt", "b.txt"] })).rejects.toBeInstanceOf(
      NothingEligibleToStashError,
    );
    await expect(createStash(dir)).rejects.toBeInstanceOf(NothingEligibleToStashError);

    // Neither attempt touched anything: a.txt's conflict and b.txt's change are both untouched.
    expect(await listStashes(dir)).toEqual([]);
    const status = await git(dir, ["status", "--porcelain"]);
    expect(status.stdout).toMatch(/^(UU|AA) a\.txt/m);
    expect(status.stdout).toContain(" M b.txt");
  });
});

describe("getStashDiff (FR-83)", () => {
  it("lists every changed file with diff content, without touching the working tree/index (AC8)", async () => {
    const dir = await makeRepo();
    await writeFile(dir, "a.txt", "1\n");
    await commit(dir, "first");
    await writeFile(dir, "a.txt", "2\n");
    await createStash(dir);

    const beforeStatus = (await git(dir, ["status", "--porcelain"])).stdout;
    const diff = await getStashDiff(dir, 0);
    expect(diff.files).toHaveLength(1);
    expect(diff.files[0]!.path).toBe("a.txt");
    expect(diff.files[0]!.isUntracked).toBe(false);
    expect(diff.files[0]!.diff.status).toBe("ok");
    const afterStatus = (await git(dir, ["status", "--porcelain"])).stdout;
    expect(afterStatus).toBe(beforeStatus);
  });
});

describe("applyStash / popStash (FR-85)", () => {
  it("apply on a cleanly-applicable stash applies its changes and leaves the entry present (AC9)", async () => {
    const dir = await makeRepo();
    await writeFile(dir, "a.txt", "1\n");
    await commit(dir, "first");
    await writeFile(dir, "a.txt", "2\n");
    await createStash(dir);
    expect(await fs.readFile(path.join(dir, "a.txt"), "utf8")).toBe("1\n");

    const outcome = await applyStash(dir, 0);
    expect(outcome.status).toBe("applied");
    expect(await fs.readFile(path.join(dir, "a.txt"), "utf8")).toBe("2\n");
    expect(await listStashes(dir)).toHaveLength(1);
  });

  it("pop removes exactly the targeted entry, leaving other entries' indices/content otherwise unaffected (AC10)", async () => {
    const dir = await makeRepo();
    await writeFile(dir, "a.txt", "1\n");
    await commit(dir, "first");

    await writeFile(dir, "a.txt", "2\n");
    await createStash(dir, { message: "first stash" }); // stash@{0}; working tree back to "1\n"

    await writeFile(dir, "b.txt", "x\n");
    await commit(dir, "add b");
    await writeFile(dir, "b.txt", "y\n");
    await createStash(dir, { message: "second stash" }); // now stash@{0}; "first stash" shifts to stash@{1}

    let stashes = await listStashes(dir);
    expect(stashes.map((s) => s.message)).toEqual(["second stash", "first stash"]);

    const outcome = await popStash(dir, 0); // pop "second stash"
    expect(outcome.status).toBe("applied");
    expect(await fs.readFile(path.join(dir, "b.txt"), "utf8")).toBe("y\n");

    stashes = await listStashes(dir);
    expect(stashes).toHaveLength(1);
    expect(stashes[0]!.message).toBe("first stash");
    expect(stashes[0]!.index).toBe(0);
  });
});

/**
 * base -> stash "STASHED" -> diverge working tree to "CURRENT" (staged) -> apply/pop conflicts,
 * since git's internal 3-way merge (base vs CURRENT vs STASHED) can't reconcile the same line
 * changed two different ways.
 *
 * The local "CURRENT" change must be STAGED (not left merely unstaged) before apply/pop: an
 * unstaged local modification to a path the stash also touches makes `git stash apply`/`pop`
 * refuse outright ("Your local changes ... would be overwritten by merge") without ever
 * attempting the 3-way merge at all — a real refusal (FR-85), not FR-86/87's conflict outcome.
 * Verified directly against real git (2026-09-01) before writing this fixture this way.
 */
async function setupStashApplyConflict(): Promise<{ dir: string }> {
  const dir = await makeRepo();
  await writeFile(dir, "a.txt", "line1\nline2\nline3\n");
  await commit(dir, "base");
  await writeFile(dir, "a.txt", "line1\nSTASHED\nline3\n");
  await createStash(dir, { message: "conflicting stash" });
  await writeFile(dir, "a.txt", "line1\nCURRENT\nline3\n");
  await git(dir, ["add", "a.txt"]);
  return { dir };
}

describe("stash-apply/pop conflicts (FR-86/FR-87 — the 'sharp edge': no fabricated in-progress-operation)", () => {
  it("apply on a conflicting stash leaves the stash present and populates getWorkingDirectoryChanges().conflicted, with NO in-progress-operation state (AC11)", async () => {
    const { dir } = await setupStashApplyConflict();
    const outcome = await applyStash(dir, 0);
    expect(outcome.status).toBe("conflict");
    if (outcome.status !== "conflict") throw new Error("expected conflict");
    expect(outcome.conflictedPaths).toEqual(["a.txt"]);

    const repo = await Repository.open(dir);
    expect(repo.getState().inProgressOperation).toBeNull(); // the spec's core "sharp edge" assertion.

    const changes = await repo.getWorkingDirectoryChanges();
    expect(changes!.conflicted.map((f) => f.path)).toEqual(["a.txt"]);

    expect(await listStashes(dir)).toHaveLength(1); // stash retained even on conflict.
  });

  it("pop on a conflicting stash leaves the stash entry present (git's real pop-never-drops-on-conflict behavior) (AC11)", async () => {
    const { dir } = await setupStashApplyConflict();
    const outcome = await popStash(dir, 0);
    expect(outcome.status).toBe("conflict");

    expect(await listStashes(dir)).toHaveLength(1); // NOT dropped, unlike a clean pop.
    const repo = await Repository.open(dir);
    expect(repo.getState().inProgressOperation).toBeNull();
  });

  it("Accept Ours / Accept Theirs / Mark as Resolved behave identically to a merge conflict, reusing conflicts.ts unmodified, including the marker-scan refusal (AC12)", async () => {
    const { dir } = await setupStashApplyConflict();
    await applyStash(dir, 0);

    const repo = await Repository.open(dir);
    const conflicted = await repo.getConflictedFiles();
    expect(conflicted).toHaveLength(1);
    expect(conflicted![0]!.path).toBe("a.txt");
    expect(conflicted![0]!.stageCombination).toBe("both-modified");

    const contentWithMarkers = await fs.readFile(path.join(dir, "a.txt"), "utf8");
    expect(contentWithMarkers).toContain("<<<<<<<");
    await expect(repo.markConflictResolved("a.txt")).rejects.toBeInstanceOf(ConflictMarkersRemainError);

    // "theirs" (index stage 3) is the stash's own content for a stash-apply conflict.
    await repo.acceptConflictSide("a.txt", "theirs");
    expect(await fs.readFile(path.join(dir, "a.txt"), "utf8")).toBe("line1\nSTASHED\nline3\n");

    const changesAfter = await repo.getWorkingDirectoryChanges();
    expect(changesAfter!.conflicted).toHaveLength(0);
    // The stash is still present — resolving the conflict is not the same as continuing/aborting
    // an operation (there is none), and does not itself touch the stash list.
    expect(await listStashes(dir)).toHaveLength(1);
  });
});

/**
 * Security-reviewer finding (medium severity): before this fix, `applyStash`/`popStash`'s
 * generic catch-and-re-read-conflicts fallback couldn't tell "conflicted entries this apply/pop
 * just produced" apart from "conflicted entries that were already there for an unrelated
 * reason" — so a genuinely-unrelated pre-existing conflict (a real merge/rebase in progress, or
 * leftover unmerged index entries from any other cause) got reported as
 * `{status: "conflict", conflictedPaths: [...]}`, misattributing it to the stash operation.
 * `assertNoPreExistingConflict()` (stash.ts) now refuses up front instead, throwing
 * `PreExistingConflictError`.
 */
describe("applyStash / popStash pre-flight refusal on a pre-existing, unrelated conflict (PreExistingConflictError)", () => {
  /**
   * A stash on b.txt (fully unrelated to a.txt), followed by a REAL, genuinely in-progress merge
   * conflict on a.txt (`git merge` failing leaves both `MERGE_HEAD` and an unmerged index entry —
   * this is real git state, not a mock). Mirrors the exact fixture shape
   * `createStash`'s own "any path anywhere is conflicted" test already uses above.
   */
  async function setupUnrelatedMergeConflict(): Promise<{ dir: string }> {
    const dir = await makeRepo();
    await writeFile(dir, "a.txt", "base\n");
    await writeFile(dir, "b.txt", "1\n");
    await commit(dir, "base");
    await writeFile(dir, "b.txt", "2\n");
    await createStash(dir, { message: "unrelated stash" }); // stash@{0}; tree clean again (b.txt back to "1\n")

    await git(dir, ["checkout", "-q", "-b", "feature"]);
    await writeFile(dir, "a.txt", "feature\n");
    await commit(dir, "feature change");
    await git(dir, ["checkout", "-q", "main"]);
    await writeFile(dir, "a.txt", "main\n");
    await commit(dir, "main change");
    await git(dir, ["merge", "-q", "feature"]).catch(() => {}); // real merge conflict on a.txt, unrelated to b.txt's stash

    return { dir };
  }

  it("applyStash refuses with PreExistingConflictError naming the in-progress merge, instead of reporting {status: \"conflict\"} for the merge's own unrelated files", async () => {
    const { dir } = await setupUnrelatedMergeConflict();
    const repo = await Repository.open(dir);
    expect(repo.getState().inProgressOperation).toBe("merge"); // sanity: a real, live merge — not just leftover index state.

    let caught: unknown;
    try {
      await applyStash(dir, 0);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PreExistingConflictError);
    const typed = caught as PreExistingConflictError;
    expect(typed.requested).toBe("apply");
    expect(typed.operation).toBe("merge");
    expect(typed.conflictedPaths).toEqual(["a.txt"]);
    expect(typed.message).toMatch(/already in progress/i);

    // Nothing was touched: no `git stash apply` was ever attempted.
    expect(await listStashes(dir)).toHaveLength(1);
    const changes = await repo.getWorkingDirectoryChanges();
    expect(changes!.conflicted.map((f) => f.path)).toEqual(["a.txt"]);
    expect(await fileExists(path.join(dir, ".git", "MERGE_HEAD"))).toBe(true);
  });

  it("popStash refuses identically and never drops the stash entry", async () => {
    const { dir } = await setupUnrelatedMergeConflict();

    let caught: unknown;
    try {
      await popStash(dir, 0);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PreExistingConflictError);
    expect((caught as PreExistingConflictError).requested).toBe("pop");
    expect(await listStashes(dir)).toHaveLength(1); // still present — pop was never attempted.
  });

  it("also refuses on pre-existing unmerged index entries with no in-progress-operation file present (operation is null)", async () => {
    const { dir } = await setupUnrelatedMergeConflict();
    // Simulate "leftover unmerged index entries from any other cause" — the conflicted index
    // entry is real git state, but no MERGE_HEAD (or any other operation file) is present.
    await fs.rm(path.join(dir, ".git", "MERGE_HEAD"));

    const repo = await Repository.open(dir);
    expect(repo.getState().inProgressOperation).toBeNull();

    let caught: unknown;
    try {
      await applyStash(dir, 0);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PreExistingConflictError);
    const typed = caught as PreExistingConflictError;
    expect(typed.operation).toBeNull();
    expect(typed.conflictedPaths).toEqual(["a.txt"]);
  });
});

describe("dropStash (FR-88)", () => {
  it("removes exactly the targeted entry, without altering any other stash or the working tree/index (AC13)", async () => {
    const dir = await makeRepo();
    await writeFile(dir, "a.txt", "1\n");
    await commit(dir, "first");
    await writeFile(dir, "a.txt", "2\n");
    await createStash(dir, { message: "s1" });
    await writeFile(dir, "a.txt", "3\n");
    await createStash(dir, { message: "s2" });

    let stashes = await listStashes(dir);
    expect(stashes.map((s) => s.message)).toEqual(["s2", "s1"]);

    await dropStash(dir, 1); // drop "s1"

    stashes = await listStashes(dir);
    expect(stashes).toHaveLength(1);
    expect(stashes[0]!.message).toBe("s2");

    const status = await git(dir, ["status", "--porcelain"]);
    expect(status.stdout.trim()).toBe(""); // drop never touches the working tree/index.
  });
});

describe("Repository facade: bare repo / unborn HEAD gating", () => {
  it("listStashes()/getStashDiff() return null on a bare repo; every mutation refuses with a working-directory error", async () => {
    const dir = await initRepo({ bare: true });
    cleanupDirs.push(dir);
    const repo = await Repository.open(dir);

    expect(await repo.listStashes()).toBeNull();
    expect(await repo.getStashDiff(0)).toBeNull();
    await expect(repo.createStash()).rejects.toThrow(/bare repository/);
    await expect(repo.applyStash(0)).rejects.toThrow(/bare repository/);
    await expect(repo.popStash(0)).rejects.toThrow(/bare repository/);
  });

  it("round-trips create/list/getStashDiff/pop through the Repository facade", async () => {
    const dir = await makeRepo();
    await writeFile(dir, "a.txt", "1\n");
    await commit(dir, "first");
    await writeFile(dir, "a.txt", "2\n");
    const repo = await Repository.open(dir);

    const created = await repo.createStash({ message: "via facade" });
    expect(created.ref).toBe("stash@{0}");

    let stashes = await repo.listStashes();
    expect(stashes).toHaveLength(1);

    const diff = await repo.getStashDiff(0);
    expect(diff!.files.map((f) => f.path)).toEqual(["a.txt"]);

    const outcome = await repo.popStash(0);
    expect(outcome.status).toBe("applied");
    stashes = await repo.listStashes();
    expect(stashes).toHaveLength(0);
  });

  it("dropStash() is reachable via the facade, separately from apply/pop", async () => {
    const dir = await makeRepo();
    await writeFile(dir, "a.txt", "1\n");
    await commit(dir, "first");
    await writeFile(dir, "a.txt", "2\n");
    const repo = await Repository.open(dir);
    await repo.createStash();

    await repo.dropStash(0);
    expect(await repo.listStashes()).toHaveLength(0);
  });
});

describe("worktree sharing (FR-82, AC16)", () => {
  it("a stash created via one linked worktree is visible from another, and apply affects only the applying worktree", async () => {
    const dir = await makeRepo();
    await writeFile(dir, "a.txt", "1\n");
    await commit(dir, "first");
    await git(dir, ["branch", "other"]);

    const worktreeDir = await makeTempDir();
    cleanupDirs.push(worktreeDir);
    await git(dir, ["worktree", "add", worktreeDir.replace(/\\/g, "/"), "other"]);

    // Create a stash from worktree A (the main worktree, `dir`).
    await writeFile(dir, "a.txt", "2\n");
    await createStash(dir, { message: "from worktree A" });

    // Visible from worktree B without any special handling.
    const stashesFromB = await listStashes(worktreeDir);
    expect(stashesFromB).toHaveLength(1);
    expect(stashesFromB[0]!.message).toBe("from worktree A");

    // Applying from worktree B affects only worktree B's working tree.
    const outcome = await applyStash(worktreeDir, 0);
    expect(outcome.status).toBe("applied");
    expect(await fs.readFile(path.join(worktreeDir, "a.txt"), "utf8")).toBe("2\n");
    expect(await fs.readFile(path.join(dir, "a.txt"), "utf8")).toBe("1\n"); // worktree A untouched.

    // The stash entry (apply, not pop) remains visible from both worktrees.
    expect(await listStashes(dir)).toHaveLength(1);
    expect(await listStashes(worktreeDir)).toHaveLength(1);
  });
});

describe("watchRepositoryRefs: stash creation/drop (FR-91)", () => {
  it("fires onChange when a stash is created and again when it is dropped, from a separate process", async () => {
    const dir = await makeRepo();
    await writeFile(dir, "a.txt", "1\n");
    await commit(dir, "first");

    const state = await getRepositoryState(dir);
    let changeCount = 0;
    const watcher = watchRepositoryRefs(
      state.gitDir,
      state.commonGitDir,
      () => {
        changeCount += 1;
      },
      { debounceMs: 150 },
    );
    try {
      const beforeCreate = changeCount;
      await writeFile(dir, "a.txt", "2\n");
      await git(dir, ["stash", "push"]);
      await waitForChangeCount(() => changeCount, beforeCreate + 1, 5000, "stash push");

      const beforeDrop = changeCount;
      await git(dir, ["stash", "drop", "stash@{0}"]);
      await waitForChangeCount(() => changeCount, beforeDrop + 1, 5000, "stash drop");
    } finally {
      watcher.close();
    }
  });
});
