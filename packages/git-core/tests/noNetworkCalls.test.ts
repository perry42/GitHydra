// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect, afterEach, vi } from "vitest";

/**
 * AC12/AC13 (`specs/stage-unstage-diff.md`): zero outbound network requests during a full
 * stage -> view diff -> unstage -> commit flow, and identical behavior whether or not a remote
 * is configured. FR-26 makes this a static property of the code (none of `staging.ts`,
 * `diff.ts`, `commitChanges.ts`, `workingDirStatus.ts` ever pass "fetch"/"pull"/"push" to git),
 * but this file verifies it black-box, by intercepting every `child_process.spawn` call this
 * process makes and asserting none of them is a network subcommand — so a future change that
 * accidentally introduces one would fail a test, not just a code-review read-through.
 *
 * Deliberately its own file: mocking `node:child_process` at module scope must be in place
 * before `gitProcess.ts` (which imports `spawn` from it) is first loaded, and doing that in a
 * file shared with other describe blocks would affect (and slow down, and risk flaking) every
 * other test in that file.
 */

const spawnCalls: { command: string; args: readonly string[] }[] = [];

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: (command: string, args: readonly string[], ...rest: unknown[]) => {
      spawnCalls.push({ command, args });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (actual.spawn as any)(command, args, ...rest);
    },
  };
});

// Imports that transitively load gitProcess.ts must come after vi.mock (hoisted by vitest to the
// top of the file automatically, but written after here for readability/clarity of intent).
const { Repository, warmUpGitResolution, OperationCancelledError } = await import("../src/index");
const { pull } = await import("../src/pull");
const { push } = await import("../src/push");
const { clone } = await import("../src/clone");
const { GitCommandError } = await import("../src/errors");
const { classifyGitNetworkError } = await import("../src/networkErrorClassification");
const { git, initRepo, writeFile, commit, cleanup, makeTempDir } = await import("./testRepo");
const path = await import("node:path");

const cleanupDirs: string[] = [];
afterEach(async () => {
  spawnCalls.length = 0;
  while (cleanupDirs.length) await cleanup(cleanupDirs.pop()!);
});

async function runFullFlow(repo: InstanceType<typeof Repository>, dir: string) {
  await writeFile(dir, "flow.txt", "hello\n");
  await repo.stageFile("flow.txt");
  const staged = await repo.getStagedFileDiff("flow.txt");
  expect(staged.status).toBe("ok");
  await repo.unstageFile("flow.txt");
  await repo.stageFile("flow.txt"); // re-stage so there's something to commit
  const result = await repo.createCommit({ subject: "Add flow.txt via full flow test" });
  const changes = await repo.getWorkingDirectoryChanges();
  return { finalStagedCount: changes!.staged.length, commitSha: result.sha };
}

/**
 * Find the actual git SUBCOMMAND token in an argv array — the first element that isn't `-c` or
 * a value bound to a preceding `-c` (the only global flag this codebase's `gitProcess.ts` ever
 * prepends, via `withFsmonitorNeutralized()`). Deliberately NOT a blanket `args.includes(...)`
 * check: `git stash push`'s own argv literally contains the token `"push"` as its SUB-subcommand
 * (stash.ts, FR-84), which a naive `includes("push")` check would misidentify as a `git push`
 * network call — a real false positive this test suite hit once `stash.ts` landed. Checking only
 * the actual subcommand position (`args[0]` after skipping any `-c <value>` pair) avoids that.
 */
function gitSubcommand(args: readonly string[]): string | undefined {
  let i = 0;
  while (i < args.length) {
    if (args[i] === "-c") {
      i += 2; // skip the flag and its bound value.
      continue;
    }
    return args[i];
  }
  return undefined;
}

function assertNoNetworkSubcommand() {
  for (const call of spawnCalls) {
    // Only inspect calls to a `git`-named executable (this test's own fixture helper, `testRepo`'s
    // `git()`, also spawns "git" directly for setup, and should be held to the same bar).
    if (!/git(\.exe)?$/i.test(call.command)) continue;
    const subcommand = gitSubcommand(call.args);
    expect(subcommand).not.toBe("fetch");
    expect(subcommand).not.toBe("pull");
    expect(subcommand).not.toBe("push");
  }
}

describe("AC12: zero network calls during a full stage/diff/unstage/commit flow", () => {
  it("spawns no fetch/pull/push git subcommand, even with a remote configured pointing at an unreachable host", async () => {
    const dir = await initRepo();
    cleanupDirs.push(dir);
    await writeFile(dir, "base.txt", "1\n");
    await commit(dir, "base");
    // A remote pointing at a host that cannot possibly be reached: if any code path here DID
    // spawn a network git command, this test would hang/fail loudly rather than silently
    // succeeding against a real reachable remote.
    await git(dir, ["remote", "add", "origin", "https://198.51.100.1.invalid/nonexistent.git"]);

    const repo = await Repository.open(dir);
    await runFullFlow(repo, dir);

    expect(spawnCalls.length).toBeGreaterThan(0); // sanity: the spy actually captured calls
    assertNoNetworkSubcommand();
  });
});

describe("AC13: identical behavior regardless of remote host presence", () => {
  it("produces the same outcome (real commit, clean index afterward) on a repo with no remote vs one with a fake local remote", async () => {
    const noRemoteDir = await initRepo();
    cleanupDirs.push(noRemoteDir);
    await writeFile(noRemoteDir, "base.txt", "1\n");
    await commit(noRemoteDir, "base");

    const withRemoteDir = await initRepo();
    cleanupDirs.push(withRemoteDir);
    await writeFile(withRemoteDir, "base.txt", "1\n");
    await commit(withRemoteDir, "base");
    const fakeRemoteDir = await initRepo({ bare: true });
    cleanupDirs.push(fakeRemoteDir);
    await git(withRemoteDir, ["remote", "add", "origin", fakeRemoteDir]);

    const repoA = await Repository.open(noRemoteDir);
    const repoB = await Repository.open(withRemoteDir);

    const resultA = await runFullFlow(repoA, noRemoteDir);
    assertNoNetworkSubcommand();
    spawnCalls.length = 0;
    const resultB = await runFullFlow(repoB, withRemoteDir);
    assertNoNetworkSubcommand();

    // Same shape of outcome regardless of remote presence: a real commit was made, and the
    // index is clean (nothing staged) afterward in both cases — host/remote had zero effect.
    expect(resultA.finalStagedCount).toBe(0);
    expect(resultB.finalStagedCount).toBe(0);
    expect(resultA.commitSha).toMatch(/^[0-9a-f]{40}$/);
    expect(resultB.commitSha).toMatch(/^[0-9a-f]{40}$/);
  });
});

