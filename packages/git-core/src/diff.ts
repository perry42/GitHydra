// SPDX-License-Identifier: GPL-3.0-or-later
import * as fs from "node:fs/promises";
import { runGit, runGitAllowingExitCodes, withEndOfOptions, withFsmonitorNeutralized } from "./gitProcess";
import { EMPTY_TREE_SHA, HEX_SHA_RE } from "./changedFiles";
import { InvalidArgumentError } from "./errors";
import { assertPathWithinWorkdir, resolveWithinWorkdir } from "./pathSafety";
import type { DiffHunk, DiffLine, DiffOptions, FileDiffResult } from "./types";

export const DEFAULT_MAX_CHANGED_LINES = 5000;
export const DEFAULT_MAX_FILE_SIZE_BYTES = 2 * 1024 * 1024; // 2MB
export const DEFAULT_CONTEXT_LINES = 3;

/**
 * Describes which of FR-20's four diff bases to compute. Callers normally reach this through
 * `Repository.get{Unstaged,Staged,Untracked,Commit}FileDiff()` rather than constructing this
 * directly, but it's exported for callers that want the single lower-level entry point.
 */
export type DiffSource =
  | { kind: "unstaged"; path: string }
  | { kind: "staged"; path: string }
  | { kind: "untracked"; path: string }
  | { kind: "commit"; sha: string; parents: readonly string[]; path: string; oldPath?: string }
  | { kind: "commit-range"; baseSha: string; targetSha: string; path: string; oldPath?: string };

interface DiffArgPlan {
  /** Revision arguments (already end-of-options-guarded), empty for worktree/index-relative diffs. */
  revisionArgs: string[];
  /** Flags specific to this source kind (--cached, --no-index, --find-renames, ...). */
  extraDiffFlags: string[];
  /** Pathspec(s) appended after the literal `--`. Two entries for a commit-mode rename (old + new path). */
  pathspecs: string[];
  /** True for `--no-index` diffs, which exit 1 (not 0) when the two inputs differ — not an error. */
  toleratesExitCode1: boolean;
  /** True for sources that read/refresh working-tree or index state, needing the fsmonitor guard. */
  touchesWorkdir: boolean;
}

/**
 * `cwd` is used for path-containment validation (`unstaged`/`staged`/`untracked` sources only —
 * see `assertPathWithinWorkdir`'s doc comment for why this matters most for `untracked`'s
 * `--no-index` diff, which is NOT itself confined to the repository the way a normal pathspec
 * is). `commit`/`commit-range` sources only ever reach git as a tree-object pathspec, never a
 * filesystem read, so containment doesn't apply there the same way — just the ordinary
 * non-empty check.
 */
