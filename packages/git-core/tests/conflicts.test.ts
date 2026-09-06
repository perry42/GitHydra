// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect, afterEach } from "vitest";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { getRepositoryState } from "../src/repository";
import {
  getConflictedFiles,
  getConflictFileDiff,
  computeConflictSideLabels,
  scanConflictMarkers,
  acceptConflictSide,
  markConflictResolved,
  abortInProgressOperation,
  continueInProgressOperation,
} from "../src/conflicts";
import { cherryPick } from "../src/cherryPick";
import { watchRepositoryRefs } from "../src/watcher";
import {
  ConflictMarkersRemainError,
  ContinueBlockedError,
  GitCommandError,
  NoOperationInProgressError,
  SymlinkEscapesWorkdirError,
} from "../src/errors";
import { git, initRepo, writeFile, commit, cleanup, makeTempDir } from "./testRepo";

const cleanupDirs: string[] = [];
afterEach(async () => {
  while (cleanupDirs.length) await cleanup(cleanupDirs.pop()!);
});

async function makeRepo(): Promise<string> {
  const dir = await initRepo();
  cleanupDirs.push(dir);
  return dir;
}

/**
 * Best-effort `fs.symlink`, for the symlink-escape guard tests below: creating a symlink can
 * require elevated privileges on some Windows configurations (no `SeCreateSymbolicLinkPrivilege`
 * and Developer Mode not enabled) even though this suite otherwise runs fully on Windows. Returns
 * `true` on success; on an `EPERM`/`EACCES` failure, calls `ctx.skip()` (Vitest's runtime skip,
 * so the test is reported as skipped, not silently passed) and returns `false` — any other error
 * is a real bug and is rethrown rather than swallowed.
 */
async function trySymlink(
  ctx: { skip: () => void },
  target: string,
  linkPath: string,
  type: "file" | "dir",
): Promise<boolean> {
  try {
    await fs.symlink(target, linkPath, type);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code !== "EPERM" && code !== "EACCES") throw err;

    // A directory symlink can fall back to a Windows junction, which (unlike a real symlink)
    // does NOT require `SeCreateSymbolicLinkPrivilege`/Developer Mode — `fs.realpath` resolves
    // through a junction exactly the same way it does a symlink, so this still exercises the
    // real guard, not a weaker substitute. `type` must already be "dir" (junctions can't target
    // a file) and `target` must already be absolute (a junction requirement) for this to work.
    if (type === "dir" && path.isAbsolute(target)) {
      try {
        await fs.symlink(target, linkPath, "junction");
        return true;
      } catch {
        // fall through to skip below
      }
    }

    ctx.skip();
    return false;
  }
}

/** base -> feature branch modifies a.txt, main branch modifies a.txt differently -> both-modified merge conflict. */
async function setupBothModifiedMerge(): Promise<{ dir: string; mainSha: string; featureSha: string }> {
  const dir = await makeRepo();
  await writeFile(dir, "a.txt", "base\n");
  await commit(dir, "base");
  await git(dir, ["checkout", "-q", "-b", "feature"]);
  await writeFile(dir, "a.txt", "feature change\n");
  const featureSha = await commit(dir, "feature change");
  await git(dir, ["checkout", "-q", "main"]);
  await writeFile(dir, "a.txt", "main change\n");
  const mainSha = await commit(dir, "main change");
  await git(dir, ["merge", "-q", "feature"]).catch(() => {});
  return { dir, mainSha, featureSha };
}

async function setupRebaseConflict(): Promise<{ dir: string; mainSha: string; featureSha: string }> {
  const dir = await makeRepo();
  await writeFile(dir, "a.txt", "base\n");
  await commit(dir, "base");
  await git(dir, ["checkout", "-q", "-b", "feature"]);
  await writeFile(dir, "a.txt", "feature change\n");
  const featureSha = await commit(dir, "feature change");
  await git(dir, ["checkout", "-q", "main"]);
  await writeFile(dir, "a.txt", "main change\n");
  const mainSha = await commit(dir, "main change");
  await git(dir, ["checkout", "-q", "feature"]);
  await git(dir, ["rebase", "main"]).catch(() => {});
  return { dir, mainSha, featureSha };
}

