import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getFileBlame, getFileHistory, parsePorcelainBlame } from "../src/blame";
import { InvalidArgumentError } from "../src/errors";
import type { CommitPager } from "../src/commitLog";
import { git, initRepo, writeFile, commit, cleanup, makeTempDir } from "./testRepo";

const cleanupDirs: string[] = [];
afterEach(async () => {
  while (cleanupDirs.length) await cleanup(cleanupDirs.pop()!);
});

async function readAllPages(reader: CommitPager, pageSize = 5) {
  const all = [];
  for (;;) {
    const page = await reader.readPage(pageSize);
    all.push(...page.commits);
    if (page.done) break;
  }
  reader.close();
  return all;
}

describe("parsePorcelainBlame", () => {
  it("parses a single-commit, multi-line group (metadata shown once, filename repeated)", () => {
    const stdout = [
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa 1 1 3",
      "author Jane Doe",
      "author-mail <jane@example.com>",
      "author-time 1700000000",
      "author-tz +0000",
      "committer Jane Doe",
      "committer-mail <jane@example.com>",
      "committer-time 1700000000",
      "committer-tz +0000",
      "summary Initial commit",
      "filename a.txt",
      "\tline one",
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa 2 2",
      "filename a.txt",
      "\tline two",
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa 3 3",
      "filename a.txt",
      "\tline three",
      "",
    ].join("\n");

    const lines = parsePorcelainBlame(stdout);
    expect(lines).toHaveLength(3);
    expect(lines.map((l) => l.content)).toEqual(["line one", "line two", "line three"]);
    expect(lines.map((l) => l.lineNumber)).toEqual([1, 2, 3]);
    for (const l of lines) {
      expect(l.commit.sha).toBe("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
      expect(l.commit.abbrevSha).toBe("aaaaaaa");
      expect(l.commit.authorName).toBe("Jane Doe");
      expect(l.commit.authorEmail).toBe("jane@example.com");
      expect(l.commit.summary).toBe("Initial commit");
      expect(l.commit.isBoundary).toBe(false);
      expect(l.commit.isUncommitted).toBe(false);
    }
    expect(lines[0]!.commit.authorDate).toBe("2023-11-14T22:13:20+00:00");
  });

  it("parses an uncommitted line with git's literal 'Not Committed Yet' placeholder, never fabricated", () => {
    const stdout = [
      "0000000000000000000000000000000000000000 1 1 1",
      "author Not Committed Yet",
      "author-mail <not.committed.yet>",
      "author-time 1700000000",
      "author-tz +0000",
      "committer Not Committed Yet",
      "committer-mail <not.committed.yet>",
      "committer-time 1700000000",
      "committer-tz +0000",
      "summary Version of a.txt from a2f6e...",
      "filename a.txt",
      "\tuncommitted edit",
      "",
    ].join("\n");

    const lines = parsePorcelainBlame(stdout);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.commit.isUncommitted).toBe(true);
    expect(lines[0]!.commit.authorName).toBe("Not Committed Yet");
    expect(lines[0]!.commit.authorEmail).toBe("not.committed.yet");
  });

  it("derives isBoundary from the supplied history-boundary set, not porcelain's own (ambiguous) 'boundary' line", () => {
    const sha = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const stdout = [
      `${sha} 1 1 1`,
      "author Root Author",
      "author-mail <root@example.com>",
      "author-time 1600000000",
      "author-tz +0200",
      "committer Root Author",
      "committer-mail <root@example.com>",
      "committer-time 1600000000",
      "committer-tz +0200",
      "summary root commit",
      "boundary",
      "filename a.txt",
      "\troot line",
      "",
    ].join("\n");

    // Porcelain's own "boundary" line is present above, but with no boundary set supplied (the
    // default), isBoundary must stay false — this line alone doesn't distinguish a genuine root
    // from a shallow/graft boundary (see parsePorcelainBlame's doc comment).
    expect(parsePorcelainBlame(stdout)[0]!.commit.isBoundary).toBe(false);
    // Only actual membership in the on-disk shallow/graft SHA set should flag it.
    expect(parsePorcelainBlame(stdout, new Set([sha]))[0]!.commit.isBoundary).toBe(true);
  });
});

