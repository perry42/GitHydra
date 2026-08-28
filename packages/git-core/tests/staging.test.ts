import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  stageFile,
  unstageFile,
  stageAllFiles,
  unstageAllFiles,
  discardTrackedFileChanges,
  discardUntrackedFile,
} from "../src/staging";
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

async function porcelain(dir: string): Promise<string> {
  const { stdout } = await git(dir, ["status", "--porcelain=v1", "--untracked-files=all"]);
  return stdout;
}

describe("stageFile / unstageFile", () => {
  it("stageFile moves an unstaged change into the index without touching the on-disk file", async () => {
    const dir = await initRepo();
    cleanupDirs.push(dir);
    await writeFile(dir, "a.txt", "1");
    await commit(dir, "base");
    await writeFile(dir, "a.txt", "2");

    expect(await porcelain(dir)).toContain(" M a.txt");
    await stageFile(dir, "a.txt");
    expect(await porcelain(dir)).toContain("M  a.txt");
    expect(await fs.readFile(path.join(dir, "a.txt"), "utf8")).toBe("2");
  });

  it("unstageFile reverses stageFile without touching the on-disk file", async () => {
    const dir = await initRepo();
    cleanupDirs.push(dir);
    await writeFile(dir, "a.txt", "1");
    await commit(dir, "base");
    await writeFile(dir, "a.txt", "2");
    await stageFile(dir, "a.txt");

    await unstageFile(dir, "a.txt");
    expect(await porcelain(dir)).toContain(" M a.txt");
    expect(await fs.readFile(path.join(dir, "a.txt"), "utf8")).toBe("2");
  });

  it("stageFile works for a newly created untracked file", async () => {
    const dir = await initRepo();
    cleanupDirs.push(dir);
    await writeFile(dir, "base.txt", "1");
    await commit(dir, "base");
    await writeFile(dir, "new.txt", "content");

    await stageFile(dir, "new.txt");
    expect(await porcelain(dir)).toContain("A  new.txt");
  });

  it("rejects an empty path", async () => {
    const dir = await initRepo();
    cleanupDirs.push(dir);
    await expect(stageFile(dir, "")).rejects.toBeInstanceOf(InvalidArgumentError);
    await expect(unstageFile(dir, "   ")).rejects.toBeInstanceOf(InvalidArgumentError);
  });
});

describe("stageAllFiles / unstageAllFiles", () => {
  it("stages every unstaged and untracked file in one call", async () => {
    const dir = await initRepo();
    cleanupDirs.push(dir);
    await writeFile(dir, "a.txt", "1");
    await writeFile(dir, "b.txt", "1");
    await commit(dir, "base");
    await writeFile(dir, "a.txt", "2");
    await writeFile(dir, "b.txt", "2");
    await writeFile(dir, "c.txt", "new");

    await stageAllFiles(dir);
    const status = await porcelain(dir);
    expect(status).toContain("M  a.txt");
    expect(status).toContain("M  b.txt");
    expect(status).toContain("A  c.txt");
  });

  it("unstages every staged file in one call, leaving further unstaged edits alone", async () => {
    const dir = await initRepo();
    cleanupDirs.push(dir);
    await writeFile(dir, "a.txt", "1");
    await commit(dir, "base");
    await writeFile(dir, "a.txt", "2");
    await git(dir, ["add", "a.txt"]);

    await unstageAllFiles(dir);
    expect(await porcelain(dir)).toContain(" M a.txt");
  });

  it("does not stage or unstage a conflicted path", async () => {
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
      /* expected conflict */
    });

    await stageAllFiles(dir);
    // The conflict marker file must still show as unmerged (UU), not resolved/staged.
    expect(await porcelain(dir)).toContain("UU a.txt");
  });

  it("is a no-op when there is nothing eligible to stage/unstage", async () => {
    const dir = await initRepo();
    cleanupDirs.push(dir);
    await writeFile(dir, "a.txt", "1");
    await commit(dir, "base");

    await expect(stageAllFiles(dir)).resolves.toBeUndefined();
    await expect(unstageAllFiles(dir)).resolves.toBeUndefined();
    expect(await porcelain(dir)).toBe("");
  });
});

