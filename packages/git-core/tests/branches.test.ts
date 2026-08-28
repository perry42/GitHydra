import { describe, it, expect, afterEach } from "vitest";
import {
  listBranches,
  listRemoteBranches,
  validateBranchName,
  createBranch,
  switchBranch,
  switchToCommit,
  deleteBranch,
  forceDeleteBranch,
} from "../src/branches";
import {
  InvalidRefNameError,
  BranchSwitchConflictError,
  BranchNotFullyMergedError,
  BranchCheckedOutError,
  GitCommandError,
} from "../src/errors";
import { Repository } from "../src/index";
import { git, initRepo, writeFile, commit, cleanup, makeTempDir, setUpMaliciousFsmonitorRepo } from "./testRepo";

const cleanupDirs: string[] = [];
afterEach(async () => {
  while (cleanupDirs.length) await cleanup(cleanupDirs.pop()!);
});

describe("listBranches", () => {
  it("lists local branches with tip metadata and marks the current branch", async () => {
    const dir = await initRepo();
    cleanupDirs.push(dir);
    await writeFile(dir, "a.txt", "1");
    const c1 = await commit(dir, "first");
    await git(dir, ["branch", "feature-x"]);

    const branches = await listBranches(dir);
    const byName = new Map(branches.map((b) => [b.name, b]));

    expect(byName.get("main")?.isCurrent).toBe(true);
    expect(byName.get("main")?.tipSha).toBe(c1);
    expect(byName.get("main")?.tipSubject).toBe("first");
    expect(byName.get("feature-x")?.isCurrent).toBe(false);
    expect(byName.get("feature-x")?.tipSha).toBe(c1);
    expect(byName.get("feature-x")?.checkedOutInWorktree).toBeNull();
  });

  it("returns an empty list for a zero-commit (unborn HEAD) repo without throwing", async () => {
    const dir = await initRepo();
    cleanupDirs.push(dir);
    expect(await listBranches(dir)).toEqual([]);
  });

  it("computes ahead/behind against an already-fetched remote-tracking ref, and flags a gone upstream", async () => {
    const origin = await initRepo({ bare: true });
    cleanupDirs.push(origin);
    const dir = await makeTempDir();
    cleanupDirs.push(dir);
    await git(process.cwd(), ["clone", "-q", origin, dir]);
    await writeFile(dir, "a.txt", "1");
    await commit(dir, "first");
    await git(dir, ["push", "-q", "-u", "origin", "main"]);

    // Diverge locally by one commit ahead.
    await writeFile(dir, "a.txt", "2");
    await commit(dir, "second");

    let branches = await listBranches(dir);
    let main = branches.find((b) => b.name === "main")!;
    expect(main.upstreamName).toBe("origin/main");
    expect(main.ahead).toBe(1);
    expect(main.behind).toBe(0);
    expect(main.upstreamGone).toBe(false);

    // Delete the remote-tracking ref out from under it (simulating the remote branch being
    // deleted, with no fetch --prune run) — upstream is configured but "gone".
    await git(dir, ["update-ref", "-d", "refs/remotes/origin/main"]);
    branches = await listBranches(dir);
    main = branches.find((b) => b.name === "main")!;
    expect(main.upstreamGone).toBe(true);
    expect(main.ahead).toBeNull();
    expect(main.behind).toBeNull();
  });

  it("flags a branch checked out in a different worktree, without flagging it as current", async () => {
    const dir = await initRepo();
    cleanupDirs.push(dir);
    await writeFile(dir, "a.txt", "1");
    await commit(dir, "first");
    await git(dir, ["branch", "other"]);

    const worktreeDir = await makeTempDir();
    cleanupDirs.push(worktreeDir);
    await git(dir, ["worktree", "add", worktreeDir.replace(/\\/g, "/"), "other"]);

    const branches = await listBranches(dir);
    const other = branches.find((b) => b.name === "other")!;
    expect(other.isCurrent).toBe(false);
    expect(other.checkedOutInWorktree).not.toBeNull();

    // Listing from inside the linked worktree flips which one is "self" vs "elsewhere".
    const branchesFromWorktree = await listBranches(worktreeDir);
    const otherFromWorktree = branchesFromWorktree.find((b) => b.name === "other")!;
    expect(otherFromWorktree.isCurrent).toBe(true);
    expect(otherFromWorktree.checkedOutInWorktree).toBeNull();
  });

  it("works on a bare repository (no working directory required)", async () => {
    const dir = await initRepo({ bare: true });
    cleanupDirs.push(dir);
    const nonBare = await makeTempDir();
    cleanupDirs.push(nonBare);
    await git(process.cwd(), ["init", "-q", nonBare]);
    await writeFile(nonBare, "a.txt", "1");
    await commit(nonBare, "first");
    await git(nonBare, ["push", "-q", dir, "HEAD:main"]);

    const branches = await listBranches(dir);
    expect(branches.find((b) => b.name === "main")).toBeDefined();
  });
});

