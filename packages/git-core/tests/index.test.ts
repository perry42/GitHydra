// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect, afterEach } from "vitest";
import { Repository } from "../src/index";
import { OperationCancelledError, InvalidArgumentError } from "../src/errors";
import { git, initRepo, writeFile, commit, cleanup, makeTempDir } from "./testRepo";

const cleanupDirs: string[] = [];
afterEach(async () => {
  while (cleanupDirs.length) await cleanup(cleanupDirs.pop()!);
});

describe("Repository (facade)", () => {
  it("opens a repo, reads state, and pages through history with HEAD/branch decorations attached", async () => {
    const dir = await initRepo();
    cleanupDirs.push(dir);
    await writeFile(dir, "a.txt", "1");
    const sha = await commit(dir, "first commit");
    await git(dir, ["tag", "v1"]);

    const repo = await Repository.open(dir);
    expect(repo.getState().currentBranch).toBe("main");
    expect(repo.getState().headSha).toBe(sha);

    const reader = await repo.createCommitLogReader();
    const page = await reader.readPage(10);
    reader.close();

    expect(page.done).toBe(true);
    expect(page.commits).toHaveLength(1);
    const commitRefs = page.commits[0]!.refs.map((r) => `${r.type}:${r.name}`).sort();
    expect(commitRefs).toEqual(["head:HEAD", "local-branch:main", "tag:v1"].sort());
  });

  it("getCommit resolves an abbreviated SHA to full commit metadata", async () => {
    const dir = await initRepo();
    cleanupDirs.push(dir);
    await writeFile(dir, "a.txt", "1");
    const sha = await commit(dir, "hello world\n\nsome body text");

    const repo = await Repository.open(dir);
    const found = await repo.getCommit(sha.slice(0, 10));
    expect(found?.sha).toBe(sha);
    expect(found?.subject).toBe("hello world");
    expect(found?.body).toBe("some body text");
    expect(found?.message).toBe("hello world\n\nsome body text");
  });

  it("getChangedFiles reports add/modify/delete/rename correctly, including for a root commit", async () => {
    const dir = await initRepo();
    cleanupDirs.push(dir);
    await writeFile(dir, "a.txt", "a content, line one\na content, line two\n");
    await writeFile(dir, "b.txt", "b content, entirely different\nfrom everything else\n");
    const rootSha = await commit(dir, "root");

    const repo = await Repository.open(dir);
    const rootCommit = await repo.getCommit(rootSha);
    const rootFiles = await repo.getChangedFiles(rootCommit!);
    expect(rootFiles.map((f) => f.path).sort()).toEqual(["a.txt", "b.txt"]);
    expect(rootFiles.every((f) => f.status === "added")).toBe(true);

    await writeFile(dir, "a.txt", "a content, line one CHANGED\na content, line two\n");
    await git(dir, ["rm", "-q", "b.txt"]);
    await writeFile(dir, "c.txt", "c content, unrelated to b entirely\nwith its own distinct text\n");
    const secondSha = await commit(dir, "second");
    const secondCommit = await repo.getCommit(secondSha);
    const files = await repo.getChangedFiles(secondCommit!);
    const byPath = new Map(files.map((f) => [f.path, f]));
    expect(byPath.get("a.txt")?.status).toBe("modified");
    expect(byPath.get("b.txt")?.status).toBe("deleted");
    expect(byPath.get("c.txt")?.status).toBe("added");
  });

  it("getChangedFiles diffs a merge commit against its first parent", async () => {
    const dir = await initRepo();
    cleanupDirs.push(dir);
    await writeFile(dir, "a.txt", "base");
    await commit(dir, "base");
    await git(dir, ["checkout", "-q", "-b", "feature"]);
    await writeFile(dir, "feature.txt", "1");
    await commit(dir, "feature work");
    await git(dir, ["checkout", "-q", "main"]);
    await writeFile(dir, "main.txt", "1");
    await commit(dir, "main work");
    await git(dir, ["merge", "-q", "--no-ff", "-m", "merge feature", "feature"]);
    const mergeSha = (await git(dir, ["rev-parse", "HEAD"])).stdout.trim();

    const repo = await Repository.open(dir);
    const mergeCommit = await repo.getCommit(mergeSha);
    const files = await repo.getChangedFiles(mergeCommit!);
    // First-parent diff (main..merge) should show feature.txt arriving via the merge.
    expect(files.map((f) => f.path)).toContain("feature.txt");
  });

  describe("getChangedFilesBetween (FR-182: compare two arbitrary commits)", () => {
    it("reports files changed between two arbitrary, caller-supplied commits", async () => {
      const dir = await initRepo();
      cleanupDirs.push(dir);
      await writeFile(dir, "a.txt", "a content, line one\na content, line two\n");
      await writeFile(dir, "b.txt", "b content, entirely different\nfrom everything else\n");
      const baseSha = await commit(dir, "base");
      await writeFile(dir, "a.txt", "a content, line one CHANGED\na content, line two\n");
      await git(dir, ["rm", "-q", "b.txt"]);
      await writeFile(dir, "c.txt", "c content, unrelated to b entirely\nwith its own distinct text\n");
      const targetSha = await commit(dir, "target");

      const repo = await Repository.open(dir);
      const files = await repo.getChangedFilesBetween(baseSha, targetSha);
      const byPath = new Map(files.map((f) => [f.path, f]));
      expect(byPath.get("a.txt")?.status).toBe("modified");
      expect(byPath.get("b.txt")?.status).toBe("deleted");
      expect(byPath.get("c.txt")?.status).toBe("added");
    });

    it("reports no changed files when comparing a commit against itself (identical trees)", async () => {
      const dir = await initRepo();
      cleanupDirs.push(dir);
      await writeFile(dir, "a.txt", "1");
      const sha = await commit(dir, "only commit");

      const repo = await Repository.open(dir);
      const files = await repo.getChangedFilesBetween(sha, sha);
      expect(files).toEqual([]);
    });

    it("succeeds for two non-ancestor, diverged-branch-tip commits with no ancestry check", async () => {
      const dir = await initRepo();
      cleanupDirs.push(dir);
      await writeFile(dir, "a.txt", "base");
      await commit(dir, "base");
      await git(dir, ["checkout", "-q", "-b", "branch-a"]);
      await writeFile(dir, "feature-a.txt", "feature a content, entirely unrelated to feature b\n");
      const branchASha = await commit(dir, "branch a work");
      await git(dir, ["checkout", "-q", "-b", "branch-b", "main"]);
      await writeFile(dir, "feature-b.txt", "feature b content, a completely different topic\n");
      const branchBSha = await commit(dir, "branch b work");

      const repo = await Repository.open(dir);
      const files = await repo.getChangedFilesBetween(branchASha, branchBSha);
      const byPath = new Map(files.map((f) => [f.path, f]));
      expect(byPath.get("feature-a.txt")?.status).toBe("deleted");
      expect(byPath.get("feature-b.txt")?.status).toBe("added");
    });

    it("rejects an invalid SHA for either endpoint", async () => {
      const dir = await initRepo();
      cleanupDirs.push(dir);
      await writeFile(dir, "a.txt", "1");
      const sha = await commit(dir, "first");

      const repo = await Repository.open(dir);
      await expect(repo.getChangedFilesBetween("not-a-sha!!", sha)).rejects.toBeInstanceOf(
        InvalidArgumentError,
      );
      await expect(repo.getChangedFilesBetween(sha, "not-a-sha!!")).rejects.toBeInstanceOf(
        InvalidArgumentError,
      );
    });

    it("works against a bare repository (no working directory required)", async () => {
      const dir = await initRepo();
      cleanupDirs.push(dir);
      await writeFile(dir, "a.txt", "1");
      const baseSha = await commit(dir, "first");
      await writeFile(dir, "a.txt", "2");
      const targetSha = await commit(dir, "second");

      const bareDir = await initRepo({ bare: true });
      cleanupDirs.push(bareDir);
      await git(dir, ["push", "-q", bareDir, "main"]).catch(async () => {
        await git(bareDir, ["fetch", "-q", dir, "main:main"]);
      });

      const repo = await Repository.open(bareDir);
      const files = await repo.getChangedFilesBetween(baseSha, targetSha);
      expect(files.map((f) => f.path)).toEqual(["a.txt"]);
      expect(files[0]!.status).toBe("modified");
    });
  });

  describe("getCommitRangeFileDiff (FR-181: compare two arbitrary commits)", () => {
    it("computes a full patch diff between two arbitrary, caller-supplied commits", async () => {
      const dir = await initRepo();
      cleanupDirs.push(dir);
      await writeFile(dir, "a.txt", "v1\n");
      const baseSha = await commit(dir, "first");
      await writeFile(dir, "a.txt", "v2\n");
      const targetSha = await commit(dir, "second");

      const repo = await Repository.open(dir);
      const result = await repo.getCommitRangeFileDiff(baseSha, targetSha, { path: "a.txt" });
      expect(result.status).toBe("ok");
      if (result.status !== "ok") throw new Error("expected ok");
      const lines = result.hunks.flatMap((h) => h.lines);
      expect(lines.some((l) => l.type === "remove" && l.content === "v1")).toBe(true);
      expect(lines.some((l) => l.type === "add" && l.content === "v2")).toBe(true);
    });

    it("works against a bare repository (no working directory required)", async () => {
      const dir = await initRepo();
      cleanupDirs.push(dir);
      await writeFile(dir, "a.txt", "v1\n");
      const baseSha = await commit(dir, "first");
      await writeFile(dir, "a.txt", "v2\n");
      const targetSha = await commit(dir, "second");

      const bareDir = await initRepo({ bare: true });
      cleanupDirs.push(bareDir);
      await git(dir, ["push", "-q", bareDir, "main"]).catch(async () => {
        await git(bareDir, ["fetch", "-q", dir, "main:main"]);
      });

      const repo = await Repository.open(bareDir);
      const result = await repo.getCommitRangeFileDiff(baseSha, targetSha, { path: "a.txt" });
      expect(result.status).toBe("ok");
      if (result.status !== "ok") throw new Error("expected ok");
      const lines = result.hunks.flatMap((h) => h.lines);
      expect(lines.some((l) => l.type === "add" && l.content === "v2")).toBe(true);
    });
  });

  it("marks the shallow-clone boundary commit rather than presenting it as a true root", async () => {
    const origin = await initRepo();
    cleanupDirs.push(origin);
    await writeFile(origin, "a.txt", "1");
    await commit(origin, "root");
    await writeFile(origin, "a.txt", "2");
    await commit(origin, "middle");
    await writeFile(origin, "a.txt", "3");
    const tipSha = await commit(origin, "tip");

    const clone = await makeTempDir();
    cleanupDirs.push(clone);
    // Plain local-path clones take git's "local clone" fast path and silently ignore --depth
    // unless --no-local forces the normal (non-hardlinked) transport, which does respect it.
    await git(process.cwd(), [
      "clone",
      "-q",
      "--depth=1",
      "--no-local",
      `file://${origin.replace(/\\/g, "/")}`,
      clone,
    ]).catch(async () => {
      await git(process.cwd(), ["clone", "-q", "--depth=1", "--no-local", origin, clone]);
    });

    const repo = await Repository.open(clone);
    expect(repo.getState().isShallow).toBe(true);

    const reader = await repo.createCommitLogReader();
    const page = await reader.readPage(10);
    reader.close();

    expect(page.commits).toHaveLength(1);
    expect(page.commits[0]!.sha).toBe(tipSha);
    expect(page.commits[0]!.parents).toEqual([]); // no parent objects available locally
    expect(page.commits[0]!.isHistoryBoundary).toBe(true); // ...but this is NOT a true root commit
  });

  it("handles a bare repository end-to-end with no working directory", async () => {
    const dir = await initRepo({ bare: true });
    cleanupDirs.push(dir);
    const repo = await Repository.open(dir);
    expect(repo.getState().isBare).toBe(true);
    expect(repo.getState().workdir).toBeNull();
    expect(repo.getState().isEmpty).toBe(true);

    const reader = await repo.createCommitLogReader();
    const page = await reader.readPage(10);
    reader.close();
    expect(page.commits).toEqual([]);
    expect(page.done).toBe(true);
  });

  describe("getWorkingDirectoryStatus", () => {
    it("reports counts for a repo with mixed staged/unstaged/untracked changes", async () => {
      const dir = await initRepo();
      cleanupDirs.push(dir);
      await writeFile(dir, "a.txt", "1");
      await commit(dir, "first");
      await writeFile(dir, "a.txt", "2");
      await writeFile(dir, "b.txt", "new");

      const repo = await Repository.open(dir);
      const status = await repo.getWorkingDirectoryStatus();
      expect(status).not.toBeNull();
      expect(status!.hasChanges).toBe(true);
      expect(status!.unstaged).toBe(1);
      expect(status!.untracked).toBe(1);
    });

    it("returns null for a bare repository (no working directory to report status for)", async () => {
      const dir = await initRepo({ bare: true });
      cleanupDirs.push(dir);
      const repo = await Repository.open(dir);
      expect(await repo.getWorkingDirectoryStatus()).toBeNull();
    });
  });

  describe("getUpstreamBranch", () => {
    it("returns null for a branch with no configured upstream", async () => {
      const dir = await initRepo();
      cleanupDirs.push(dir);
      await writeFile(dir, "a.txt", "1");
      await commit(dir, "first");

      const repo = await Repository.open(dir);
      expect(await repo.getUpstreamBranch()).toBeNull();
    });

    it("returns null for a detached HEAD without ever shelling out for @{u}", async () => {
      const dir = await initRepo();
      cleanupDirs.push(dir);
      await writeFile(dir, "a.txt", "1");
      const sha = await commit(dir, "first");
      await git(dir, ["checkout", "-q", sha]);

      const repo = await Repository.open(dir);
      expect(repo.getState().isDetachedHead).toBe(true);
      expect(await repo.getUpstreamBranch()).toBeNull();
    });

    it("resolves the current branch's configured upstream", async () => {
      const origin = await initRepo({ bare: true });
      cleanupDirs.push(origin);
      const clone = await makeTempDir();
      cleanupDirs.push(clone);
      await git(process.cwd(), ["clone", "-q", origin, clone]);
      await writeFile(clone, "a.txt", "1");
      await commit(clone, "first");
      await git(clone, ["push", "-q", "-u", "origin", "main"]);

      const repo = await Repository.open(clone);
      expect(await repo.getUpstreamBranch()).toBe("origin/main");
    });
  });
});