describe("AC14 (merge-rebase-conflict-resolution.md): zero network calls across a full conflict-resolution flow", () => {
  async function setUpMergeConflict(): Promise<string> {
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
    // A remote pointing at an unreachable host, same as AC12 above — any accidental network
    // call during detect/view/resolve/continue would hang/fail loudly here.
    await git(dir, ["remote", "add", "origin", "https://198.51.100.1.invalid/nonexistent.git"]);
    await git(dir, ["merge", "-q", "feature"]).catch(() => {});
    return dir;
  }

  it("spawns no fetch/pull/push subcommand across detect -> view conflict -> resolve -> continue", async () => {
    const dir = await setUpMergeConflict();
    const repo = await Repository.open(dir);

    const state = repo.getState();
    expect(state.inProgressOperation).toBe("merge");
    const conflicted = await repo.getConflictedFiles();
    expect(conflicted).toHaveLength(1);
    const diff = await repo.getConflictFileDiff(conflicted![0]!);
    expect(diff.oursToTheirs?.status).toBe("ok");
    repo.getConflictSideLabels();

    await repo.scanConflictMarkers("a.txt");
    await repo.acceptConflictSide("a.txt", "theirs");
    await repo.continueInProgressOperation();
    await repo.refreshState();
    expect(repo.getState().inProgressOperation).toBeNull();

    expect(spawnCalls.length).toBeGreaterThan(0);
    assertNoNetworkSubcommand();
  });

  it("spawns no fetch/pull/push subcommand across a full detect -> abort flow", async () => {
    const dir = await setUpMergeConflict();
    const repo = await Repository.open(dir);
    expect(repo.getState().inProgressOperation).toBe("merge");

    await repo.abortInProgressOperation();
    await repo.refreshState();
    expect(repo.getState().inProgressOperation).toBeNull();

    expect(spawnCalls.length).toBeGreaterThan(0);
    assertNoNetworkSubcommand();
  });
});

describe("AC17 (specs/stash.md): zero network calls across a full create -> list -> preview -> apply/pop -> drop flow", () => {
  it("spawns no fetch/pull/push subcommand across create -> list -> getStashDiff -> apply -> pop -> drop, with a remote configured pointing at an unreachable host", async () => {
    const dir = await initRepo();
    cleanupDirs.push(dir);
    await writeFile(dir, "a.txt", "1\n");
    await commit(dir, "base");
    await git(dir, ["remote", "add", "origin", "https://198.51.100.1.invalid/nonexistent.git"]);

    const repo = await Repository.open(dir);

    await writeFile(dir, "a.txt", "2\n");
    const created = await repo.createStash({ message: "network-free stash" });
    expect(created.sha).toMatch(/^[0-9a-f]{40}$/);

    const stashes = await repo.listStashes();
    expect(stashes).toHaveLength(1);

    const diff = await repo.getStashDiff(0);
    expect(diff!.files).toHaveLength(1);

    const applyOutcome = await repo.applyStash(0);
    expect(applyOutcome.status).toBe("applied");
    // Revert the just-applied change (a plain, local, non-network restore) so the next stash
    // operation starts from a clean working tree rather than tripping git's unrelated
    // would-be-overwritten refusal for re-applying the same stash on top of itself.
    await repo.discardTrackedFileChanges("a.txt");

    const popOutcome = await repo.popStash(0);
    expect(popOutcome.status).toBe("applied");

    await writeFile(dir, "a.txt", "3\n");
    await repo.createStash({ message: "second stash" });
    await repo.dropStash(0);
    expect(await repo.listStashes()).toHaveLength(0);

    expect(spawnCalls.length).toBeGreaterThan(0);
    assertNoNetworkSubcommand();
  });
});

describe("AC10 (specs/amend-last-commit.md): zero network calls amending the last commit, regardless of configured remote host", () => {
  /** Exercises `amendCommit` for a single repo, asserting a real amended commit results — a
   * no-op assertion would let this test pass vacuously without ever actually spawning the
   * git-core calls AC10 is about. */
  async function runAmendFlow(repo: InstanceType<typeof Repository>, dir: string): Promise<void> {
    await writeFile(dir, "b.txt", "new file\n");
    await repo.stageFile("b.txt");
    const result = await repo.amendCommit({ subject: "base, amended" });
    expect(result.sha).toMatch(/^[0-9a-f]{40}$/);
  }

  it(
    "spawns no fetch/pull/push subcommand amending HEAD's message and folding in staged content, with remotes configured against GitHub, GitLab, Bitbucket, and a self-hosted host — none of them reachable",
    async () => {
      const dir = await initRepo();
      cleanupDirs.push(dir);
      await writeFile(dir, "a.txt", "1\n");
      await commit(dir, "base");
      // FR-153: network behavior is a static property of the code (amendCommit never touches a
      // network client at all — only local `commit --amend`/index plumbing), so — mirroring how
      // AC8's image-diff-preview matrix above verifies this by configuring one remote per named
      // host FROM the spec's own AC10 wording, each pointed at a non-routable address — any
      // accidental network attempt would hang/fail loudly rather than silently succeeding.
      await git(dir, ["remote", "add", "origin", "https://github.com.invalid.198.51.100.1/o/r.git"]);
      await git(dir, ["remote", "add", "gitlab", "https://gitlab.com.invalid.198.51.100.1/o/r.git"]);
      await git(dir, ["remote", "add", "bitbucket", "https://bitbucket.org.invalid.198.51.100.1/o/r.git"]);
      await git(dir, ["remote", "add", "selfhosted", "https://git.example.invalid.198.51.100.1/o/r.git"]);

      const repo = await Repository.open(dir);
      await runAmendFlow(repo, dir);

      expect(spawnCalls.length).toBeGreaterThan(0); // sanity: the spy actually captured calls
      assertNoNetworkSubcommand();
    },
    15000,
  );

  it("spawns no fetch/pull/push subcommand amending the same way on a purely local repo with no remote at all", async () => {
    const dir = await initRepo();
    cleanupDirs.push(dir);
    await writeFile(dir, "a.txt", "1\n");
    await commit(dir, "base");

    const repo = await Repository.open(dir);
    await runAmendFlow(repo, dir);

    expect(spawnCalls.length).toBeGreaterThan(0);
    assertNoNetworkSubcommand();
  });
});

