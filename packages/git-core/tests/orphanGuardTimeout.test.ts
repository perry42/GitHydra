// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect, afterEach, vi } from "vitest";
import { GitCommandTimeoutError, GitCommandError } from "../src/errors";
import { git, initRepo, writeFile, commit, cleanup } from "./testRepo";

let failMode: "timeout" | "garbage" | "exit128" | null = null;

vi.mock("../src/gitProcess", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/gitProcess")>();
  return {
    ...actual,
    runGit: (args: readonly string[], opts: Parameters<typeof actual.runGit>[1]) => {
      if (failMode && args[0] === "rev-list") {
        if (failMode === "timeout") return Promise.reject(new GitCommandTimeoutError(args, 10_000));
        if (failMode === "exit128") return Promise.reject(new GitCommandError("boom", args, 128, "fatal: x"));
        return Promise.resolve({ stdout: "this is not rev-list output\n", stderr: "" });
      }
      return actual.runGit(args, opts);
    },
  };
});

const cleanupDirs: string[] = [];
afterEach(async () => {
  failMode = null;
  while (cleanupDirs.length) await cleanup(cleanupDirs.pop()!);
});

async function detachedRepo(): Promise<string> {
  const dir = await initRepo();
  cleanupDirs.push(dir);
  await writeFile(dir, "a.txt", "1\n");
  await commit(dir, "base");
  await git(dir, ["checkout", "-q", "--detach"]);
  await writeFile(dir, "a.txt", "2\n");
  await commit(dir, "orphan");
  return dir;
}

describe("getOrphanedHeadCommits fails closed", () => {
  it("returns status unknown / reason timeout when the rev-list times out", async () => {
    const { getOrphanedHeadCommits } = await import("../src/orphanGuard");
    const dir = await detachedRepo();
    failMode = "timeout";
    const r = await getOrphanedHeadCommits(dir);
    expect(r).toMatchObject({ status: "unknown", reason: "timeout", total: 0 });
  });

  it("returns unknown when rev-list exits non-zero", async () => {
    const { getOrphanedHeadCommits } = await import("../src/orphanGuard");
    const dir = await detachedRepo();
    failMode = "exit128";
    expect(await getOrphanedHeadCommits(dir)).toMatchObject({ status: "unknown", reason: "error" });
  });

  it("returns unknown (not an empty list) when rev-list output cannot be parsed", async () => {
    const { getOrphanedHeadCommits } = await import("../src/orphanGuard");
    const dir = await detachedRepo();
    failMode = "garbage";
    const r = await getOrphanedHeadCommits(dir);
    expect(r.status).toBe("unknown");
    expect(r.shown).toEqual([]);
  });
});
