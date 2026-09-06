// SPDX-License-Identifier: GPL-3.0-or-later
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { runGit, runGitBuffer, withEndOfOptions, withFsmonitorNeutralized } from "./gitProcess";
import { EMPTY_TREE_SHA, HEX_SHA_RE } from "./changedFiles";
import { InvalidArgumentError } from "./errors";
import { assertPathWithinWorkdir, resolveRealPathWithinWorkdir } from "./pathSafety";
import type { DiffSource } from "./diff";
import type { ImageBlob, ImageDiffResult } from "./types";

/**
 * FR-139: fixed, case-insensitive extension allowlist for image-preview eligibility. Deliberately
 * independent of `getFileDiff`'s own binary/text detection (`diff.ts`) — an `.svg` is ordinary
 * text to git (so `getFileDiff` would return `status: "ok"` with hunks for it), but it's still
 * image-eligible and takes the image-preview path instead. No content-sniffing/magic-byte
 * detection: a misnamed file (a PNG saved as `.txt`) is intentionally NOT treated as an image —
 * see `specs/image-diff-preview.md`'s Non-goals.
 */
export const IMAGE_EXTENSION_MIME_TYPES: Readonly<Record<string, string>> = {
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".bmp": "image/bmp",
  ".svg": "image/svg+xml",
};

function imageMimeTypeForPath(filePath: string): string | null {
  const ext = path.extname(filePath).toLowerCase();
  return Object.prototype.hasOwnProperty.call(IMAGE_EXTENSION_MIME_TYPES, ext)
    ? IMAGE_EXTENSION_MIME_TYPES[ext]!
    : null;
}

/** FR-139: true when `filePath`'s extension (case-insensitive) is on the fixed image allowlist. */
export function isImageEligiblePath(filePath: string): boolean {
  return imageMimeTypeForPath(filePath) !== null;
}

/**
 * FR-141: non-configurable per-side cap on how many raw bytes `getImageDiff()` will ever read and
 * base64-encode for one side of a change. Deliberately separate from `diff.ts`'s
 * `DEFAULT_MAX_FILE_SIZE_BYTES`/`DiffOptions.maxFileSizeBytes` (that guard never even runs for a
 * binary file today — `getFileDiff` returns `status: "binary"` before its own size check, per
 * `diff.ts`'s early return) and deliberately NOT exposed as an option: a base64 data URI is ~33%
 * larger than the raw bytes and this payload crosses the IPC boundary into a renderer `<img
 * src>`, so this bound protects renderer memory regardless of any caller preference.
 */
export const MAX_IMAGE_SIDE_BYTES = 25 * 1024 * 1024;

/** One side's read plan: either a working-tree filesystem path, or a git blob revision expression. */
type ImageSidePlan =
  | { kind: "workdir"; path: string; mimeType: string }
  | { kind: "blob"; ref: string; touchesIndex: boolean; mimeType: string };

/** `primaryPath`'s own extension wins; falls back to `fallbackPath`'s (the other side's) only
 * when `primaryPath` itself doesn't qualify — relevant for a rename whose two sides have
 * different extensions where one somehow isn't on the allowlist (e.g. an image renamed to a
 * non-image extension mid-change, still reachable since overall eligibility only requires ONE
 * side to qualify per FR-139). */
function resolveMimeType(primaryPath: string, fallbackPath: string): string {
  return imageMimeTypeForPath(primaryPath) ?? imageMimeTypeForPath(fallbackPath) ?? "application/octet-stream";
}

/** The path identifying each side, independent of whether that side actually exists — used only
 * for FR-139's eligibility check and per-side mime-type derivation. */
function identityPaths(source: DiffSource): { oldPath: string; newPath: string } {
  if (source.kind === "commit" || source.kind === "commit-range") {
    return { oldPath: source.oldPath ?? source.path, newPath: source.path };
  }
  return { oldPath: source.path, newPath: source.path };
}

/**
 * Mirrors `diff.ts`'s `planDiffArgs` base-selection per `DiffSource` kind, but for FR-140's two
 * independent content sides (old/new) rather than a single unified-diff pathspec pair. `cwd` is
 * used only for the same path-containment validation `diff.ts` already performs for
 * worktree/index-relative sources (see `assertPathWithinWorkdir`'s doc comment); `commit` sources
 * never touch the working tree, same as `diff.ts`.
 */
