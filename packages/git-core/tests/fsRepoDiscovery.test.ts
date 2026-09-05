import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fastCheckRepositoryDiscovery } from "../src/fsRepoDiscovery";
import { OperationCancelledError } from "../src/errors";
import { git, initRepo, makeTempDir, cleanup } from "./testRepo";

const cleanupDirs: string[] = [];
const savedEnv: Record<string, string | undefined> = {};

afterEach(async () => {
  while (cleanupDirs.length) await cleanup(cleanupDirs.pop()!);
  for (const key of Object.keys(savedEnv)) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
    delete savedEnv[key];
  }
});

/** Save + set an env var for the duration of one test, auto-restored by the shared `afterEach`. */
function setEnv(key: string, value: string | undefined): void {
  if (!(key in savedEnv)) savedEnv[key] = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

/**
 * Isolate a fresh nested temp dir from any ambient repo above it, the same way
 * repository.test.ts's own "throws NotAGitRepositoryError" test does: an ancestor directory (a
 * developer's home directory, a CI runner's checkout root, ...) may itself be a real git
 * repository, which would otherwise make the upward walk find IT instead of confirming "no repo
 * anywhere". `GIT_CEILING_DIRECTORIES` is honored directly by `fastCheckRepositoryDiscovery`
 * (see its own doc comment for why), so setting it here is not a test-only hack layered on top of
 * production code — it exercises real, supported behavior.
 */
async function makeIsolatedNestedDir(depth = 3): Promise<{ leaf: string; root: string }> {
  const root = await makeTempDir();
  let leaf = root;
  for (let i = 0; i < depth; i++) {
    leaf = path.join(leaf, `nested${i}`);
  }
  await fs.mkdir(leaf, { recursive: true });
  setEnv("GIT_CEILING_DIRECTORIES", root);
  return { leaf, root };
}

describe("fastCheckRepositoryDiscovery", () => {
  it('returns "definitely-not-a-repo" for a plain nested directory with no .git anywhere up to the ceiling', async () => {
    const { leaf, root } = await makeIsolatedNestedDir();
    cleanupDirs.push(root);
    await expect(fastCheckRepositoryDiscovery(leaf)).resolves.toBe("definitely-not-a-repo");
  });

  it('returns "defer-to-git" once a real repo\'s .git directory is found in the parent chain', async () => {
    const dir = await initRepo();
    cleanupDirs.push(dir);
    const nested = path.join(dir, "a", "b", "c");
    await fs.mkdir(nested, { recursive: true });
    await expect(fastCheckRepositoryDiscovery(nested)).resolves.toBe("defer-to-git");
  });

  it('returns "defer-to-git" for the repo root itself (.git is a direct child)', async () => {
    const dir = await initRepo();
    cleanupDirs.push(dir);
    await expect(fastCheckRepositoryDiscovery(dir)).resolves.toBe("defer-to-git");
  });

  it('returns "defer-to-git" when .git is a FILE (worktree/submodule gitdir pointer), not a directory', async () => {
    const { leaf, root } = await makeIsolatedNestedDir(1);
    cleanupDirs.push(root);
    await fs.writeFile(path.join(leaf, ".git"), "gitdir: /somewhere/else/.git/worktrees/x\n", "utf8");
    await expect(fastCheckRepositoryDiscovery(leaf)).resolves.toBe("defer-to-git");
  });

  it('returns "defer-to-git" for a directory that itself looks like a bare repository (no .git child, but HEAD/objects/refs present)', async () => {
    const dir = await initRepo({ bare: true });
    cleanupDirs.push(dir);
    await expect(fastCheckRepositoryDiscovery(dir)).resolves.toBe("defer-to-git");
  });

  it('returns "defer-to-git" for a directory NESTED inside a bare repository (walk must keep climbing until it reaches the bare repo\'s own top)', async () => {
    const dir = await initRepo({ bare: true });
    cleanupDirs.push(dir);
    // A bare repo's own internal layout has real subdirectories (objects/, refs/) that are
    // themselves ordinary, non-bare-looking directories — the walk must not stop at the first
    // one and must climb all the way to the bare repo's own top, which IS detected as such.
    const nested = path.join(dir, "objects", "pack");
    await fs.mkdir(nested, { recursive: true });
    await expect(fastCheckRepositoryDiscovery(nested)).resolves.toBe("defer-to-git");
  });

  it('does NOT mistake an ordinary directory that merely happens to contain files named "HEAD"/"objects"/"refs" for a bare repo (HEAD content must parse as a symref or SHA)', async () => {
    const { leaf, root } = await makeIsolatedNestedDir(1);
    cleanupDirs.push(root);
    await fs.writeFile(path.join(leaf, "HEAD"), "not a real ref or sha\n", "utf8");
    await fs.mkdir(path.join(leaf, "objects"));
    await fs.mkdir(path.join(leaf, "refs"));
    await expect(fastCheckRepositoryDiscovery(leaf)).resolves.toBe("definitely-not-a-repo");
  });

  // Security-review finding (2026-09-04): GitHydra explicitly supports opening untrusted repos,
  // so an oversized file that merely happens to be named "HEAD" next to real-looking objects/refs
  // directories must never be read in full — its size alone is enough to rule out "looks bare".
  it('does NOT read an oversized "HEAD" file\'s content at all (size-capped before any read), treating it as "not bare"', async () => {
    const { leaf, root } = await makeIsolatedNestedDir(1);
    cleanupDirs.push(root);
    // Well over MAX_HEAD_FILE_SIZE_BYTES (1024) but still starts with a byte sequence that WOULD
    // parse as a valid ref if this function ever read it — proves the size check runs first.
    const oversized = `ref: refs/heads/main\n${"x".repeat(4096)}`;
    await fs.writeFile(path.join(leaf, "HEAD"), oversized, "utf8");
    await fs.mkdir(path.join(leaf, "objects"));
    await fs.mkdir(path.join(leaf, "refs"));
    await expect(fastCheckRepositoryDiscovery(leaf)).resolves.toBe("definitely-not-a-repo");
  });

  it('honors GIT_CEILING_DIRECTORIES: still checks the ceiling directory itself for .git, but never its parent', async () => {
    // A real repo one level ABOVE the ceiling must never be found once the ceiling is reached.
    const dir = await initRepo();
    cleanupDirs.push(dir);
    const ceiling = path.join(dir, "ceiling");
    const leaf = path.join(ceiling, "leaf");
    await fs.mkdir(leaf, { recursive: true });
    setEnv("GIT_CEILING_DIRECTORIES", ceiling);
    await expect(fastCheckRepositoryDiscovery(leaf)).resolves.toBe("definitely-not-a-repo");
  });

  it('honors a MULTI-entry GIT_CEILING_DIRECTORIES list (delimiter-separated)', async () => {
    const { leaf, root } = await makeIsolatedNestedDir(2);
    cleanupDirs.push(root);
    const otherCeiling = await makeTempDir();
    cleanupDirs.push(otherCeiling);
    setEnv("GIT_CEILING_DIRECTORIES", [otherCeiling, root].join(path.delimiter));
    await expect(fastCheckRepositoryDiscovery(leaf)).resolves.toBe("definitely-not-a-repo");
  });

  it('ignores a non-absolute GIT_CEILING_DIRECTORIES entry rather than erroring, falling back to the real filesystem walk', async () => {
    const { leaf, root } = await makeIsolatedNestedDir();
    cleanupDirs.push(root);
    setEnv("GIT_CEILING_DIRECTORIES", ["relative/entry", root].join(path.delimiter));
    await expect(fastCheckRepositoryDiscovery(leaf)).resolves.toBe("definitely-not-a-repo");
  });

  for (const envVar of ["GIT_DIR", "GIT_WORK_TREE", "GIT_DISCOVERY_ACROSS_FILESYSTEM"]) {
    it(`defers to git (never answers "definitely-not-a-repo") when ${envVar} is set, even for an otherwise-clean non-repo directory`, async () => {
      const { leaf, root } = await makeIsolatedNestedDir();
      cleanupDirs.push(root);
      setEnv(envVar, envVar === "GIT_DIR" ? path.join(root, "somewhere.git") : "1");
      await expect(fastCheckRepositoryDiscovery(leaf)).resolves.toBe("defer-to-git");
    });
  }

  it("defers to git (rather than throwing) when startDir does not exist at all", async () => {
    const root = await makeTempDir();
    cleanupDirs.push(root);
    const missing = path.join(root, "does-not-exist");
    await expect(fastCheckRepositoryDiscovery(missing)).resolves.toBe("defer-to-git");
  });

  it("rejects with OperationCancelledError, not a verdict, when the caller aborts mid-walk", async () => {
    const { leaf, root } = await makeIsolatedNestedDir(50);
    cleanupDirs.push(root);
    const controller = new AbortController();
    controller.abort();
    await expect(fastCheckRepositoryDiscovery(leaf, controller.signal)).rejects.toBeInstanceOf(
      OperationCancelledError,
    );
  });

  // Security-review finding (2026-09-04): a real repo reachable only through a SYMLINKED ancestor
  // directory must still be found — `startDir` is resolved via `fs.realpath()` before the upward
  // walk begins (see fsRepoDiscovery.ts's own doc comment), matching what a real spawned `git`
  // process would see via its physical cwd. Uses a Windows junction (no elevated privileges
  // required, unlike a plain directory symlink — confirmed empirically on this dev machine) on
  // win32, a plain directory symlink elsewhere.
  it("finds a real repo reachable only through a symlinked/junctioned ancestor directory, never falsely answering \"definitely-not-a-repo\"", async () => {
    const repoDir = await initRepo();
    cleanupDirs.push(repoDir);
    // The actual, PHYSICAL location the symlink will point at: a subdirectory of the real repo
    // that has no `.git` of its own — only its ancestor (repoDir) does.
    const physicalTarget = path.join(repoDir, "project-a");
    await fs.mkdir(physicalTarget);

    // The symlink/junction lives somewhere else entirely, isolated via GIT_CEILING_DIRECTORIES so
    // that, if the fix regresses (walking the caller-supplied path's own unresolved parent chain
    // instead of the resolved physical one), the walk would deterministically hit this ceiling
    // and answer "definitely-not-a-repo" WITHOUT ever reaching repoDir — proving this test can
    // actually catch that regression, not just coincidentally pass either way.
    const linkParent = await makeTempDir();
    cleanupDirs.push(linkParent);
    setEnv("GIT_CEILING_DIRECTORIES", linkParent);
    const linkPath = path.join(linkParent, "link-to-project-a");
    await fs.symlink(physicalTarget, linkPath, process.platform === "win32" ? "junction" : "dir");

    await expect(fastCheckRepositoryDiscovery(linkPath)).resolves.toBe("defer-to-git");
  });

  it("a large/deeply-populated non-repo directory tree resolves just as fast as an empty one (cost is parent-chain depth, not directory contents)", async () => {
    const { leaf, root } = await makeIsolatedNestedDir(1);
    cleanupDirs.push(root);
    for (let i = 0; i < 25; i++) {
      const sub = path.join(leaf, `dir${i}`);
      await fs.mkdir(sub, { recursive: true });
      for (let j = 0; j < 25; j++) {
        await fs.writeFile(path.join(sub, `file${j}.txt`), "x".repeat(50));
      }
    }
    const start = Date.now();
    await expect(fastCheckRepositoryDiscovery(leaf)).resolves.toBe("definitely-not-a-repo");
    // Generous bound (this never touches directory contents at all, so it should be near-instant
    // regardless of machine load) — guards against an accidental future change that starts
    // reading the target directory's own children.
    expect(Date.now() - start).toBeLessThan(2000);
  });
});