describe("AC15 (specs/cherry-pick.md): zero network calls across single/multi-commit/conflict/empty-result cherry-pick flows", () => {
  it("spawns no fetch/pull/push subcommand across a clean single-commit cherry-pick, with a remote configured pointing at an unreachable host", async () => {
    const dir = await initRepo();
    cleanupDirs.push(dir);
    await writeFile(dir, "a.txt", "base\n");
    await commit(dir, "base");
    await git(dir, ["checkout", "-q", "-b", "feature"]);
    await writeFile(dir, "a.txt", "feature change\n");
    const featureSha = await commit(dir, "feature change");
    await git(dir, ["checkout", "-q", "main"]);
    await git(dir, ["remote", "add", "origin", "https://198.51.100.1.invalid/nonexistent.git"]);

    const repo = await Repository.open(dir);
    await repo.cherryPick([featureSha]);
    await repo.refreshState();
    expect(repo.getState().inProgressOperation).toBeNull();

    expect(spawnCalls.length).toBeGreaterThan(0);
    assertNoNetworkSubcommand();
  });

  it("spawns no fetch/pull/push subcommand across a multi-commit cherry-pick that pauses on conflict, then Continue", async () => {
    const dir = await initRepo();
    cleanupDirs.push(dir);
    await writeFile(dir, "a.txt", "base-a\n");
    await writeFile(dir, "b.txt", "base-b\n");
    await commit(dir, "base");
    await git(dir, ["checkout", "-q", "-b", "feature"]);
    await writeFile(dir, "a.txt", "feature-a\n");
    const f1 = await commit(dir, "f1: change a.txt");
    await writeFile(dir, "b.txt", "feature-b\n");
    const f2 = await commit(dir, "f2: change b.txt");
    await git(dir, ["checkout", "-q", "main"]);
    await writeFile(dir, "b.txt", "main-b\n");
    await commit(dir, "m1: change b.txt on main");
    await git(dir, ["remote", "add", "origin", "https://198.51.100.1.invalid/nonexistent.git"]);

    const repo = await Repository.open(dir);
    await expect(repo.cherryPick([f1, f2])).rejects.toThrow();
    await repo.refreshState();
    expect(repo.getState().inProgressOperation).toBe("cherry-pick");

    await writeFile(dir, "b.txt", "resolved-b\n");
    await repo.markConflictResolved("b.txt");
    await repo.continueInProgressOperation();
    await repo.refreshState();
    expect(repo.getState().inProgressOperation).toBeNull();

    expect(spawnCalls.length).toBeGreaterThan(0);
    assertNoNetworkSubcommand();
  });

  it("spawns no fetch/pull/push subcommand across an empty-result cherry-pick pause resolved via Skip, then Commit-empty", async () => {
    const dir = await initRepo();
    cleanupDirs.push(dir);
    await writeFile(dir, "a.txt", "base-a\n");
    await commit(dir, "base");
    await git(dir, ["checkout", "-q", "-b", "feature"]);
    await writeFile(dir, "a.txt", "feature-a\n");
    const f1 = await commit(dir, "f1: change a.txt");
    await git(dir, ["checkout", "-q", "main"]);
    await git(dir, ["remote", "add", "origin", "https://198.51.100.1.invalid/nonexistent.git"]);

    const repo = await Repository.open(dir);
    await repo.cherryPick([f1]);
    // Re-picking the same already-applied commit is a genuine empty-result pause.
    await expect(repo.cherryPick([f1])).rejects.toThrow();
    await repo.refreshState();
    let detail = repo.getState().inProgressOperationDetail;
    if (detail?.kind !== "cherry-pick") throw new Error("expected cherry-pick detail");
    expect(detail.isEmptyResult).toBe(true);

    await repo.skipCherryPickCommit();
    await repo.refreshState();
    expect(repo.getState().inProgressOperation).toBeNull();

    // Repeat once more to exercise commitEmptyCherryPick() too.
    await expect(repo.cherryPick([f1])).rejects.toThrow();
    await repo.refreshState();
    detail = repo.getState().inProgressOperationDetail;
    if (detail?.kind !== "cherry-pick") throw new Error("expected cherry-pick detail");
    expect(detail.isEmptyResult).toBe(true);
    await repo.commitEmptyCherryPick();
    await repo.refreshState();
    expect(repo.getState().inProgressOperation).toBeNull();

    expect(spawnCalls.length).toBeGreaterThan(0);
    assertNoNetworkSubcommand();
  });
});