function planImageSides(
  cwd: string,
  source: DiffSource,
): { old: ImageSidePlan | null; new: ImageSidePlan | null } {
  switch (source.kind) {
    case "unstaged": {
      assertPathWithinWorkdir(cwd, source.path);
      const mimeType = resolveMimeType(source.path, source.path);
      return {
        // ":path" = the index (stage 0) version — the "old" side of a worktree-vs-index diff.
        old: { kind: "blob", ref: `:${source.path}`, touchesIndex: true, mimeType },
        new: { kind: "workdir", path: source.path, mimeType },
      };
    }
    case "staged": {
      assertPathWithinWorkdir(cwd, source.path);
      const mimeType = resolveMimeType(source.path, source.path);
      return {
        old: { kind: "blob", ref: `HEAD:${source.path}`, touchesIndex: false, mimeType },
        new: { kind: "blob", ref: `:${source.path}`, touchesIndex: true, mimeType },
      };
    }
    case "untracked": {
      assertPathWithinWorkdir(cwd, source.path);
      const mimeType = resolveMimeType(source.path, source.path);
      return {
        old: null,
        new: { kind: "workdir", path: source.path, mimeType },
      };
    }
    case "commit": {
      if (!source.path || !source.path.trim()) {
        throw new InvalidArgumentError("File path must not be empty.");
      }
      if (!HEX_SHA_RE.test(source.sha)) {
        throw new InvalidArgumentError(`Not a valid hex SHA: ${JSON.stringify(source.sha)}`);
      }
      const base = source.parents.length > 0 ? source.parents[0]! : EMPTY_TREE_SHA;
      if (base !== EMPTY_TREE_SHA && !HEX_SHA_RE.test(base)) {
        throw new InvalidArgumentError(`Not a valid hex SHA: ${JSON.stringify(base)}`);
      }
      const oldPath = source.oldPath ?? source.path;
      return {
        old: {
          kind: "blob",
          ref: `${base}:${oldPath}`,
          touchesIndex: false,
          mimeType: resolveMimeType(oldPath, source.path),
        },
        new: {
          kind: "blob",
          ref: `${source.sha}:${source.path}`,
          touchesIndex: false,
          mimeType: resolveMimeType(source.path, oldPath),
        },
      };
    }
    case "commit-range": {
      // Mirrors the "commit" case above for FR-181's arbitrary-two-commit source, except both
      // endpoints are caller-supplied (`baseSha`/`targetSha`) instead of one being derived from
      // `parents[0]`. Not yet wired to a public `getCommitRangeImageDiff` entry point — see
      // `specs/compare-commits.md`'s Non-goals (image diff parity is an explicit fast-follow) —
      // this case exists purely so `DiffSource`'s switch stays exhaustive and type-safe.
      if (!source.path || !source.path.trim()) {
        throw new InvalidArgumentError("File path must not be empty.");
      }
      if (!HEX_SHA_RE.test(source.baseSha)) {
        throw new InvalidArgumentError(`Not a valid hex SHA: ${JSON.stringify(source.baseSha)}`);
      }
      if (!HEX_SHA_RE.test(source.targetSha)) {
        throw new InvalidArgumentError(`Not a valid hex SHA: ${JSON.stringify(source.targetSha)}`);
      }
      const oldPath = source.oldPath ?? source.path;
      return {
        old: {
          kind: "blob",
          ref: `${source.baseSha}:${oldPath}`,
          touchesIndex: false,
          mimeType: resolveMimeType(oldPath, source.path),
        },
        new: {
          kind: "blob",
          ref: `${source.targetSha}:${source.path}`,
          touchesIndex: false,
          mimeType: resolveMimeType(source.path, oldPath),
        },
      };
    }
  }
}

/**
 * FR-141: best-effort size read for one side, checked BEFORE any byte content is read or
 * base64-encoded. `null` means "unknown, don't block" (e.g. the side genuinely doesn't exist —
 * indistinguishable here from a transient read failure, same best-effort convention
 * `diff.ts`'s `getNewSideSizeBytes` already uses) — never treated as oversized.
 */
async function getSideSizeBytes(cwd: string, sidePlan: ImageSidePlan): Promise<number | null> {
  if (sidePlan.kind === "workdir") {
    // Resolves (and validates) through any symlink chain rather than sizing the symlink itself —
    // unlike `diff.ts`'s `statWorkdirFileSize` (which only ever needs a size, never the actual
    // target bytes), this module's whole point is to materialize and ship those bytes over IPC,
    // so it must know the size of what will actually be read, and refuse (via
    // `SymlinkEscapesWorkdirError`) exactly when the real read below would refuse.
    const real = await resolveRealPathWithinWorkdir(cwd, sidePlan.path);
    if (real === null) return null;
    try {
      const stat = await fs.stat(real);
      return stat.isFile() ? stat.size : null;
    } catch {
      return null;
    }
  }
  try {
    const args = ["cat-file", "-s", ...withEndOfOptions([sidePlan.ref])];
    const { stdout } = await runGit(sidePlan.touchesIndex ? withFsmonitorNeutralized(args) : args, { cwd });
    const n = Number(stdout.trim());
    return Number.isFinite(n) ? n : null;
  } catch {
    // Not necessarily an error — most commonly this side simply doesn't exist at this ref (e.g.
    // an added file's "old" side, or a deleted file's "new" side).
    return null;
  }
}