describe("getFileBlame", () => {
  it("blames a plain committed file untouched since its initial commit — one commit, no uncommitted block", async () => {
    const dir = await initRepo();
    cleanupDirs.push(dir);
    await writeFile(dir, "a.txt", "line one\nline two\nline three\n");
    const sha = await commit(dir, "base");

    const result = await getFileBlame(dir, "a.txt", null);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error("expected ok");
    expect(result.lines).toHaveLength(3);
    expect(result.lines.every((l) => l.commit.sha === sha)).toBe(true);
    expect(result.lines.every((l) => !l.commit.isUncommitted)).toBe(true);
    expect(result.lines.map((l) => l.content)).toEqual(["line one", "line two", "line three"]);
  });

  it("attributes an uncommitted (working-tree) edit to 'Not Committed Yet', leaving unrelated lines attributed normally", async () => {
    const dir = await initRepo();
    cleanupDirs.push(dir);
    await writeFile(dir, "a.txt", "line one\nline two\nline three\n");
    const sha = await commit(dir, "base");
    await writeFile(dir, "a.txt", "line one\nline TWO EDITED\nline three\n");

    const result = await getFileBlame(dir, "a.txt", null);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error("expected ok");
    expect(result.lines).toHaveLength(3);
    expect(result.lines[0]!.commit.sha).toBe(sha);
    expect(result.lines[0]!.commit.isUncommitted).toBe(false);
    expect(result.lines[1]!.commit.isUncommitted).toBe(true);
    expect(result.lines[1]!.commit.authorName).toBe("Not Committed Yet");
    expect(result.lines[1]!.content).toBe("line TWO EDITED");
    expect(result.lines[2]!.commit.sha).toBe(sha);
    expect(result.lines[2]!.commit.isUncommitted).toBe(false);
  });

  it("blames a file as of a historical commit, never the working tree's current content", async () => {
    const dir = await initRepo();
    cleanupDirs.push(dir);
    await writeFile(dir, "a.txt", "v1 line one\nv1 line two\n");
    const firstSha = await commit(dir, "first");
    await writeFile(dir, "a.txt", "v2 line one\nv2 line two\n");
    const secondSha = await commit(dir, "second");
    // Further, still-uncommitted edit on top — historical blame must ignore this entirely.
    await writeFile(dir, "a.txt", "v3 UNCOMMITTED\nv3 UNCOMMITTED\n");

    const result = await getFileBlame(dir, "a.txt", firstSha);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error("expected ok");
    expect(result.lines.map((l) => l.content)).toEqual(["v1 line one", "v1 line two"]);
    expect(result.lines.every((l) => l.commit.sha === firstSha)).toBe(true);

    const secondResult = await getFileBlame(dir, "a.txt", secondSha);
    expect(secondResult.status).toBe("ok");
    if (secondResult.status !== "ok") throw new Error("expected ok");
    expect(secondResult.lines.map((l) => l.content)).toEqual(["v2 line one", "v2 line two"]);
    expect(secondResult.lines.every((l) => l.commit.sha === secondSha)).toBe(true);
  });

  it("blames a file renamed at some point in its history, attributing pre-rename lines to the original commit", async () => {
    const dir = await initRepo();
    cleanupDirs.push(dir);
    await writeFile(dir, "original.txt", "line one\nline two\nline three\n");
    const firstSha = await commit(dir, "base");
    await git(dir, ["mv", "original.txt", "renamed.txt"]);
    await writeFile(dir, "renamed.txt", "line one\nline two\nline three\nline four\n");
    const secondSha = await commit(dir, "rename and extend");

    const result = await getFileBlame(dir, "renamed.txt", null);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error("expected ok");
    expect(result.lines).toHaveLength(4);
    // Pre-rename lines still attributed to the original (pre-rename) commit.
    expect(result.lines[0]!.commit.sha).toBe(firstSha);
    expect(result.lines[1]!.commit.sha).toBe(firstSha);
    expect(result.lines[2]!.commit.sha).toBe(firstSha);
    // The newly-added post-rename line is attributed to the rename commit.
    expect(result.lines[3]!.commit.sha).toBe(secondSha);
    expect(result.lines[3]!.content).toBe("line four");
  });

  it("reports the binary state for a binary file, before ever running a full blame", async () => {
    const dir = await initRepo();
    cleanupDirs.push(dir);
    await fs.writeFile(path.join(dir, "image.bin"), Buffer.from([0, 1, 2, 3, 0, 255, 254, 0, 1]));
    await commit(dir, "binary base");

    const result = await getFileBlame(dir, "image.bin", null);
    expect(result.status).toBe("binary");
  });

  it("reports the too-large state for a file exceeding the size guard, with no full blame fetched", async () => {
    const dir = await initRepo();
    cleanupDirs.push(dir);
    await writeFile(dir, "base.txt", "1");
    await commit(dir, "base");
    // A single huge line, comfortably over DEFAULT_MAX_FILE_SIZE_BYTES's own default (2MB) is
    // slow to fixture — instead this test relies on getFileBlame() having no override knob (the
    // guard threshold is fixed, matching the spec's "reuse DEFAULT_MAX_FILE_SIZE_BYTES" — this
    // exercises the guard end-to-end against a real oversized file well under 2MB is not
    // possible without an override, so this test writes just over 2MB).
    await writeFile(dir, "huge.txt", "x".repeat(2 * 1024 * 1024 + 1000));

    const result = await getFileBlame(dir, "huge.txt", null);
    expect(result.status).toBe("too-large");
    if (result.status !== "too-large") throw new Error("expected too-large");
    expect(result.reason).toBe("file-size");
    expect(result.fileSizeBytes).toBeGreaterThan(2 * 1024 * 1024);
  });

  it("reports the empty state for a valid, zero-length file — not an error, no 'Not Committed Yet' block", async () => {
    const dir = await initRepo();
    cleanupDirs.push(dir);
    await writeFile(dir, "empty.txt", "");
    await commit(dir, "add empty file");

    const result = await getFileBlame(dir, "empty.txt", null);
    expect(result.status).toBe("empty");
  });

  it("reports not-found for a path that doesn't exist in the working tree", async () => {
    const dir = await initRepo();
    cleanupDirs.push(dir);
    await writeFile(dir, "base.txt", "1");
    await commit(dir, "base");

    const result = await getFileBlame(dir, "does-not-exist.txt", null);
    expect(result.status).toBe("not-found");
  });

  it("reports not-found for a path that didn't exist at the given historical revision", async () => {
    const dir = await initRepo();
    cleanupDirs.push(dir);
    await writeFile(dir, "base.txt", "1");
    const firstSha = await commit(dir, "base");
    await writeFile(dir, "new.txt", "hello\n");
    await commit(dir, "add new.txt");

    const result = await getFileBlame(dir, "new.txt", firstSha);
    expect(result.status).toBe("not-found");
  });

  it("rejects an empty path", async () => {
    const dir = await initRepo();
    cleanupDirs.push(dir);
    await expect(getFileBlame(dir, "", null)).rejects.toBeInstanceOf(InvalidArgumentError);
  });

  it("rejects a non-hex revision", async () => {
    const dir = await initRepo();
    cleanupDirs.push(dir);
    await writeFile(dir, "a.txt", "1");
    await commit(dir, "base");
    await expect(getFileBlame(dir, "a.txt", "--upload-pack=/bin/sh")).rejects.toBeInstanceOf(
      InvalidArgumentError,
    );
  });

  it("rejects a path-traversal escape for the no-revision (working-tree) path", async () => {
    const outside = await makeTempDir();
    cleanupDirs.push(outside);
    await writeFile(outside, "secret.txt", "TOP SECRET\n");

    const dir = await initRepo();
    cleanupDirs.push(dir);
    await writeFile(dir, "base.txt", "1");
    await commit(dir, "base");

    const relTraversal = path
      .relative(dir, path.join(outside, "secret.txt"))
      .split(path.sep)
      .join("/");
    expect(relTraversal.startsWith("..")).toBe(true);

    await expect(getFileBlame(dir, relTraversal, null)).rejects.toBeInstanceOf(InvalidArgumentError);
  });

  it("marks a shallow-clone boundary commit's blamed lines as isBoundary: true, not a true root", async () => {
    const origin = await initRepo();
    cleanupDirs.push(origin);
    await writeFile(origin, "a.txt", "line one\nline two\n");
    await commit(origin, "root");
    await writeFile(origin, "a.txt", "line one\nline two CHANGED\n");
    const tipSha = await commit(origin, "tip");

    const clone = await makeTempDir();
    cleanupDirs.push(clone);
    await git(process.cwd(), [
      "clone",
      "-q",
      "--depth=1",
      "--no-local",
      `file://${origin.replace(/\\/g, "/")}`,
      clone,
    ]).catch(async () => {
      await git(process.cwd(), ["clone", "-q", "--depth=1", origin, clone]);
    });

    const result = await getFileBlame(clone, "a.txt", null);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error("expected ok");
    expect(result.lines).toHaveLength(2);
    expect(result.lines.every((l) => l.commit.sha === tipSha)).toBe(true);
    expect(result.lines.every((l) => l.commit.isBoundary)).toBe(true);
  });

  it("does not flag a genuine (non-shallow) root commit as a boundary", async () => {
    const dir = await initRepo();
    cleanupDirs.push(dir);
    await writeFile(dir, "a.txt", "root line\n");
    await commit(dir, "root");

    const result = await getFileBlame(dir, "a.txt", null);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error("expected ok");
    expect(result.lines.every((l) => !l.commit.isBoundary)).toBe(true);
  });

  it("blames a merge commit against its first-parent tree only, matching getCommitFileDiff's convention", async () => {
    const dir = await initRepo();
    cleanupDirs.push(dir);
    await writeFile(dir, "a.txt", "base\n");
    await commit(dir, "base");
    await git(dir, ["checkout", "-q", "-b", "feature"]);
    await writeFile(dir, "a.txt", "base\nfeature line\n");
    const featureSha = await commit(dir, "feature work");
    await git(dir, ["checkout", "-q", "main"]);
    await writeFile(dir, "a.txt", "base\nmain line\n");
    const mainSha = await commit(dir, "main work");
    await git(dir, ["merge", "-q", "-X", "ours", "-m", "merge feature", "feature"]);
    const mergeSha = (await git(dir, ["rev-parse", "HEAD"])).stdout.trim();

    const result = await getFileBlame(dir, "a.txt", mergeSha);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error("expected ok");
    // -X ours kept main's content at the merge — first-parent blame should attribute every line
    // to base/main-work commits, never the feature branch's commit.
    const shas = result.lines.map((l) => l.commit.sha);
    expect(shas).not.toContain(featureSha);
    expect(shas).toContain(mainSha);
  });

  it("blames a real historical commit against a bare repository (specs/blame.md edge case: 'DetailPanel-driven blame works normally' on bare repos)", async () => {
    const origin = await initRepo();
    cleanupDirs.push(origin);
    await writeFile(origin, "a.txt", "bare line one\nbare line two\n");
    const sha = await commit(origin, "base");

    const bare = await makeTempDir();
    cleanupDirs.push(bare);
    await git(process.cwd(), ["clone", "-q", "--bare", origin, bare]);

    // A bare repo has no working tree at all — only the revision-mode path (never the
    // no-revision/working-tree path) is reachable here, matching ChangesPanel offering no file
    // rows (and thus no Blame entry point) on a bare repo.
    const result = await getFileBlame(bare, "a.txt", sha);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error("expected ok");
    expect(result.lines.map((l) => l.content)).toEqual(["bare line one", "bare line two"]);
    expect(result.lines.every((l) => l.commit.sha === sha && !l.commit.isUncommitted)).toBe(true);
  });
});