describe("AC8 (specs/image-diff-preview.md): zero network calls previewing image diffs, regardless of configured remote host", () => {
  /** Real (if tiny) PNG-shaped bytes — mirrors `imageDiff.test.ts`'s own fixture helper, since
   * this file intentionally does not import from that test file (each `noNetworkCalls` describe
   * block stays self-contained, per this file's own module-scope-mock doc comment). */
  function pngBytes(marker: number): Buffer {
    return Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, marker]);
  }

  async function writeBinaryFile(dir: string, relPath: string, data: Buffer): Promise<void> {
    const fs = await import("node:fs/promises");
    await fs.writeFile(`${dir}/${relPath}`, data);
  }

  /** Exercises all four FR-142 methods (unstaged/staged/untracked/commit) for a single repo,
   * asserting each returns real image content — a no-op assertion would let this test pass
   * vacuously without ever actually spawning the git-core calls AC8 is about. */
  async function runImageDiffFlow(repo: InstanceType<typeof Repository>, dir: string): Promise<void> {
    await writeBinaryFile(dir, "a.png", pngBytes(1));
    const baseSha = await commit(dir, "base png");
    await writeBinaryFile(dir, "a.png", pngBytes(2));
    await git(dir, ["add", "a.png"]);
    await writeBinaryFile(dir, "a.png", pngBytes(3));
    await writeBinaryFile(dir, "untracked.jpg", pngBytes(4));

    const unstaged = await repo.getUnstagedImageDiff("a.png");
    expect(unstaged.status).toBe("ok");
    const staged = await repo.getStagedImageDiff("a.png");
    expect(staged.status).toBe("ok");
    const untracked = await repo.getUntrackedImageDiff("untracked.jpg");
    expect(untracked.status).toBe("ok");
    const commitDiff = await repo.getCommitImageDiff({ sha: baseSha, parents: [] }, { path: "a.png" });
    expect(commitDiff.status).toBe("ok");
  }

  it(
    "spawns no fetch/pull/push subcommand across unstaged/staged/untracked/commit image-diff reads, with remotes configured against GitHub, GitLab, Bitbucket, and a self-hosted host — none of them reachable",
    async () => {
      const dir = await initRepo();
      cleanupDirs.push(dir);
      // FR-143: network behavior is a static property of the code (this module never touches a
      // network client at all — only `cat-file`/`fs.readFile`), so — mirroring how AC13 above
      // verifies "identical behavior regardless of remote host" by trying more than one shape,
      // not by literally reaching real GitHub/GitLab/Bitbucket servers (which would defeat the
      // whole point of an offline-safe test) — this configures one remote per named host FROM
      // the spec's own AC8 wording, each pointed at a non-routable address so any accidental
      // network attempt would hang/fail loudly rather than silently succeeding.
      await git(dir, ["remote", "add", "origin", "https://github.com.invalid.198.51.100.1/o/r.git"]);
      await git(dir, ["remote", "add", "gitlab", "https://gitlab.com.invalid.198.51.100.1/o/r.git"]);
      await git(dir, ["remote", "add", "bitbucket", "https://bitbucket.org.invalid.198.51.100.1/o/r.git"]);
      await git(dir, ["remote", "add", "selfhosted", "https://git.example.invalid.198.51.100.1/o/r.git"]);

      const repo = await Repository.open(dir);
      await runImageDiffFlow(repo, dir);

      expect(spawnCalls.length).toBeGreaterThan(0); // sanity: the spy actually captured calls
      assertNoNetworkSubcommand();
    },
    15000,
  );

  it("spawns no fetch/pull/push subcommand across the same flow on a purely local repo with no remote at all", async () => {
    const dir = await initRepo();
    cleanupDirs.push(dir);

    const repo = await Repository.open(dir);
    await runImageDiffFlow(repo, dir);

    expect(spawnCalls.length).toBeGreaterThan(0);
    assertNoNetworkSubcommand();
  });
});

// specs/repo-open-feedback.md AC8: "Zero outbound network requests introduced by this feature —
// canceling/timing a local process spawn has no network surface, consistent with every prior
// spec's no-network guarantee." Named distinctly from the "AC8 (specs/image-diff-preview.md)"
// block above — AC numbers are per-spec, not globally unique across this file's describe blocks.
// FR-162's `warmUpGitResolution()` only ever runs `git --version`; FR-163's cancellable
// `Repository.open({ signal })` only ever wraps the SAME rev-parse/`--version`/`rev-list` calls
// `resolveRepositoryPaths()`/`getRepositoryState()` already made pre-cancellation, with an
// `AbortSignal` — no new git subcommand was introduced by either.
describe("AC9 (specs/compare-commits.md): zero network calls comparing two arbitrary commits, regardless of configured remote host", () => {
  /** Exercises both FR-181/FR-182 entry points for a single repo — a no-op assertion would let
   * this test pass vacuously without ever actually spawning the git-core calls AC9 is about. */
  async function runCompareFlow(
    repo: InstanceType<typeof Repository>,
    baseSha: string,
    targetSha: string,
  ): Promise<void> {
    const files = await repo.getChangedFilesBetween(baseSha, targetSha);
    expect(files.length).toBeGreaterThan(0);
    const diff = await repo.getCommitRangeFileDiff(baseSha, targetSha, { path: files[0]!.path });
    expect(diff.status).toBe("ok");
  }

  it(
    "spawns no fetch/pull/push subcommand across getChangedFilesBetween + getCommitRangeFileDiff, with remotes configured against GitHub, GitLab, Bitbucket, and a self-hosted host — none of them reachable",
    async () => {
      const dir = await initRepo();
      cleanupDirs.push(dir);
      await writeFile(dir, "a.txt", "1\n");
      const baseSha = await commit(dir, "base");
      await writeFile(dir, "a.txt", "2\n");
      const targetSha = await commit(dir, "target");
      // FR-192: network behavior is a static property of the code (both entry points only ever
      // shell out to local `git diff`/`git cat-file` against already-fetched local commit
      // objects), so — mirroring how AC10 (amend-last-commit)/AC8 (image-diff-preview) above
      // verify this by configuring one remote per named host FROM the spec's own FR-192 wording,
      // each pointed at a non-routable address — any accidental network attempt would hang/fail
      // loudly rather than silently succeeding.
      await git(dir, ["remote", "add", "origin", "https://github.com.invalid.198.51.100.1/o/r.git"]);
      await git(dir, ["remote", "add", "gitlab", "https://gitlab.com.invalid.198.51.100.1/o/r.git"]);
      await git(dir, ["remote", "add", "bitbucket", "https://bitbucket.org.invalid.198.51.100.1/o/r.git"]);
      await git(dir, ["remote", "add", "selfhosted", "https://git.example.invalid.198.51.100.1/o/r.git"]);

      const repo = await Repository.open(dir);
      await runCompareFlow(repo, baseSha, targetSha);

      expect(spawnCalls.length).toBeGreaterThan(0); // sanity: the spy actually captured calls
      assertNoNetworkSubcommand();
    },
    15000,
  );

  it("spawns no fetch/pull/push subcommand comparing two diverged-branch-tip commits on a purely local repo with no remote at all", async () => {
    const dir = await initRepo();
    cleanupDirs.push(dir);
    await writeFile(dir, "a.txt", "base\n");
    await commit(dir, "base");
    await git(dir, ["checkout", "-q", "-b", "left"]);
    await writeFile(dir, "a.txt", "left\n");
    const leftSha = await commit(dir, "left tip");
    await git(dir, ["checkout", "-q", "main"]);
    await git(dir, ["checkout", "-q", "-b", "right"]);
    await writeFile(dir, "a.txt", "right\n");
    const rightSha = await commit(dir, "right tip");

    const repo = await Repository.open(dir);
    await runCompareFlow(repo, leftSha, rightSha);

    expect(spawnCalls.length).toBeGreaterThan(0);
    assertNoNetworkSubcommand();
  });
});

