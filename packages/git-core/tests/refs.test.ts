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