function planDiffArgs(cwd: string, source: DiffSource): DiffArgPlan {
  switch (source.kind) {
    case "unstaged":
      assertPathWithinWorkdir(cwd, source.path);
      return {
        revisionArgs: [],
        extraDiffFlags: [],
        pathspecs: [source.path],
        toleratesExitCode1: false,
        touchesWorkdir: true,
      };
    case "staged":
      assertPathWithinWorkdir(cwd, source.path);
      return {
        revisionArgs: [],
        extraDiffFlags: ["--cached"],
        pathspecs: [source.path],
        toleratesExitCode1: false,
        touchesWorkdir: true,
      };
    case "untracked":
      assertPathWithinWorkdir(cwd, source.path);
      // --no-index compares two filesystem paths directly; "/dev/null" is special-cased by
      // git's own diff machinery (recognized as a literal sentinel string, not opened as a
      // real device path) on every platform git runs on, including Git for Windows — this is
      // the standard cross-platform idiom other git tooling uses for "diff against nothing".
      // `source.path` itself was just validated to resolve inside `cwd` above — `--no-index`
      // is the one diff mode in this module that reads arbitrary filesystem paths rather than
      // a git-confined pathspec, so that validation is load-bearing here, not just defense in
      // depth (see `assertPathWithinWorkdir`'s doc comment).
      return {
        revisionArgs: [],
        extraDiffFlags: ["--no-index"],
        pathspecs: ["/dev/null", source.path],
        toleratesExitCode1: true,
        touchesWorkdir: false,
      };
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
      // Include both endpoints of a rename in the pathspec so git's rename detection (enabled
      // below) can pair them into one rename-diff instead of showing a pure delete + pure add.
      const pathspecs = source.oldPath && source.oldPath !== source.path
        ? [source.oldPath, source.path]
        : [source.path];
      return {
        revisionArgs: withEndOfOptions([base, source.sha]),
        extraDiffFlags: ["--find-renames", "--find-copies"],
        pathspecs,
        toleratesExitCode1: false,
        touchesWorkdir: false,
      };
    }
    case "commit-range": {
      // FR-181: an arbitrary two-commit diff (no parent/child or ancestry relationship
      // required — see `specs/compare-commits.md` FR-184). Both endpoints are caller-supplied,
      // so both get the same independent SHA validation `commit`'s `sha`/`base` get above.
      if (!source.path || !source.path.trim()) {
        throw new InvalidArgumentError("File path must not be empty.");
      }
      if (!HEX_SHA_RE.test(source.baseSha)) {
        throw new InvalidArgumentError(`Not a valid hex SHA: ${JSON.stringify(source.baseSha)}`);
      }
      if (!HEX_SHA_RE.test(source.targetSha)) {
        throw new InvalidArgumentError(`Not a valid hex SHA: ${JSON.stringify(source.targetSha)}`);
      }
      const pathspecs = source.oldPath && source.oldPath !== source.path
        ? [source.oldPath, source.path]
        : [source.path];
      return {
        revisionArgs: withEndOfOptions([source.baseSha, source.targetSha]),
        extraDiffFlags: ["--find-renames", "--find-copies"],
        pathspecs,
        toleratesExitCode1: false,
        touchesWorkdir: false,
      };
    }
  }
}

async function runDiff(
  cwd: string,
  args: string[],
  toleratesExitCode1: boolean,
): Promise<string> {
  if (toleratesExitCode1) {
    const { stdout } = await runGitAllowingExitCodes(args, { cwd }, [0, 1]);
    return stdout;
  }
  const { stdout } = await runGit(args, { cwd });
  return stdout;
}

/** Exported for reuse by `conflicts.ts`'s blob-to-blob diffs (FR-64), which need the same
 * binary/changed-line detection this module already implements for pathspec-based diffs. */
export function parseNumstat(stdout: string): { isBinary: boolean; changedLines: number } {
  let isBinary = false;
  let changedLines = 0;
  for (const rawLine of stdout.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    const parts = line.split("\t");
    if (parts.length < 2) continue;
    const [addedRaw, deletedRaw] = parts;
    if (addedRaw === "-" && deletedRaw === "-") {
      isBinary = true;
      continue;
    }
    const added = Number(addedRaw);
    const deleted = Number(deletedRaw);
    if (Number.isFinite(added)) changedLines += added;
    if (Number.isFinite(deleted)) changedLines += deleted;
  }
  return { isBinary, changedLines };
}

const HUNK_HEADER_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

/**
 * Parse unified diff patch text (as produced by `git diff -U<n>`) into structured hunks with
 * per-line add/remove/context typing and old/new line numbers (FR-20). Exported for direct
 * unit testing.
 */
export function parseUnifiedDiffHunks(patchText: string): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  if (!patchText) return hunks;

  const lines = patchText.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

  let current: DiffHunk | null = null;
  let oldLine = 0;
  let newLine = 0;

  for (const line of lines) {
    const headerMatch = HUNK_HEADER_RE.exec(line);
    if (headerMatch) {
      const oldStart = Number(headerMatch[1]);
      const oldLines = headerMatch[2] !== undefined ? Number(headerMatch[2]) : 1;
      const newStart = Number(headerMatch[3]);
      const newLines = headerMatch[4] !== undefined ? Number(headerMatch[4]) : 1;
      current = { header: line, oldStart, oldLines, newStart, newLines, lines: [] };
      hunks.push(current);
      oldLine = oldStart;
      newLine = newStart;
      continue;
    }

    if (!current) continue; // preamble before the first hunk: "diff --git", "index ...", "--- a/...", "+++ b/...".

    if (line.startsWith("\\ No newline at end of file")) continue;

    const marker = line[0];
    const diffLine: DiffLine | null =
      marker === " "
        ? { type: "context", content: line.slice(1), oldLineNumber: oldLine, newLineNumber: newLine }
        : marker === "-"
          ? { type: "remove", content: line.slice(1), oldLineNumber: oldLine, newLineNumber: null }
          : marker === "+"
            ? { type: "add", content: line.slice(1), oldLineNumber: null, newLineNumber: newLine }
            : null;

    if (!diffLine) {
      // Not a hunk content line — e.g. a subsequent file's "diff --git" section, when a
      // commit-mode rename's pathspec matched two separate diff sections instead of one
      // paired rename. Stop appending until the next "@@" header.
      current = null;
      continue;
    }

    current.lines.push(diffLine);
    if (diffLine.type !== "add") oldLine++;
    if (diffLine.type !== "remove") newLine++;
  }

  return hunks;
}