/** Reads one side's raw bytes. `null` means the side doesn't exist (never a thrown error for
 * that ordinary case — mirrors `getFileDiff`'s own "absent side" handling). */
async function readSideBytes(cwd: string, sidePlan: ImageSidePlan): Promise<Buffer | null> {
  if (sidePlan.kind === "workdir") {
    const real = await resolveRealPathWithinWorkdir(cwd, sidePlan.path);
    if (real === null) return null;
    try {
      return await fs.readFile(real);
    } catch {
      return null;
    }
  }
  try {
    const args = ["cat-file", "-p", ...withEndOfOptions([sidePlan.ref])];
    // `runGitBuffer`, not `runGit`: this stdout is arbitrary binary image content, which
    // `runGit`'s UTF-8 string decoding would corrupt before it ever reaches base64 encoding.
    const { stdout } = await runGitBuffer(sidePlan.touchesIndex ? withFsmonitorNeutralized(args) : args, {
      cwd,
    });
    return stdout;
  } catch {
    return null;
  }
}

async function buildImageBlob(cwd: string, sidePlan: ImageSidePlan): Promise<ImageBlob | null> {
  const bytes = await readSideBytes(cwd, sidePlan);
  if (bytes === null) return null;
  return { base64: bytes.toString("base64"), byteSize: bytes.length, mimeType: sidePlan.mimeType };
}

/**
 * FR-140/FR-141/FR-143: read both sides of an image-eligible file's change and base64-encode
 * them, reusing `getFileDiff`'s exact `DiffSource` union (`unstaged`/`staged`/`untracked`/
 * `commit` — no new source vocabulary) so callers plumb through the same four bases FR-20 already
 * established. Guards each side's byte size (FR-141's fixed 25MB cap) before reading or encoding
 * any content. Never touches the network (FR-143) — every byte comes from the working tree or
 * git's own object store via `cat-file`, exactly like every other read in this package.
 *
 * Throws `InvalidArgumentError` if neither side's own path is image-eligible per
 * `isImageEligiblePath()` (FR-139) — this is a defense-in-depth guard against a caller bug, not
 * the primary eligibility gate (the UI is expected to check `isImageEligiblePath()` itself before
 * ever calling this, per FR-144).
 */
export async function getImageDiff(cwd: string, source: DiffSource): Promise<ImageDiffResult> {
  const { oldPath, newPath } = identityPaths(source);
  if (!isImageEligiblePath(oldPath) && !isImageEligiblePath(newPath)) {
    throw new InvalidArgumentError(
      `Not an image-eligible path (checked ${JSON.stringify(newPath)}` +
        (oldPath !== newPath ? ` and ${JSON.stringify(oldPath)}` : "") +
        `) — see FR-139's fixed extension allowlist.`,
    );
  }

  const sides = planImageSides(cwd, source);

  // Step 1: size-only guard for each existing side, before any byte content is read.
  const [oldSize, newSize] = await Promise.all([
    sides.old ? getSideSizeBytes(cwd, sides.old) : Promise.resolve(null),
    sides.new ? getSideSizeBytes(cwd, sides.new) : Promise.resolve(null),
  ]);
  const oldTooLarge = sides.old !== null && oldSize !== null && oldSize > MAX_IMAGE_SIDE_BYTES;
  const newTooLarge = sides.new !== null && newSize !== null && newSize > MAX_IMAGE_SIDE_BYTES;
  if (oldTooLarge || newTooLarge) {
    return { status: "too-large", side: oldTooLarge && newTooLarge ? "both" : oldTooLarge ? "old" : "new" };
  }

  // Step 2: only now fetch and base64-encode actual content.
  const [oldBlob, newBlob] = await Promise.all([
    sides.old ? buildImageBlob(cwd, sides.old) : Promise.resolve(null),
    sides.new ? buildImageBlob(cwd, sides.new) : Promise.resolve(null),
  ]);

  return { status: "ok", old: oldBlob, new: newBlob };
}
