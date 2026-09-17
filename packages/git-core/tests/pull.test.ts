// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect, afterEach } from "vitest";
import * as path from "node:path";
import { pull, PULL_STRATEGIES } from "../src/pull";
import { Repository } from "../src/index";
import { abortInProgressOperation } from "../src/conflicts";
import {
  GitCommandError,
  InvalidArgumentError,
  NoUpstreamConfiguredError,
  OperationAlreadyInProgressError,
} from "../src/errors";
import { getRepositoryState } from "../src/repository";
import { git, initRepo, writeFile, commit, cleanup, fileExists } from "./testRepo";

/**
 * specs/online-sync-pull.md's git-core surface (FR-338 through FR-343): `pull()`, composed from
 * `fetchRemote()` + `mergeCommit()`/`rebaseCommitOnto()`, never a literal `git pull` call. Covers
 * every acceptance criterion in the spec against real local bare-remote fixtures (no network,
 * matching this package's existing offline-only test conventions).
 */

/** Isolate config reads (`pull.rebase`/`branch.<name>.rebase`) from whatever global/system git
 * config exists on the machine actually running this suite — mirrors `commitChanges.test.ts`'s/
 * `amendCommit.test.ts`'s identical `withEnv()` helper and rationale (identity resolution there,
 * strategy-config resolution here — same underlying problem: this package deliberately reads
 * EFFECTIVE config, which is otherwise at the mercy of the dev/CI machine's own ambient
 * ~/.gitconfig). Applied around BOTH the fixture's own `git config --global` calls and the actual
 * `pull()` call under test, so the code under test sees the exact same isolated config a real user
 * with a clean `HOME` would. */
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

const cleanupDirs: string[] = [];
afterEach(async () => {
  while (cleanupDirs.length) await cleanup(cleanupDirs.pop()!);
});

/** An isolated-config env for one particular repo dir: no system config, a global config file
 * that doesn't exist yet (so `git config --global` calls made under this same env create and
 * write to it, entirely separate from the real machine's `~/.gitconfig`). */
function isolatedConfigEnv(dir: string): Record<string, string> {
  return {
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: path.join(dir, "isolated-global-gitconfig"),
    HOME: dir,
    USERPROFILE: dir,
  };
}

/** Build a bare "remote" repo seeded with one commit on `main`, plus a clone of it with
 * `branch.main.remote`/`branch.main.merge` wired up the normal way (`git clone` does this
 * automatically). Returns both directories. */
async function makeRemoteAndClone(): Promise<{ bareDir: string; cloneDir: string; baseSha: string }> {
  const seedDir = await initRepo();
  cleanupDirs.push(seedDir);
  await writeFile(seedDir, "a.txt", "base\n");
  const baseSha = await commit(seedDir, "base");

  const bareDir = await initRepo({ bare: true });
  cleanupDirs.push(bareDir);
  await git(seedDir, ["remote", "add", "origin", bareDir]);
  await git(seedDir, ["push", "-q", "origin", "main"]);

  const cloneDir = await initRepo();
  cleanupDirs.push(cloneDir);
  await git(cloneDir, ["remote", "add", "origin", bareDir]);
  await git(cloneDir, ["fetch", "-q", "origin"]);
  await git(cloneDir, ["checkout", "-q", "-b", "main", "origin/main"]);

  return { bareDir, cloneDir, baseSha };
}

/** Push one more commit to the bare remote via a second, throwaway clone of it — simulating
 * "someone else pushed since we last fetched," without touching `cloneDir`'s own working state. */
async function localConfigGet(dir: string, key: string): Promise<string | null> {
  try {
    const { stdout } = await git(dir, ["config", "--local", "--get", key]);
    return stdout.replace(/\r?\n$/, "");
  } catch {
    return null;
  }
}

async function pushNewCommitToRemote(bareDir: string, fileContents: string, message: string): Promise<string> {
  const pusherDir = await initRepo();
  cleanupDirs.push(pusherDir);
  await git(pusherDir, ["remote", "add", "origin", bareDir]);
  await git(pusherDir, ["fetch", "-q", "origin"]);
  await git(pusherDir, ["checkout", "-q", "-b", "main", "origin/main"]);
  await writeFile(pusherDir, "a.txt", fileContents);
  const sha = await commit(pusherDir, message);
  await git(pusherDir, ["push", "-q", "origin", "main"]);
  return sha;
}

