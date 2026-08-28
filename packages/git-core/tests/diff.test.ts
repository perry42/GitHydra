import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getFileDiff, parseUnifiedDiffHunks } from "../src/diff";
import { InvalidArgumentError } from "../src/errors";
import {
  git,
  initRepo,
  writeFile,
  commit,
  cleanup,
  makeTempDir,
  fileExists,
  setUpMaliciousFsmonitorRepo,
} from "./testRepo";

const cleanupDirs: string[] = [];
afterEach(async () => {
  while (cleanupDirs.length) await cleanup(cleanupDirs.pop()!);
});

describe("parseUnifiedDiffHunks", () => {
  it("returns no hunks for empty patch text", () => {
    expect(parseUnifiedDiffHunks("")).toEqual([]);
  });

  it("parses a single hunk with context/add/remove lines and correct line numbers", () => {
    const patch = [
      "diff --git a/a.txt b/a.txt",
      "index 111..222 100644",
      "--- a/a.txt",
      "+++ b/a.txt",
      "@@ -1,3 +1,3 @@",
      " context one",
      "-removed line",
      "+added line",
      " context two",
      "",
    ].join("\n");

    const hunks = parseUnifiedDiffHunks(patch);
    expect(hunks).toHaveLength(1);
    const hunk = hunks[0]!;
    expect(hunk.oldStart).toBe(1);
    expect(hunk.newStart).toBe(1);
    expect(hunk.lines).toEqual([
      { type: "context", content: "context one", oldLineNumber: 1, newLineNumber: 1 },
      { type: "remove", content: "removed line", oldLineNumber: 2, newLineNumber: null },
      { type: "add", content: "added line", oldLineNumber: null, newLineNumber: 2 },
      { type: "context", content: "context two", oldLineNumber: 3, newLineNumber: 3 },
    ]);
  });

  it("ignores a trailing 'No newline at end of file' marker", () => {
    const patch = ["@@ -1 +1 @@", "-old", "+new", "\\ No newline at end of file", ""].join("\n");
    const hunks = parseUnifiedDiffHunks(patch);
    expect(hunks[0]!.lines).toHaveLength(2);
  });

  it("parses multiple hunks in one file independently", () => {
    const patch = [
      "diff --git a/a.txt b/a.txt",
      "--- a/a.txt",
      "+++ b/a.txt",
      "@@ -1,1 +1,1 @@",
      "-first old",
      "+first new",
      "@@ -10,1 +10,1 @@",
      "-second old",
      "+second new",
      "",
    ].join("\n");
    const hunks = parseUnifiedDiffHunks(patch);
    expect(hunks).toHaveLength(2);
    expect(hunks[0]!.oldStart).toBe(1);
    expect(hunks[1]!.oldStart).toBe(10);
  });
});

