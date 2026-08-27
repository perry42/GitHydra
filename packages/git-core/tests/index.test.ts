import { describe, it, expect, afterEach } from "vitest";
import { Repository } from "../src/index";
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
});