// specs/repo-open-feedback.md FR-163/FR-165: `Repository.open()`'s `options.signal` is the actual
// public API surface a caller (the desktop IPC layer) uses to make an `openRepo` attempt
// cancellable end-to-end.
describe("Repository.open cancellation (FR-163/FR-165)", () => {
  it("rejects with OperationCancelledError when options.signal aborts mid-open, never resolving a Repository", async () => {
    const dir = await initRepo();
    cleanupDirs.push(dir);
    await writeFile(dir, "a.txt", "1");
    await commit(dir, "first commit");

    const controller = new AbortController();
    const promise = Repository.open(dir, { signal: controller.signal });
    controller.abort();

    await expect(promise).rejects.toBeInstanceOf(OperationCancelledError);
  });

  it("an uncancelled open with a live signal still works normally (no regression)", async () => {
    const dir = await initRepo();
    cleanupDirs.push(dir);
    await writeFile(dir, "a.txt", "1");
    const sha = await commit(dir, "first commit");

    const controller = new AbortController();
    const repo = await Repository.open(dir, { signal: controller.signal });
    expect(repo.getState().headSha).toBe(sha);
  });

  it("Repository.open(dir) with no options argument at all still works (backward compatible)", async () => {
    const dir = await initRepo();
    cleanupDirs.push(dir);
    await writeFile(dir, "a.txt", "1");
    const sha = await commit(dir, "first commit");

    const repo = await Repository.open(dir);
    expect(repo.getState().headSha).toBe(sha);
  });
});