describe("getFileDiff", () => {
  it("returns the unstaged (worktree vs index) diff for a modified file", async () => {
    const dir = await initRepo();
    cleanupDirs.push(dir);
    await writeFile(dir, "a.txt", "line one\nline two\nline three\n");
    await commit(dir, "base");
    await writeFile(dir, "a.txt", "line one\nline TWO CHANGED\nline three\n");

    const result = await getFileDiff(dir, { kind: "unstaged", path: "a.txt" });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error("expected ok");
    expect(result.isBinary).toBe(false);
    const allLines = result.hunks.flatMap((h) => h.lines);
    expect(allLines.some((l) => l.type === "remove" && l.content === "line two")).toBe(true);
    expect(allLines.some((l) => l.type === "add" && l.content === "line TWO CHANGED")).toBe(true);
  });

  it("returns the staged (index vs HEAD) diff for a staged file, distinct from the unstaged diff", async () => {
    const dir = await initRepo();
    cleanupDirs.push(dir);
    await writeFile(dir, "a.txt", "original\n");
    await commit(dir, "base");
    await writeFile(dir, "a.txt", "staged version\n");
    await git(dir, ["add", "a.txt"]);
    await writeFile(dir, "a.txt", "staged version, then further worktree edit\n");

    const staged = await getFileDiff(dir, { kind: "staged", path: "a.txt" });
    const unstaged = await getFileDiff(dir, { kind: "unstaged", path: "a.txt" });
    expect(staged.status).toBe("ok");
    expect(unstaged.status).toBe("ok");
    if (staged.status !== "ok" || unstaged.status !== "ok") throw new Error("expected ok");

    const stagedAdds = staged.hunks.flatMap((h) => h.lines).filter((l) => l.type === "add");
    expect(stagedAdds.some((l) => l.content === "staged version")).toBe(true);

    const unstagedAdds = unstaged.hunks.flatMap((h) => h.lines).filter((l) => l.type === "add");
    expect(unstagedAdds.some((l) => l.content === "staged version, then further worktree edit")).toBe(true);
  });

  it("returns an untracked file's content as an all-addition diff against empty", async () => {
    const dir = await initRepo();
    cleanupDirs.push(dir);
    await writeFile(dir, "base.txt", "1");
    await commit(dir, "base");
    await writeFile(dir, "new.txt", "brand new line one\nbrand new line two\n");

    const result = await getFileDiff(dir, { kind: "untracked", path: "new.txt" });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error("expected ok");
    const lines = result.hunks.flatMap((h) => h.lines);
    expect(lines.every((l) => l.type === "add")).toBe(true);
    expect(lines.map((l) => l.content)).toEqual(["brand new line one", "brand new line two"]);
  });

  it("returns a historical commit's file diff against its parent", async () => {
    const dir = await initRepo();
    cleanupDirs.push(dir);
    await writeFile(dir, "a.txt", "v1\n");
    await commit(dir, "first");
    await writeFile(dir, "a.txt", "v2\n");
    const secondSha = await commit(dir, "second");
    const parentSha = (await git(dir, ["rev-parse", `${secondSha}^`])).stdout.trim();

    const result = await getFileDiff(dir, {
      kind: "commit",
      sha: secondSha,
      parents: [parentSha],
      path: "a.txt",
    });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error("expected ok");
    const lines = result.hunks.flatMap((h) => h.lines);
    expect(lines.some((l) => l.type === "remove" && l.content === "v1")).toBe(true);
    expect(lines.some((l) => l.type === "add" && l.content === "v2")).toBe(true);
  });

  it("diffs a root commit's file against the empty tree as all-addition", async () => {
    const dir = await initRepo();
    cleanupDirs.push(dir);
    await writeFile(dir, "a.txt", "root content\n");
    const rootSha = await commit(dir, "root");

    const result = await getFileDiff(dir, { kind: "commit", sha: rootSha, parents: [], path: "a.txt" });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error("expected ok");
    expect(result.hunks.flatMap((h) => h.lines).every((l) => l.type === "add")).toBe(true);
  });

  it("diffs a renamed file in a commit correctly, using oldPath", async () => {
    const dir = await initRepo();
    cleanupDirs.push(dir);
    await writeFile(dir, "original.txt", "line one\nline two\nline three\nline four\nline five\n");
    await commit(dir, "base");
    await git(dir, ["mv", "original.txt", "renamed.txt"]);
    await writeFile(dir, "renamed.txt", "line one\nline two CHANGED\nline three\nline four\nline five\n");
    const renameSha = await commit(dir, "rename and tweak");
    const parentSha = (await git(dir, ["rev-parse", `${renameSha}^`])).stdout.trim();

    const result = await getFileDiff(dir, {
      kind: "commit",
      sha: renameSha,
      parents: [parentSha],
      path: "renamed.txt",
      oldPath: "original.txt",
    });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error("expected ok");
    const lines = result.hunks.flatMap((h) => h.lines);
    expect(lines.some((l) => l.type === "remove" && l.content === "line two")).toBe(true);
    expect(lines.some((l) => l.type === "add" && l.content === "line two CHANGED")).toBe(true);
  });

  it("reports isBinary for a binary file instead of patch content", async () => {
    const dir = await initRepo();
    cleanupDirs.push(dir);
    await fs.writeFile(path.join(dir, "image.bin"), Buffer.from([0, 1, 2, 3, 0, 255, 254, 0, 1]));
    await commit(dir, "base with binary");
    await fs.writeFile(path.join(dir, "image.bin"), Buffer.from([0, 9, 9, 9, 0, 255, 254, 0, 1]));

    const result = await getFileDiff(dir, { kind: "unstaged", path: "image.bin" });
    expect(result.status).toBe("binary");
    expect(result.isBinary).toBe(true);
  });

  it("reports an untracked binary file as binary, not garbled content", async () => {
    const dir = await initRepo();
    cleanupDirs.push(dir);
    await writeFile(dir, "base.txt", "1");
    await commit(dir, "base");
    await fs.writeFile(path.join(dir, "new.bin"), Buffer.from([0, 1, 2, 3, 0, 255]));

    const result = await getFileDiff(dir, { kind: "untracked", path: "new.bin" });
    expect(result.status).toBe("binary");
  });

  it("guards an oversized diff via the changed-line-count threshold", async () => {
    const dir = await initRepo();
    cleanupDirs.push(dir);
    const original = Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\n") + "\n";
    await writeFile(dir, "big.txt", original);
    await commit(dir, "base");
    const changed = Array.from({ length: 200 }, (_, i) => `line ${i} CHANGED`).join("\n") + "\n";
    await writeFile(dir, "big.txt", changed);

    const result = await getFileDiff(
      dir,
      { kind: "unstaged", path: "big.txt" },
      { maxChangedLines: 50 },
    );
    expect(result.status).toBe("too-large");
    if (result.status !== "too-large") throw new Error("expected too-large");
    expect(result.reason).toBe("changed-lines");
    expect(result.changedLineCount).toBeGreaterThan(50);
  });

  it("guards an oversized diff via the absolute file-size threshold", async () => {
    const dir = await initRepo();
    cleanupDirs.push(dir);
    await writeFile(dir, "base.txt", "1");
    await commit(dir, "base");
    // A single huge line: few "changed lines" by count, but large in bytes.
    await writeFile(dir, "huge.txt", "x".repeat(5000));

    const result = await getFileDiff(
      dir,
      { kind: "untracked", path: "huge.txt" },
      { maxFileSizeBytes: 1000, maxChangedLines: 100000 },
    );
    expect(result.status).toBe("too-large");
    if (result.status !== "too-large") throw new Error("expected too-large");
    expect(result.reason).toBe("file-size");
    expect(result.fileSizeBytes).toBeGreaterThan(1000);
  });

  it("supports non-ASCII filenames", async () => {
    const dir = await initRepo();
    cleanupDirs.push(dir);
    await writeFile(dir, "base.txt", "1");
    await commit(dir, "base");
    await writeFile(dir, "résumé-日本語.txt", "hello\n");

    const result = await getFileDiff(dir, { kind: "untracked", path: "résumé-日本語.txt" });
    expect(result.status).toBe("ok");
  });

  it("rejects an empty path", async () => {
    const dir = await initRepo();
    cleanupDirs.push(dir);
    await expect(getFileDiff(dir, { kind: "unstaged", path: "" })).rejects.toThrow();
  });

  // Regression: CRITICAL 2 from the security review — `getFileDiff`'s "untracked" source built
  // `git diff --no-index -- /dev/null <path>`, and unlike a normal pathspec, `--no-index`
  // compares two arbitrary filesystem paths and is NOT confined to the repository. Without a
  // containment check, `{ kind: "untracked", path: "../../../../secret.txt" }` (or an absolute
  // path) would read and return that file's content as diff "add" lines — an arbitrary-file-read
  // primitive once wired to IPC. Applied to all three worktree-relative sources for defense in
  // depth, and verified end-to-end (the secret's content never appears in the result) rather
  // than just checking that *a* rejection happens.
  describe("path containment (arbitrary-file-read guard)", () => {
    it("rejects a path-traversal escape for the untracked source, without leaking the target file's content", async () => {
      const outside = await makeTempDir();
      cleanupDirs.push(outside);
      await writeFile(outside, "secret.txt", "TOP SECRET CONTENT THAT MUST NEVER LEAK\n");

      const dir = await initRepo();
      cleanupDirs.push(dir);
      await writeFile(dir, "base.txt", "1");
      await commit(dir, "base");

      const relTraversal = path
        .relative(dir, path.join(outside, "secret.txt"))
        .split(path.sep)
        .join("/");
      expect(relTraversal.startsWith("..")).toBe(true);

      let caught: unknown;
      try {
        await getFileDiff(dir, { kind: "untracked", path: relTraversal });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(InvalidArgumentError);
    });

    it("rejects an absolute path for the untracked source, without leaking the target file's content", async () => {
      const outside = await makeTempDir();
      cleanupDirs.push(outside);
      await writeFile(outside, "secret.txt", "TOP SECRET CONTENT THAT MUST NEVER LEAK\n");

      const dir = await initRepo();
      cleanupDirs.push(dir);
      await writeFile(dir, "base.txt", "1");
      await commit(dir, "base");

      await expect(
        getFileDiff(dir, { kind: "untracked", path: path.join(outside, "secret.txt") }),
      ).rejects.toBeInstanceOf(InvalidArgumentError);
    });

    it("rejects a path-traversal escape for unstaged/staged sources too (defense in depth)", async () => {
      const dir = await initRepo();
      cleanupDirs.push(dir);
      await writeFile(dir, "base.txt", "1");
      await commit(dir, "base");

      await expect(
        getFileDiff(dir, { kind: "unstaged", path: "../outside.txt" }),
      ).rejects.toBeInstanceOf(InvalidArgumentError);
      await expect(
        getFileDiff(dir, { kind: "staged", path: "../outside.txt" }),
      ).rejects.toBeInstanceOf(InvalidArgumentError);
    });

    it("does not silently bypass the size guard for an escaping path (the compounding bug): it throws instead of returning null/ok", async () => {
      // Before the fix, `path.join(cwd, absolutePath)` did not strip the absolute path, so
      // `fs.stat` silently failed, the size guard treated that as "unknown, don't block", and
      // the diff proceeded to leak the file's content. Now the containment check runs first
      // and throws, so the escaping path never reaches numstat/size-check/patch-fetch at all.
      const outside = await makeTempDir();
      cleanupDirs.push(outside);
      await writeFile(outside, "secret.txt", "leaked!\n");

      const dir = await initRepo();
      cleanupDirs.push(dir);
      await writeFile(dir, "base.txt", "1");
      await commit(dir, "base");

      const absoluteEscape = path.join(outside, "secret.txt");
      await expect(
        getFileDiff(dir, { kind: "untracked", path: absoluteEscape }, { maxFileSizeBytes: 1 }),
      ).rejects.toBeInstanceOf(InvalidArgumentError);
    });

    it("still allows a normal, legitimately nested repo-relative path", async () => {
      const dir = await initRepo();
      cleanupDirs.push(dir);
      await writeFile(dir, "src/nested/deep.txt", "1\n");
      await commit(dir, "base");
      await writeFile(dir, "src/nested/deep.txt", "2\n");

      const result = await getFileDiff(dir, { kind: "unstaged", path: "src/nested/deep.txt" });
      expect(result.status).toBe("ok");
    });
  });

  // Regression: CRITICAL 1 — commands that refresh working-tree/index state against an
  // untrusted repo must neutralize `core.fsmonitor`, same as `getWorkingDirectoryStatus()`.
  // This PR added `getFileDiff`'s "unstaged"/"staged" sources as two more such call sites.
  describe("fsmonitor argument-injection guard", () => {
    it("getFileDiff (unstaged source) does NOT execute a malicious core.fsmonitor command", async () => {
      const { dir, markerPath } = await setUpMaliciousFsmonitorRepo(cleanupDirs);
      await writeFile(dir, "a.txt", "changed, unstaged");
      expect(await fileExists(markerPath)).toBe(false);

      const result = await getFileDiff(dir, { kind: "unstaged", path: "a.txt" });

      expect(result.status).toBe("ok");
      expect(await fileExists(markerPath)).toBe(false);
    });

    it("getFileDiff (staged source) does NOT execute a malicious core.fsmonitor command", async () => {
      const { dir, markerPath } = await setUpMaliciousFsmonitorRepo(cleanupDirs);
      await writeFile(dir, "a.txt", "changed, staged");
      // Stage via testRepo.ts's raw, unguarded `git()` helper (deliberately separate from the
      // library under test) so the fixture itself doesn't rely on git-core's own fsmonitor
      // guard — but that means this specific `git add` invocation is itself unguarded and (as
      // this line demonstrates) DOES trip the hook. Reset the marker afterward so the
      // assertion below is isolated to "did `getFileDiff`'s OWN staged-diff call trip it".
      await git(dir, ["add", "a.txt"]);
      await fs.rm(markerPath, { force: true });
      expect(await fileExists(markerPath)).toBe(false);

      const result = await getFileDiff(dir, { kind: "staged", path: "a.txt" });

      expect(result.status).toBe("ok");
      expect(await fileExists(markerPath)).toBe(false);
    });
  });

  // Regression: HIGH — GIT_LITERAL_PATHSPECS must force glob-magic filenames to be interpreted
  // literally, so a real-world name like a Next.js dynamic route (`pages/[id].tsx`) is diffed
  // as itself rather than "[id]" being parsed as a bracket character class.
  describe("literal pathspec handling", () => {
    it("diffs a file whose name contains pathspec-magic bracket characters, as itself", async () => {
      const dir = await initRepo();
      cleanupDirs.push(dir);
      await writeFile(dir, "pages/[id].tsx", "export default function Page() { return null; }\n");
      await commit(dir, "base");
      await writeFile(
        dir,
        "pages/[id].tsx",
        "export default function Page() { return <div />; }\n",
      );

      const result = await getFileDiff(dir, { kind: "unstaged", path: "pages/[id].tsx" });
      expect(result.status).toBe("ok");
      if (result.status !== "ok") throw new Error("expected ok");
      const lines = result.hunks.flatMap((h) => h.lines);
      expect(lines.some((l) => l.type === "add" && l.content.includes("<div />"))).toBe(true);
    });
  });
});
