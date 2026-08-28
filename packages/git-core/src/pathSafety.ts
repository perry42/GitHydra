import * as path from "node:path";
import { InvalidArgumentError } from "./errors";

/**
 * Validate that `relPath` is a non-empty, repository-relative path that resolves to somewhere
 * inside `workdir` — never absolute, never able to escape via `..` segments.
 *
 * Required before any caller-supplied path reaches a filesystem read (`fs.stat`/`fs.lstat`) or
 * a `--no-index` diff (`diff.ts`'s "untracked" source): unlike a normal git pathspec, which git
 * itself refuses to resolve outside the working tree, `--no-index` compares two arbitrary
 * filesystem paths and is NOT confined to the repository at all. Without this check,
 * `getUntrackedFileDiff("../../../../.ssh/id_rsa")` (or an absolute path) would read and
 * return that file's content as diff "add" lines — a real arbitrary-file-read primitive once
 * wired to IPC from the renderer.
 *
 * Also applied, as defense-in-depth, to the plain pathspec-based commands in `staging.ts`
 * (stage/unstage/discard) even though git's own pathspec resolution already refuses to operate
 * outside the working tree for those — belt and suspenders against a change to that assumption
 * (or a git version/config difference) ever going unnoticed.
 *
 * Throws `InvalidArgumentError` rather than silently truncating/normalizing/clamping, so a
 * caller can never be surprised by an operation quietly acting on a different path than the
 * one it asked for.
 */
export function assertPathWithinWorkdir(workdir: string, relPath: string): void {
  if (!relPath || !relPath.trim()) {
    throw new InvalidArgumentError("File path must not be empty.");
  }
  if (path.isAbsolute(relPath)) {
    throw new InvalidArgumentError(
      `File path must be repository-relative, not absolute: ${JSON.stringify(relPath)}`,
    );
  }

  const workdirResolved = path.resolve(workdir);
  const resolved = path.resolve(workdirResolved, relPath);
  const relativeFromWorkdir = path.relative(workdirResolved, resolved);

  // path.relative() returns a string starting with ".." when `resolved` lands outside
  // `workdirResolved` (including exactly ".." for the workdir's own parent), or an absolute
  // path when the two inputs are on different Windows drives — both mean "escapes workdir".
  const escapesWorkdir =
    relativeFromWorkdir === ".." ||
    relativeFromWorkdir.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativeFromWorkdir);

  if (escapesWorkdir) {
    throw new InvalidArgumentError(
      `File path escapes the repository working directory: ${JSON.stringify(relPath)}`,
    );
  }
}

/** Same containment check as `assertPathWithinWorkdir`, returning the validated absolute path. */
export function resolveWithinWorkdir(workdir: string, relPath: string): string {
  assertPathWithinWorkdir(workdir, relPath);
  return path.resolve(workdir, relPath);
}