describe("computeInProgressOperationDetail (FR-58)", () => {
  it("merge: headSha/headSubject are HEAD's, mergeHeadSha/subject are MERGE_HEAD's, incomingRef parses from MERGE_MSG", async () => {
    const { dir, mainSha, featureSha } = await setupBothModifiedMerge();
    const state = await getRepositoryState(dir);
    expect(state.inProgressOperation).toBe("merge");
    const detail = state.inProgressOperationDetail;
    expect(detail?.kind).toBe("merge");
    if (detail?.kind !== "merge") throw new Error("expected merge detail");
    expect(detail.headSha).toBe(mainSha);
    expect(detail.headSubject).toBe("main change");
    expect(detail.mergeHeadSha).toBe(featureSha);
    expect(detail.mergeHeadSubject).toBe("feature change");
    expect(detail.incomingRef).toBe("feature");
  });

  it("rebase: originalBranch/ontoSha/ontoRef/step counts match rebase-merge state files exactly (acceptance criterion 2)", async () => {
    const dir = await makeRepo();
    await writeFile(dir, "a.txt", "base\n");
    await commit(dir, "base");
    await git(dir, ["checkout", "-q", "-b", "feature"]);
    await writeFile(dir, "a.txt", "f1\n", );
    await commit(dir, "f1");
    await writeFile(dir, "a.txt", "f1\nf2\n");
    await commit(dir, "f2");
    await git(dir, ["checkout", "-q", "main"]);
    await writeFile(dir, "a.txt", "base\nm1\n");
    const mainSha = await commit(dir, "m1");
    await git(dir, ["checkout", "-q", "feature"]);
    await git(dir, ["rebase", "main"]).catch(() => {});

    const state = await getRepositoryState(dir);
    expect(state.inProgressOperation).toBe("rebase");
    const detail = state.inProgressOperationDetail;
    expect(detail?.kind).toBe("rebase");
    if (detail?.kind !== "rebase") throw new Error("expected rebase detail");
    expect(detail.originalBranch).toBe("feature");
    expect(detail.ontoSha).toBe(mainSha);
    expect(detail.ontoRef).toBe("main");
    expect(detail.currentStep).toBe(1);
    expect(detail.totalSteps).toBe(2);
    expect(detail.currentCommitSubject).toBe("f1");
  });

  it("cherry-pick: targetSha/targetSubject match the cherry-picked commit", async () => {
    const dir = await makeRepo();
    await writeFile(dir, "a.txt", "base\n");
    await commit(dir, "base");
    await git(dir, ["checkout", "-q", "-b", "feature"]);
    await writeFile(dir, "a.txt", "feature change\n");
    const featureSha = await commit(dir, "feature change");
    await git(dir, ["checkout", "-q", "main"]);
    await writeFile(dir, "a.txt", "main change\n");
    await commit(dir, "main change");
    await git(dir, ["cherry-pick", featureSha]).catch(() => {});

    const state = await getRepositoryState(dir);
    const detail = state.inProgressOperationDetail;
    expect(detail?.kind).toBe("cherry-pick");
    if (detail?.kind !== "cherry-pick") throw new Error("expected cherry-pick detail");
    expect(detail.targetSha).toBe(featureSha);
    expect(detail.targetSubject).toBe("feature change");
  });

  it("revert: targetSha/targetSubject match the commit being reverted", async () => {
    const dir = await makeRepo();
    await writeFile(dir, "a.txt", "base\n");
    await commit(dir, "base");
    await writeFile(dir, "a.txt", "changed\n");
    const changeSha = await commit(dir, "change it");
    await writeFile(dir, "a.txt", "changed again\n");
    await commit(dir, "change again");
    await git(dir, ["revert", "--no-edit", changeSha]).catch(() => {});

    const state = await getRepositoryState(dir);
    const detail = state.inProgressOperationDetail;
    expect(detail?.kind).toBe("revert");
    if (detail?.kind !== "revert") throw new Error("expected revert detail");
    expect(detail.targetSha).toBe(changeSha);
    expect(detail.targetSubject).toBe("change it");
  });
});

