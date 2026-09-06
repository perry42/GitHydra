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
const { git, initRepo, writeFile, commit, cleanup } = await import("./testRepo");

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
  }, 15000);

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
  }, 15000);
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
  }, 15000);
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
  }, 15000);

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
  }, 15000);

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
  }, 15000);
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
  }, 15000);
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
  }, 15000);
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
