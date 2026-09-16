// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { resetCurrentBranch, countCommitsExclusiveToHead, type ResetMode } from "../src/reset";
import { Repository } from "../src/index";
import { GitCommandError, InvalidArgumentError, OperationAlreadyInProgressError } from "../src/errors";
import { git, initRepo, writeFile, commit, cleanup, fileExists, makeTempDir } from "./testRepo";

/**
 * specs/reset-to-here.md's git-core surface (FR-359 through FR-365): `resetCurrentBranch()` and
 * `countCommitsExclusiveToHead()`. `computeCommitPairRelationship()` (FR-365) is reused unmodified
 * from `commitPairs.ts` — see `commitPairs.test.ts` for its own coverage; nothing new to test here.
 */

const cleanupDirs: string[] = [];
afterEach(async () => {
  while (cleanupDirs.length) await cleanup(cleanupDirs.pop()!);
});

async function makeRepo(): Promise<string> {
  const dir = await initRepo();
  cleanupDirs.push(dir);
  // Matches stash.test.ts's own precedent: a machine-wide `core.autocrlf=true` (common on
  // Windows) would make the working-tree bytes this suite reads back via `fs.readFile` differ
  // from what was written/committed (LF vs CRLF), independent of anything `resetCurrentBranch()`
  // itself does — pin this repo's own local config so every assertion below is about reset
  // behavior, not an ambient host setting.
  await git(dir, ["config", "core.autocrlf", "false"]);
  return dir;
}

async function porcelain(dir: string): Promise<string> {
  const { stdout } = await git(dir, ["status", "--porcelain=v1", "--untracked-files=all"]);
  return stdout;
}

/**
 * Mirrors `testRepo.ts`'s `setUpMaliciousFsmonitorRepo()` but applies the malicious
 * `core.fsmonitor` config to an ALREADY-built repo/history, rather than seeding a single fresh
 * commit itself — needed here because every reset test wants at least two real commits (a
 * `baseSha` to reset to and a `secondSha` to reset away from) in place *before* the malicious
 * config is attached, so the test's own fixture-setup commits (which go through the raw,
 * unguarded `commit()` helper — itself a plain `git add`, which the "does not execute" guard
 * this describe block is proving doesn't apply to) never trip the marker themselves.
 */
async function attachMaliciousFsmonitor(dir: string): Promise<{ markerPath: string }> {
  const outsideDir = await makeTempDir();
  cleanupDirs.push(outsideDir);
  const markerPath = `${outsideDir.replace(/\\/g, "/")}/PWNED_MARKER`;
  const scriptPath = `${outsideDir.replace(/\\/g, "/")}/fsmonitor-marker.sh`;
  await writeFile(outsideDir, "fsmonitor-marker.sh", `#!/bin/sh\necho PWNED > "${markerPath}"\n`);
  await git(dir, ["config", "core.fsmonitor", scriptPath]);
  return { markerPath };
}

describe("resetCurrentBranch (FR-359): soft", () => {
  it("moves the branch ref but leaves the index and working tree exactly as they were — the undone commit's content ends up staged", async () => {
    const dir = await makeRepo();
    await writeFile(dir, "a.txt", "v1\n");
    const baseSha = await commit(dir, "base");
    await writeFile(dir, "a.txt", "v2\n");
    const secondSha = await commit(dir, "second");

    await resetCurrentBranch(dir, baseSha, "soft");

    expect((await git(dir, ["rev-parse", "main"])).stdout.trim()).toBe(baseSha);
    expect((await git(dir, ["rev-parse", "HEAD"])).stdout.trim()).toBe(baseSha);
    // Working tree file untouched — still second's content.
    expect(await fs.readFile(path.join(dir, "a.txt"), "utf8")).toBe("v2\n");
    // The undone commit's full change is staged, ready to re-commit.
    const staged = (await git(dir, ["diff", "--cached"])).stdout;
    expect(staged).toContain("-v1");
    expect(staged).toContain("+v2");
    // Nothing left unstaged — soft leaves the working tree identical to the index.
    expect((await git(dir, ["diff"])).stdout).toBe("");
    void secondSha;
  });
});