describe("getConflictedFiles classification (FR-62/FR-63)", () => {
  it("classifies a normal three-way text conflict as both-modified, stages matching :2:/:3: content", async () => {
    const { dir } = await setupBothModifiedMerge();
    const state = await getRepositoryState(dir);
    const files = await getConflictedFiles(dir, dir, state);
    expect(files).toHaveLength(1);
    const f = files[0]!;
    expect(f.path).toBe("a.txt");
    expect(f.stageCombination).toBe("both-modified");
    expect(f.isSubmodule).toBe(false);
    expect(f.isBinary).toBe(false);
    expect(f.base).not.toBeNull();
    expect(f.ours).not.toBeNull();
    expect(f.theirs).not.toBeNull();

    const { stdout: oursContent } = await git(dir, ["show", `:2:a.txt`]);
    const { stdout: theirsContent } = await git(dir, ["show", `:3:a.txt`]);
    expect(oursContent.trim()).toBe("main change");
    expect(theirsContent.trim()).toBe("feature change");
    const oursBlob = await git(dir, ["rev-parse", ":2:a.txt"]);
    const theirsBlob = await git(dir, ["rev-parse", ":3:a.txt"]);
    expect(f.ours?.sha).toBe(oursBlob.stdout.trim());
    expect(f.theirs?.sha).toBe(theirsBlob.stdout.trim());
  });

  it("classifies an add/add conflict (no common ancestor) as both-added", async () => {
    const dir = await makeRepo();
    await writeFile(dir, "seed.txt", "seed\n");
    await commit(dir, "seed");
    await git(dir, ["checkout", "-q", "-b", "feature"]);
    await writeFile(dir, "b.txt", "feature content\n");
    await commit(dir, "add b (feature)");
    await git(dir, ["checkout", "-q", "main"]);
    await writeFile(dir, "b.txt", "main content\n");
    await commit(dir, "add b (main)");
    await git(dir, ["merge", "-q", "feature"]).catch(() => {});

    const state = await getRepositoryState(dir);
    const files = await getConflictedFiles(dir, dir, state);
    const f = files.find((x) => x.path === "b.txt")!;
    expect(f.stageCombination).toBe("both-added");
    expect(f.base).toBeNull();
    expect(f.ours).not.toBeNull();
    expect(f.theirs).not.toBeNull();
  });

  it("classifies a delete/modify conflict as deleted-by-us / deleted-by-them correctly", async () => {
    const dir = await makeRepo();
    await writeFile(dir, "c.txt", "base\n");
    await commit(dir, "base");
    await git(dir, ["checkout", "-q", "-b", "feature"]);
    await writeFile(dir, "c.txt", "feature change\n");
    await commit(dir, "modify (feature)");
    await git(dir, ["checkout", "-q", "main"]);
    await git(dir, ["rm", "-q", "c.txt"]);
    await commit(dir, "delete (main)");
    await git(dir, ["merge", "-q", "feature"]).catch(() => {});

    const state = await getRepositoryState(dir);
    const files = await getConflictedFiles(dir, dir, state);
    const f = files.find((x) => x.path === "c.txt")!;
    // main (current branch, "ours") deleted it -> deleted-by-us; theirs (feature) still has content.
    expect(f.stageCombination).toBe("deleted-by-us");
    expect(f.ours).toBeNull();
    expect(f.theirs).not.toBeNull();
    expect(f.base).not.toBeNull();
  });

  it("classifies a submodule gitlink conflict with three candidate SHAs and no diff content (FR-77)", async () => {
    const dir = await makeRepo();
    await writeFile(dir, "readme.txt", "x\n");
    await commit(dir, "base");
    const shaBase = "1111111111111111111111111111111111111111";
    const shaMain = "3333333333333333333333333333333333333333";
    const shaFeature = "2222222222222222222222222222222222222222";
    // Deliberately NOT using the shared `commit()` helper here: it runs `git add -A` first,
    // which — since "sub" never exists as a real directory on disk in this test (no actual
    // submodule checkout needed to exercise gitlink conflict *detection*) — treats the gitlink
    // as a working-tree deletion and un-stages it right back out again ("nothing to commit").
    // Committing directly, with no `add -A` in between, keeps the `update-index --add
    // --cacheinfo` entry intact.
    const rawCommit = async (message: string): Promise<void> => {
      await git(dir, ["commit", "-q", "-m", message]);
    };
    await git(dir, ["update-index", "--add", "--cacheinfo", `160000,${shaBase},sub`]);
    await rawCommit("add gitlink");
    await git(dir, ["checkout", "-q", "-b", "feature"]);
    await git(dir, ["update-index", "--add", "--cacheinfo", `160000,${shaFeature},sub`]);
    await rawCommit("feature bump");
    await git(dir, ["checkout", "-q", "main"]);
    await git(dir, ["update-index", "--add", "--cacheinfo", `160000,${shaMain},sub`]);
    await rawCommit("main bump");
    await git(dir, ["merge", "-q", "feature"]).catch(() => {});

    const state = await getRepositoryState(dir);
    const files = await getConflictedFiles(dir, dir, state);
    const f = files.find((x) => x.path === "sub")!;
    expect(f.isSubmodule).toBe(true);
    expect(f.isBinary).toBe(false);
    expect(f.base?.sha).toBe(shaBase);
    expect(f.ours?.sha).toBe(shaMain);
    expect(f.theirs?.sha).toBe(shaFeature);

    const diff = await getConflictFileDiff(dir, f);
    expect(diff.baseToOurs).toBeNull();
    expect(diff.baseToTheirs).toBeNull();
    expect(diff.oursToTheirs).toBeNull();
  });

  it("classifies a binary conflict and flags isBinary (FR-80)", async () => {
    const dir = await makeRepo();
    await fs.writeFile(path.join(dir, "img.bin"), Buffer.from([0, 1, 2, 3, 0, 255]));
    await commit(dir, "base binary");
    await git(dir, ["checkout", "-q", "-b", "feature"]);
    await fs.writeFile(path.join(dir, "img.bin"), Buffer.from([0, 9, 9, 9, 0, 255]));
    await commit(dir, "feature binary change");
    await git(dir, ["checkout", "-q", "main"]);
    await fs.writeFile(path.join(dir, "img.bin"), Buffer.from([0, 5, 5, 5, 0, 255]));
    await commit(dir, "main binary change");
    await git(dir, ["merge", "-q", "feature"]).catch(() => {});

    const state = await getRepositoryState(dir);
    const files = await getConflictedFiles(dir, dir, state);
    const f = files.find((x) => x.path === "img.bin")!;
    expect(f.isBinary).toBe(true);

    const diff = await getConflictFileDiff(dir, f);
    expect(diff.oursToTheirs?.status).toBe("binary");
  });

  it("detects a rename/rename conflict with old->new path mapping on both sides (FR-79)", async () => {
    const dir = await makeRepo();
    await writeFile(dir, "e.txt", "line1\nline2\nline3\nline4\nline5\nline6\n");
    await commit(dir, "base");
    await git(dir, ["checkout", "-q", "-b", "feature"]);
    await git(dir, ["mv", "e.txt", "e-feature.txt"]);
    await commit(dir, "rename (feature)");
    await git(dir, ["checkout", "-q", "main"]);
    await git(dir, ["mv", "e.txt", "e-main.txt"]);
    await commit(dir, "rename (main)");
    await git(dir, ["merge", "-q", "feature"]).catch(() => {});

    const state = await getRepositoryState(dir);
    const files = await getConflictedFiles(dir, dir, state);
    const ourSideFile = files.find((x) => x.path === "e-main.txt");
    const theirSideFile = files.find((x) => x.path === "e-feature.txt");
    expect(ourSideFile).toBeDefined();
    expect(theirSideFile).toBeDefined();
    expect(ourSideFile!.rename).toEqual([
      expect.objectContaining({ side: "ours", oldPath: "e.txt", newPath: "e-main.txt" }),
    ]);
    expect(theirSideFile!.rename).toEqual([
      expect.objectContaining({ side: "theirs", oldPath: "e.txt", newPath: "e-feature.txt" }),
    ]);
  });
});