describe("discardTrackedFileChanges", () => {
  it("reverts an unstaged edit back to the index content", async () => {
    const dir = await initRepo();
    cleanupDirs.push(dir);
    await writeFile(dir, "a.txt", "original\n");
    await commit(dir, "base");
    await writeFile(dir, "a.txt", "edited\n");

    await discardTrackedFileChanges(dir, "a.txt");
    // Normalize CRLF: Windows git installs commonly default core.autocrlf=true, which
    // rewrites LF -> CRLF on checkout — irrelevant to what this test is actually verifying
    // (that `git restore --` reverted the content), so tolerate either line ending.
    expect((await fs.readFile(path.join(dir, "a.txt"), "utf8")).replace(/\r\n/g, "\n")).toBe(
      "original\n",
    );
    expect(await porcelain(dir)).toBe("");
  });

  it("leaves staged changes untouched (distinct from unstageFile)", async () => {
    const dir = await initRepo();
    cleanupDirs.push(dir);
    await writeFile(dir, "a.txt", "original\n");
    await commit(dir, "base");
    await writeFile(dir, "a.txt", "staged\n");
    await git(dir, ["add", "a.txt"]);
    await writeFile(dir, "a.txt", "staged, then further edit\n");

    await discardTrackedFileChanges(dir, "a.txt");
    // Worktree reverts to the staged (index) content, but the staged change itself remains
    // staged. CRLF-tolerant for the same reason as the test above.
    expect((await fs.readFile(path.join(dir, "a.txt"), "utf8")).replace(/\r\n/g, "\n")).toBe(
      "staged\n",
    );
    expect(await porcelain(dir)).toContain("M  a.txt");
  });
});

describe("discardUntrackedFile", () => {
  it("removes a single untracked file from disk", async () => {
    const dir = await initRepo();
    cleanupDirs.push(dir);
    await writeFile(dir, "base.txt", "1");
    await commit(dir, "base");
    await writeFile(dir, "scratch.txt", "temp");

    await discardUntrackedFile(dir, "scratch.txt");
    await expect(fs.access(path.join(dir, "scratch.txt"))).rejects.toThrow();
  });

  it("never touches other untracked files (scoped to exactly one path)", async () => {
    const dir = await initRepo();
    cleanupDirs.push(dir);
    await writeFile(dir, "base.txt", "1");
    await commit(dir, "base");
    await writeFile(dir, "keep-me.txt", "keep");
    await writeFile(dir, "remove-me.txt", "remove");

    await discardUntrackedFile(dir, "remove-me.txt");
    await expect(fs.access(path.join(dir, "keep-me.txt"))).resolves.toBeUndefined();
    await expect(fs.access(path.join(dir, "remove-me.txt"))).rejects.toThrow();
  });

  it("is a safe no-op if the given path is actually tracked", async () => {
    const dir = await initRepo();
    cleanupDirs.push(dir);
    await writeFile(dir, "tracked.txt", "1");
    await commit(dir, "base");

    await expect(discardUntrackedFile(dir, "tracked.txt")).resolves.toBeUndefined();
    await expect(fs.access(path.join(dir, "tracked.txt"))).resolves.toBeUndefined();
  });
});