/**
 * `relPath` is re-validated here (not just trusted from an earlier call in the same request)
 * so this stays safe even if ever called directly rather than through `getFileDiff()`.
 *
 * Uses `fs.lstat`, not `fs.stat`, deliberately: this reports the size of a symlink *itself*
 * (a short string — its target path) rather than silently following it and sizing whatever it
 * points at, which matters because git's own diff of a symlink shows the link target text, not
 * the referenced file's content, so the size guard should reflect what will actually be
 * diffed. This narrows, but does not eliminate, a TOCTOU window: a concurrent local process
 * could still swap the file (or replace it with a symlink) between this check and the real
 * `git diff` read a moment later. Fully closing that would need an fd-based check-then-read,
 * which git's own CLI doesn't expose here — accepted as a residual, low-severity risk (it
 * requires local code execution racing this process, which is already a much bigger problem).
 */
async function statWorkdirFileSize(cwd: string, relPath: string): Promise<number | null> {
  // Deliberately OUTSIDE the try/catch below: a path-containment violation must propagate as
  // a real `InvalidArgumentError`, never be swallowed into a `null` "unknown size, don't
  // block" result — that swallowing is exactly what let an absolute/escaping path bypass the
  // size guard before this fix (the guard silently no-op'd instead of blocking or rejecting).
  const resolved = resolveWithinWorkdir(cwd, relPath);
  try {
    const stat = await fs.lstat(resolved);
    return stat.isFile() || stat.isSymbolicLink() ? stat.size : null;
  } catch {
    return null; // genuinely missing/unreadable — fine to treat as "unknown, don't block".
  }
}