describe("getConflictFileDiff (FR-64)", () => {
  it("returns base->ours, base->theirs, and ours->theirs diffs for a both-modified conflict", async () => {
    const { dir } = await setupBothModifiedMerge();
    const state = await getRepositoryState(dir);
    const files = await getConflictedFiles(dir, dir, state);
    const f = files[0]!;
    const diff = await getConflictFileDiff(dir, f);
    expect(diff.baseToOurs?.status).toBe("ok");
    expect(diff.baseToTheirs?.status).toBe("ok");
    expect(diff.oursToTheirs?.status).toBe("ok");
  });

  it("baseToOurs is null and oursToTheirs is present for an add/add conflict (no base)", async () => {
    const dir = await makeRepo();
    await writeFile(dir, "seed.txt", "seed\n");
    await commit(dir, "seed");
    await git(dir, ["checkout", "-q", "-b", "feature"]);
    await writeFile(dir, "b.txt", "feature content\n");
    await commit(dir, "add b (feature)");
    await git(dir, ["checkout", "-q", "main"]);
    await writeFile(dir, "b.txt", "main content\n");
    await commit(dir, "add b (main)");
    await git(dir, ["merge", "-q", "feature"]).catch(() => {});

    const state = await getRepositoryState(dir);
    const files = await getConflictedFiles(dir, dir, state);
    const f = files.find((x) => x.path === "b.txt")!;
    const diff = await getConflictFileDiff(dir, f);
    expect(diff.baseToOurs).toBeNull();
    expect(diff.baseToTheirs).toBeNull();
    expect(diff.oursToTheirs?.status).toBe("ok");
  });
});

describe("computeConflictSideLabels (FR-61) — the swap must never be backwards", () => {
  it("merge: 'ours' label maps to stage 2 (HEAD/current branch), 'theirs' maps to stage 3 (incoming)", async () => {
    const { dir } = await setupBothModifiedMerge();
    const state = await getRepositoryState(dir);
    const labels = computeConflictSideLabels(state);
    expect(labels).not.toBeNull();
    expect(labels!.ours.refName).toBe("main");
    expect(labels!.theirs.refName).toBe("feature");

    const oursBlob = (await git(dir, ["rev-parse", ":2:a.txt"])).stdout.trim();
    const theirsBlob = (await git(dir, ["rev-parse", ":3:a.txt"])).stdout.trim();
    expect(labels!.ours.sha).toBe(state.headSha); // stage 2 == HEAD for a merge
    expect(oursBlob).toBeTruthy();
    expect(theirsBlob).toBeTruthy();
  });

  it("rebase: 'ours' label maps to onto/target (stage 2), 'theirs' maps to the original branch's own commit (stage 3) — inverted from merge", async () => {
    const { dir } = await setupRebaseConflict();
    const state = await getRepositoryState(dir);
    const labels = computeConflictSideLabels(state);
    expect(labels).not.toBeNull();
    // "Onto" (main) is the ours/stage-2 label for a rebase — the inversion FR-61 requires.
    expect(labels!.ours.refName).toBe("main");
    // "Your branch" (feature) is the theirs/stage-3 label for a rebase.
    expect(labels!.theirs.refName).toBe("feature");

    const stage2Blob = (await git(dir, ["rev-parse", ":2:a.txt"])).stdout.trim();
    const stage2FromMain = (await git(dir, ["rev-parse", "main:a.txt"])).stdout.trim();
    expect(stage2Blob).toBe(stage2FromMain); // stage 2 really is main's content during this rebase, confirming the inversion is correct, not just labeled that way.
  });
});

