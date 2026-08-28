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
const { Repository } = await import("../src/index");
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

function assertNoNetworkSubcommand() {
  for (const call of spawnCalls) {
    // Only inspect calls to a `git`-named executable (this test's own fixture helper, `testRepo`'s
    // `git()`, also spawns "git" directly for setup, and should be held to the same bar).
    if (!/git(\.exe)?$/i.test(call.command)) continue;
    expect(call.args).not.toContain("fetch");
    expect(call.args).not.toContain("pull");
    expect(call.args).not.toContain("push");
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