async function getBlobSizeAt(
  cwd: string,
  revPrefixedPath: string,
  touchesIndex: boolean,
): Promise<number | null> {
  try {
    const args = ["cat-file", "-s", ...withEndOfOptions([revPrefixedPath])];
    const { stdout } = await runGit(touchesIndex ? withFsmonitorNeutralized(args) : args, { cwd });
    const n = Number(stdout.trim());
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

/** Best-effort size (in bytes) of the "new" side of the diff, used for FR-22's absolute-size guard. */
async function getNewSideSizeBytes(cwd: string, source: DiffSource): Promise<number | null> {
  switch (source.kind) {
    case "unstaged":
    case "untracked":
      return statWorkdirFileSize(cwd, source.path);
    case "staged":
      // ":path" = the index (stage 0) version of the file — reading it touches the index, so
      // this needs the same fsmonitor guard as the diff calls above (see
      // `withFsmonitorNeutralized`'s doc comment).
      return getBlobSizeAt(cwd, `:${source.path}`, true);
    case "commit": {
      // `<sha>:<path>`/`<base>:<path>` read tree objects for an already-committed snapshot —
      // no index/working-tree involvement, so no fsmonitor guard needed here.
      const size = await getBlobSizeAt(cwd, `${source.sha}:${source.path}`, false);
      if (size !== null) return size;
      // File may have been deleted at `sha` (or renamed away from oldPath) — fall back to the
      // base side so a large *deleted* file still gets guarded.
      const base = source.parents.length > 0 ? source.parents[0]! : EMPTY_TREE_SHA;
      return getBlobSizeAt(cwd, `${base}:${source.oldPath ?? source.path}`, false);
    }
    case "commit-range": {
      // Same tree-object read as "commit" above, just against caller-supplied `targetSha`/
      // `baseSha` instead of `sha`/`parents[0]` — no index/working-tree involvement here either.
      const size = await getBlobSizeAt(cwd, `${source.targetSha}:${source.path}`, false);
      if (size !== null) return size;
      // File may have been deleted at `targetSha` (or renamed away from oldPath) — fall back to
      // the base side so a large *deleted* file still gets guarded.
      return getBlobSizeAt(cwd, `${source.baseSha}:${source.oldPath ?? source.path}`, false);
    }
  }
}

/**
 * FR-20/FR-21/FR-22: compute a single file's diff content for one of four bases (unstaged,
 * staged, untracked, or a historical commit), guarding against binary content and oversized
 * diffs before ever materializing full patch text.
 *
 * `cwd` must be a valid git working directory for `unstaged`/`staged`/`untracked` sources
 * (there is no worktree/index to diff against in a bare repo) — see
 * `Repository.get{Unstaged,Staged,Untracked}FileDiff()`, which guard that. `commit` sources
 * work against a bare repo too (same as `getChangedFiles`), since they only compare two
 * existing commits' trees.
 */
export async function getFileDiff(
  cwd: string,
  source: DiffSource,
  options: DiffOptions = {},
): Promise<FileDiffResult> {
  const maxChangedLines = options.maxChangedLines ?? DEFAULT_MAX_CHANGED_LINES;
  const maxFileSizeBytes = options.maxFileSizeBytes ?? DEFAULT_MAX_FILE_SIZE_BYTES;
  const contextLines = options.contextLines ?? DEFAULT_CONTEXT_LINES;

  const plan = planDiffArgs(cwd, source);
  // "unstaged"/"staged" sources refresh the index against the real working tree (the same
  // fsmonitor-hook-execution vector `getWorkingDirectoryStatus()` guards for `status`) — see
  // `withFsmonitorNeutralized()`'s doc comment. "untracked" (--no-index) and "commit" (two
  // tree objects) never touch the index, so they're left alone.
  const neutralize = (args: string[]): string[] =>
    plan.touchesWorkdir ? withFsmonitorNeutralized(args) : args;

  // Step 1: cheap numstat pass — bounded output regardless of file size, tells us binary-ness
  // and the changed-line count without ever materializing full patch content.
  const numstatArgs = neutralize([
    "diff",
    "--no-color",
    ...plan.extraDiffFlags,
    "--numstat",
    ...plan.revisionArgs,
    "--",
    ...plan.pathspecs,
  ]);
  const { isBinary, changedLines } = parseNumstat(
    await runDiff(cwd, numstatArgs, plan.toleratesExitCode1),
  );

  if (isBinary) {
    return { status: "binary", isBinary: true };
  }
  if (changedLines > maxChangedLines) {
    return { status: "too-large", isBinary: false, reason: "changed-lines", changedLineCount: changedLines };
  }

  // Step 2: absolute byte-size guard — catches e.g. one enormous line, which numstat's
  // changed-*line*-count guard alone wouldn't. Best-effort: null (unknown) never blocks.
  const fileSizeBytes = await getNewSideSizeBytes(cwd, source);
  if (fileSizeBytes !== null && fileSizeBytes > maxFileSizeBytes) {
    return { status: "too-large", isBinary: false, reason: "file-size", fileSizeBytes };
  }

  // Step 3: only now fetch the full patch text.
  const patchArgs = neutralize([
    "diff",
    "--no-color",
    ...plan.extraDiffFlags,
    `-U${contextLines}`,
    ...plan.revisionArgs,
    "--",
    ...plan.pathspecs,
  ]);
  const patchText = await runDiff(cwd, patchArgs, plan.toleratesExitCode1);
  const hunks = parseUnifiedDiffHunks(patchText);

  // Defense in depth: numstat already told us this isn't binary, but if git's patch output
  // still comes back as a "Binary files ... differ" line with zero parsed hunks, trust that.
  if (hunks.length === 0 && /^Binary files /m.test(patchText)) {
    return { status: "binary", isBinary: true };
  }

  return { status: "ok", isBinary: false, hunks };
}
