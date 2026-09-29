// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect, afterEach } from "vitest";
import { listRefs, indexRefsBySha } from "../src/refs";
import { git, initRepo, writeFile, commit, cleanup, makeTempDir } from "./testRepo";

const cleanupDirs: string[] = [];
afterEach(async () => {
  while (cleanupDirs.length) await cleanup(cleanupDirs.pop()!);
});

describe("listRefs", () => {
  it("lists local branches, tags (lightweight + annotated), and remote-tracking branches", async () => {
    const origin = await initRepo({ bare: true });
    cleanupDirs.push(origin);

    const dir = await makeTempDir();
    cleanupDirs.push(dir);
    await git(process.cwd(), ["clone", "-q", origin, dir]).catch(async () => {
      await git(process.cwd(), ["init", "-q", dir]);
      await git(dir, ["remote", "add", "origin", origin]);
    });
    await git(dir, ["checkout", "-q", "-b", "main"]).catch(() => {});
    await writeFile(dir, "a.txt", "1");
    const c1 = await commit(dir, "first");
    await git(dir, ["push", "-q", "-u", "origin", "main"]).catch(() => {});

    await git(dir, ["branch", "feature-x"]);
    await git(dir, ["tag", "v1.0.0"]); // lightweight
    await git(dir, ["tag", "-a", "v2.0.0", "-m", "release 2"]); // annotated

    const refs = await listRefs(dir);
    const byShort = new Map(refs.map((r) => [r.shortName, r]));

    expect(byShort.get("main")?.type).toBe("local-branch");
    expect(byShort.get("main")?.targetCommitSha).toBe(c1);
    expect(byShort.get("feature-x")?.type).toBe("local-branch");
    expect(byShort.get("v1.0.0")?.type).toBe("tag");
    expect(byShort.get("v1.0.0")?.isAnnotatedTag).toBe(false);
    expect(byShort.get("v1.0.0")?.targetCommitSha).toBe(c1);
    expect(byShort.get("v2.0.0")?.isAnnotatedTag).toBe(true);
    expect(byShort.get("v2.0.0")?.targetCommitSha).toBe(c1); // dereferenced to the commit, not the tag object

    const remoteBranch = refs.find((r) => r.type === "remote-branch" && r.shortName === "origin/main");
    expect(remoteBranch).toBeDefined();
    expect(remoteBranch?.remoteName).toBe("origin");
  });

  it("returns an empty list for a zero-commit repo without throwing", async () => {
    const dir = await initRepo();
    cleanupDirs.push(dir);
    const refs = await listRefs(dir);
    expect(refs).toEqual([]);
  });

  // Follow-up to specs/ref-chip-synced-upstream-merge.md, found via a real Electron test: a real
  // `git clone` creates a symbolic `refs/remotes/origin/HEAD -> refs/remotes/origin/main` pointer —
  // `for-each-ref` happily returns it, but it's an alias, not a real branch, and must not decorate
  // any commit as a phantom "origin/HEAD" remote-tracking chip (same exclusion
  // `listRemoteBranches()` in branches.ts already applies, for the identical reason).
  it("excludes a remote's symbolic HEAD pointer (refs/remotes/origin/HEAD) — not a real remote branch", async () => {
    const origin = await initRepo({ bare: true });
    cleanupDirs.push(origin);

    const seed = await initRepo();
    cleanupDirs.push(seed);
    await writeFile(seed, "a.txt", "1");
    await commit(seed, "first");
    await git(seed, ["remote", "add", "origin", origin]);
    await git(seed, ["push", "-q", "origin", "main"]);

    const dir = await makeTempDir();
    cleanupDirs.push(dir);
    // A plain clone (no --branch override) is the default, most common shape that creates
    // refs/remotes/origin/HEAD — confirmed present on disk below, so this test fails loudly if the
    // fixture itself stops producing the symref this regression is actually about.
    await git(process.cwd(), ["clone", "-q", origin, dir]);
    const { stdout: symbolicRefCheck } = await git(dir, ["symbolic-ref", "refs/remotes/origin/HEAD"]);
    expect(symbolicRefCheck.trim()).toBe("refs/remotes/origin/main");

    const refs = await listRefs(dir);
    expect(refs.find((r) => r.fullName === "refs/remotes/origin/HEAD")).toBeUndefined();
    expect(refs.find((r) => r.shortName === "origin/HEAD")).toBeUndefined();
    // The real remote branch itself is still listed, unaffected.
    expect(refs.find((r) => r.shortName === "origin/main")?.type).toBe("remote-branch");
  });
});

describe("indexRefsBySha", () => {
  it("groups multiple refs pointing at the same commit", async () => {
    const dir = await initRepo();
    cleanupDirs.push(dir);
    await writeFile(dir, "a.txt", "1");
    const sha = await commit(dir, "first");
    await git(dir, ["branch", "other-branch"]);
    await git(dir, ["tag", "v1"]);

    const refs = await listRefs(dir);
    const bySha = indexRefsBySha(refs);
    const decorations = bySha.get(sha) ?? [];
    const names = decorations.map((d) => d.name).sort();
    expect(names).toEqual(["main", "other-branch", "v1"].sort());
  });
});