describe("FR-300 (specs/drag-commit-menu.md): zero network calls across computeCommitPairRelationship / mergeCommit / rebaseCommitOnto, regardless of configured remote host", () => {
  it("spawns no fetch/pull/push subcommand across all four ancestry outcomes plus a fast-forward merge and a real replay rebase, with a remote configured pointing at an unreachable host", async () => {
    const dir = await initRepo();
    cleanupDirs.push(dir);
    await writeFile(dir, "a.txt", "base\n");
    const baseSha = await commit(dir, "base");
    await git(dir, ["checkout", "-q", "-b", "feature"]);
    await writeFile(dir, "b.txt", "feature-only\n");
    const featureSha = await commit(dir, "feature change");
    await git(dir, ["checkout", "-q", "main"]);
    await git(dir, ["remote", "add", "origin", "https://198.51.100.1.invalid/nonexistent.git"]);

    const repo = await Repository.open(dir);

    // FR-295: ancestry read (a-ancestor-of-b direction, since base -> feature is linear).
    const relationship = await repo.computeCommitPairRelationship(baseSha, featureSha);
    expect(relationship).toBe("a-ancestor-of-b");

    // FR-297: fast-forward merge (HEAD == base, merging in the descendant feature commit).
    await repo.mergeCommit(featureSha);
    await repo.refreshState();
    expect(repo.getState().headSha).toBe(featureSha);

    // FR-298: a real rebase replay — diverge a fresh branch off HEAD, then rebase it back onto HEAD.
    await git(dir, ["checkout", "-q", "-b", "topic"]);
    await writeFile(dir, "c.txt", "topic-only\n");
    await commit(dir, "topic change");
    await git(dir, ["checkout", "-q", "main"]);
    await writeFile(dir, "d.txt", "main-only\n");
    const newMainSha = await commit(dir, "main moves on");
    await git(dir, ["checkout", "-q", "topic"]);
    const repoOnTopic = await Repository.open(dir);
    await repoOnTopic.rebaseCommitOnto(newMainSha);
    await repoOnTopic.refreshState();
    expect(repoOnTopic.getState().inProgressOperation).toBeNull();

    expect(spawnCalls.length).toBeGreaterThan(0);
    assertNoNetworkSubcommand();
  });

  it("spawns no fetch/pull/push subcommand computing the no-common-ancestor outcome for two orphan branches, on a purely local repo with no remote at all", async () => {
    const dir = await initRepo();
    cleanupDirs.push(dir);
    await writeFile(dir, "a.txt", "main\n");
    const shaA = await commit(dir, "main root");
    await git(dir, ["checkout", "-q", "--orphan", "unrelated"]);
    await git(dir, ["rm", "-rf", "-q", "."]).catch(() => {});
    await writeFile(dir, "b.txt", "orphan\n");
    const shaB = await commit(dir, "orphan root");

    const repo = await Repository.open(dir);
    const relationship = await repo.computeCommitPairRelationship(shaA, shaB);
    expect(relationship).toBe("no-common-ancestor");

    expect(spawnCalls.length).toBeGreaterThan(0);
    assertNoNetworkSubcommand();
  });
});

describe("AC8 (specs/repo-open-feedback.md): zero network calls warming up git resolution and cancellable-opening a repo, regardless of configured remote host", () => {
  /** Same four-named-host matrix AC10 (amend-last-commit)/AC8 (image-diff-preview) above already
   * use, straight from this spec's own "GitHub, GitLab, Bitbucket, self-hosted" no-host-lock-in
   * wording — each pointed at a non-routable address so any accidental network attempt would
   * hang/fail loudly rather than silently succeeding. */
  async function addUnreachableRemotes(dir: string): Promise<void> {
    await git(dir, ["remote", "add", "origin", "https://github.com.invalid.198.51.100.1/o/r.git"]);
    await git(dir, ["remote", "add", "gitlab", "https://gitlab.com.invalid.198.51.100.1/o/r.git"]);
    await git(dir, ["remote", "add", "bitbucket", "https://bitbucket.org.invalid.198.51.100.1/o/r.git"]);
    await git(dir, ["remote", "add", "selfhosted", "https://git.example.invalid.198.51.100.1/o/r.git"]);
  }

  it(
    "spawns no fetch/pull/push subcommand from warmUpGitResolution()'s eager startup `git --version` call",
    async () => {
      const dir = await initRepo();
      cleanupDirs.push(dir);
      await writeFile(dir, "a.txt", "1\n");
      await commit(dir, "base");
      await addUnreachableRemotes(dir);

      warmUpGitResolution(dir);
      // Fire-and-forget by design (main.ts never awaits it either) — give it a tick to actually
      // spawn and settle before asserting on what it spawned.
      await new Promise((resolve) => setTimeout(resolve, 500));

      expect(spawnCalls.length).toBeGreaterThan(0); // sanity: the spy actually captured a call
      assertNoNetworkSubcommand();
    },
    15000,
  );

  it("spawns no fetch/pull/push subcommand across a cancellable Repository.open() that completes normally (a signal is supplied but never aborted)", async () => {
    const dir = await initRepo();
    cleanupDirs.push(dir);
    await writeFile(dir, "a.txt", "1\n");
    const sha = await commit(dir, "base");
    await addUnreachableRemotes(dir);

    const controller = new AbortController();
    const repo = await Repository.open(dir, { signal: controller.signal });
    expect(repo.getState().headSha).toBe(sha);

    expect(spawnCalls.length).toBeGreaterThan(0);
    assertNoNetworkSubcommand();
  });

  it("spawns no fetch/pull/push subcommand among whatever git calls DID get issued before a caller cancels Repository.open() mid-flight", async () => {
    const dir = await initRepo();
    cleanupDirs.push(dir);
    await writeFile(dir, "a.txt", "1\n");
    await commit(dir, "base");
    await addUnreachableRemotes(dir);

    const controller = new AbortController();
    const openPromise = Repository.open(dir, { signal: controller.signal });
    controller.abort();
    await expect(openPromise).rejects.toBeInstanceOf(OperationCancelledError);

    // At least the cancelled attempt's own spawn(s) were captured — a vacuous pass (nothing
    // spawned at all) would prove nothing about THIS feature's network surface specifically.
    expect(spawnCalls.length).toBeGreaterThan(0);
    assertNoNetworkSubcommand();
  });
});

