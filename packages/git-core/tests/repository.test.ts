import { describe, it, expect, afterEach } from "vitest";
import * as path from "node:path";
import { getRepositoryState } from "../src/repository";
import { NotAGitRepositoryError } from "../src/errors";
import { git, initRepo, writeFile, commit, cleanup, makeTempDir } from "./testRepo";

const cleanupDirs: string[] = [];
afterEach(async () => {
  while (cleanupDirs.length) await cleanup(cleanupDirs.pop()!);
});

describe("getRepositoryState", () => {
  it("throws NotAGitRepositoryError for a non-repo directory", async () => {
    const dir = await makeTempDir();
    cleanupDirs.push(dir);
    // Isolate from any ambient repo that might exist in an ancestor directory (git normally
    // searches upward) so this test is deterministic regardless of where the temp dir lands.
    const previousCeiling = process.env.GIT_CEILING_DIRECTORIES;
    process.env.GIT_CEILING_DIRECTORIES = path.dirname(dir);
    try {
      await expect(getRepositoryState(dir)).rejects.toBeInstanceOf(NotAGitRepositoryError);
    } finally {
      if (previousCeiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
      else process.env.GIT_CEILING_DIRECTORIES = previousCeiling;
    }
  });

  it("reports a fresh repo as empty with unborn HEAD, attached to the initial branch", async () => {
    const dir = await initRepo();
    cleanupDirs.push(dir);
    const state = await getRepositoryState(dir);
    expect(state.isEmpty).toBe(true);
    expect(state.isUnbornHead).toBe(true);
    expect(state.isDetachedHead).toBe(false);
    expect(state.currentBranch).toBe("main");
    expect(state.headSha).toBeNull();
    expect(state.isBare).toBe(false);
    expect(state.inProgressOperation).toBeNull();
  });

  it("reports a normal repo with one commit correctly", async () => {
    const dir = await initRepo();
    cleanupDirs.push(dir);
    await writeFile(dir, "a.txt", "hello");
    const sha = await commit(dir, "first commit");
    const state = await getRepositoryState(dir);
    expect(state.isEmpty).toBe(false);
    expect(state.isUnbornHead).toBe(false);
    expect(state.currentBranch).toBe("main");
    expect(state.headSha).toBe(sha);
  });

  it("detects a bare repository, with no workdir", async () => {
    const dir = await initRepo({ bare: true });
    cleanupDirs.push(dir);
    const state = await getRepositoryState(dir);
    expect(state.isBare).toBe(true);
    expect(state.workdir).toBeNull();
  });

  it("detects detached HEAD", async () => {
    const dir = await initRepo();
    cleanupDirs.push(dir);
    await writeFile(dir, "a.txt", "hello");
    const sha = await commit(dir, "first");
    await writeFile(dir, "a.txt", "world");
    await commit(dir, "second");
    await git(dir, ["checkout", "-q", sha]);

    const state = await getRepositoryState(dir);
    expect(state.isDetachedHead).toBe(true);
    expect(state.currentBranch).toBeNull();
    expect(state.headSha).toBe(sha);
  });

  it("detects an in-progress merge (conflicted)", async () => {
    const dir = await initRepo();
    cleanupDirs.push(dir);
    await writeFile(dir, "a.txt", "base\n");
    await commit(dir, "base");
    await git(dir, ["checkout", "-q", "-b", "feature"]);
    await writeFile(dir, "a.txt", "feature change\n");
    await commit(dir, "feature change");
    await git(dir, ["checkout", "-q", "main"]);
    await writeFile(dir, "a.txt", "main change\n");
    await commit(dir, "main change");
    await git(dir, ["merge", "-q", "feature"]).catch(() => {
      /* expected to fail with a conflict */
    });

    const state = await getRepositoryState(dir);
    expect(state.inProgressOperation).toBe("merge");
  });

  it("detects an in-progress rebase", async () => {
    const dir = await initRepo();
    cleanupDirs.push(dir);
    await writeFile(dir, "a.txt", "base\n");
    await commit(dir, "base");
    await git(dir, ["checkout", "-q", "-b", "feature"]);
    await writeFile(dir, "a.txt", "feature change\n");
    await commit(dir, "feature change");
    await git(dir, ["checkout", "-q", "main"]);
    await writeFile(dir, "a.txt", "main change\n");
    await commit(dir, "main change");
    await git(dir, ["checkout", "-q", "feature"]);
    await git(dir, ["rebase", "main"]).catch(() => {
      /* expected to fail with a conflict, leaving rebase-apply/rebase-merge state */
    });

    const state = await getRepositoryState(dir);
    expect(state.inProgressOperation).toBe("rebase");
  });

  it("detects an in-progress cherry-pick", async () => {
    const dir = await initRepo();
    cleanupDirs.push(dir);
    await writeFile(dir, "a.txt", "base\n");
    await commit(dir, "base");
    await git(dir, ["checkout", "-q", "-b", "feature"]);
    await writeFile(dir, "a.txt", "feature change\n");
    const featureSha = await commit(dir, "feature change");
    await git(dir, ["checkout", "-q", "main"]);
    await writeFile(dir, "a.txt", "main change\n");
    await commit(dir, "main change");
    await git(dir, ["cherry-pick", featureSha]).catch(() => {
      /* expected conflict */
    });

    const state = await getRepositoryState(dir);
    expect(state.inProgressOperation).toBe("cherry-pick");
  });

  it("detects a linked worktree as such, sharing commonGitDir with the main repo", async () => {
    const dir = await initRepo();
    cleanupDirs.push(dir);
    await writeFile(dir, "a.txt", "hello");
    await commit(dir, "first");
    const worktreeDir = path.join(path.dirname(dir), path.basename(dir) + "-wt");
    await git(dir, ["worktree", "add", "-q", "-b", "wt-branch", worktreeDir]);
    cleanupDirs.push(worktreeDir);

    const mainState = await getRepositoryState(dir);
    const wtState = await getRepositoryState(worktreeDir);

    expect(mainState.isWorktree).toBe(false);
    expect(wtState.isWorktree).toBe(true);
    expect(wtState.commonGitDir).toBe(mainState.commonGitDir);
    expect(wtState.currentBranch).toBe("wt-branch");

    await git(dir, ["worktree", "remove", "-f", worktreeDir]).catch(() => {});
  });

  it("detects a shallow clone", async () => {
    const origin = await initRepo();
    cleanupDirs.push(origin);
    await writeFile(origin, "a.txt", "1");
    await commit(origin, "one");
    await writeFile(origin, "a.txt", "2");
    await commit(origin, "two");
    await writeFile(origin, "a.txt", "3");
    await commit(origin, "three");

    const clone = await makeTempDir();
    cleanupDirs.push(clone);
    await git(process.cwd(), ["clone", "-q", "--depth=1", "--no-local", `file://${origin.replace(/\\/g, "/")}`, clone]).catch(async () => {
      // file:// clone can be finicky on some Windows git builds; fall back to a local path clone.
      await git(process.cwd(), ["clone", "-q", "--depth=1", origin, clone]);
    });

    const state = await getRepositoryState(clone);
    expect(state.isShallow).toBe(true);
  });
});