// Regression: CRITICAL 2 from the security review, applied here as defense-in-depth. Even
// though `stageFile`/`unstageFile`/`discardTrackedFileChanges`/`discardUntrackedFile` all go
// through normal git pathspec commands (which git itself already refuses to resolve outside
// the working tree), each now runs the same containment check as `diff.ts`'s "untracked"
// source, so a path-traversal or absolute-path argument is rejected before it ever reaches
// git — most importantly for `discardUntrackedFile`, which is destructive.
describe("path containment (defense in depth)", () => {
  it("stageFile/unstageFile reject a path-traversal escape", async () => {
    const dir = await initRepo();
    cleanupDirs.push(dir);
    await writeFile(dir, "a.txt", "1");
    await commit(dir, "base");

    await expect(stageFile(dir, "../outside.txt")).rejects.toBeInstanceOf(InvalidArgumentError);
    await expect(unstageFile(dir, "../outside.txt")).rejects.toBeInstanceOf(InvalidArgumentError);
  });

  it("discardTrackedFileChanges rejects a path-traversal escape", async () => {
    const dir = await initRepo();
    cleanupDirs.push(dir);
    await writeFile(dir, "a.txt", "1");
    await commit(dir, "base");

    await expect(discardTrackedFileChanges(dir, "../outside.txt")).rejects.toBeInstanceOf(
      InvalidArgumentError,
    );
  });

  it("discardUntrackedFile rejects a traversal/absolute path instead of deleting a file outside the repo", async () => {
    const outside = await makeTempDir();
    cleanupDirs.push(outside);
    const outsideFile = path.join(outside, "innocent-bystander.txt");
    await fs.writeFile(outsideFile, "do not delete me");

    const dir = await initRepo();
    cleanupDirs.push(dir);
    await writeFile(dir, "a.txt", "1");
    await commit(dir, "base");

    const relTraversal = path.relative(dir, outsideFile).split(path.sep).join("/");
    expect(relTraversal.startsWith("..")).toBe(true);

    await expect(discardUntrackedFile(dir, relTraversal)).rejects.toBeInstanceOf(InvalidArgumentError);
    await expect(discardUntrackedFile(dir, outsideFile)).rejects.toBeInstanceOf(InvalidArgumentError);
    // The outside file must still exist — neither call touched it.
    await expect(fs.access(outsideFile)).resolves.toBeUndefined();
  });

  it("still allows a normal, legitimately nested repo-relative path", async () => {
    const dir = await initRepo();
    cleanupDirs.push(dir);
    await writeFile(dir, "src/nested/deep.txt", "1");
    await commit(dir, "base");
    await writeFile(dir, "src/nested/deep.txt", "2");

    await expect(stageFile(dir, "src/nested/deep.txt")).resolves.toBeUndefined();
    expect(await porcelain(dir)).toContain("M  src/nested/deep.txt");
  });
});

// Regression: CRITICAL 1 — every command in this module that stages/unstages/discards touches
// the index and/or working tree of a possibly-untrusted repo, so each now neutralizes
// `core.fsmonitor` the same way `getWorkingDirectoryStatus()` does for `status`.
describe("fsmonitor argument-injection guard", () => {
  it("stageFile does NOT execute a malicious core.fsmonitor command", async () => {
    const { dir, markerPath } = await setUpMaliciousFsmonitorRepo(cleanupDirs);
    await writeFile(dir, "new.txt", "content");
    expect(await fileExists(markerPath)).toBe(false);

    await stageFile(dir, "new.txt");

    expect(await fileExists(markerPath)).toBe(false);
  });

  it("unstageFile does NOT execute a malicious core.fsmonitor command", async () => {
    const { dir, markerPath } = await setUpMaliciousFsmonitorRepo(cleanupDirs);
    await writeFile(dir, "a.txt", "2");
    // Stage via the raw, unguarded fixture helper (deliberately separate from the library
    // under test) — that `git add` itself trips the hook, so reset the marker before the
    // assertion below, which is only about `unstageFile`'s own behavior.
    await git(dir, ["add", "a.txt"]);
    await fs.rm(markerPath, { force: true });
    expect(await fileExists(markerPath)).toBe(false);

    await unstageFile(dir, "a.txt");

    expect(await fileExists(markerPath)).toBe(false);
  });

  it("stageAllFiles does NOT execute a malicious core.fsmonitor command", async () => {
    const { dir, markerPath } = await setUpMaliciousFsmonitorRepo(cleanupDirs);
    await writeFile(dir, "a.txt", "2");
    await writeFile(dir, "new.txt", "content");
    expect(await fileExists(markerPath)).toBe(false);

    await stageAllFiles(dir);

    expect(await fileExists(markerPath)).toBe(false);
  });

  it("unstageAllFiles does NOT execute a malicious core.fsmonitor command", async () => {
    const { dir, markerPath } = await setUpMaliciousFsmonitorRepo(cleanupDirs);
    await writeFile(dir, "a.txt", "2");
    await git(dir, ["add", "a.txt"]);
    await fs.rm(markerPath, { force: true });
    expect(await fileExists(markerPath)).toBe(false);

    await unstageAllFiles(dir);

    expect(await fileExists(markerPath)).toBe(false);
  });

  it("discardTrackedFileChanges does NOT execute a malicious core.fsmonitor command", async () => {
    const { dir, markerPath } = await setUpMaliciousFsmonitorRepo(cleanupDirs);
    await writeFile(dir, "a.txt", "2");
    expect(await fileExists(markerPath)).toBe(false);

    await discardTrackedFileChanges(dir, "a.txt");

    expect(await fileExists(markerPath)).toBe(false);
  });

  it("discardUntrackedFile does NOT execute a malicious core.fsmonitor command", async () => {
    const { dir, markerPath } = await setUpMaliciousFsmonitorRepo(cleanupDirs);
    await writeFile(dir, "scratch.txt", "temp");
    expect(await fileExists(markerPath)).toBe(false);

    await discardUntrackedFile(dir, "scratch.txt");

    expect(await fileExists(markerPath)).toBe(false);
  });
});