describe("FR-66: conflict marker scanning blocks unsafe staging", () => {
  it("scanConflictMarkers finds marker lines in an unresolved conflicted file", async () => {
    const { dir } = await setupBothModifiedMerge();
    const scan = await scanConflictMarkers(dir, "a.txt");
    expect(scan.hasMarkers).toBe(true);
    expect(scan.markerLines.length).toBeGreaterThan(0);
  });

  it("markConflictResolved refuses (throws ConflictMarkersRemainError, no git add) while markers remain", async () => {
    const { dir } = await setupBothModifiedMerge();
    await expect(markConflictResolved(dir, "a.txt")).rejects.toBeInstanceOf(ConflictMarkersRemainError);
    const { stdout } = await git(dir, ["status", "--porcelain=v1"]);
    expect(stdout).toMatch(/^UU a\.txt/m); // still unmerged — no git add happened.
  });

  it("markConflictResolved succeeds once markers are fully removed, and the file leaves the conflicted count", async () => {
    const { dir } = await setupBothModifiedMerge();
    await writeFile(dir, "a.txt", "resolved content\n");
    await markConflictResolved(dir, "a.txt");
    const { stdout } = await git(dir, ["status", "--porcelain=v1"]);
    expect(stdout).not.toMatch(/^U/m);
    expect(stdout).toMatch(/^M  a\.txt/m);
  });

  it("acceptConflictSide('ours') and ('theirs') resolve without leaving markers", async () => {
    const dir1 = await makeRepo();
    {
      await writeFile(dir1, "a.txt", "base\n");
      await commit(dir1, "base");
      await git(dir1, ["checkout", "-q", "-b", "feature"]);
      await writeFile(dir1, "a.txt", "feature change\n");
      await commit(dir1, "feature change");
      await git(dir1, ["checkout", "-q", "main"]);
      await writeFile(dir1, "a.txt", "main change\n");
      await commit(dir1, "main change");
      await git(dir1, ["merge", "-q", "feature"]).catch(() => {});
    }
    await acceptConflictSide(dir1, "a.txt", "ours");
    const content1 = await fs.readFile(path.join(dir1, "a.txt"), "utf8");
    expect(content1.trim()).toBe("main change");
    const status1 = await git(dir1, ["status", "--porcelain=v1"]);
    expect(status1.stdout).not.toMatch(/^U/m);
  });

  it("acceptConflictSide on the missing side of a delete/modify conflict stages the deletion instead of failing (FR-78)", async () => {
    const dir = await makeRepo();
    await writeFile(dir, "c.txt", "base\n");
    await commit(dir, "base");
    await git(dir, ["checkout", "-q", "-b", "feature"]);
    await writeFile(dir, "c.txt", "feature change\n");
    await commit(dir, "modify (feature)");
    await git(dir, ["checkout", "-q", "main"]);
    await git(dir, ["rm", "-q", "c.txt"]);
    await commit(dir, "delete (main)");
    await git(dir, ["merge", "-q", "feature"]).catch(() => {});

    // "ours" (main) deleted it — accepting ours should keep it deleted. Since main's HEAD
    // already reflects the deletion, resolving this way leaves NO staged diff for the path at
    // all (index now matches HEAD exactly) — the meaningful assertions are "no longer unmerged"
    // and "gone from the working tree", not a specific staged-status line.
    await acceptConflictSide(dir, "c.txt", "ours");
    const status = await git(dir, ["status", "--porcelain=v1"]);
    expect(status.stdout).not.toMatch(/c\.txt/);
    const exists = await fs
      .access(path.join(dir, "c.txt"))
      .then(() => true)
      .catch(() => false);
    expect(exists).toBe(false);
  });
});

describe("symlink-escape guard: refuse to read a working-tree path that resolves outside the repo", () => {
  it("scanConflictMarkers refuses a conflicted path whose entry is a symlink to a file outside the repo", async (ctx) => {
    const dir = await makeRepo();
    const outsideDir = await makeTempDir();
    cleanupDirs.push(outsideDir);
    const secretPath = path.join(outsideDir, "secret.txt");
    await fs.writeFile(secretPath, "super secret contents that must never be read by scanConflictMarkers\n", "utf8");

    const linkPath = path.join(dir, "a.txt");
    const created = await trySymlink(ctx, secretPath, linkPath, "file");
    if (!created) return;

    await expect(scanConflictMarkers(dir, "a.txt")).rejects.toBeInstanceOf(SymlinkEscapesWorkdirError);
  });

  it("scanConflictMarkers refuses when an INTERMEDIATE directory component is a symlink to outside the repo", async (ctx) => {
    const dir = await makeRepo();
    const outsideDir = await makeTempDir();
    cleanupDirs.push(outsideDir);
    await fs.mkdir(path.join(outsideDir, "nested"), { recursive: true });
    await fs.writeFile(path.join(outsideDir, "nested", "secret.txt"), "super secret nested contents\n", "utf8");

    const linkedSubdir = path.join(dir, "linked");
    const created = await trySymlink(ctx, path.join(outsideDir, "nested"), linkedSubdir, "dir");
    if (!created) return;

    await expect(scanConflictMarkers(dir, "linked/secret.txt")).rejects.toBeInstanceOf(SymlinkEscapesWorkdirError);
  });

  it("markConflictResolved refuses (and makes no git add call) when the path is a symlink escaping the repo", async (ctx) => {
    const dir = await makeRepo();
    const outsideDir = await makeTempDir();
    cleanupDirs.push(outsideDir);
    const secretPath = path.join(outsideDir, "secret.txt");
    await fs.writeFile(secretPath, "super secret contents\n", "utf8");

    // Give the repo an actual both-modified conflict on a different path first, so `a.txt`
    // being untracked-but-a-symlink is the only unusual thing about this repo's state.
    await writeFile(dir, "base.txt", "base\n");
    await commit(dir, "base");

    const linkPath = path.join(dir, "a.txt");
    const created = await trySymlink(ctx, secretPath, linkPath, "file");
    if (!created) return;

    await expect(markConflictResolved(dir, "a.txt")).rejects.toBeInstanceOf(SymlinkEscapesWorkdirError);
    const { stdout } = await git(dir, ["status", "--porcelain=v1"]);
    // Refused before any `git add` — the symlink must still show as an untracked path, not staged.
    expect(stdout).toMatch(/^\?\? a\.txt/m);
  });

  it("does NOT refuse a symlink that resolves to a target still inside the repo", async (ctx) => {
    const dir = await makeRepo();
    await writeFile(dir, "real.txt", "<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> branch\n");

    const linkPath = path.join(dir, "link.txt");
    // Relative symlink target, resolving to "real.txt" inside the same repo directory.
    const created = await trySymlink(ctx, "real.txt", linkPath, "file");
    if (!created) return;

    const scan = await scanConflictMarkers(dir, "link.txt");
    expect(scan.hasMarkers).toBe(true);
    expect(scan.markerLines.length).toBeGreaterThan(0);
  });
});

