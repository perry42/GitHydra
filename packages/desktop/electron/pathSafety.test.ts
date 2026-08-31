import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InvalidArgumentError } from "@githydra/git-core";
import { resolveRepoRelativePath, realpathWithinWorkdir } from "./pathSafety";

describe("resolveRepoRelativePath — textual containment", () => {
  const workdir = path.join("C:", "repo");

  it("resolves a plain repository-relative path against workdir", () => {
    expect(resolveRepoRelativePath(workdir, "src/index.ts")).toBe(path.resolve(workdir, "src/index.ts"));
  });

  it("rejects an empty path", () => {
    expect(() => resolveRepoRelativePath(workdir, "")).toThrow(InvalidArgumentError);
  });

  it("rejects an absolute path", () => {
    expect(() => resolveRepoRelativePath(workdir, path.join("C:", "elsewhere", "file.txt"))).toThrow(
      InvalidArgumentError,
    );
  });

  it("rejects a path that escapes workdir via ..", () => {
    expect(() => resolveRepoRelativePath(workdir, "../../outside.txt")).toThrow(InvalidArgumentError);
  });
});

describe("realpathWithinWorkdir — symlink escape check", () => {
  let tmpRoot: string;
  let workdir: string;
  let outsideDir: string;

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "githydra-pathsafety-"));
    workdir = path.join(tmpRoot, "repo");
    outsideDir = path.join(tmpRoot, "outside");
    await fs.mkdir(workdir, { recursive: true });
    await fs.mkdir(outsideDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it("returns the realpath for an ordinary file inside workdir", async () => {
    const filePath = path.join(workdir, "conflicted.txt");
    await fs.writeFile(filePath, "content");

    const realPath = await realpathWithinWorkdir(workdir, filePath);

    expect(realPath).toBe(await fs.realpath(filePath));
  });

  it("throws InvalidArgumentError for a path that doesn't exist", async () => {
    await expect(realpathWithinWorkdir(workdir, path.join(workdir, "missing.txt"))).rejects.toThrow(
      InvalidArgumentError,
    );
  });

  // Symlink creation can require elevated privileges on Windows (SeCreateSymbolicLinkPrivilege /
  // Developer Mode) — attempt it in each test, but skip gracefully (rather than failing, and
  // rather than assuming Unix-only) if it's not permitted in this environment. Per the
  // security-reviewer finding this test exercises.
  async function trySymlink(target: string, linkPath: string, type: "file" | "dir"): Promise<boolean> {
    try {
      await fs.symlink(target, linkPath, type);
      return true;
    } catch {
      // eslint-disable-next-line no-console
      console.warn("Skipping symlink-escape assertion: fs.symlink not permitted in this environment.");
      return false;
    }
  }

  it("refuses a conflicted-file path whose working-tree entry is a symlink pointing outside the repo working directory", async () => {
    const outsideTarget = path.join(outsideDir, "secret.exe");
    await fs.writeFile(outsideTarget, "not really an exe, just a probe target");
    const conflictedPath = path.join(workdir, "conflicted-file.exe");

    if (!(await trySymlink(outsideTarget, conflictedPath, "file"))) return;

    await expect(realpathWithinWorkdir(workdir, conflictedPath)).rejects.toThrow(InvalidArgumentError);
  });

  it("refuses a path reached through an intermediate symlinked directory pointing outside workdir", async () => {
    const outsideSubdir = path.join(outsideDir, "nested");
    await fs.mkdir(outsideSubdir, { recursive: true });
    await fs.writeFile(path.join(outsideSubdir, "file.txt"), "content");
    const linkedDir = path.join(workdir, "linked-dir");

    if (!(await trySymlink(outsideSubdir, linkedDir, "dir"))) return;

    const conflictedPath = path.join(linkedDir, "file.txt");
    await expect(realpathWithinWorkdir(workdir, conflictedPath)).rejects.toThrow(InvalidArgumentError);
  });

  it("allows a symlink that stays within the repo working directory", async () => {
    const realTarget = path.join(workdir, "real-file.txt");
    await fs.writeFile(realTarget, "content");
    const linkPath = path.join(workdir, "link-to-real.txt");

    if (!(await trySymlink(realTarget, linkPath, "file"))) return;

    const realPath = await realpathWithinWorkdir(workdir, linkPath);
    expect(realPath).toBe(await fs.realpath(realTarget));
  });
});
