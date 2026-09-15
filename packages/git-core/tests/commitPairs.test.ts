// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect, afterEach } from "vitest";
import { computeCommitPairRelationship } from "../src/commitPairs";
import { Repository } from "../src/index";
import { InvalidArgumentError } from "../src/errors";
import { git, initRepo, makeTempDir, writeFile, commit, cleanup } from "./testRepo";

/**
 * specs/drag-commit-menu.md's git-core surface for FR-295/296: `computeCommitPairRelationship()`.
 * Covers all four documented outcomes (AC4), the shallow-clone-boundary fallback FR-295 explicitly
 * requires (never throw), and FR-296's up-front validation (malformed SHA / self-comparison).
 */

const cleanupDirs: string[] = [];
afterEach(async () => {
  while (cleanupDirs.length) await cleanup(cleanupDirs.pop()!);
});

async function makeRepo(): Promise<string> {
  const dir = await initRepo();
  cleanupDirs.push(dir);
  return dir;
}

describe("computeCommitPairRelationship (FR-295): the four documented outcomes (AC4)", () => {
  it("a-ancestor-of-b: A is a direct ancestor of B on a linear history", async () => {
    const dir = await makeRepo();
    await writeFile(dir, "a.txt", "1\n");
    const shaA = await commit(dir, "commit A");
    await writeFile(dir, "a.txt", "2\n");
    const shaB = await commit(dir, "commit B");

    const result = await computeCommitPairRelationship(dir, shaA, shaB);
    expect(result).toBe("a-ancestor-of-b");
  });

  it("b-ancestor-of-a: B is a direct ancestor of A (the reverse pairing of the same linear history)", async () => {
    const dir = await makeRepo();
    await writeFile(dir, "a.txt", "1\n");
    const shaB = await commit(dir, "commit B (older)");
    await writeFile(dir, "a.txt", "2\n");
    const shaA = await commit(dir, "commit A (newer)");

    const result = await computeCommitPairRelationship(dir, shaA, shaB);
    expect(result).toBe("b-ancestor-of-a");
  });

  it("no-common-ancestor: two genuinely disconnected orphan-branch histories", async () => {
    const dir = await makeRepo();
    await writeFile(dir, "a.txt", "main\n");
    const shaA = await commit(dir, "main root");
    await git(dir, ["checkout", "-q", "--orphan", "unrelated"]);
    await git(dir, ["rm", "-rf", "-q", "."]).catch(() => {});
    await writeFile(dir, "b.txt", "orphan\n");
    const shaB = await commit(dir, "orphan root");

    const result = await computeCommitPairRelationship(dir, shaA, shaB);
    expect(result).toBe("no-common-ancestor");
  });

  it("diverged: two branches sharing a real common ancestor but neither is an ancestor of the other", async () => {
    const dir = await makeRepo();
    await writeFile(dir, "a.txt", "base\n");
    await commit(dir, "base");
    await git(dir, ["checkout", "-q", "-b", "left"]);
    await writeFile(dir, "a.txt", "left\n");
    const shaA = await commit(dir, "left tip");
    await git(dir, ["checkout", "-q", "main"]);
    await git(dir, ["checkout", "-q", "-b", "right"]);
    await writeFile(dir, "a.txt", "right\n");
    const shaB = await commit(dir, "right tip");

    const result = await computeCommitPairRelationship(dir, shaA, shaB);
    expect(result).toBe("diverged");
  });
});