describe("listRemoteBranches", () => {
  it("lists remote-tracking branches grouped implicitly by remoteName, excluding the symbolic HEAD pointer", async () => {
    const origin = await initRepo({ bare: true });
    cleanupDirs.push(origin);
    const dir = await makeTempDir();
    cleanupDirs.push(dir);
    await git(process.cwd(), ["clone", "-q", origin, dir]);
    await writeFile(dir, "a.txt", "1");
    await commit(dir, "first");
    await git(dir, ["push", "-q", "-u", "origin", "main"]);
    await git(dir, ["push", "-q", "origin", "main:feature-y"]);
    await git(dir, ["fetch", "-q"]);
    await git(dir, ["remote", "set-head", "origin", "main"]);

    const remoteBranches = await listRemoteBranches(dir);
    const names = remoteBranches.map((b) => `${b.remoteName}/${b.name}`).sort();
    expect(names).toEqual(["origin/feature-y", "origin/main"]);
    expect(remoteBranches.find((b) => b.name === "HEAD")).toBeUndefined();
  });
});

describe("validateBranchName / createBranch", () => {
  it("creates a branch at HEAD when no start point is given, leaving HEAD unmoved", async () => {
    const dir = await initRepo();
    cleanupDirs.push(dir);
    await writeFile(dir, "a.txt", "1");
    const c1 = await commit(dir, "first");

    const result = await createBranch(dir, { name: "new-branch" });
    expect(result.sha).toBe(c1);
    expect(result.switched).toBe(false);

    const { stdout } = await git(dir, ["symbolic-ref", "--short", "HEAD"]);
    expect(stdout.trim()).toBe("main");
  });

  it("creates a branch at an explicit non-HEAD start point (graph 'Create branch here')", async () => {
    const dir = await initRepo();
    cleanupDirs.push(dir);
    await writeFile(dir, "a.txt", "1");
    const c1 = await commit(dir, "first");
    await writeFile(dir, "a.txt", "2");
    await commit(dir, "second");

    const result = await createBranch(dir, { name: "from-c1", startPoint: c1 });
    expect(result.sha).toBe(c1);
  });

  it("creates and switches to a new branch in one call", async () => {
    const dir = await initRepo();
    cleanupDirs.push(dir);
    await writeFile(dir, "a.txt", "1");
    await commit(dir, "first");

    const result = await createBranch(dir, { name: "switched-to", switchToIt: true });
    expect(result.switched).toBe(true);
    const { stdout } = await git(dir, ["symbolic-ref", "--short", "HEAD"]);
    expect(stdout.trim()).toBe("switched-to");
  });

  it("wires tracking automatically when the start point is a remote-tracking branch, with no network call", async () => {
    const origin = await initRepo({ bare: true });
    cleanupDirs.push(origin);
    const dir = await makeTempDir();
    cleanupDirs.push(dir);
    await git(process.cwd(), ["clone", "-q", origin, dir]);
    await writeFile(dir, "a.txt", "1");
    await commit(dir, "first");
    await git(dir, ["push", "-q", "-u", "origin", "main"]);
    await git(dir, ["checkout", "-q", "-b", "throwaway"]); // move off main so "main" is free to recreate

    await git(dir, ["branch", "-D", "main"]);
    await createBranch(dir, { name: "main", startPoint: "origin/main" });

    const { stdout } = await git(dir, ["rev-parse", "--abbrev-ref", "main@{u}"]);
    expect(stdout.trim()).toBe("origin/main");
  });

  /**
   * Regression: `git switch -c` binds whatever argv token comes immediately after `-c` as the
   * new branch name (a mandatory bound value, like `-b`/`-B` on `checkout`). Putting
   * `--track`/`--no-track` between `-c` and `name` silently created a branch named
   * "--track"/"--no-track" instead of the requested name (or failed outright), breaking exactly
   * the flagship FR-36+FR-37 workflow: create-and-switch with tracking from a remote-tracking
   * start point (also FR-49's default-checked "switch to new branch" UI path). This combination
   * had no prior coverage.
   */
  describe("create-and-switch with a remote-tracking start point (regression: -c argv ordering)", () => {
    async function setUpRepoWithRemoteMain(): Promise<{ dir: string; c1: string }> {
      const origin = await initRepo({ bare: true });
      cleanupDirs.push(origin);
      const dir = await makeTempDir();
      cleanupDirs.push(dir);
      await git(process.cwd(), ["clone", "-q", origin, dir]);
      await writeFile(dir, "a.txt", "1");
      const c1 = await commit(dir, "first");
      await git(dir, ["push", "-q", "-u", "origin", "main"]);
      await git(dir, ["checkout", "-q", "-b", "throwaway"]); // free up "main" as a start-point-only ref
      return { dir, c1 };
    }

    it("creates and switches with auto-detected tracking (no explicit track option), landing the exact requested name", async () => {
      const { dir, c1 } = await setUpRepoWithRemoteMain();

      const result = await createBranch(dir, {
        name: "feature-from-remote",
        startPoint: "origin/main",
        switchToIt: true,
      });

      expect(result.name).toBe("feature-from-remote");
      expect(result.switched).toBe(true);
      expect(result.sha).toBe(c1);

      const { stdout: head } = await git(dir, ["symbolic-ref", "--short", "HEAD"]);
      expect(head.trim()).toBe("feature-from-remote");
      const { stdout: upstream } = await git(dir, ["rev-parse", "--abbrev-ref", "feature-from-remote@{u}"]);
      expect(upstream.trim()).toBe("origin/main");

      // The bug this guards against would have created a branch literally named "--track" (or
      // failed outright) instead — make that regression impossible to miss.
      const { stdout: branchList } = await git(dir, ["branch", "--list"]);
      expect(branchList).not.toContain("--track");
      expect(branchList).not.toContain("--no-track");
    });

    it("honors an explicit track:true, landing the exact requested name with tracking wired", async () => {
      const { dir } = await setUpRepoWithRemoteMain();

      const result = await createBranch(dir, {
        name: "explicit-track",
        startPoint: "origin/main",
        switchToIt: true,
        track: true,
      });

      expect(result.name).toBe("explicit-track");
      const { stdout: head } = await git(dir, ["symbolic-ref", "--short", "HEAD"]);
      expect(head.trim()).toBe("explicit-track");
      const { stdout: upstream } = await git(dir, ["rev-parse", "--abbrev-ref", "explicit-track@{u}"]);
      expect(upstream.trim()).toBe("origin/main");
    });

    it("honors an explicit track:false, landing the exact requested name with no upstream configured", async () => {
      const { dir } = await setUpRepoWithRemoteMain();

      const result = await createBranch(dir, {
        name: "no-track",
        startPoint: "origin/main",
        switchToIt: true,
        track: false,
      });

      expect(result.name).toBe("no-track");
      const { stdout: head } = await git(dir, ["symbolic-ref", "--short", "HEAD"]);
      expect(head.trim()).toBe("no-track");
      await expect(git(dir, ["rev-parse", "--abbrev-ref", "no-track@{u}"])).rejects.toBeTruthy();
    });
  });

  it("rejects an invalid branch name before any mutating git call, leaving no branch behind", async () => {
    const dir = await initRepo();
    cleanupDirs.push(dir);
    await writeFile(dir, "a.txt", "1");
    await commit(dir, "first");

    await expect(createBranch(dir, { name: "bad name with spaces" })).rejects.toBeInstanceOf(
      InvalidRefNameError,
    );
    await expect(createBranch(dir, { name: "trailing.lock" })).rejects.toBeInstanceOf(InvalidRefNameError);

    const { stdout } = await git(dir, ["branch", "--list"]);
    expect(stdout).not.toContain("bad name with spaces");
    expect(stdout).not.toContain("trailing.lock");
  });

  it("validateBranchName resolves cleanly for a valid name and rejects an invalid one", async () => {
    const dir = await initRepo();
    cleanupDirs.push(dir);
    await expect(validateBranchName(dir, "feature/x")).resolves.toBeUndefined();
    await expect(validateBranchName(dir, "")).rejects.toBeInstanceOf(InvalidRefNameError);
  });
});