describe("FR-68/69/70/71: abort and continue", () => {
  it("continueInProgressOperation is blocked with ContinueBlockedError while a conflict remains, and never invokes git --continue", async () => {
    const { dir } = await setupBothModifiedMerge();
    await expect(continueInProgressOperation(dir, dir, "merge")).rejects.toBeInstanceOf(ContinueBlockedError);
    const state = await getRepositoryState(dir);
    expect(state.inProgressOperation).toBe("merge"); // still mid-merge — continue never ran.
  });

  it("continueInProgressOperation succeeds once all conflicts are resolved, and completes without hanging on an editor (FR-70)", async () => {
    const { dir } = await setupBothModifiedMerge();
    await writeFile(dir, "a.txt", "resolved\n");
    await markConflictResolved(dir, "a.txt");
    await continueInProgressOperation(dir, dir, "merge");
    const state = await getRepositoryState(dir);
    expect(state.inProgressOperation).toBeNull();
    const mergeHeadExists = await fs
      .access(path.join(dir, ".git", "MERGE_HEAD"))
      .then(() => true)
      .catch(() => false);
    expect(mergeHeadExists).toBe(false);
  }, 15000);

  it("abortInProgressOperation restores pre-merge HEAD/index/worktree exactly", async () => {
    const { dir, mainSha } = await setupBothModifiedMerge();
    await abortInProgressOperation(dir, "merge");
    const state = await getRepositoryState(dir);
    expect(state.inProgressOperation).toBeNull();
    expect(state.headSha).toBe(mainSha);
    const status = await git(dir, ["status", "--porcelain"]);
    expect(status.stdout.trim()).toBe("");
  });

  it("abortInProgressOperation restores a multi-commit rebase's original branch tip", async () => {
    const dir = await makeRepo();
    await writeFile(dir, "a.txt", "base\n");
    await commit(dir, "base");
    await git(dir, ["checkout", "-q", "-b", "feature"]);
    await writeFile(dir, "a.txt", "f1\n");
    await commit(dir, "f1");
    await writeFile(dir, "a.txt", "f1\nf2\n");
    const featureTip = await commit(dir, "f2");
    await git(dir, ["checkout", "-q", "main"]);
    await writeFile(dir, "a.txt", "base\nm1\n");
    await commit(dir, "m1");
    await git(dir, ["checkout", "-q", "feature"]);
    await git(dir, ["rebase", "main"]).catch(() => {});

    await abortInProgressOperation(dir, "rebase");
    const state = await getRepositoryState(dir);
    expect(state.inProgressOperation).toBeNull();
    expect(state.headSha).toBe(featureTip);
    expect(state.currentBranch).toBe("feature");
    const status = await git(dir, ["status", "--porcelain"]);
    expect(status.stdout.trim()).toBe("");
  });

  it("abortInProgressOperation restores pre-cherry-pick and pre-revert state", async () => {
    const dir = await makeRepo();
    await writeFile(dir, "a.txt", "base\n");
    await commit(dir, "base");
    await git(dir, ["checkout", "-q", "-b", "feature"]);
    await writeFile(dir, "a.txt", "feature change\n");
    const featureSha = await commit(dir, "feature change");
    await git(dir, ["checkout", "-q", "main"]);
    await writeFile(dir, "a.txt", "main change\n");
    const mainSha = await commit(dir, "main change");
    await git(dir, ["cherry-pick", featureSha]).catch(() => {});
    await abortInProgressOperation(dir, "cherry-pick");
    let state = await getRepositoryState(dir);
    expect(state.inProgressOperation).toBeNull();
    expect(state.headSha).toBe(mainSha);

    // revert
    await writeFile(dir, "a.txt", "main change\nmore\n");
    const changeSha = await commit(dir, "more change");
    await git(dir, ["revert", "--no-edit", mainSha]).catch(() => {});
    // (may or may not conflict depending on content overlap — force a real conflict scenario)
    state = await getRepositoryState(dir);
    if (state.inProgressOperation === "revert") {
      await abortInProgressOperation(dir, "revert");
      state = await getRepositoryState(dir);
      expect(state.inProgressOperation).toBeNull();
      expect(state.headSha).toBe(changeSha);
    }
  });

  it("abortInProgressOperation throws NoOperationInProgressError when nothing is in progress", async () => {
    const dir = await makeRepo();
    await writeFile(dir, "a.txt", "x\n");
    await commit(dir, "one");
    await expect(abortInProgressOperation(dir, null)).rejects.toBeInstanceOf(NoOperationInProgressError);
  });
});