describe("pull (FR-340): fast-forward path", () => {
  it("AC1: moves HEAD forward with zero conflict UI and no MERGE_HEAD/rebase-merge ever created", async () => {
    const { bareDir, cloneDir, baseSha } = await makeRemoteAndClone();
    const newSha = await pushNewCommitToRemote(bareDir, "second\n", "second");

    const outcome = await pull(cloneDir);

    expect(outcome).toEqual({ kind: "fast-forward", fromSha: baseSha, toSha: newSha });
    const state = await getRepositoryState(cloneDir);
    expect(state.headSha).toBe(newSha);
    expect(state.inProgressOperation).toBeNull();
    expect(await fileExists(path.join(cloneDir, ".git", "MERGE_HEAD"))).toBe(false);
    expect(await fileExists(path.join(cloneDir, ".git", "rebase-merge"))).toBe(false);

    // No merge commit was created — a plain single-parent fast-forward.
    const { stdout: parentsRaw } = await git(cloneDir, ["log", "-1", "--format=%P", "HEAD"]);
    expect(parentsRaw.trim()).toBe(baseSha);
  });

  it("fast-forwards correctly regardless of the configured strategy (rebase-configured branch still just fast-forwards)", async () => {
    const { bareDir, cloneDir } = await makeRemoteAndClone();
    const newSha = await pushNewCommitToRemote(bareDir, "second\n", "second");
    await git(cloneDir, ["config", "branch.main.rebase", "true"]);

    const outcome = await pull(cloneDir);

    expect(outcome).toEqual({ kind: "fast-forward", fromSha: expect.any(String), toSha: newSha });
    const state = await getRepositoryState(cloneDir);
    expect(state.headSha).toBe(newSha);
  });

  it("fast-forwards a genuinely unborn HEAD onto the fetched upstream commit", async () => {
    const seedDir = await initRepo();
    cleanupDirs.push(seedDir);
    await writeFile(seedDir, "a.txt", "base\n");
    const baseSha = await commit(seedDir, "base");
    const bareDir = await initRepo({ bare: true });
    cleanupDirs.push(bareDir);
    await git(seedDir, ["remote", "add", "origin", bareDir]);
    await git(seedDir, ["push", "-q", "origin", "main"]);

    const unbornDir = await initRepo();
    cleanupDirs.push(unbornDir);
    await git(unbornDir, ["remote", "add", "origin", bareDir]);
    await git(unbornDir, ["config", "branch.main.remote", "origin"]);
    await git(unbornDir, ["config", "branch.main.merge", "refs/heads/main"]);
    // HEAD is attached to "main" but there is no commit yet at all (a genuinely fresh `git init`).
    expect((await getRepositoryState(unbornDir)).isUnbornHead).toBe(true);

    const outcome = await pull(unbornDir);

    expect(outcome).toEqual({ kind: "fast-forward", fromSha: baseSha, toSha: baseSha });
    const state = await getRepositoryState(unbornDir);
    expect(state.isUnbornHead).toBe(false);
    expect(state.headSha).toBe(baseSha);
  });
});

describe("pull: already up to date", () => {
  it("returns up-to-date with no merge/rebase/ff call when HEAD already equals the fetched upstream", async () => {
    const { cloneDir, baseSha } = await makeRemoteAndClone();

    const outcome = await pull(cloneDir);

    expect(outcome).toEqual({ kind: "up-to-date" });
    const state = await getRepositoryState(cloneDir);
    expect(state.headSha).toBe(baseSha);
  });
});

describe("pull (FR-339 / AC2): diverged branch, merge strategy", () => {
  it("produces a real 2-parent merge commit via the composed mergeCommit() path when configured for merge", async () => {
    const { bareDir, cloneDir, baseSha } = await makeRemoteAndClone();
    const remoteSha = await pushNewCommitToRemote(bareDir, "second\n", "remote change");
    await writeFile(cloneDir, "b.txt", "local-only\n");
    const localSha = await commit(cloneDir, "local change");
    await git(cloneDir, ["config", "branch.main.rebase", "false"]);

    const outcome = await pull(cloneDir);

    expect(outcome).toEqual({ kind: "integrated", strategy: "merge" });
    const state = await getRepositoryState(cloneDir);
    expect(state.inProgressOperation).toBeNull();
    const { stdout: parentsRaw } = await git(cloneDir, ["log", "-1", "--format=%P", "HEAD"]);
    const parents = parentsRaw.trim().split(" ");
    expect(parents).toEqual([localSha, remoteSha]); // 2 parents -> a real merge commit.
    expect(baseSha).toBeTruthy();
  });
});