// specs/online-sync-fetch.md FR-328 / specs/online-sync-security-flags.md section 2: this is the
// ONE new, separate describe block this phase adds — asserting the OPPOSITE of every block above.
// Every describe block above this one is left completely unmodified (byte-for-byte, per FR-328's
// own text) and must keep passing exactly as it always has; this block exists purely to prove
// `fetchRemote`/`fetchAllRemotes` are the only functions in this package that ever spawn a real
// `fetch` subcommand, and that introducing them did not silently grant network capability to
// anything else.
describe("FR-328 (specs/online-sync-fetch.md): fetchRemote/fetchAllRemotes are the only functions that spawn a real fetch subcommand", () => {
  async function makeBareRemote(): Promise<string> {
    const seedDir = await initRepo();
    cleanupDirs.push(seedDir);
    await writeFile(seedDir, "a.txt", "1\n");
    await commit(seedDir, "base");
    const bareDir = await initRepo({ bare: true });
    cleanupDirs.push(bareDir);
    await git(seedDir, ["remote", "add", "origin", bareDir]);
    await git(seedDir, ["push", "-q", "origin", "main"]);
    return bareDir;
  }

  it("fetchRemote spawns a real 'fetch' subcommand — the opposite of every describe block above", async () => {
    const bareDir = await makeBareRemote();
    const dir = await initRepo();
    cleanupDirs.push(dir);
    await git(dir, ["remote", "add", "origin", bareDir]);

    const repo = await Repository.open(dir);
    spawnCalls.length = 0; // isolate: only count spawns from the fetch call itself.
    await repo.fetchRemote("origin");

    const fetchCalls = spawnCalls.filter(
      (call) => /git(\.exe)?$/i.test(call.command) && gitSubcommand(call.args) === "fetch",
    );
    expect(fetchCalls.length).toBeGreaterThanOrEqual(1);
    for (const call of spawnCalls) {
      if (!/git(\.exe)?$/i.test(call.command)) continue;
      const subcommand = gitSubcommand(call.args);
      expect(subcommand).not.toBe("pull");
      expect(subcommand).not.toBe("push");
    }
  });

  it("fetchAllRemotes spawns one real 'fetch' subcommand per configured remote", async () => {
    const bareDirA = await makeBareRemote();
    const bareDirB = await makeBareRemote();
    const dir = await initRepo();
    cleanupDirs.push(dir);
    await git(dir, ["remote", "add", "a", bareDirA]);
    await git(dir, ["remote", "add", "b", bareDirB]);

    const repo = await Repository.open(dir);
    spawnCalls.length = 0;
    const result = await repo.fetchAllRemotes();
    expect(result.outcomes.every((o) => o.status === "ok")).toBe(true);

    const fetchCalls = spawnCalls.filter(
      (call) => /git(\.exe)?$/i.test(call.command) && gitSubcommand(call.args) === "fetch",
    );
    expect(fetchCalls.length).toBe(2);
    for (const call of spawnCalls) {
      if (!/git(\.exe)?$/i.test(call.command)) continue;
      const subcommand = gitSubcommand(call.args);
      expect(subcommand).not.toBe("pull");
      expect(subcommand).not.toBe("push");
    }
  });

  it("fetching a remote does not retroactively grant network capability to an ordinary stage/diff/commit flow run in the same session", async () => {
    const bareDir = await makeBareRemote();
    const dir = await initRepo();
    cleanupDirs.push(dir);
    await writeFile(dir, "base.txt", "1\n");
    await commit(dir, "base");
    await git(dir, ["remote", "add", "origin", bareDir]);

    const repo = await Repository.open(dir);
    await repo.fetchRemote("origin");

    spawnCalls.length = 0; // isolate: only count spawns from the ordinary flow below.
    await runFullFlow(repo, dir);

    expect(spawnCalls.length).toBeGreaterThan(0);
    assertNoNetworkSubcommand();
  });
});

// specs/online-sync-pull.md: `pull()` is composed from `fetchRemote()` +
// `mergeCommit()`/`rebaseCommitOnto()` — FR-343's acceptance criterion #6 (no `--force`/`-f`/any
// destructive flag ever in argv for a pull-related spawn call) and acceptance criterion #7 (zero
// network calls beyond the one fetch per pull — no incidental second fetch, no push) both need
// the same black-box argv-inspection technique the rest of this file already uses, so this block
// lives here (not in `pull.test.ts`) rather than duplicating a second, working
// `vi.mock("node:child_process", ...)` setup — see this file's own module doc comment for why
// that mock must be in place before `gitProcess.ts` is first loaded, which is only guaranteed once,
// at this file's own module scope.
describe("specs/online-sync-pull.md: pull() argv/network surface", () => {
  async function makeRemoteAndClone(): Promise<{ bareDir: string; cloneDir: string }> {
    const seedDir = await initRepo();
    cleanupDirs.push(seedDir);
    await writeFile(seedDir, "a.txt", "base\n");
    await commit(seedDir, "base");
    const bareDir = await initRepo({ bare: true });
    cleanupDirs.push(bareDir);
    await git(seedDir, ["remote", "add", "origin", bareDir]);
    await git(seedDir, ["push", "-q", "origin", "main"]);

    const cloneDir = await initRepo();
    cleanupDirs.push(cloneDir);
    await git(cloneDir, ["remote", "add", "origin", bareDir]);
    await git(cloneDir, ["fetch", "-q", "origin"]);
    await git(cloneDir, ["checkout", "-q", "-b", "main", "origin/main"]);
    return { bareDir, cloneDir };
  }

  async function pushNewCommitToRemote(bareDir: string, message: string): Promise<void> {
    const pusherDir = await initRepo();
    cleanupDirs.push(pusherDir);
    await git(pusherDir, ["remote", "add", "origin", bareDir]);
    await git(pusherDir, ["fetch", "-q", "origin"]);
    await git(pusherDir, ["checkout", "-q", "-b", "main", "origin/main"]);
    await writeFile(pusherDir, "a.txt", message);
    await commit(pusherDir, message);
    await git(pusherDir, ["push", "-q", "origin", "main"]);
  }

  it("AC6: no --force/-f/destructive flag anywhere in argv across a fast-forward, a real merge, and a real rebase pull", async () => {
    const { bareDir: ffBare, cloneDir: ffClone } = await makeRemoteAndClone();
    await pushNewCommitToRemote(ffBare, "ff change\n");

    const { bareDir: mergeBare, cloneDir: mergeClone } = await makeRemoteAndClone();
    await pushNewCommitToRemote(mergeBare, "remote change\n");
    await writeFile(mergeClone, "b.txt", "local-only\n");
    await commit(mergeClone, "local change");
    await git(mergeClone, ["config", "branch.main.rebase", "false"]);

    const { bareDir: rebaseBare, cloneDir: rebaseClone } = await makeRemoteAndClone();
    await pushNewCommitToRemote(rebaseBare, "remote change\n");
    await writeFile(rebaseClone, "b.txt", "local-only\n");
    await commit(rebaseClone, "local change");
    await git(rebaseClone, ["config", "branch.main.rebase", "true"]);

    spawnCalls.length = 0;
    await pull(ffClone); // fast-forward
    await pull(mergeClone); // real merge commit
    await pull(rebaseClone); // real rebase replay

    let gitCallCount = 0;
    for (const call of spawnCalls) {
      if (!/git(\.exe)?$/i.test(call.command)) continue;
      gitCallCount += 1;
      for (const arg of call.args) {
        expect(arg).not.toBe("--force");
        expect(arg).not.toBe("-f");
        expect(arg).not.toMatch(/^--force(=|$)/);
      }
    }
    expect(gitCallCount).toBeGreaterThan(0); // sanity: the spy actually captured git calls.
  });

  it("AC7: spawns exactly one 'fetch' subcommand and no 'pull'/'push' subcommand for a single pull", async () => {
    const { bareDir, cloneDir } = await makeRemoteAndClone();
    await pushNewCommitToRemote(bareDir, "remote change\n");
    await writeFile(cloneDir, "b.txt", "local-only\n");
    await commit(cloneDir, "local change");
    await git(cloneDir, ["config", "branch.main.rebase", "false"]);

    spawnCalls.length = 0;
    await pull(cloneDir);

    const fetchCalls = spawnCalls.filter(
      (call) => /git(\.exe)?$/i.test(call.command) && gitSubcommand(call.args) === "fetch",
    );
    expect(fetchCalls).toHaveLength(1);
    for (const call of spawnCalls) {
      if (!/git(\.exe)?$/i.test(call.command)) continue;
      const subcommand = gitSubcommand(call.args);
      expect(subcommand).not.toBe("pull");
      expect(subcommand).not.toBe("push");
    }
  });
});