describe("resetCurrentBranch (FR-359): mixed", () => {
  it("moves the branch ref, resets the index to the target tree, and leaves the undone change as an unstaged working-tree modification", async () => {
    const dir = await makeRepo();
    await writeFile(dir, "a.txt", "v1\n");
    const baseSha = await commit(dir, "base");
    await writeFile(dir, "a.txt", "v2\n");
    await commit(dir, "second");

    await resetCurrentBranch(dir, baseSha, "mixed");

    expect((await git(dir, ["rev-parse", "main"])).stdout.trim()).toBe(baseSha);
    // Index now matches the target commit's tree.
    expect((await git(dir, ["diff", "--cached"])).stdout).toBe("");
    // Working tree still has second's content, now unstaged.
    expect(await fs.readFile(path.join(dir, "a.txt"), "utf8")).toBe("v2\n");
    expect(await porcelain(dir)).toBe(" M a.txt\n");
  });
});

describe("resetCurrentBranch (FR-359): hard", () => {
  it("on a clean working tree, makes the branch ref, index, and working tree all match the target commit exactly", async () => {
    const dir = await makeRepo();
    await writeFile(dir, "a.txt", "v1\n");
    const baseSha = await commit(dir, "base");
    await writeFile(dir, "a.txt", "v2\n");
    await commit(dir, "second");

    await resetCurrentBranch(dir, baseSha, "hard");

    expect((await git(dir, ["rev-parse", "main"])).stdout.trim()).toBe(baseSha);
    expect(await porcelain(dir)).toBe("");
    expect((await git(dir, ["diff", baseSha, "HEAD"])).stdout).toBe("");
    expect(await fs.readFile(path.join(dir, "a.txt"), "utf8")).toBe("v1\n");
  });

  it("discards staged and unstaged tracked-file changes, but leaves a coexisting untracked file untouched", async () => {
    const dir = await makeRepo();
    await writeFile(dir, "a.txt", "v1\n");
    await writeFile(dir, "b.txt", "orig\n");
    const baseSha = await commit(dir, "base");
    await writeFile(dir, "a.txt", "v2\n");
    await commit(dir, "second");
    // A staged tracked-file change, an unstaged tracked-file change, and a genuinely untracked
    // file, all present at the moment of reset — "untracked files are not touched" (FR-367) is
    // only a meaningful claim if the untracked path here is neither of the two tracked ones.
    await writeFile(dir, "a.txt", "dirty-staged\n");
    await git(dir, ["add", "a.txt"]);
    await writeFile(dir, "b.txt", "dirty-unstaged\n");
    await writeFile(dir, "scratch.txt", "untracked content\n");

    await resetCurrentBranch(dir, baseSha, "hard");

    expect(await porcelain(dir)).toBe("?? scratch.txt\n");
    expect(await fs.readFile(path.join(dir, "a.txt"), "utf8")).toBe("v1\n");
    expect(await fs.readFile(path.join(dir, "b.txt"), "utf8")).toBe("orig\n");
    expect(await fs.readFile(path.join(dir, "scratch.txt"), "utf8")).toBe("untracked content\n");
  });
});

describe("resetCurrentBranch (FR-359): detached HEAD", () => {
  it("moves HEAD directly without creating or moving any branch ref", async () => {
    const dir = await makeRepo();
    await writeFile(dir, "a.txt", "v1\n");
    const baseSha = await commit(dir, "base");
    await writeFile(dir, "a.txt", "v2\n");
    const secondSha = await commit(dir, "second");
    await git(dir, ["checkout", "-q", secondSha]); // detach

    await resetCurrentBranch(dir, baseSha, "hard");

    expect((await git(dir, ["rev-parse", "HEAD"])).stdout.trim()).toBe(baseSha);
    // Still detached — no branch was created or moved by this call.
    await expect(git(dir, ["symbolic-ref", "-q", "HEAD"])).rejects.toThrow();
    expect((await git(dir, ["rev-parse", "main"])).stdout.trim()).toBe(secondSha);
  });
});

