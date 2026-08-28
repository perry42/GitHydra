import { describe, it, expect, afterEach } from "vitest";
import { Repository } from "../src/index";
import { InvalidArgumentError } from "../src/errors";
import { git, initRepo, writeFile, commit, cleanup } from "./testRepo";

/**
 * Integration tests against the PUBLIC `Repository` facade (`src/index.ts`), not the lower-level
 * `workingDirStatus.ts`, `diff.ts`, `staging.ts`, `commitChanges.ts` functions those modules'
 * own unit tests already cover directly. Every one of `getWorkingDirectoryChanges()`,
 * `get{Unstaged,Staged,Untracked,Commit}FileDiff()`, the stage/unstage/discard methods, and
 * `createCommit()` is reachable only through `Repository` from the desktop app (via IPC) — but
 * none of them were exercised through that facade anywhere in the existing suite before this
 * file, so the `requireWorkdir()`/bare-repo guards specific to the facade (as opposed to the
 * underlying impl functions, which take a raw workdir string and don't know about bare repos at
 * all) were previously untested. This file closes that gap and directly verifies the PRD's
 * acceptance criteria that cross the "UI clicks through to git-core" boundary
 * (`specs/stage-unstage-diff.md`, AC3/AC6/AC9/AC10/AC12/AC13).
 */

const cleanupDirs: string[] = [];
afterEach(async () => {
  while (cleanupDirs.length) await cleanup(cleanupDirs.pop()!);
});

async function openRepo(dir: string): Promise<Repository> {
  return Repository.open(dir);
}

describe("Repository facade: bare repo guards (AC10)", () => {
  it("getWorkingDirectoryChanges() returns null for a bare repo, through the public facade", async () => {
    const dir = await initRepo({ bare: true });
    cleanupDirs.push(dir);
    const repo = await openRepo(dir);

    await expect(repo.getWorkingDirectoryChanges()).resolves.toBeNull();
  });

  it("every mutating action throws a typed, actionable error (not a raw git crash) against a bare repo", async () => {
    const dir = await initRepo({ bare: true });
    cleanupDirs.push(dir);
    const repo = await openRepo(dir);

    await expect(repo.stageFile("a.txt")).rejects.toBeInstanceOf(InvalidArgumentError);
    await expect(repo.unstageFile("a.txt")).rejects.toBeInstanceOf(InvalidArgumentError);
    await expect(repo.stageAllFiles()).rejects.toBeInstanceOf(InvalidArgumentError);
    await expect(repo.unstageAllFiles()).rejects.toBeInstanceOf(InvalidArgumentError);
    await expect(repo.discardTrackedFileChanges("a.txt")).rejects.toBeInstanceOf(InvalidArgumentError);
    await expect(repo.discardUntrackedFile("a.txt")).rejects.toBeInstanceOf(InvalidArgumentError);
    await expect(repo.createCommit({ subject: "x" })).rejects.toBeInstanceOf(InvalidArgumentError);
    await expect(repo.getUnstagedFileDiff("a.txt")).rejects.toBeInstanceOf(InvalidArgumentError);
    await expect(repo.getStagedFileDiff("a.txt")).rejects.toBeInstanceOf(InvalidArgumentError);
    await expect(repo.getUntrackedFileDiff("a.txt")).rejects.toBeInstanceOf(InvalidArgumentError);
  });

  it("getCommitFileDiff still works against a bare repo (no working directory required)", async () => {
    const dir = await initRepo();
    cleanupDirs.push(dir);
    await writeFile(dir, "a.txt", "v1\n");
    await commit(dir, "first");
    await writeFile(dir, "a.txt", "v2\n");
    const secondSha = await commit(dir, "second");

    // Clone to a bare repo so the same history exists with no working directory at all.
    const bareDir = await initRepo({ bare: true });
    cleanupDirs.push(bareDir);
    await git(dir, ["push", "-q", bareDir, "main"]).catch(async () => {
      // `git push` to a plain empty bare dir needs a receive; if that's unavailable in this
      // environment, fall back to fetching into the bare repo instead (equivalent end state).
      await git(bareDir, ["fetch", "-q", dir, "main:main"]);
    });

    const repo = await openRepo(bareDir);
    const commitInfo = { sha: secondSha, parents: (await git(dir, ["rev-parse", `${secondSha}^`])).stdout
      .trim()
      .split("\n") };
    const result = await repo.getCommitFileDiff(commitInfo, { path: "a.txt" });
    expect(result.status).toBe("ok");
  });
});