// Regression: HIGH — GIT_LITERAL_PATHSPECS must force glob-magic filenames (bracket character
// classes, in particular — the only pathspec-magic character that's also a legal Windows
// filename character, e.g. a real-world Next.js dynamic route `pages/[id].tsx`) to be
// interpreted literally, rather than letting git glob-match a *different* file. This matters
// most for the destructive discard operations, where a wrong match would destroy real work.
describe("literal pathspec handling", () => {
  it("stages a file whose name contains bracket characters, as itself", async () => {
    const dir = await initRepo();
    cleanupDirs.push(dir);
    await writeFile(dir, "base.txt", "1");
    await commit(dir, "base");
    await writeFile(dir, "pages/[id].tsx", "export default function Page() {}\n");

    await stageFile(dir, "pages/[id].tsx");
    expect(await porcelain(dir)).toContain("A  pages/[id].tsx");
  });

  it("does not let a non-matching bracket pathspec silently glob-match a differently-named file", async () => {
    const dir = await initRepo();
    cleanupDirs.push(dir);
    // No file literally named "[a].txt" exists — only "a.txt". Without
    // GIT_LITERAL_PATHSPECS, git would interpret "[a].txt" as a glob (a bracket character
    // class matching the single character "a"), which WOULD match "a.txt".
    await writeFile(dir, "a.txt", "must never be touched by the pathspec below");
    await commit(dir, "base");
    await writeFile(dir, "a.txt", "unrelated edit");

    await expect(stageFile(dir, "[a].txt")).rejects.toThrow();
    // "a.txt" must still be unstaged — the "[a].txt" pathspec must NOT have matched it.
    expect(await porcelain(dir)).toContain(" M a.txt");
    expect(await porcelain(dir)).not.toContain("M  a.txt");
  });

  it("discardUntrackedFile scoped to a bracket-magic name never removes a differently-named file", async () => {
    const dir = await initRepo();
    cleanupDirs.push(dir);
    await writeFile(dir, "base.txt", "1");
    await commit(dir, "base");
    // "a.txt" exists; "[a].txt" (the literal name we ask to discard) does not.
    await writeFile(dir, "a.txt", "must survive");

    await expect(discardUntrackedFile(dir, "[a].txt")).resolves.toBeUndefined(); // no-op: no literal match
    await expect(fs.access(path.join(dir, "a.txt"))).resolves.toBeUndefined();
  });
});