describe("resetCurrentBranch (FR-359): unrelated-history target", () => {
  it("resets onto a commit with no shared history at all (no ancestry restriction)", async () => {
    const dir = await makeRepo();
    await writeFile(dir, "a.txt", "v1\n");
    await commit(dir, "base");
    await git(dir, ["checkout", "-q", "--orphan", "unrelated"]);
    await git(dir, ["reset", "--hard"]); // clear the orphan branch's inherited index/worktree
    await writeFile(dir, "z.txt", "orphan\n");
    const orphanSha = await commit(dir, "orphan root");
    await git(dir, ["checkout", "-q", "main"]);

    await resetCurrentBranch(dir, orphanSha, "hard");

    expect((await git(dir, ["rev-parse", "main"])).stdout.trim()).toBe(orphanSha);
  });
});

describe("resetCurrentBranch (FR-361): invalid targetSha", () => {
  it("throws InvalidArgumentError and makes no git call at all", async () => {
    const dir = await makeRepo();
    await writeFile(dir, "a.txt", "v1\n");
    const baseSha = await commit(dir, "base");

    await expect(resetCurrentBranch(dir, "not-a-sha!!", "soft")).rejects.toBeInstanceOf(
      InvalidArgumentError,
    );
    await expect(resetCurrentBranch(dir, "--upload-pack=/bin/sh", "hard")).rejects.toBeInstanceOf(
      InvalidArgumentError,
    );

    expect((await git(dir, ["rev-parse", "HEAD"])).stdout.trim()).toBe(baseSha);
  });
});

// Security review (2026-09-17): `mode`'s "soft" | "mixed" | "hard" union is compile-time only and
// does not survive the IPC boundary (`contextBridge` makes `window.gitHydra` reachable by any JS
// in the renderer) — a runtime allow-list check is required so an arbitrary string can never
// become a literal `--<mode>` flag reaching `git reset`.
describe("resetCurrentBranch: invalid mode (runtime allow-list, not just the compile-time union)", () => {
  it("throws InvalidArgumentError and makes no git call at all for a flag-shaped mode value", async () => {
    const dir = await makeRepo();
    await writeFile(dir, "a.txt", "v1\n");
    const baseSha = await commit(dir, "base");

    // The exact shape the security-review finding named: without a runtime check, this would
    // reach git as `git reset --pathspec-from-file=/some/path <sha>` — a real flag combination
    // well outside the three sanctioned reset modes.
    await expect(
      resetCurrentBranch(dir, baseSha, "pathspec-from-file=/some/path" as unknown as ResetMode),
    ).rejects.toBeInstanceOf(InvalidArgumentError);

    // Also cover a plain, non-flag-shaped bogus value, and confirm nothing moved either way.
    await expect(
      resetCurrentBranch(dir, baseSha, "nonsense" as unknown as ResetMode),
    ).rejects.toBeInstanceOf(InvalidArgumentError);

    expect((await git(dir, ["rev-parse", "HEAD"])).stdout.trim()).toBe(baseSha);
  });
});