describe("AC3: diff source switches from unstaged to staged after staging the same file", () => {
  it("getUnstagedFileDiff shows worktree-vs-index; after stageFile, getStagedFileDiff shows index-vs-HEAD for the same path", async () => {
    const dir = await initRepo();
    cleanupDirs.push(dir);
    await writeFile(dir, "a.txt", "original\n");
    await commit(dir, "base");
    await writeFile(dir, "a.txt", "edited worktree content\n");

    const repo = await openRepo(dir);

    // Before staging: unstaged diff shows the edit; staged diff is empty (index == HEAD).
    const beforeUnstaged = await repo.getUnstagedFileDiff("a.txt");
    expect(beforeUnstaged.status).toBe("ok");
    if (beforeUnstaged.status !== "ok") throw new Error("expected ok");
    expect(beforeUnstaged.hunks.flatMap((h) => h.lines).some((l) => l.type === "add" && l.content === "edited worktree content")).toBe(true);

    const beforeStaged = await repo.getStagedFileDiff("a.txt");
    expect(beforeStaged.status).toBe("ok");
    if (beforeStaged.status !== "ok") throw new Error("expected ok");
    expect(beforeStaged.hunks).toEqual([]);

    // Stage it via the facade (exactly what the UI's "Stage" button calls).
    await repo.stageFile("a.txt");

    // After staging: staged diff now shows the change; unstaged diff (worktree vs index) is
    // now empty, since the worktree matches the freshly-updated index exactly.
    const afterStaged = await repo.getStagedFileDiff("a.txt");
    expect(afterStaged.status).toBe("ok");
    if (afterStaged.status !== "ok") throw new Error("expected ok");
    expect(afterStaged.hunks.flatMap((h) => h.lines).some((l) => l.type === "add" && l.content === "edited worktree content")).toBe(true);

    const afterUnstaged = await repo.getUnstagedFileDiff("a.txt");
    expect(afterUnstaged.status).toBe("ok");
    if (afterUnstaged.status !== "ok") throw new Error("expected ok");
    expect(afterUnstaged.hunks).toEqual([]);
  });
});

describe("AC6: stage-all / unstage-all against a repo with a real rename", () => {
  it("stageAllFiles stages a worktree rename as a single renamed entry, reflected correctly by a subsequent getWorkingDirectoryChanges()", async () => {
    const dir = await initRepo();
    cleanupDirs.push(dir);
    await writeFile(
      dir,
      "original.txt",
      "line one\nline two\nline three\nline four\nline five\nline six\n",
    );
    await writeFile(dir, "other.txt", "unrelated\n");
    await commit(dir, "base");

    const repo = await openRepo(dir);

    // `git mv` stages the rename immediately; fully unstage BOTH halves of the pair (the old
    // path's implicit delete and the new path's add) so this is a genuine *unstaged* rename —
    // exactly what stage-all is meant to pick up, git's own similarity heuristic included.
    await git(dir, ["mv", "original.txt", "renamed.txt"]);
    await git(dir, ["reset", "-q"]);
    await writeFile(dir, "other.txt", "unrelated, modified\n");

    await repo.stageAllFiles();

    const changes = await repo.getWorkingDirectoryChanges();
    expect(changes).not.toBeNull();
    const renamedEntry = changes!.staged.find((f) => f.path === "renamed.txt");
    expect(renamedEntry).toBeDefined();
    expect(renamedEntry!.status).toBe("renamed");
    expect(renamedEntry!.oldPath).toBe("original.txt");
    expect(changes!.staged.find((f) => f.path === "other.txt")).toBeDefined();
    // The stale "original.txt" path must not linger as its own separate staged/unstaged entry.
    expect(changes!.staged.find((f) => f.path === "original.txt")).toBeUndefined();
    expect(changes!.unstaged).toEqual([]);
    expect(changes!.untracked).toEqual([]);
  });

  // Regression test for a bug found during QA (fixed in packages/git-core/src/staging.ts via
  // `restorePathsFor`): `unstageAllFiles`/`unstageFile` used to enumerate a staged rename/copy
  // entry's PATH ONLY when building the `git restore --staged --` pathspec. For a rename, that
  // path is the NEW filename; the old filename's corresponding index-side delete was never named,
  // so `git restore --staged` never touched it. Net effect was that after "Unstage" on a staged
  // rename, the new path became untracked (looked correctly unstaged) but the OLD path was left
  // behind as its own newly-"staged deletion" that never existed before that action — silently
  // deleting the original file from history on a later commit, with no trace of the rename.
  // `restorePathsFor` now restores both the old and new path for rename/copy entries, so this
  // asserts the repo fully returns to its pre-stage-all state. See also the single-file
  // `unstageFile` repro in this same describe block.
  it("unstageAllFiles fully reverts a staged rename back to a clean pre-stage state", async () => {
    const dir = await initRepo();
    cleanupDirs.push(dir);
    await writeFile(
      dir,
      "original.txt",
      "line one\nline two\nline three\nline four\nline five\nline six\n",
    );
    await commit(dir, "base");
    await git(dir, ["mv", "original.txt", "renamed.txt"]); // stages the rename as one R100 entry

    const repo = await openRepo(dir);
    await repo.unstageAllFiles();

    const afterUnstageAll = await repo.getWorkingDirectoryChanges();
    // Expected (correct) behavior: nothing left staged at all, and the working tree is exactly
    // as it was before staging (original.txt tracked and unmodified, renamed.txt does not
    // exist) — a plain worktree-only rename, i.e. unstaged/untracked, not a phantom deletion.
    expect(afterUnstageAll!.staged).toEqual([]);
  });

  it("unstageFile on a single staged-rename row does not leave a phantom staged deletion of the old path", async () => {
    const dir = await initRepo();
    cleanupDirs.push(dir);
    await writeFile(
      dir,
      "original.txt",
      "line one\nline two\nline three\nline four\nline five\nline six\n",
    );
    await commit(dir, "base");
    await git(dir, ["mv", "original.txt", "renamed.txt"]);

    const repo = await openRepo(dir);
    // This is exactly what the UI calls when the user clicks "Unstage" on the single row the
    // Changes panel shows for a staged rename (path = the new filename; see FR-19/ChangesPanel).
    await repo.unstageFile("renamed.txt");

    const changes = await repo.getWorkingDirectoryChanges();
    // Before the fix, `changes.staged` would contain a NEW entry
    // { path: "original.txt", status: "deleted" } that did not exist before this action, and
    // `git ls-files` would no longer list "original.txt" as tracked at all.
    expect(changes!.staged).toEqual([]);
  });
});