describe("computeCommitPairRelationship (FR-295): shallow-clone boundary falls back rather than throwing", () => {
  /** A real shallow clone whose oldest commit is entirely absent from the local object database —
   * verified directly (2026-09-15): `git merge-base --is-ancestor`/`git merge-base` both exit 128
   * with "fatal: Not a valid commit name ..." for a SHA outside the shallow fetch, a different
   * failure shape than the plain "no common ancestor" (exit 1, empty output) two orphan branches
   * produce — but FR-295 deliberately folds both into the same permissive fallback rather than a
   * dedicated unknown-ancestry state (see the spec's own Non-goals). */
  async function makeShallowCloneFixture(): Promise<{ dir: string; prunedSha: string; tipSha: string }> {
    const originDir = await makeRepo();
    await writeFile(originDir, "f.txt", "1\n");
    const prunedSha = await commit(originDir, "c1");
    await writeFile(originDir, "f.txt", "2\n");
    await commit(originDir, "c2");
    await writeFile(originDir, "f.txt", "3\n");
    await commit(originDir, "c3");
    await writeFile(originDir, "f.txt", "4\n");
    await commit(originDir, "c4");

    const shallowDir = await makeTempDir();
    cleanupDirs.push(shallowDir);
    // `--depth` is silently IGNORED for a plain local-path clone source ("warning: --depth is
    // ignored in local clones; use file:// instead", verified directly, 2026-09-15) — an explicit
    // `file://` URL is required to actually get a real shallow clone here, not a full one.
    const originUrl = `file://${originDir.replace(/\\/g, "/")}`;
    await git(process.cwd(), ["clone", "-q", "--depth=2", originUrl, shallowDir]);
    const { stdout: tipShaRaw } = await git(shallowDir, ["rev-parse", "HEAD"]);
    return { dir: shallowDir, prunedSha, tipSha: tipShaRaw.trim() };
  }

  it("resolves to no-common-ancestor (the permissive/enabled fallback) instead of throwing, for a SHA outside the shallow fetch", async () => {
    const { dir, prunedSha, tipSha } = await makeShallowCloneFixture();

    const result = await computeCommitPairRelationship(dir, prunedSha, tipSha);
    expect(result).toBe("no-common-ancestor");

    // Reversed argument order produces the identical fallback — neither direction is favored.
    const reversed = await computeCommitPairRelationship(dir, tipSha, prunedSha);
    expect(reversed).toBe("no-common-ancestor");
  });
});

describe("computeCommitPairRelationship (FR-296): validation before any git call", () => {
  it("rejects a malformed shaA with InvalidArgumentError", async () => {
    const dir = await makeRepo();
    await writeFile(dir, "a.txt", "1\n");
    const validSha = await commit(dir, "one");

    await expect(computeCommitPairRelationship(dir, "not-a-sha!", validSha)).rejects.toBeInstanceOf(
      InvalidArgumentError,
    );
  });

  it("rejects a malformed shaB with InvalidArgumentError", async () => {
    const dir = await makeRepo();
    await writeFile(dir, "a.txt", "1\n");
    const validSha = await commit(dir, "one");

    await expect(computeCommitPairRelationship(dir, validSha, "zzzzzzz")).rejects.toBeInstanceOf(
      InvalidArgumentError,
    );
  });

  it("rejects shaA === shaB defensively, even though the UI layer never calls this for a self-drop (FR-302)", async () => {
    const dir = await makeRepo();
    await writeFile(dir, "a.txt", "1\n");
    const sha = await commit(dir, "one");

    await expect(computeCommitPairRelationship(dir, sha, sha)).rejects.toBeInstanceOf(
      InvalidArgumentError,
    );
  });

  it("accepts an abbreviated (short) hex SHA on both sides, same as a full 40-char SHA", async () => {
    const dir = await makeRepo();
    await writeFile(dir, "a.txt", "1\n");
    const shaA = await commit(dir, "commit A");
    await writeFile(dir, "a.txt", "2\n");
    const shaB = await commit(dir, "commit B");

    const result = await computeCommitPairRelationship(dir, shaA.slice(0, 8), shaB.slice(0, 8));
    expect(result).toBe("a-ancestor-of-b");
  });
});

describe("Repository facade (computeCommitPairRelationship)", () => {
  it("round-trips through the Repository facade", async () => {
    const dir = await makeRepo();
    await writeFile(dir, "a.txt", "1\n");
    const shaA = await commit(dir, "commit A");
    await writeFile(dir, "a.txt", "2\n");
    const shaB = await commit(dir, "commit B");

    const repo = await Repository.open(dir);
    const result = await repo.computeCommitPairRelationship(shaA, shaB);
    expect(result).toBe("a-ancestor-of-b");
  });

  it("works against a bare repository (no working directory required — a pure two-commit read)", async () => {
    const dir = await makeRepo();
    await writeFile(dir, "a.txt", "1\n");
    const shaA = await commit(dir, "commit A");
    await writeFile(dir, "a.txt", "2\n");
    const shaB = await commit(dir, "commit B");

    const bareDir = await initRepo({ bare: true });
    cleanupDirs.push(bareDir);
    await git(dir, ["push", "-q", bareDir, "main"]).catch(async () => {
      // `git push` to a plain empty bare dir needs a receive; if that's unavailable in this
      // environment, fall back to fetching into the bare repo instead (equivalent end state) —
      // same fallback `diff.test.ts`'s own bare-repo fixture already uses.
      await git(bareDir, ["fetch", "-q", dir, "main:main"]);
    });

    const repo = await Repository.open(bareDir);
    expect(repo.getState().isBare).toBe(true);
    const result = await repo.computeCommitPairRelationship(shaA, shaB);
    expect(result).toBe("a-ancestor-of-b");
  });
});
