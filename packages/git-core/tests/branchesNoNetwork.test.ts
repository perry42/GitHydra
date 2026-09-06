// SPDX-License-Identifier: GPL-3.0-or-later
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
const { switchBranch, deleteBranch, createBranch } = await import("../src/branches");
const { InvalidArgumentError } = await import("../src/errors");
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

/**
 * Mirrors `commitLog.test.ts`'s "resolves a ref literally named like a flag ... proving
 * --end-of-options is actually in effect" regression, but for `assertSafeRevisionArg` — the
 * guard `branches.ts` relies on precisely because `git switch -c`/`check-ref-format`/
 * `rev-parse` do NOT honor `--end-of-options` the way `git log` does (see that function's doc
 * comment in `src/branches.ts`). A `--`-shaped ref name is a real thing a repo's on-disk refs
 * can legitimately contain (`git update-ref` doesn't enforce the same restrictions `git branch`
 * does), so this proves the guard actually fires — not just that it looks like it should —
 * and does so synchronously, before any git process is ever spawned, so a future "cleanup" of
 * `assertSafeRevisionArg` as apparently-redundant can't silently reopen the gap.
 */
describe("assertSafeRevisionArg: rejects a flag-shaped ref before any git process spawns", () => {
  it("switchBranch rejects a ref literally named like a flag, with zero spawns", async () => {
    const dir = await initRepo();
    cleanupDirs.push(dir);
    await writeFile(dir, "a.txt", "1");
    const sha = await commit(dir, "first");
    await git(dir, ["update-ref", "refs/heads/--upload-pack", sha]);
    spawnCalls.length = 0; // clear the setup calls above; only count calls from switchBranch itself.

    await expect(switchBranch(dir, "--upload-pack")).rejects.toBeInstanceOf(InvalidArgumentError);
    expect(spawnCalls.length).toBe(0);
  });

  it("deleteBranch rejects a ref literally named like a flag, with zero spawns", async () => {
    const dir = await initRepo();
    cleanupDirs.push(dir);
    await writeFile(dir, "a.txt", "1");
    const sha = await commit(dir, "first");
    await git(dir, ["update-ref", "refs/heads/--upload-pack", sha]);
    spawnCalls.length = 0;

    await expect(deleteBranch(dir, "--upload-pack")).rejects.toBeInstanceOf(InvalidArgumentError);
    expect(spawnCalls.length).toBe(0);
  });

  it("createBranch rejects a flag-shaped start point before ever spawning `git branch`/`git switch`", async () => {
    const dir = await initRepo();
    cleanupDirs.push(dir);
    await writeFile(dir, "a.txt", "1");
    const sha = await commit(dir, "first");
    await git(dir, ["update-ref", "refs/heads/--upload-pack", sha]);
    spawnCalls.length = 0; // clear the setup calls; only inspect calls made by createBranch itself.

    await expect(
      createBranch(dir, { name: "safe-name", startPoint: "--upload-pack" }),
    ).rejects.toBeInstanceOf(InvalidArgumentError);
    // `name` is valid, so createBranch's own non-mutating `check-ref-format` validation call is
    // expected here — the guarantee under test is that the flag-shaped start point is caught
    // before the actual mutating `branch`/`switch` call, not that nothing was spawned at all.
    for (const call of spawnCalls) {
      expect(call.args).not.toContain("branch");
      expect(call.args).not.toContain("switch");
    }
  });
});