describe("pull (FR-339 / AC3): diverged branch, rebase strategy", () => {
  it("replays the local commit onto the fetched upstream via the composed rebaseCommitOnto() path, as a rewritten SHA", async () => {
    const { bareDir, cloneDir } = await makeRemoteAndClone();
    const remoteSha = await pushNewCommitToRemote(bareDir, "second\n", "remote change");
    await writeFile(cloneDir, "b.txt", "local-only\n");
    const localSha = await commit(cloneDir, "local change");
    await git(cloneDir, ["config", "branch.main.rebase", "true"]);

    const outcome = await pull(cloneDir);

    expect(outcome).toEqual({ kind: "integrated", strategy: "rebase" });
    const state = await getRepositoryState(cloneDir);
    expect(state.inProgressOperation).toBeNull();
    // Linear history: single parent, directly onto the fetched remote commit.
    const { stdout: parentRaw } = await git(cloneDir, ["log", "-1", "--format=%P", "HEAD"]);
    expect(parentRaw.trim()).toBe(remoteSha);
    // Rewritten SHA, not reused — the replayed commit is a genuinely new object.
    expect(state.headSha).not.toBe(localSha);
    const { stdout: subjectRaw } = await git(cloneDir, ["log", "-1", "--format=%s", "HEAD"]);
    expect(subjectRaw.trim()).toBe("local change");
  });
});

describe("pull (FR-339): strategy resolution precedence", () => {
  it("an explicit per-call override wins over both branch.<name>.rebase and pull.rebase", async () => {
    const { bareDir, cloneDir } = await makeRemoteAndClone();
    await pushNewCommitToRemote(bareDir, "second\n", "remote change");
    await writeFile(cloneDir, "b.txt", "local-only\n");
    await commit(cloneDir, "local change");
    await git(cloneDir, ["config", "branch.main.rebase", "false"]);
    await git(cloneDir, ["config", "pull.rebase", "false"]);

    const outcome = await pull(cloneDir, { strategy: "rebase" });

    expect(outcome).toEqual({ kind: "integrated", strategy: "rebase" });
  });

  it("branch.<name>.rebase wins over pull.rebase when both are set", async () => {
    const { bareDir, cloneDir } = await makeRemoteAndClone();
    await pushNewCommitToRemote(bareDir, "second\n", "remote change");
    await writeFile(cloneDir, "b.txt", "local-only\n");
    await commit(cloneDir, "local change");
    await git(cloneDir, ["config", "pull.rebase", "true"]);
    await git(cloneDir, ["config", "branch.main.rebase", "false"]);

    const outcome = await pull(cloneDir);

    expect(outcome).toEqual({ kind: "integrated", strategy: "merge" });
  });

  it("falls back to pull.rebase when branch.<name>.rebase is unset", async () => {
    const { bareDir, cloneDir } = await makeRemoteAndClone();
    await pushNewCommitToRemote(bareDir, "second\n", "remote change");
    await writeFile(cloneDir, "b.txt", "local-only\n");
    await commit(cloneDir, "local change");
    await git(cloneDir, ["config", "pull.rebase", "true"]);

    const outcome = await pull(cloneDir);

    expect(outcome).toEqual({ kind: "integrated", strategy: "rebase" });
  });

  it("defaults to merge (git's own default) when neither key is configured anywhere, isolated from the host machine's own config", async () => {
    const { bareDir, cloneDir } = await makeRemoteAndClone();
    await pushNewCommitToRemote(bareDir, "second\n", "remote change");
    await writeFile(cloneDir, "b.txt", "local-only\n");
    await commit(cloneDir, "local change");

    // The isolated env also strips the ambient identity `commit`/`git()` calls above relied on
    // implicitly (via testRepo.ts's own GIT_AUTHOR_*/GIT_COMMITTER_* env, which the CODE UNDER
    // TEST's spawns never see) — give the repo its own local identity so the real merge commit
    // this test expects can actually be created under full isolation.
    await git(cloneDir, ["config", "user.name", "Test User"]);
    await git(cloneDir, ["config", "user.email", "test@example.com"]);

    await withEnv(isolatedConfigEnv(cloneDir), async () => {
      const outcome = await pull(cloneDir);
      expect(outcome).toEqual({ kind: "integrated", strategy: "merge" });
    });
  });

  it("recognizes branch.<name>.rebase = 'merges' (a real, non-boolean git-accepted spelling) as rebase", async () => {
    const { bareDir, cloneDir } = await makeRemoteAndClone();
    await pushNewCommitToRemote(bareDir, "second\n", "remote change");
    await writeFile(cloneDir, "b.txt", "local-only\n");
    await commit(cloneDir, "local change");
    await git(cloneDir, ["config", "branch.main.rebase", "merges"]);

    const outcome = await pull(cloneDir);

    expect(outcome).toEqual({ kind: "integrated", strategy: "rebase" });
  });

  it("never writes pull.rebase/branch.<name>.rebase itself, regardless of the strategy actually used", async () => {
    const { bareDir, cloneDir } = await makeRemoteAndClone();
    await pushNewCommitToRemote(bareDir, "second\n", "remote change");
    await writeFile(cloneDir, "b.txt", "local-only\n");
    await commit(cloneDir, "local change");

    await pull(cloneDir, { strategy: "rebase" });

    expect(await localConfigGet(cloneDir, "branch.main.rebase")).toBeNull(); // still unset — never written by pull().
    expect(await localConfigGet(cloneDir, "pull.rebase")).toBeNull();
  });
});