describe("getFileHistory", () => {
  it("pages a file's commit history, newest first", async () => {
    const dir = await initRepo();
    cleanupDirs.push(dir);
    const shas: string[] = [];
    for (let i = 0; i < 5; i++) {
      await writeFile(dir, "a.txt", String(i));
      shas.push(await commit(dir, `edit ${i}`));
    }
    shas.reverse();

    const reader = await getFileHistory(dir, "HEAD", "a.txt");
    const commits = await readAllPages(reader, 2);
    expect(commits.map((c) => c.sha)).toEqual(shas);
  });

  it("excludes commits that never touched the file", async () => {
    const dir = await initRepo();
    cleanupDirs.push(dir);
    await writeFile(dir, "a.txt", "1");
    const relevantSha = await commit(dir, "touches a.txt");
    await writeFile(dir, "unrelated.txt", "1");
    await commit(dir, "touches unrelated.txt only");

    const reader = await getFileHistory(dir, "HEAD", "a.txt");
    const commits = await readAllPages(reader);
    expect(commits.map((c) => c.sha)).toEqual([relevantSha]);
  });

  it("includes pre-rename history for a renamed file via --follow", async () => {
    const dir = await initRepo();
    cleanupDirs.push(dir);
    await writeFile(dir, "original.txt", "line one\n");
    const firstSha = await commit(dir, "base");
    await git(dir, ["mv", "original.txt", "renamed.txt"]);
    const renameSha = await commit(dir, "rename");

    const reader = await getFileHistory(dir, "HEAD", "renamed.txt");
    const commits = await readAllPages(reader);
    expect(commits.map((c) => c.sha)).toEqual([renameSha, firstSha]);
  });

  it("re-blames against an earlier revision selected from file history", async () => {
    const dir = await initRepo();
    cleanupDirs.push(dir);
    await writeFile(dir, "a.txt", "v1\n");
    const firstSha = await commit(dir, "first");
    await writeFile(dir, "a.txt", "v2\n");
    await commit(dir, "second");

    const reader = await getFileHistory(dir, "HEAD", "a.txt");
    const commits = await readAllPages(reader);
    const earlier = commits[commits.length - 1]!;
    expect(earlier.sha).toBe(firstSha);

    const result = await getFileBlame(dir, "a.txt", earlier.sha);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error("expected ok");
    expect(result.lines.map((l) => l.content)).toEqual(["v1"]);
  });

  it("rejects an empty path and an empty revision", async () => {
    const dir = await initRepo();
    cleanupDirs.push(dir);
    await writeFile(dir, "a.txt", "1");
    await commit(dir, "base");
    await expect(getFileHistory(dir, "HEAD", "")).rejects.toBeInstanceOf(InvalidArgumentError);
    await expect(getFileHistory(dir, "", "a.txt")).rejects.toBeInstanceOf(InvalidArgumentError);
  });
});
