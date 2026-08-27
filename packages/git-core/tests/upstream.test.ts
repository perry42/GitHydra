import { describe, it, expect, afterEach } from "vitest";
import { getUpstreamBranch } from "../src/upstream";
import { git, initRepo, writeFile, commit, cleanup, makeTempDir } from "./testRepo";

const cleanupDirs: string[] = [];
afterEach(async () => {
  while (cleanupDirs.length) await cleanup(cleanupDirs.pop()!);
});

describe("getUpstreamBranch", () => {
  it("resolves the current branch's configured upstream", async () => {
    const origin = await initRepo({ bare: true });
    cleanupDirs.push(origin);

    const clone = await makeTempDir();
    cleanupDirs.push(clone);
    await git(process.cwd(), ["clone", "-q", origin, clone]);
    await writeFile(clone, "a.txt", "1");
    await commit(clone, "first");
    await git(clone, ["push", "-q", "-u", "origin", "main"]);

    const upstream = await getUpstreamBranch(clone);
    expect(upstream).toBe("origin/main");
  });

  it("returns null when the current branch has no upstream configured", async () => {
    const dir = await initRepo();
    cleanupDirs.push(dir);
    await writeFile(dir, "a.txt", "1");
    await commit(dir, "first");

    const upstream = await getUpstreamBranch(dir);
    expect(upstream).toBeNull();
  });

  it("returns null for a detached HEAD", async () => {
    const dir = await initRepo();
    cleanupDirs.push(dir);
    await writeFile(dir, "a.txt", "1");
    const sha = await commit(dir, "first");
    await git(dir, ["checkout", "-q", sha]);

    const upstream = await getUpstreamBranch(dir);
    expect(upstream).toBeNull();
  });

  it("returns null for an unborn branch (fresh, commit-less repo)", async () => {
    const dir = await initRepo();
    cleanupDirs.push(dir);

    const upstream = await getUpstreamBranch(dir);
    expect(upstream).toBeNull();
  });
});