describe("pull (FR-338 / AC4): conflicting pull reaches the exact same conflict-resolution flow as a manual merge", () => {
  it("rejects with a plain GitCommandError, leaving MERGE_HEAD/conflicted state discoverable via a fresh RepositoryState read", async () => {
    const { bareDir, cloneDir } = await makeRemoteAndClone();
    await pushNewCommitToRemote(bareDir, "remote change\n", "remote change");
    await writeFile(cloneDir, "a.txt", "local change\n");
    await commit(cloneDir, "local change");
    await git(cloneDir, ["config", "branch.main.rebase", "false"]);

    await expect(pull(cloneDir)).rejects.toBeInstanceOf(GitCommandError);

    const state = await getRepositoryState(cloneDir);
    expect(state.inProgressOperation).toBe("merge");
    const conflicted = await (await import("../src/conflicts")).getConflictedFiles(cloneDir, cloneDir, state);
    expect(conflicted.map((f) => f.path)).toEqual(["a.txt"]);

    await abortInProgressOperation(cloneDir, "merge");
  });

  it("AC5: aborting a pull-triggered merge leaves the branch's tip SHA identical to what it was immediately before Pull", async () => {
    const { bareDir, cloneDir, baseSha } = await makeRemoteAndClone();
    await pushNewCommitToRemote(bareDir, "remote change\n", "remote change");
    await writeFile(cloneDir, "a.txt", "local change\n");
    const preTipSha = await commit(cloneDir, "local change");
    await git(cloneDir, ["config", "branch.main.rebase", "false"]);

    await expect(pull(cloneDir)).rejects.toBeInstanceOf(GitCommandError);
    expect((await getRepositoryState(cloneDir)).inProgressOperation).toBe("merge");

    await abortInProgressOperation(cloneDir, "merge");

    const state = await getRepositoryState(cloneDir);
    expect(state.headSha).toBe(preTipSha);
    expect(state.inProgressOperation).toBeNull();
    expect(baseSha).toBeTruthy();
  });

  it("a pull-triggered rebase conflict pauses discoverably too, and aborting restores the exact pre-pull tip", async () => {
    const { bareDir, cloneDir } = await makeRemoteAndClone();
    await pushNewCommitToRemote(bareDir, "remote change\n", "remote change");
    await writeFile(cloneDir, "a.txt", "local change\n");
    const preTipSha = await commit(cloneDir, "local change");
    await git(cloneDir, ["config", "branch.main.rebase", "true"]);

    await expect(pull(cloneDir)).rejects.toBeInstanceOf(GitCommandError);
    expect((await getRepositoryState(cloneDir)).inProgressOperation).toBe("rebase");

    await abortInProgressOperation(cloneDir, "rebase");

    const state = await getRepositoryState(cloneDir);
    expect(state.headSha).toBe(preTipSha);
    expect(state.inProgressOperation).toBeNull();
  });
});

// FR-343's acceptance criterion #6 (no --force/-f/destructive flag ever in argv for a
// pull-related spawn call) and AC7 (zero network calls beyond the one fetch per pull) are
// covered in `noNetworkCalls.test.ts`'s "specs/online-sync-pull.md" describe block instead of
// here — that file's own module-scope `vi.mock("node:child_process", ...)` is the established,
// working pattern in this suite for black-box argv inspection (see its own doc comment for why
// this must be its own file: the mock must be in place before `gitProcess.ts` is first loaded).

