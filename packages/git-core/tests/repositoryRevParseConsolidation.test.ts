import { describe, it, expect, afterEach, vi } from "vitest";

/**
 * Regression coverage for the `resolveRepositoryPaths()` consolidation (git-core-engineer,
 * 2026-09-05): the 4 independent `git rev-parse` probes (`--absolute-git-dir`,
 * `--git-common-dir`, `--is-bare-repository`, `--is-inside-work-tree`) that used to be 4
 * separate, parallel `git` process spawns are now issued as ONE spawn with all 4 flags — verified
 * safe because none of these 4 queries is ever individually inapplicable while the others succeed
 * (see `repository.ts`'s own doc comment at the call site for the full investigation). This file
 * proves, black-box, that the actual number and shape of `child_process.spawn` calls changed as
 * intended, and that `resolveRepositoryPaths()`'s *observable* return value is unaffected across
 * every repository shape this suite already exercises (normal repo, bare repo, linked worktree).
 *
 * Deliberately its own file, mocking `node:child_process` at module scope — same reasoning as
 * `noNetworkCalls.test.ts`: the mock must be in place before `gitProcess.ts` first loads `spawn`,
 * and doing that in a shared test file would affect every other test in it.
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

const { resolveRepositoryPaths } = await import("../src/repository");
const { _resetGitVersionCacheForTests } = await import("../src/gitProcess");
const { initRepo, writeFile, commit, cleanup, git } = await import("./testRepo");

const cleanupDirs: string[] = [];
afterEach(async () => {
  spawnCalls.length = 0;
  _resetGitVersionCacheForTests();
  while (cleanupDirs.length) await cleanup(cleanupDirs.pop()!);
});

function revParseCalls(): { command: string; args: readonly string[] }[] {
  return spawnCalls.filter((c) => c.args[0] === "rev-parse");
}

describe("resolveRepositoryPaths rev-parse consolidation", () => {
  it("issues exactly ONE combined rev-parse spawn (not 4 separate ones) plus one --show-toplevel spawn, for a normal non-bare repo", async () => {
    const dir = await initRepo();
    cleanupDirs.push(dir);
    await writeFile(dir, "a.txt", "hello");
    await commit(dir, "first");
    spawnCalls.length = 0; // fixture setup above (initRepo/writeFile/commit) also spawns git; only count calls made by the function under test.

    const result = await resolveRepositoryPaths(dir);

    const calls = revParseCalls();
    expect(calls).toHaveLength(2);
    expect(calls[0]!.args).toEqual([
      "rev-parse",
      "--absolute-git-dir",
      "--git-common-dir",
      "--is-bare-repository",
      "--is-inside-work-tree",
    ]);
    expect(calls[1]!.args).toEqual(["rev-parse", "--show-toplevel"]);

    expect(result.isBare).toBe(false);
    expect(result.workdir).not.toBeNull();
  });

  it("issues exactly ONE combined rev-parse spawn and skips --show-toplevel entirely for a bare repo", async () => {
    const dir = await initRepo({ bare: true });
    cleanupDirs.push(dir);

    const result = await resolveRepositoryPaths(dir);

    const calls = revParseCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args).toEqual([
      "rev-parse",
      "--absolute-git-dir",
      "--git-common-dir",
      "--is-bare-repository",
      "--is-inside-work-tree",
    ]);

    expect(result.isBare).toBe(true);
    expect(result.workdir).toBeNull();
  });

  it("correctly positionally parses all 4 fields for a linked worktree from the single combined spawn", async () => {
    const dir = await initRepo();
    cleanupDirs.push(dir);
    await writeFile(dir, "a.txt", "hello");
    await commit(dir, "first");
    const worktreeDir = `${dir}-wt`;
    await git(dir, ["worktree", "add", "-q", "-b", "wt-branch", worktreeDir]);
    cleanupDirs.push(worktreeDir);
    spawnCalls.length = 0; // fixture setup above also spawns git; only count calls made by the function under test.

    try {
      const result = await resolveRepositoryPaths(worktreeDir);

      const calls = revParseCalls();
      expect(calls).toHaveLength(2); // combined probe + --show-toplevel (a worktree is a real worktree)
      expect(calls[0]!.args).toEqual([
        "rev-parse",
        "--absolute-git-dir",
        "--git-common-dir",
        "--is-bare-repository",
        "--is-inside-work-tree",
      ]);

      expect(result.isBare).toBe(false);
      // The linked worktree's own gitDir lives under the main repo's .git/worktrees/<name>, while
      // commonGitDir resolves back to the main repo's .git — proves --absolute-git-dir (line 1)
      // and --git-common-dir (line 2) were each read from the correct positional line, not swapped.
      expect(result.gitDir.replace(/\\/g, "/")).toContain("/worktrees/");
      expect(result.commonGitDir.replace(/\\/g, "/")).not.toContain("/worktrees/");
      expect(result.workdir).not.toBeNull();
    } finally {
      await git(dir, ["worktree", "remove", "-f", worktreeDir]).catch(() => {});
    }
  });

  // This deliberately forces past `fastCheckRepositoryDiscovery`'s fs-only fast path (which would
  // otherwise answer "definitely not a repo" from plain fs reads alone, spawning no `git` process
  // at all — already covered by repository.test.ts's own "[fast path]" test) via `GIT_DIR`, one of
  // `fsRepoDiscovery.ts`'s own documented `DISCOVERY_OVERRIDE_ENV_VARS` that unconditionally defers
  // to a real git invocation, so this test actually exercises the combined rev-parse spawn's own
  // failure path rather than short-circuiting before ever reaching it.
  it("a genuinely-broken repo location still rejects with NotAGitRepositoryError from the single combined spawn's non-zero exit, with exactly one rev-parse spawn (no per-flag fallback calls)", async () => {
    const path = await import("node:path");
    const { makeTempDir } = await import("./testRepo");
    const { NotAGitRepositoryError } = await import("../src/errors");

    const dir = await makeTempDir();
    cleanupDirs.push(dir);
    const previousGitDir = process.env.GIT_DIR;
    process.env.GIT_DIR = path.join(dir, "definitely-does-not-exist", ".git");
    try {
      await expect(resolveRepositoryPaths(dir)).rejects.toBeInstanceOf(NotAGitRepositoryError);
      // The combined probe is still exactly one spawn even on the failure path (git errors out on
      // the first flag it can't satisfy and stops, rather than us falling back to per-flag calls).
      expect(revParseCalls()).toHaveLength(1);
    } finally {
      if (previousGitDir === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = previousGitDir;
    }
  });
});