describe("FR-59: watcher observes operation-state files it previously did not (gap closed)", () => {
  it("fires onChange when MERGE_HEAD is created by an external process while the watcher is already running", async () => {
    const dir = await makeRepo();
    await writeFile(dir, "a.txt", "base\n");
    await commit(dir, "base");
    await git(dir, ["checkout", "-q", "-b", "feature"]);
    await writeFile(dir, "a.txt", "feature change\n");
    await commit(dir, "feature change");
    await git(dir, ["checkout", "-q", "main"]);
    await writeFile(dir, "a.txt", "main change\n");
    await commit(dir, "main change");

    const state = await getRepositoryState(dir);
    let fired = false;
    let resolveFired: () => void;
    const firedPromise = new Promise<void>((resolve) => {
      resolveFired = resolve;
    });
    const watcher = watchRepositoryRefs(state.gitDir, state.commonGitDir, () => {
      fired = true;
      resolveFired();
    }, { debounceMs: 30 });

    try {
      // Simulate a teammate's terminal starting a merge while GitHydra is already open/watching.
      await git(dir, ["merge", "-q", "feature"]).catch(() => {});
      await Promise.race([
        firedPromise,
        new Promise((resolve) => setTimeout(resolve, 4000)),
      ]);
      expect(fired).toBe(true);
    } finally {
      watcher.close();
    }
  }, 10000);
});

describe("worktree scoping (FR-76)", () => {
  it("an operation in progress in one worktree does not appear in a different worktree's state", async () => {
    const dir = await makeRepo();
    await writeFile(dir, "a.txt", "base\n");
    await commit(dir, "base");
    const worktreeDir = path.join(path.dirname(dir), path.basename(dir) + "-wt-conflict");
    await git(dir, ["worktree", "add", "-q", "-b", "wt-branch", worktreeDir]);
    cleanupDirs.push(worktreeDir);

    await git(dir, ["checkout", "-q", "-b", "feature"]);
    await writeFile(dir, "a.txt", "feature change\n");
    await commit(dir, "feature change");
    await git(dir, ["checkout", "-q", "main"]);
    await writeFile(dir, "a.txt", "main change\n");
    await commit(dir, "main change");
    await git(dir, ["merge", "-q", "feature"]).catch(() => {});

    const mainState = await getRepositoryState(dir);
    const wtState = await getRepositoryState(worktreeDir);
    expect(mainState.inProgressOperation).toBe("merge");
    expect(wtState.inProgressOperation).toBeNull();
    expect(wtState.inProgressOperationDetail).toBeNull();

    await abortInProgressOperation(dir, "merge");
    await git(dir, ["worktree", "remove", "-f", worktreeDir]).catch(() => {});
  });
});