describe("pull (FR-341): scope and refusal cases", () => {
  it("throws NoUpstreamConfiguredError, making no git call at all, when the current branch has no configured upstream", async () => {
    const dir = await initRepo();
    cleanupDirs.push(dir);
    await writeFile(dir, "a.txt", "1\n");
    await commit(dir, "base");

    await expect(pull(dir)).rejects.toBeInstanceOf(NoUpstreamConfiguredError);
  });

  it("throws NoUpstreamConfiguredError on a detached HEAD", async () => {
    const { cloneDir, baseSha } = await makeRemoteAndClone();
    await git(cloneDir, ["checkout", "-q", "--detach", baseSha]);

    await expect(pull(cloneDir)).rejects.toBeInstanceOf(NoUpstreamConfiguredError);
  });

  it("throws NoUpstreamConfiguredError when the configured merge ref doesn't exist on the remote at all", async () => {
    const { cloneDir } = await makeRemoteAndClone();
    // A misconfigured (or since-deleted-and-never-pruned) upstream: `branch.main.remote` is a
    // real, reachable remote, but `branch.main.merge` names a branch that was never pushed there
    // — after fetch, `@{u}` (which resolves through this exact mapping) has nothing to point at.
    await git(cloneDir, ["config", "branch.main.merge", "refs/heads/never-existed-on-remote"]);

    await expect(pull(cloneDir)).rejects.toBeInstanceOf(NoUpstreamConfiguredError);
  });

  it("throws OperationAlreadyInProgressError, requestedAction 'pull', naming the pre-existing operation, making no fetch call", async () => {
    const { bareDir, cloneDir } = await makeRemoteAndClone();
    await pushNewCommitToRemote(bareDir, "second\n", "remote change");
    await writeFile(cloneDir, "a.txt", "conflicting local edit\n");
    await commit(cloneDir, "local edit");
    await git(cloneDir, ["checkout", "-q", "-b", "other"]);
    await writeFile(cloneDir, "z.txt", "other\n");
    const otherSha = await commit(cloneDir, "other branch commit");
    await git(cloneDir, ["checkout", "-q", "main"]);
    // Leave a real cherry-pick genuinely mid-conflict, unrelated to the pull we're about to attempt.
    await writeFile(cloneDir, "z.txt", "main version\n");
    await commit(cloneDir, "main also touches z.txt");
    await git(cloneDir, ["cherry-pick", otherSha]).catch(() => {});
    expect((await getRepositoryState(cloneDir)).inProgressOperation).toBe("cherry-pick");

    let caught: unknown;
    try {
      await pull(cloneDir);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(OperationAlreadyInProgressError);
    const typed = caught as OperationAlreadyInProgressError;
    expect(typed.operation).toBe("cherry-pick");
    expect(typed.requestedAction).toBe("pull");
    expect(typed.message).toMatch(/^Cannot pull:/);

    await abortInProgressOperation(cloneDir, "cherry-pick");
  });

  it("throws InvalidArgumentError, making no git call at all, for an out-of-band strategy override value", async () => {
    const { cloneDir } = await makeRemoteAndClone();

    // @ts-expect-error -- deliberately passing a runtime value outside the PullStrategy union,
    // simulating an IPC-boundary caller that isn't held to the compile-time type.
    await expect(pull(cloneDir, { strategy: "squash" })).rejects.toBeInstanceOf(InvalidArgumentError);
  });
});

describe("PULL_STRATEGIES", () => {
  it("is exactly ['merge', 'rebase'] — no squash or other non-default strategy", () => {
    expect(PULL_STRATEGIES).toEqual(["merge", "rebase"]);
  });
});

describe("Repository facade (pull)", () => {
  it("round-trips a fast-forward pull through the Repository facade", async () => {
    const { bareDir, cloneDir, baseSha } = await makeRemoteAndClone();
    const newSha = await pushNewCommitToRemote(bareDir, "second\n", "second");

    const repo = await Repository.open(cloneDir);
    const outcome = await repo.pull();
    await repo.refreshState();

    expect(outcome).toEqual({ kind: "fast-forward", fromSha: baseSha, toSha: newSha });
    expect(repo.getState().headSha).toBe(newSha);
  });

  it("refuses with a bare-repository error", async () => {
    const dir = await initRepo({ bare: true });
    cleanupDirs.push(dir);
    const repo = await Repository.open(dir);

    await expect(repo.pull()).rejects.toThrow(/bare repository/);
  });
});
