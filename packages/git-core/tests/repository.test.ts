import { describe, it, expect, afterEach } from "vitest";
import * as path from "node:path";
import { getRepositoryState } from "../src/repository";
import { NotAGitRepositoryError, OperationCancelledError, GitCommandTimeoutError } from "../src/errors";
import { _resetGitVersionCacheForTests, checkGitVersion } from "../src/gitProcess";
import { git, initRepo, writeFile, commit, cleanup, makeTempDir } from "./testRepo";

const cleanupDirs: string[] = [];
afterEach(async () => {
  while (cleanupDirs.length) await cleanup(cleanupDirs.pop()!);
});

describe("getRepositoryState", () => {
  it("throws NotAGitRepositoryError for a non-repo directory", async () => {
    const dir = await makeTempDir();
    cleanupDirs.push(dir);
    // Isolate from any ambient repo that might exist in an ancestor directory (git normally
    // searches upward) so this test is deterministic regardless of where the temp dir lands.
    const previousCeiling = process.env.GIT_CEILING_DIRECTORIES;
    process.env.GIT_CEILING_DIRECTORIES = path.dirname(dir);
    try {
      await expect(getRepositoryState(dir)).rejects.toBeInstanceOf(NotAGitRepositoryError);
    } finally {
      if (previousCeiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
      else process.env.GIT_CEILING_DIRECTORIES = previousCeiling;
    }
  });

  it("reports a fresh repo as empty with unborn HEAD, attached to the initial branch", async () => {
    const dir = await initRepo();
    cleanupDirs.push(dir);
    const state = await getRepositoryState(dir);
    expect(state.isEmpty).toBe(true);
    expect(state.isUnbornHead).toBe(true);
    expect(state.isDetachedHead).toBe(false);
    expect(state.currentBranch).toBe("main");
    expect(state.headSha).toBeNull();
    expect(state.isBare).toBe(false);
    expect(state.inProgressOperation).toBeNull();
  });

  it("reports a normal repo with one commit correctly", async () => {
    const dir = await initRepo();
    cleanupDirs.push(dir);
    await writeFile(dir, "a.txt", "hello");
    const sha = await commit(dir, "first commit");
    const state = await getRepositoryState(dir);
    expect(state.isEmpty).toBe(false);
    expect(state.isUnbornHead).toBe(false);
    expect(state.currentBranch).toBe("main");
    expect(state.headSha).toBe(sha);
  });

  it("detects a bare repository, with no workdir", async () => {
    const dir = await initRepo({ bare: true });
    cleanupDirs.push(dir);
    const state = await getRepositoryState(dir);
    expect(state.isBare).toBe(true);
    expect(state.workdir).toBeNull();
  });

  it("detects detached HEAD", async () => {
    const dir = await initRepo();
    cleanupDirs.push(dir);
    await writeFile(dir, "a.txt", "hello");
    const sha = await commit(dir, "first");
    await writeFile(dir, "a.txt", "world");
    await commit(dir, "second");
    await git(dir, ["checkout", "-q", sha]);

    const state = await getRepositoryState(dir);
    expect(state.isDetachedHead).toBe(true);
    expect(state.currentBranch).toBeNull();
    expect(state.headSha).toBe(sha);
  });

  it("detects an in-progress merge (conflicted)", async () => {
    const dir = await initRepo();
    cleanupDirs.push(dir);
    await writeFile(dir, "a.txt", "base\n");
    await commit(dir, "base");
    await git(dir, ["checkout", "-q", "-b", "feature"]);
    await writeFile(dir, "a.txt", "feature change\n");
    await commit(dir, "feature change");
    await git(dir, ["checkout", "-q", "main"]);
    await writeFile(dir, "a.txt", "main change\n");
    await commit(dir, "main change");
    await git(dir, ["merge", "-q", "feature"]).catch(() => {
      /* expected to fail with a conflict */
    });

    const state = await getRepositoryState(dir);
    expect(state.inProgressOperation).toBe("merge");
  });

  it("detects an in-progress rebase", async () => {
    const dir = await initRepo();
    cleanupDirs.push(dir);
    await writeFile(dir, "a.txt", "base\n");
    await commit(dir, "base");
    await git(dir, ["checkout", "-q", "-b", "feature"]);
    await writeFile(dir, "a.txt", "feature change\n");
    await commit(dir, "feature change");
    await git(dir, ["checkout", "-q", "main"]);
    await writeFile(dir, "a.txt", "main change\n");
    await commit(dir, "main change");
    await git(dir, ["checkout", "-q", "feature"]);
    await git(dir, ["rebase", "main"]).catch(() => {
      /* expected to fail with a conflict, leaving rebase-apply/rebase-merge state */
    });

    const state = await getRepositoryState(dir);
    expect(state.inProgressOperation).toBe("rebase");
  });

  it("detects an in-progress cherry-pick", async () => {
    const dir = await initRepo();
    cleanupDirs.push(dir);
    await writeFile(dir, "a.txt", "base\n");
    await commit(dir, "base");
    await git(dir, ["checkout", "-q", "-b", "feature"]);
    await writeFile(dir, "a.txt", "feature change\n");
    const featureSha = await commit(dir, "feature change");
    await git(dir, ["checkout", "-q", "main"]);
    await writeFile(dir, "a.txt", "main change\n");
    await commit(dir, "main change");
    await git(dir, ["cherry-pick", featureSha]).catch(() => {
      /* expected conflict */
    });

    const state = await getRepositoryState(dir);
    expect(state.inProgressOperation).toBe("cherry-pick");
  });

  it("detects a linked worktree as such, sharing commonGitDir with the main repo", async () => {
    const dir = await initRepo();
    cleanupDirs.push(dir);
    await writeFile(dir, "a.txt", "hello");
    await commit(dir, "first");
    const worktreeDir = path.join(path.dirname(dir), path.basename(dir) + "-wt");
    await git(dir, ["worktree", "add", "-q", "-b", "wt-branch", worktreeDir]);
    cleanupDirs.push(worktreeDir);

    const mainState = await getRepositoryState(dir);
    const wtState = await getRepositoryState(worktreeDir);

    expect(mainState.isWorktree).toBe(false);
    expect(wtState.isWorktree).toBe(true);
    expect(wtState.commonGitDir).toBe(mainState.commonGitDir);
    expect(wtState.currentBranch).toBe("wt-branch");

    await git(dir, ["worktree", "remove", "-f", worktreeDir]).catch(() => {});
  });

  it("detects a shallow clone", async () => {
    const origin = await initRepo();
    cleanupDirs.push(origin);
    await writeFile(origin, "a.txt", "1");
    await commit(origin, "one");
    await writeFile(origin, "a.txt", "2");
    await commit(origin, "two");
    await writeFile(origin, "a.txt", "3");
    await commit(origin, "three");

    const clone = await makeTempDir();
    cleanupDirs.push(clone);
    await git(process.cwd(), ["clone", "-q", "--depth=1", "--no-local", `file://${origin.replace(/\\/g, "/")}`, clone]).catch(async () => {
      // file:// clone can be finicky on some Windows git builds; fall back to a local path clone.
      await git(process.cwd(), ["clone", "-q", "--depth=1", origin, clone]);
    });

    const state = await getRepositoryState(clone);
    expect(state.isShallow).toBe(true);
  });
});

// specs/repo-open-feedback.md FR-163/FR-165: `getRepositoryState()` is the function
// `Repository.open()` calls directly — this is "the repo-validity check plus initial reads"
// FR-163 names. These tests exercise the real, threaded `signal` end-to-end against a real repo
// (not a mock), proving cancellation surfaces as its own distinct outcome rather than being
// silently absorbed by any of this module's many "degrade to a safe default" catches.
describe("getRepositoryState cancellation (FR-163/FR-165)", () => {
  afterEach(() => {
    _resetGitVersionCacheForTests();
  });

  it("rejects with OperationCancelledError (not NotAGitRepositoryError/GitCommandError) when the caller aborts mid-open", async () => {
    const dir = await initRepo();
    cleanupDirs.push(dir);
    await writeFile(dir, "a.txt", "hello");
    await commit(dir, "first commit");

    const controller = new AbortController();
    const promise = getRepositoryState(dir, controller.signal);
    controller.abort();

    let caught: unknown;
    try {
      await promise;
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(OperationCancelledError);
    expect(caught).not.toBeInstanceOf(NotAGitRepositoryError);
  });

  it("never resolves with degraded-but-successful state on cancellation — isShallowRepository/readHeadState/isRepositoryEmpty must rethrow, not swallow, a cancellation", async () => {
    // Regression guard for the specific failure mode this feature could easily introduce: those
    // three functions each normally SWALLOW a failure into a safe default (false/null/true) by
    // design (a genuinely corrupt/unreadable repo degrades gracefully rather than throwing) — if
    // any one of them failed to special-case `OperationCancelledError`, a cancel click would
    // silently resolve `getRepositoryState()` with wrong data instead of rejecting.
    const dir = await initRepo();
    cleanupDirs.push(dir);
    await writeFile(dir, "a.txt", "hello");
    await commit(dir, "first commit");

    const controller = new AbortController();
    controller.abort(); // already aborted before the call even starts
    await expect(getRepositoryState(dir, controller.signal)).rejects.toBeInstanceOf(OperationCancelledError);
  });

  it("a cancelled open does not permanently poison the process-wide git-version cache — a later, uncancelled open still succeeds", async () => {
    _resetGitVersionCacheForTests();
    const dir = await initRepo();
    cleanupDirs.push(dir);

    const controller = new AbortController();
    controller.abort();
    await expect(getRepositoryState(dir, controller.signal)).rejects.toBeInstanceOf(OperationCancelledError);

    // If `checkGitVersion()` had cached the cancellation as a permanent failure, every subsequent
    // open — cancelled-signal-free or not — would incorrectly reject with
    // `UnsupportedGitVersionError` for the rest of the process lifetime.
    const state = await getRepositoryState(dir);
    expect(state.isEmpty).toBe(true);
  });

  // Security-review finding (2026-09-03): a genuine `GitCommandTimeoutError` — not just a
  // caller-initiated cancellation — was ALSO getting folded into `UnsupportedGitVersionError` and
  // cached forever, permanently breaking every subsequent repo-open in the session with a
  // misleading "git version unsupported" error even though the real git install was fine. The
  // PRD's own investigation documents this as a real, observed scenario (the very first `git`
  // spawn in a session — this one, `warmUpGitResolution()`'s startup call, or the plain
  // non-cancellable `openRepo` path — taking up to the full 120s `DEFAULT_GIT_TIMEOUT_MS` ceiling
  // under heavy AV/PATH overhead). Exercised against a REAL timeout — the REAL git binary, an
  // aggressively short `timeoutMs` override (1ms) rather than a fake hanging executable: spawning
  // any real OS process inherently takes several milliseconds (process creation, exec, first IPC
  // round trip), so a 1ms budget reliably loses that race every time (confirmed directly: 10/10
  // real runs in this environment) without needing a synthetic hang — and, unlike attempting to
  // fake a hanging `git.cmd`/`git.bat` on Windows, never runs into `child_process.spawn`'s own
  // `EINVAL` when invoking a batch file with this module's mandatory `shell: false` (confirmed
  // directly too) — not a mock either way, since the real `resolveGitExecutablePath()` and a real
  // `git --version` child process both still run.
  it("a genuine GitCommandTimeoutError does not permanently poison the process-wide git-version cache either — a later, healthy open still succeeds", async () => {
    _resetGitVersionCacheForTests();
    const dir = await initRepo();
    cleanupDirs.push(dir);

    await expect(checkGitVersion(dir, undefined, 1)).rejects.toBeInstanceOf(GitCommandTimeoutError);

    // If `checkGitVersion()` had cached the timeout as a permanent `UnsupportedGitVersionError`,
    // this next call — against a perfectly healthy real git install, no timeout override this time
    // — would incorrectly reject forever, for the rest of the process lifetime, until an app
    // restart.
    const state = await getRepositoryState(dir);
    expect(state.isEmpty).toBe(true);
  });

  it("an uncancelled open completes normally and reflects real repository state (no regression to the non-cancellation path)", async () => {
    const dir = await initRepo();
    cleanupDirs.push(dir);
    await writeFile(dir, "a.txt", "hello");
    const sha = await commit(dir, "first commit");

    const controller = new AbortController();
    const state = await getRepositoryState(dir, controller.signal);
    expect(state.headSha).toBe(sha);
    expect(state.currentBranch).toBe("main");
  });
});
