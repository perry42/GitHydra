import * as fs from "node:fs/promises";
import * as path from "node:path";
import { InvalidArgumentError } from "@githydra/git-core";

/**
 * specs/merge-rebase-conflict-resolution.md: same repository-relative-path containment discipline
 * `git-core`'s own `pathSafety.ts` uses for every filesystem-touching operation, mirrored here
 * (not imported — `pathSafety.ts` isn't part of `git-core`'s public exports) because
 * `openPathInExternalEditor` is a main-process-only affordance with no `git-core` equivalent:
 * `shell.openPath` takes an arbitrary filesystem path with no confinement of its own, so a
 * caller-supplied conflicted-file path must be validated before it ever reaches it — the same
 * class of arbitrary-file-open primitive `git-core`'s README documents for `--no-index` diffing.
 *
 * This is a *textual* check only: it never touches the filesystem, so it cannot see whether the
 * resolved path is actually a symlink pointing outside `workdir`. Callers that hand the result to
 * something which follows symlinks (like `shell.openPath`) must also run `realpathWithinWorkdir`
 * below before acting on it.
 */
export function resolveRepoRelativePath(workdir: string, relPath: string): string {
  if (!relPath || !relPath.trim()) {
    throw new InvalidArgumentError("File path must not be empty.");
  }
  if (path.isAbsolute(relPath)) {
    throw new InvalidArgumentError(`File path must be repository-relative, not absolute: ${JSON.stringify(relPath)}`);
  }
  const workdirResolved = path.resolve(workdir);
  const resolved = path.resolve(workdirResolved, relPath);
  const relativeFromWorkdir = path.relative(workdirResolved, resolved);
  const escapesWorkdir =
    relativeFromWorkdir === ".." ||
    relativeFromWorkdir.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativeFromWorkdir);
  if (escapesWorkdir) {
    throw new InvalidArgumentError(`File path escapes the repository working directory: ${JSON.stringify(relPath)}`);
  }
  return resolved;
}

/**
 * `fs.realpath`s `absolutePath` (an already textually-validated path from `resolveRepoRelativePath`)
 * and re-runs the same containment check against the *realpath*, not the textual one.
 *
 * Security finding (specs/merge-rebase-conflict-resolution.md review): `resolveRepoRelativePath`'s
 * check is textual-only (rejects absolute paths and `..` segments via `path.resolve`/
 * `path.relative`, neither of which touch the filesystem). A conflicted file's materialized
 * working-tree entry can be a symlink (git blob mode `120000`) to an arbitrary target outside the
 * repo, or an intermediate path segment can be a symlinked directory — either passes textual
 * containment untouched. `shell.openPath` follows symlinks and, for many file types
 * (`.exe`/`.bat`/`.cmd`/`.lnk` on Windows, `.desktop` on Linux), executes them via the OS default
 * handler, so a caller-supplied path must be re-verified against its realpath before reaching it.
 * Mirrors `git-core`'s `diff.ts` `statWorkdirFileSize()` deliberately using `fs.lstat` (not
 * `fs.stat`) to avoid following a symlink, for the same risk class.
 *
 * Returns the realpath — callers should act on *that* path (not the original), so the last thing
 * that touches the filesystem is the exact path that was actually verified as contained.
 *
 * Throws `InvalidArgumentError` (never returns a path that escapes `workdir`) if the path can't
 * be resolved (e.g. it doesn't exist) or if its realpath escapes the repository working directory.
 */
export async function realpathWithinWorkdir(workdir: string, absolutePath: string): Promise<string> {
  let workdirReal: string;
  try {
    workdirReal = await fs.realpath(path.resolve(workdir));
  } catch {
    throw new InvalidArgumentError(`Could not resolve the repository working directory: ${JSON.stringify(workdir)}`);
  }

  let pathReal: string;
  try {
    pathReal = await fs.realpath(absolutePath);
  } catch {
    throw new InvalidArgumentError(`Could not resolve "${absolutePath}" — it may not exist in the working directory.`);
  }

  const relativeFromWorkdir = path.relative(workdirReal, pathReal);
  const escapesWorkdir =
    relativeFromWorkdir === ".." ||
    relativeFromWorkdir.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativeFromWorkdir);
  if (escapesWorkdir) {
    throw new InvalidArgumentError(
      `File path resolves outside the repository working directory, possibly via a symlink: ${JSON.stringify(absolutePath)}`,
    );
  }
  return pathReal;
}