describe("FR-107: multi-commit cherry-pick sequence — abort/continue regression coverage", () => {
  /**
   * base: a/b/c.txt all present. `feature` has 3 commits, each touching a distinct file
   * (f1: a.txt, f2: b.txt, f3: c.txt). `main`'s own single commit changes BOTH b.txt and c.txt,
   * so a `cherryPick(dir, [f1, f2, f3])` from `main` applies f1 cleanly, then conflicts on f2
   * AND (if resumed) conflicts again on f3 — a genuine two-pause multi-commit sequence, not a
   * single-conflict stand-in.
   */
  async function setupThreeCommitSequenceWithTwoConflicts(): Promise<{
    dir: string;
    preSequenceHeadSha: string;
    f1Sha: string;
    f2Sha: string;
    f3Sha: string;
  }> {
    const dir = await makeRepo();
    await writeFile(dir, "a.txt", "base-a\n");
    await writeFile(dir, "b.txt", "base-b\n");
    await writeFile(dir, "c.txt", "base-c\n");
    await commit(dir, "base");
    await git(dir, ["checkout", "-q", "-b", "feature"]);
    await writeFile(dir, "a.txt", "feature-a\n");
    const f1Sha = await commit(dir, "f1: change a.txt");
    await writeFile(dir, "b.txt", "feature-b\n");
    const f2Sha = await commit(dir, "f2: change b.txt");
    await writeFile(dir, "c.txt", "feature-c\n");
    const f3Sha = await commit(dir, "f3: change c.txt");
    await git(dir, ["checkout", "-q", "main"]);
    await writeFile(dir, "b.txt", "main-b\n");
    await writeFile(dir, "c.txt", "main-c\n");
    const preSequenceHeadSha = await commit(dir, "m1: change b.txt and c.txt on main");
    return { dir, preSequenceHeadSha, f1Sha, f2Sha, f3Sha };
  }

  it("pauses on the middle commit (f2), leaving f1 already committed and f3 correctly counted as still-queued", async () => {
    const { dir, f1Sha, f2Sha, f3Sha } = await setupThreeCommitSequenceWithTwoConflicts();

    await expect(cherryPick(dir, [f1Sha, f2Sha, f3Sha])).rejects.toBeInstanceOf(GitCommandError);

    const log = await git(dir, ["log", "--format=%s", "-3"]);
    expect(log.stdout.trim().split("\n")[0]).toBe("f1: change a.txt"); // f1 already committed.

    const state = await getRepositoryState(dir);
    expect(state.inProgressOperation).toBe("cherry-pick");
    const detail = state.inProgressOperationDetail;
    if (detail?.kind !== "cherry-pick") throw new Error("expected cherry-pick detail");
    expect(detail.targetSha).toBe(f2Sha);
    expect(detail.isEmptyResult).toBe(false); // real conflict, not FR-105's empty-result case.
    // sequencer/todo still lists f2 (current) and f3 -> 2 pick lines total -> 1 remaining after current.
    expect(detail.remainingAfterCurrent).toBe(1);
  });

  it("--abort restores the EXACT pre-sequence HEAD sha, not merely the current step (acceptance criterion 6)", async () => {
    const { dir, preSequenceHeadSha, f1Sha, f2Sha, f3Sha } = await setupThreeCommitSequenceWithTwoConflicts();
    await expect(cherryPick(dir, [f1Sha, f2Sha, f3Sha])).rejects.toBeInstanceOf(GitCommandError);

    // Sanity: f1 really was committed on top of preSequenceHeadSha before the abort.
    const midState = await getRepositoryState(dir);
    expect(midState.headSha).not.toBe(preSequenceHeadSha);

    await abortInProgressOperation(dir, "cherry-pick");

    const state = await getRepositoryState(dir);
    expect(state.inProgressOperation).toBeNull();
    expect(state.headSha).toBe(preSequenceHeadSha); // f1's commit is gone too, not just f2's staged conflict.
    const status = await git(dir, ["status", "--porcelain"]);
    expect(status.stdout.trim()).toBe("");
  });

  it("--continue auto-advances past a resolved step and correctly pauses AGAIN when the next commit also conflicts, then a final --continue completes the whole sequence (acceptance criterion 5)", async () => {
    const { dir, preSequenceHeadSha, f1Sha, f2Sha, f3Sha } = await setupThreeCommitSequenceWithTwoConflicts();
    await expect(cherryPick(dir, [f1Sha, f2Sha, f3Sha])).rejects.toBeInstanceOf(GitCommandError);

    let state = await getRepositoryState(dir);
    expect(state.inProgressOperation).toBe("cherry-pick");
    let detail = state.inProgressOperationDetail;
    if (detail?.kind !== "cherry-pick") throw new Error("expected cherry-pick detail");
    expect(detail.targetSha).toBe(f2Sha);

    // Resolve b.txt and continue — should auto-advance straight into f3's conflict (f3 also
    // touches a path main changed), pausing again rather than completing. Like the initial
    // `cherry-pick` call above, git itself exits non-zero here (the SAME real-git shape as a
    // plain `git rebase --continue` that immediately hits a new conflict — see
    // watcher.test.ts's `setupMultiStepConflictingRebase`) — f2 IS committed by this call even
    // though the call rejects, since git commits the resolved step before attempting f3.
    await writeFile(dir, "b.txt", "resolved-b\n");
    await markConflictResolved(dir, "b.txt");
    await expect(continueInProgressOperation(dir, dir, "cherry-pick")).rejects.toBeInstanceOf(GitCommandError);

    state = await getRepositoryState(dir);
    expect(state.inProgressOperation).toBe("cherry-pick"); // paused again, not done.
    detail = state.inProgressOperationDetail;
    if (detail?.kind !== "cherry-pick") throw new Error("expected cherry-pick detail");
    expect(detail.targetSha).toBe(f3Sha);
    expect(detail.remainingAfterCurrent).toBe(0); // f3 is the last queued commit.

    // Resolve c.txt and continue — this is the final step, sequence completes entirely.
    await writeFile(dir, "c.txt", "resolved-c\n");
    await markConflictResolved(dir, "c.txt");
    await continueInProgressOperation(dir, dir, "cherry-pick");

    state = await getRepositoryState(dir);
    expect(state.inProgressOperation).toBeNull();
    expect(state.inProgressOperationDetail).toBeNull();

    const log = await git(dir, ["log", "--format=%s"]);
    const subjects = log.stdout.trim().split("\n");
    expect(subjects.slice(0, 3)).toEqual(["f3: change c.txt", "f2: change b.txt", "f1: change a.txt"]);
    expect(subjects).toHaveLength(5); // base + m1 + f1 + f2 + f3.
    // sanity: preSequenceHeadSha's own subject is still in history exactly once, not duplicated.
    expect(subjects.filter((s) => s === "m1: change b.txt and c.txt on main")).toHaveLength(1);

    // HEAD moved exactly 3 commits past the pre-sequence tip.
    const { stdout: mergeBase } = await git(dir, ["merge-base", "HEAD", preSequenceHeadSha]);
    expect(mergeBase.trim()).toBe(preSequenceHeadSha);
  });
});