describe("switchBranch", () => {
  it("moves HEAD to an existing local branch with a clean working tree", async () => {
    const dir = await initRepo();
    cleanupDirs.push(dir);
    await writeFile(dir, "a.txt", "1");
    const c1 = await commit(dir, "first");
    await git(dir, ["branch", "other"]);

    const result = await switchBranch(dir, "other");
    expect(result.sha).toBe(c1);
    const { stdout } = await git(dir, ["symbolic-ref", "--short", "HEAD"]);
    expect(stdout.trim()).toBe("other");
  });

  it("refuses to switch when uncommitted changes would be overwritten, surfacing the real file list, and leaves the working tree untouched", async () => {
    const dir = await initRepo();
    cleanupDirs.push(dir);
    await writeFile(dir, "a.txt", "1");
    await commit(dir, "first");
    await git(dir, ["branch", "other"]);
    await git(dir, ["checkout", "-q", "other"]);
    await writeFile(dir, "a.txt", "2");
    await commit(dir, "second-on-other");
    await git(dir, ["checkout", "-q", "main"]);

    // Uncommitted local modification that conflicts with what "other" holds for the same file.
    await writeFile(dir, "a.txt", "conflicting-uncommitted-edit");

    let caught: unknown;
    try {
      await switchBranch(dir, "other");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(BranchSwitchConflictError);
    const err = caught as InstanceType<typeof BranchSwitchConflictError>;
    expect(err.conflictingPaths).toContain("a.txt");
    expect(err.stderr.length).toBeGreaterThan(0);

    // Working tree and HEAD are unchanged.
    const { stdout: head } = await git(dir, ["symbolic-ref", "--short", "HEAD"]);
    expect(head.trim()).toBe("main");
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    expect(await fs.readFile(path.join(dir, "a.txt"), "utf8")).toBe("conflicting-uncommitted-edit");
  });

  it("does not execute a malicious core.fsmonitor hook (FR-43 regression)", async () => {
    const { dir, markerPath } = await setUpMaliciousFsmonitorRepo(cleanupDirs);
    await git(dir, ["branch", "other"]);

    await switchBranch(dir, "other");

    const fs = await import("node:fs/promises");
    await expect(fs.access(markerPath)).rejects.toBeTruthy();
  });
});

describe("switchToCommit (detached HEAD)", () => {
  it("checks out an arbitrary commit-ish in detached HEAD state", async () => {
    const dir = await initRepo();
    cleanupDirs.push(dir);
    await writeFile(dir, "a.txt", "1");
    const c1 = await commit(dir, "first");
    await writeFile(dir, "a.txt", "2");
    await commit(dir, "second");

    const result = await switchToCommit(dir, c1);
    expect(result.sha).toBe(c1);
    await expect(git(dir, ["symbolic-ref", "-q", "--short", "HEAD"])).rejects.toBeTruthy();
  });
});

describe("deleteBranch / forceDeleteBranch", () => {
  it("safe-deletes a fully-merged branch", async () => {
    const dir = await initRepo();
    cleanupDirs.push(dir);
    await writeFile(dir, "a.txt", "1");
    await commit(dir, "first");
    await git(dir, ["branch", "merged"]);

    await deleteBranch(dir, "merged");
    const { stdout } = await git(dir, ["branch", "--list"]);
    expect(stdout).not.toContain("merged");
  });

  it("rejects a safe-delete of an unmerged branch with a typed error, leaving it intact, then force-delete removes it", async () => {
    const dir = await initRepo();
    cleanupDirs.push(dir);
    await writeFile(dir, "a.txt", "1");
    await commit(dir, "first");
    await git(dir, ["checkout", "-q", "-b", "unmerged"]);
    await writeFile(dir, "a.txt", "2");
    await commit(dir, "second");
    await git(dir, ["checkout", "-q", "main"]);

    await expect(deleteBranch(dir, "unmerged")).rejects.toBeInstanceOf(BranchNotFullyMergedError);
    let branchList = await git(dir, ["branch", "--list"]);
    expect(branchList.stdout).toContain("unmerged");

    await forceDeleteBranch(dir, "unmerged");
    branchList = await git(dir, ["branch", "--list"]);
    expect(branchList.stdout).not.toContain("unmerged");
  });

  it("rejects deleting the currently-checked-out branch with a typed, non-crashing error", async () => {
    const dir = await initRepo();
    cleanupDirs.push(dir);
    await writeFile(dir, "a.txt", "1");
    await commit(dir, "first");

    await expect(deleteBranch(dir, "main")).rejects.toBeInstanceOf(BranchCheckedOutError);
    const { stdout } = await git(dir, ["branch", "--list"]);
    expect(stdout).toContain("main");
  });

  it("rejects deleting a branch checked out in a different worktree, naming that worktree's path", async () => {
    const dir = await initRepo();
    cleanupDirs.push(dir);
    await writeFile(dir, "a.txt", "1");
    await commit(dir, "first");
    await git(dir, ["branch", "other"]);

    const worktreeDir = await makeTempDir();
    cleanupDirs.push(worktreeDir);
    const worktreePathPosix = worktreeDir.replace(/\\/g, "/");
    await git(dir, ["worktree", "add", worktreePathPosix, "other"]);

    let caught: unknown;
    try {
      await deleteBranch(dir, "other");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(BranchCheckedOutError);
    const err = caught as InstanceType<typeof BranchCheckedOutError>;
    expect(err.worktreePath).not.toBeNull();

    const { stdout } = await git(dir, ["branch", "--list"]);
    expect(stdout).toContain("other");
  });

  it("propagates a plain GitCommandError for an unrelated failure (deleting a nonexistent branch)", async () => {
    const dir = await initRepo();
    cleanupDirs.push(dir);
    await writeFile(dir, "a.txt", "1");
    await commit(dir, "first");

    await expect(deleteBranch(dir, "does-not-exist")).rejects.toBeInstanceOf(GitCommandError);
  });

  it("works on a bare repository (no working directory required)", async () => {
    const dir = await initRepo({ bare: true });
    cleanupDirs.push(dir);
    const nonBare = await makeTempDir();
    cleanupDirs.push(nonBare);
    await git(process.cwd(), ["init", "-q", nonBare]);
    await writeFile(nonBare, "a.txt", "1");
    await commit(nonBare, "first");
    await git(nonBare, ["push", "-q", dir, "HEAD:main"]);
    await git(nonBare, ["push", "-q", dir, "HEAD:removable"]);

    await createBranch(dir, { name: "created-on-bare" });
    let branches = await listBranches(dir);
    expect(branches.find((b) => b.name === "created-on-bare")).toBeDefined();

    await deleteBranch(dir, "removable");
    branches = await listBranches(dir);
    expect(branches.find((b) => b.name === "removable")).toBeUndefined();
  });
});

describe("Repository facade", () => {
  it("exposes branch operations and enforces the working-directory requirement for switch on a bare repo", async () => {
    const dir = await initRepo({ bare: true });
    cleanupDirs.push(dir);
    const nonBare = await makeTempDir();
    cleanupDirs.push(nonBare);
    await git(process.cwd(), ["init", "-q", nonBare]);
    await writeFile(nonBare, "a.txt", "1");
    await commit(nonBare, "first");
    await git(nonBare, ["push", "-q", dir, "HEAD:main"]);

    const repo = await Repository.open(dir);

    await repo.createBranch({ name: "from-facade" });
    const branches = await repo.listBranches();
    expect(branches.find((b) => b.name === "from-facade")).toBeDefined();

    await expect(repo.switchBranch("from-facade")).rejects.toThrow(/bare repository/);
    await expect(repo.createBranch({ name: "switch-on-bare", switchToIt: true })).rejects.toThrow(
      /bare repository/,
    );
  });

  it("create/switch/delete round-trip via the Repository facade in a normal repo", async () => {
    const dir = await initRepo();
    cleanupDirs.push(dir);
    await writeFile(dir, "a.txt", "1");
    await commit(dir, "first");
    const repo = await Repository.open(dir);

    await repo.createBranch({ name: "roundtrip" });
    await repo.switchBranch("roundtrip");
    const state = await repo.refreshState();
    expect(state.currentBranch).toBe("roundtrip");

    await repo.switchBranch("main");
    await repo.deleteBranch("roundtrip");
    const branches = await repo.listBranches();
    expect(branches.find((b) => b.name === "roundtrip")).toBeUndefined();
  });
});