// specs/online-sync-push.md: `push()` is the highest-risk primitive in the whole V2 online-sync
// milestone — the ONLY function in this package that ever mutates a remote. Acceptance criterion 6
// requires a black-box argv-inspection test mirroring this file's own technique, proving
// `--force`/`-f`/`--delete`/`--mirror` never appear in ANY push-related spawn call, across the
// clean-push, non-fast-forward-rejected, and new-branch-with-upstream code paths — this is the
// mechanical proof security-reviewer's checklist (specs/online-sync-security-flags.md, item 4)
// calls for explicitly, not just optional polish. Lives here (not in `push.test.ts`) for the exact
// same reason the pull argv/network-surface block above does: this file's own module-scope
// `vi.mock("node:child_process", ...)` must be in place before `gitProcess.ts` is first loaded.
describe("specs/online-sync-push.md: push() argv/network surface", () => {
  async function makeRemoteAndClone(): Promise<{ bareDir: string; cloneDir: string }> {
    const seedDir = await initRepo();
    cleanupDirs.push(seedDir);
    await writeFile(seedDir, "a.txt", "base\n");
    await commit(seedDir, "base");
    const bareDir = await initRepo({ bare: true });
    cleanupDirs.push(bareDir);
    await git(seedDir, ["remote", "add", "origin", bareDir]);
    await git(seedDir, ["push", "-q", "origin", "main"]);

    const cloneDir = await initRepo();
    cleanupDirs.push(cloneDir);
    await git(cloneDir, ["remote", "add", "origin", bareDir]);
    await git(cloneDir, ["fetch", "-q", "origin"]);
    await git(cloneDir, ["checkout", "-q", "-b", "main", "origin/main"]);
    return { bareDir, cloneDir };
  }

  function assertNoDestructivePushFlag(calls: readonly { command: string; args: readonly string[] }[]) {
    let gitCallCount = 0;
    for (const call of calls) {
      if (!/git(\.exe)?$/i.test(call.command)) continue;
      gitCallCount += 1;
      for (const arg of call.args) {
        expect(arg).not.toBe("--force");
        expect(arg).not.toBe("-f");
        expect(arg).not.toMatch(/^--force(-with-lease)?(=|$)/);
        expect(arg).not.toBe("--delete");
        expect(arg).not.toBe("-d");
        expect(arg).not.toBe("--mirror");
        expect(arg).not.toBe("--tags");
        expect(arg).not.toBe("--all");
      }
    }
    expect(gitCallCount).toBeGreaterThan(0); // sanity: the spy actually captured git calls.
  }

  it("AC6: no --force/-f/--delete/--mirror/--tags/--all anywhere in argv across a clean push, a non-fast-forward rejection, and a new-branch-with-upstream publish", async () => {
    // Path 1: a clean, already-tracked fast-forward push (FR-344).
    const { cloneDir: cleanClone } = await makeRemoteAndClone();
    await writeFile(cleanClone, "a.txt", "second\n");
    await commit(cleanClone, "second commit");

    // Path 2: a non-fast-forward rejection (FR-346) — diverge the remote out from under a clone
    // that never re-fetched.
    const { bareDir: rejectedBare, cloneDir: rejectedClone } = await makeRemoteAndClone();
    const otherPusher = await initRepo();
    cleanupDirs.push(otherPusher);
    await git(otherPusher, ["remote", "add", "origin", rejectedBare]);
    await git(otherPusher, ["fetch", "-q", "origin"]);
    await git(otherPusher, ["checkout", "-q", "-b", "main", "origin/main"]);
    await writeFile(otherPusher, "a.txt", "someone else's change\n");
    await commit(otherPusher, "someone else's change");
    await git(otherPusher, ["push", "-q", "origin", "main"]);
    await writeFile(rejectedClone, "b.txt", "local-only\n");
    await commit(rejectedClone, "local-only change");

    // Path 3: a brand-new local branch with no upstream yet (FR-345).
    const { cloneDir: newBranchClone } = await makeRemoteAndClone();
    await git(newBranchClone, ["checkout", "-q", "-b", "feature"]);
    await writeFile(newBranchClone, "feature.txt", "new file\n");
    await commit(newBranchClone, "feature work");

    spawnCalls.length = 0;
    await push(cleanClone, "origin", "main");
    await expect(push(rejectedClone, "origin", "main")).rejects.toBeInstanceOf(GitCommandError);
    await push(newBranchClone, "origin", "feature");

    assertNoDestructivePushFlag(spawnCalls);
  });

  it("AC7: spawns exactly one 'push' subcommand and no incidental 'fetch'/'pull' subcommand for a single push", async () => {
    const { cloneDir } = await makeRemoteAndClone();
    await writeFile(cloneDir, "a.txt", "second\n");
    await commit(cloneDir, "second commit");

    spawnCalls.length = 0;
    await push(cloneDir, "origin", "main");

    const pushCalls = spawnCalls.filter(
      (call) => /git(\.exe)?$/i.test(call.command) && gitSubcommand(call.args) === "push",
    );
    expect(pushCalls).toHaveLength(1);
    for (const call of spawnCalls) {
      if (!/git(\.exe)?$/i.test(call.command)) continue;
      const subcommand = gitSubcommand(call.args);
      expect(subcommand).not.toBe("fetch");
      expect(subcommand).not.toBe("pull");
    }
  });

  it("classifies a real non-fast-forward rejection via classifyGitNetworkError, reusing FR-323's exact infrastructure (FR-348)", async () => {
    const { bareDir, cloneDir } = await makeRemoteAndClone();
    const otherPusher = await initRepo();
    cleanupDirs.push(otherPusher);
    await git(otherPusher, ["remote", "add", "origin", bareDir]);
    await git(otherPusher, ["fetch", "-q", "origin"]);
    await git(otherPusher, ["checkout", "-q", "-b", "main", "origin/main"]);
    await writeFile(otherPusher, "a.txt", "someone else's change\n");
    await commit(otherPusher, "someone else's change");
    await git(otherPusher, ["push", "-q", "origin", "main"]);
    await writeFile(cloneDir, "b.txt", "local-only\n");
    await commit(cloneDir, "local-only change");

    let caught: unknown;
    try {
      await push(cloneDir, "origin", "main");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(GitCommandError);
    expect(classifyGitNetworkError((caught as GitCommandError).stderr).kind).toBe(
      "push-rejected-non-fast-forward",
    );
  });
});

// specs/online-sync-clone.md: `clone()` is the last of the four network-capable primitives this
// package exposes. Acceptance criterion 6 requires the identical black-box argv-inspection
// technique this file's push/pull blocks above already use, proving `--depth`/
// `--recurse-submodules`/`--mirror`/`--bare` never appear in ANY clone-related spawn call — this is
// the mechanical proof for the spec's own Non-goals ("simplest correct form only, this pass"), not
// just a code-review-time promise. Lives here (not in `clone.test.ts`) for the exact same reason
// the pull/push argv/network-surface blocks above do: this file's own module-scope
// `vi.mock("node:child_process", ...)` must already be in place before `gitProcess.ts` is first
// loaded, which is only guaranteed once, at this file's own module scope.
describe("specs/online-sync-clone.md: clone() argv/network surface", () => {
  async function makeBareRemoteWithCommit(): Promise<string> {
    const seedDir = await initRepo();
    cleanupDirs.push(seedDir);
    await writeFile(seedDir, "a.txt", "1\n");
    await commit(seedDir, "base");
    const bareDir = await initRepo({ bare: true });
    cleanupDirs.push(bareDir);
    await git(seedDir, ["remote", "add", "origin", bareDir]);
    await git(seedDir, ["push", "-q", "origin", "main"]);
    return bareDir;
  }

  it("AC6: --depth/--recurse-submodules/--mirror/--bare never appear in any clone-related spawn call", async () => {
    const bareDir = await makeBareRemoteWithCommit();
    const parent = await makeTempDir();
    cleanupDirs.push(parent);
    const dest = path.join(parent, "argv-check-dest");

    spawnCalls.length = 0;
    await clone(bareDir, dest);

    let gitCallCount = 0;
    for (const call of spawnCalls) {
      if (!/git(\.exe)?$/i.test(call.command)) continue;
      gitCallCount += 1;
      for (const arg of call.args) {
        expect(arg).not.toBe("--depth");
        expect(arg).not.toMatch(/^--depth(=|$)/);
        expect(arg).not.toBe("--recurse-submodules");
        expect(arg).not.toMatch(/^--recurse-submodules(=|$)/);
        expect(arg).not.toBe("--recursive");
        expect(arg).not.toBe("--mirror");
        expect(arg).not.toBe("--bare");
      }
    }
    expect(gitCallCount).toBeGreaterThan(0); // sanity: the spy actually captured git calls.
  });

  it("AC7: passes a dash-prefixed URL through safely (--end-of-options precedes it in argv), and spawns exactly one 'clone' subcommand with no incidental 'fetch'/'pull'/'push' subcommand", async () => {
    const bareDir = await makeBareRemoteWithCommit();
    const parent = await makeTempDir();
    cleanupDirs.push(parent);
    const dest = path.join(parent, "single-clone-dest");

    spawnCalls.length = 0;
    await clone(bareDir, dest);

    const cloneCalls = spawnCalls.filter(
      (call) => /git(\.exe)?$/i.test(call.command) && gitSubcommand(call.args) === "clone",
    );
    expect(cloneCalls).toHaveLength(1);
    const cloneArgs = cloneCalls[0]!.args;
    // FR-352: --end-of-options must precede both positional args (url, destination) — the exact
    // mechanical guard that makes a dash-prefixed url/destination safe (see clone.test.ts's own
    // real-git AC7 test for the end-to-end behavioral proof of this same guarantee).
    const endOfOptionsIndex = cloneArgs.indexOf("--end-of-options");
    expect(endOfOptionsIndex).toBeGreaterThanOrEqual(0);
    expect(cloneArgs.indexOf(bareDir)).toBeGreaterThan(endOfOptionsIndex);

    for (const call of spawnCalls) {
      if (!/git(\.exe)?$/i.test(call.command)) continue;
      const subcommand = gitSubcommand(call.args);
      expect(subcommand).not.toBe("fetch");
      expect(subcommand).not.toBe("pull");
      expect(subcommand).not.toBe("push");
    }
  });
});
