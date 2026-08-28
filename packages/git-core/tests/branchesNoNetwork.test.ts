import { describe, it, expect, afterEach, vi } from "vitest";

/**
 * AC17 (`specs/branch-management.md`): zero outbound network requests during a full
 * create -> switch -> delete flow (including the unmerged -> force-delete escalation), on a
 * repo with a remote configured. FR-45 makes this a static property of `branches.ts` (it never
 * passes "fetch"/"pull"/"push" to git), but this file verifies it black-box, the same way
 * `noNetworkCalls.test.ts` does for the stage/diff/commit flow — deliberately its own file for
 * the same `vi.mock` module-scoping reason documented there.
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

const { Repository } = await import("../src/index");
const { git, initRepo, writeFile, commit, cleanup } = await import("./testRepo");

const cleanupDirs: string[] = [];
afterEach(async () => {
  spawnCalls.length = 0;
  while (cleanupDirs.length) await cleanup(cleanupDirs.pop()!);
});

function assertNoNetworkSubcommand() {
  for (const call of spawnCalls) {
    if (!/git(\.exe)?$/i.test(call.command)) continue;
    expect(call.args).not.toContain("fetch");
    expect(call.args).not.toContain("pull");
    expect(call.args).not.toContain("push");
  }
}

describe("AC17: zero network calls during a full branch create -> switch -> delete flow", () => {
  it("spawns no fetch/pull/push git subcommand, even with a remote configured pointing at an unreachable host", async () => {
    const dir = await initRepo();
    cleanupDirs.push(dir);
    await writeFile(dir, "base.txt", "1\n");
    await commit(dir, "base");
    await git(dir, ["remote", "add", "origin", "https://198.51.100.1.invalid/nonexistent.git"]);

    const repo = await Repository.open(dir);

    await repo.listBranches();
    await repo.listRemoteBranches();
    await repo.createBranch({ name: "feature-a" });
    await repo.switchBranch("feature-a");
    await writeFile(dir, "base.txt", "2\n");
    await commit(dir, "unmergeable change");
    await repo.switchBranch("main");
    await expect(repo.deleteBranch("feature-a")).rejects.toThrow(); // not fully merged
    await repo.forceDeleteBranch("feature-a");

    expect(spawnCalls.length).toBeGreaterThan(0); // sanity: the spy actually captured calls
    assertNoNetworkSubcommand();
  });
});