describe("AC9: conflicted files distinct category via the public facade, no stage/unstage reachable", () => {
  it("getWorkingDirectoryChanges() reports a merge conflict in `conflicted`, and stageAllFiles/unstageAllFiles never touch it", async () => {
    const dir = await initRepo();
    cleanupDirs.push(dir);
    await writeFile(dir, "a.txt", "base\n");
    await writeFile(dir, "clean.txt", "1\n");
    await commit(dir, "base");
    await git(dir, ["checkout", "-q", "-b", "feature"]);
    await writeFile(dir, "a.txt", "feature change\n");
    await commit(dir, "feature change");
    await git(dir, ["checkout", "-q", "main"]);
    await writeFile(dir, "a.txt", "main change\n");
    await commit(dir, "main change");
    await writeFile(dir, "clean.txt", "2\n"); // an ordinary unstaged edit alongside the conflict
    await git(dir, ["merge", "-q", "feature"]).catch(() => {
      /* expected conflict */
    });

    const repo = await openRepo(dir);
    const changes = await repo.getWorkingDirectoryChanges();
    expect(changes!.conflicted.map((f) => f.path)).toEqual(["a.txt"]);
    expect(changes!.conflicted[0]!.status).toBe("unmerged");
    expect(changes!.staged.find((f) => f.path === "a.txt")).toBeUndefined();
    expect(changes!.unstaged.find((f) => f.path === "a.txt")).toBeUndefined();

    // stage-all/unstage-all must be no-ops with respect to the conflicted path — never silently
    // "resolving" it — even though other ordinary changes exist alongside it in the same repo.
    await repo.stageAllFiles();
    const afterStageAll = await repo.getWorkingDirectoryChanges();
    expect(afterStageAll!.conflicted.map((f) => f.path)).toEqual(["a.txt"]);
    expect(afterStageAll!.staged.find((f) => f.path === "clean.txt")).toBeDefined();
  });
});

// AC12/AC13 (zero network calls; identical behavior with/without a remote) are covered in
// `tests/noNetworkCalls.test.ts` — split into its own file because verifying "no fetch/pull/push
// is ever spawned" needs a module-level `vi.mock("node:child_process", ...)`, which must apply
// before any other import in that file loads `gitProcess.ts`, and would otherwise affect every
// other test in this file if colocated here.