describe("resetCurrentBranch (FR-360): already-in-progress refusal", () => {
  it("refuses up front, making no `git reset` call, when another operation is already in progress", async () => {
    const dir = await makeRepo();
    await writeFile(dir, "a.txt", "base\n");
    await commit(dir, "base");
    await git(dir, ["checkout", "-q", "-b", "feature"]);
    await writeFile(dir, "a.txt", "feature change\n");
    const featureSha = await commit(dir, "feature change");
    await git(dir, ["checkout", "-q", "-b", "other"]);
    await writeFile(dir, "a.txt", "other change\n");
    const otherSha = await commit(dir, "other change");
    await git(dir, ["checkout", "-q", "main"]);
    await writeFile(dir, "a.txt", "main change\n");
    const mainSha = await commit(dir, "main change");
    // Leave a real cherry-pick genuinely mid-conflict, unrelated to the reset we're about to attempt.
    await git(dir, ["cherry-pick", otherSha]).catch(() => {});
    expect(await fileExists(path.join(dir, ".git", "CHERRY_PICK_HEAD"))).toBe(true);

    let caught: unknown;
    try {
      await resetCurrentBranch(dir, featureSha, "hard");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(OperationAlreadyInProgressError);
    const typed = caught as OperationAlreadyInProgressError;
    expect(typed.operation).toBe("cherry-pick");
    expect(typed.requestedAction).toBe("reset");
    expect(typed.message).toMatch(/^Cannot reset:/);

    // Nothing moved — the pre-existing cherry-pick's conflict state and HEAD are both untouched.
    expect((await git(dir, ["rev-parse", "HEAD"])).stdout.trim()).toBe(mainSha);
    expect(await fileExists(path.join(dir, ".git", "CHERRY_PICK_HEAD"))).toBe(true);

    await git(dir, ["cherry-pick", "--abort"]);
  });
});

describe("resetCurrentBranch (FR-362): fsmonitor argument-injection guard", () => {
  it("mixed reset does NOT execute a malicious core.fsmonitor command", async () => {
    const dir = await makeRepo();
    await writeFile(dir, "a.txt", "v1\n");
    const baseSha = await commit(dir, "base");
    await writeFile(dir, "a.txt", "changed\n");
    await commit(dir, "second");
    const { markerPath } = await attachMaliciousFsmonitor(dir);
    expect(await fileExists(markerPath)).toBe(false);

    await resetCurrentBranch(dir, baseSha, "mixed");

    expect(await fileExists(markerPath)).toBe(false);
  });

  it("hard reset does NOT execute a malicious core.fsmonitor command", async () => {
    const dir = await makeRepo();
    await writeFile(dir, "a.txt", "v1\n");
    const baseSha = await commit(dir, "base");
    await writeFile(dir, "a.txt", "changed\n");
    await commit(dir, "second");
    const { markerPath } = await attachMaliciousFsmonitor(dir);
    expect(await fileExists(markerPath)).toBe(false);

    await resetCurrentBranch(dir, baseSha, "hard");

    expect(await fileExists(markerPath)).toBe(false);
  });
});

describe("countCommitsExclusiveToHead (FR-364)", () => {
  it("returns the exact undone-commit count when targetSha is an ancestor of headSha", async () => {
    const dir = await makeRepo();
    await writeFile(dir, "a.txt", "1\n");
    const baseSha = await commit(dir, "base");
    await writeFile(dir, "a.txt", "2\n");
    await commit(dir, "second");
    await writeFile(dir, "a.txt", "3\n");
    const headSha = await commit(dir, "third");

    await expect(countCommitsExclusiveToHead(dir, baseSha, headSha)).resolves.toBe(2);
  });

  it("returns 0 when targetSha is a descendant of headSha (nothing is lost)", async () => {
    const dir = await makeRepo();
    await writeFile(dir, "a.txt", "1\n");
    const headSha = await commit(dir, "base");
    await writeFile(dir, "a.txt", "2\n");
    const targetSha = await commit(dir, "second");

    await expect(countCommitsExclusiveToHead(dir, targetSha, headSha)).resolves.toBe(0);
  });

  it("returns the branch-unique count on a diverged pair", async () => {
    const dir = await makeRepo();
    await writeFile(dir, "a.txt", "1\n");
    await commit(dir, "base");
    await git(dir, ["checkout", "-q", "-b", "feature"]);
    await writeFile(dir, "f.txt", "feature\n");
    const targetSha = await commit(dir, "feature-only");
    await git(dir, ["checkout", "-q", "main"]);
    await writeFile(dir, "m1.txt", "main1\n");
    await commit(dir, "main-only-1");
    await writeFile(dir, "m2.txt", "main2\n");
    const headSha = await commit(dir, "main-only-2");

    await expect(countCommitsExclusiveToHead(dir, targetSha, headSha)).resolves.toBe(2);
  });

  it("returns headSha's full commit count on genuinely unrelated histories", async () => {
    const dir = await makeRepo();
    await writeFile(dir, "a.txt", "1\n");
    await commit(dir, "base");
    await writeFile(dir, "a.txt", "2\n");
    const headSha = await commit(dir, "second");
    await git(dir, ["checkout", "-q", "--orphan", "unrelated"]);
    await git(dir, ["reset", "--hard"]);
    await writeFile(dir, "z.txt", "orphan\n");
    const targetSha = await commit(dir, "orphan root");
    await git(dir, ["checkout", "-q", "main"]);

    await expect(countCommitsExclusiveToHead(dir, targetSha, headSha)).resolves.toBe(2);
  });

  it("returns 0 when targetSha and headSha are the same commit (already here)", async () => {
    const dir = await makeRepo();
    await writeFile(dir, "a.txt", "1\n");
    const sha = await commit(dir, "base");

    await expect(countCommitsExclusiveToHead(dir, sha, sha)).resolves.toBe(0);
  });

  it("degrades to null (never throws) for a malformed SHA", async () => {
    const dir = await makeRepo();
    await writeFile(dir, "a.txt", "1\n");
    const sha = await commit(dir, "base");

    await expect(countCommitsExclusiveToHead(dir, "not-a-sha", sha)).resolves.toBeNull();
    await expect(countCommitsExclusiveToHead(dir, sha, "not-a-sha")).resolves.toBeNull();
  });

  it("degrades to null (never throws) for a well-formed but unresolvable SHA", async () => {
    const dir = await makeRepo();
    await writeFile(dir, "a.txt", "1\n");
    const sha = await commit(dir, "base");
    const bogus = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef";

    await expect(countCommitsExclusiveToHead(dir, bogus, sha)).resolves.toBeNull();
  });
});

describe("Repository facade (resetCurrentBranch / countCommitsExclusiveToHead)", () => {
  it("round-trips a hard reset through the Repository facade", async () => {
    const dir = await makeRepo();
    await writeFile(dir, "a.txt", "v1\n");
    const baseSha = await commit(dir, "base");
    await writeFile(dir, "a.txt", "v2\n");
    await commit(dir, "second");

    const repo = await Repository.open(dir);
    await repo.resetCurrentBranch(baseSha, "hard");
    await repo.refreshState();
    expect(repo.getState().headSha).toBe(baseSha);
    expect(repo.getState().inProgressOperation).toBeNull();
  });

  it("countCommitsExclusiveToHead works through the facade too, including against a bare repository", async () => {
    // A bare repo has no worktree for `writeFile`/`commit` to act on — build the two commits in
    // an ordinary temp repo first, then `git clone --bare` it, matching how a real bare repo a
    // user might open (a shared/central remote) actually comes to exist.
    const srcDir = await makeRepo();
    await writeFile(srcDir, "a.txt", "v1\n");
    const baseSha = await commit(srcDir, "base");
    await writeFile(srcDir, "a.txt", "v2\n");
    const secondSha = await commit(srcDir, "second");
    const bareDir = `${srcDir}-bare.git`;
    cleanupDirs.push(bareDir);
    await git(path.dirname(srcDir), ["clone", "-q", "--bare", srcDir, bareDir]);

    const dir = bareDir;
    const repo = await Repository.open(dir);
    await expect(repo.countCommitsExclusiveToHead(baseSha, secondSha)).resolves.toBe(1);

    // Soft succeeds even in a bare repo (ref-only) — deliberately no bare-repo gating in git-core.
    await repo.resetCurrentBranch(baseSha, "soft");
    expect((await git(dir, ["rev-parse", "HEAD"])).stdout.trim()).toBe(baseSha);

    // Mixed/hard genuinely fail in a bare repo — as a plain GitCommandError from git itself, not
    // this package's own bare-repo wording (that gating lives in the UI layer per FR-366).
    await expect(repo.resetCurrentBranch(secondSha, "hard")).rejects.toBeInstanceOf(GitCommandError);
  });
});
