import * as fs from "node:fs/promises";
import * as path from "node:path";
import { InvalidArgumentError, SymlinkEscapesWorkdirError } from "./errors";

/** True for a Node `fs` error carrying a string `.code` (a `NodeJS.ErrnoException`) — narrower
 * than a bare `instanceof Error` check, and used to distinguish "couldn't resolve this path at
 * all" (ENOENT/ENOTDIR/ELOOP/EACCES/...) from an unexpected non-filesystem exception. */
function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return typeof err === "object" && err !== null && typeof (err as { code?: unknown }).code === "string";
}

/**
 * Shared containment check, taking two already-`path.resolve`'d absolute paths. Factored out of
 * `assertPathWithinWorkdir` so `resolveRealPathWithinWorkdir` below can run the identical check
 * against an `fs.realpath()` result, which is legitimately absolute and must NOT go back through
 * `assertPathWithinWorkdir`'s "must not be absolute" input guard (that guard exists for
 * caller-supplied relative pathspecs, not for a resolved-on-disk realpath).
 */
function escapesWorkdir(workdirResolved: string, targetResolved: string): boolean {
  const relativeFromWorkdir = path.relative(workdirResolved, targetResolved);
  // path.relative() returns a string starting with ".." when `targetResolved` lands outside
  // `workdirResolved` (including exactly ".." for the workdir's own parent), or an absolute
  // path when the two inputs are on different Windows drives — both mean "escapes workdir".
  return (
    relativeFromWorkdir === ".." ||
    relativeFromWorkdir.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativeFromWorkdir)
  );
}

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

  if (escapesWorkdir(workdirResolved, resolved)) {
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

/**
 * The check `resolveWithinWorkdir` alone is NOT sufficient before any `fs.readFile` (or other
 * content-reading call) of a working-tree path: `resolveWithinWorkdir`/`assertPathWithinWorkdir`
 * are purely textual (no `..`, not absolute) and say nothing about what the path actually
 * resolves to on disk. A conflicted path's working-tree entry can be a symlink (git blob mode
 * `120000`) whose target is absolute or `..`-relative and points anywhere on the filesystem —
 * `~/.ssh/id_rsa`, `/etc/shadow`, anything the process can read — which `resolveWithinWorkdir`
 * has no way to see, since it never touches the filesystem. A repo can also point an
 * *intermediate* path component at a symlinked directory for the same effect.
 *
 * This resolves `relPath` within `workdir` (via `resolveWithinWorkdir`), then further resolves
 * every symlink in the result — both the final path segment AND any intermediate directory
 * component — via `fs.realpath()`, and re-runs the containment check against that fully-resolved
 * path. Refuses (throws `SymlinkEscapesWorkdirError`) if the realpath lands outside the working
 * directory. A relative symlink that stays inside the working directory is left alone — this is
 * about escaping the repo, not about symlinks per se.
 *
 * `workdir` itself is also realpath'd before comparing, so a symlink somewhere in the *workdir's
 * own* path (e.g. a platform temp directory that's itself a symlink, as `/tmp` commonly is on
 * macOS) can never produce a false-positive "escapes" refusal.
 *
 * Returns `null` — not an error — whenever `fs.realpath` can't resolve `relPath` at all: missing
 * (ENOENT — `fs.realpath` requires every path component to exist), a component that turned out
 * not to be a directory (ENOTDIR), a symlink loop (ELOOP), or a permission error reading an
 * intermediate directory (EACCES/EPERM). Every one of these is a case where no content could be
 * read either way (the caller's own subsequent `fs.readFile` would fail identically), so this
 * intentionally matches the "missing file" outcome callers already treat as benign (e.g. the user
 * resolved a conflict by deleting the file) rather than forcing every I/O quirk into a refusal.
 * Only a *successfully resolved* realpath that lands outside the working directory is a refusal —
 * an inability to resolve the path at all is not, by itself, evidence of an escape.
 *
 * Mirrors `diff.ts`'s `statWorkdirFileSize()` precedent of never trusting a symlink's target at
 * face value, but goes further: that function uses `fs.lstat` to avoid follow-and-size a symlink
 * target it never reads; this function is for callers that DO need to read the target's actual
 * bytes, so it must resolve the symlink chain and validate where it lands rather than just
 * refusing to follow it at all.
 */
export async function resolveRealPathWithinWorkdir(
  workdir: string,
  relPath: string,
): Promise<string | null> {
  const resolved = resolveWithinWorkdir(workdir, relPath);
  const workdirResolved = path.resolve(workdir);

  let real: string;
  try {
    real = await fs.realpath(resolved);
  } catch (err) {
    if (isErrnoException(err)) return null;
    throw err;
  }

  // Best-effort: if the workdir's own path can't be realpath'd (shouldn't normally happen — the
  // caller is presumably already operating inside it), fall back to the plain resolved form
  // rather than letting an unrelated failure here mask the actual symlink-escape check.
  const workdirReal = await fs.realpath(workdirResolved).catch(() => workdirResolved);

  if (escapesWorkdir(workdirReal, real)) {
    throw new SymlinkEscapesWorkdirError(relPath, real);
  }

  return real;
}
