// SPDX-License-Identifier: GPL-3.0-or-later
import * as fs from "node:fs/promises";
import {
  runGit,
  withEndOfOptions,
  withFsmonitorNeutralized,
} from "./gitProcess";
import { GitCommandError, InvalidArgumentError, ConflictMarkersRemainError, ContinueBlockedError, NoOperationInProgressError } from "./errors";
import { assertPathWithinWorkdir, resolveRealPathWithinWorkdir } from "./pathSafety";
import { splitFields, getWorkingDirectoryChanges } from "./workingDirStatus";
import {
  parseNumstat,
  parseUnifiedDiffHunks,
  DEFAULT_MAX_CHANGED_LINES,
  DEFAULT_MAX_FILE_SIZE_BYTES,
  DEFAULT_CONTEXT_LINES,
} from "./diff";
import type {
  ConflictedFileInfo,
  ConflictFileDiff,
  ConflictMarkerScanResult,
  ConflictRenameSide,
  ConflictSideLabel,
  ConflictSideLabels,
  ConflictStageCombination,
  ConflictStageEntry,
  DiffOptions,
  FileDiffResult,
  InProgressOperation,
  RepositoryState,
} from "./types";

/**
 * Implements specs/merge-rebase-conflict-resolution.md's git-core surface (FR-58 through FR-80):
 * classify each conflicted path (FR-63), fetch three-way comparison content for one (FR-64),
 * compute FR-61's per-operation-type "ours"/"theirs" labels, and safely resolve/abort/continue
 * (FR-66, FR-68 through FR-71). See Repository's own methods (index.ts) for the facade most
 * callers should use; the functions here are the lower-level implementation.
 */

const FULL_SHA_RE = /^[0-9a-fA-F]{40}$/;

function assertFullSha(sha: string, label: string): void {
  if (!FULL_SHA_RE.test(sha)) {
    throw new InvalidArgumentError(`${label} must be a full 40-character hex SHA: ${JSON.stringify(sha)}`);
  }
}

// -------------------------------------------------------------------------------------------
// FR-62/FR-63: classify every conflicted path from git's own index stages.
// -------------------------------------------------------------------------------------------

interface RawUnmergedEntry {
  /** git status's own two-letter unmerged code, e.g. "UU", "AA", "AU", "UA", "DU", "UD", "DD". */
  xy: string;
  mode1: string;
  mode2: string;
  mode3: string;
  hash1: string;
  hash2: string;
  hash3: string;
  path: string;
}

/**
 * Parse `git status --porcelain=v2 -z` output for its "u" (unmerged) records only:
 * `u XY sub m1 m2 m3 mW h1 h2 h3 path`. This is a finer-grained parse than
 * `workingDirStatus.ts`'s `parsePorcelainV2Changes` (which only needs path+status for its
 * conflicted category) — here we need the full per-stage mode/hash fields to classify FR-63's
 * stage-presence combination and detect a submodule gitlink (mode 160000) or binary content.
 * Exported for direct unit testing, same convention as `parsePorcelainV2Changes`.
 */
export function parseUnmergedRecords(porcelainOutput: string): RawUnmergedEntry[] {
  const entries: RawUnmergedEntry[] = [];
  const records = porcelainOutput.split("\0").filter((r) => r.length > 0);
  for (const record of records) {
    if (record[0] !== "u") continue;
    const { fields, rest: path } = splitFields(record, 10);
    // fields: [0]="u", [1]=XY, [2]=sub, [3]=m1, [4]=m2, [5]=m3, [6]=mW, [7]=h1, [8]=h2, [9]=h3
    const xy = fields[1];
    const mode1 = fields[3];
    const mode2 = fields[4];
    const mode3 = fields[5];
    const hash1 = fields[7];
    const hash2 = fields[8];
    const hash3 = fields[9];
    if (!xy || !mode1 || !mode2 || !mode3 || !hash1 || !hash2 || !hash3 || !path) continue;
    entries.push({ xy, mode1, mode2, mode3, hash1, hash2, hash3, path });
  }
  return entries;
}

/**
 * A stage is "absent" per porcelain v2's own convention: an all-zero mode (empirically "000000",
 * not the single-char "0" the format docs' prose might suggest — verified directly, 2026-08-30)
 * and an all-zero 40-hex hash. Checking either is sufficient (both are always zero together for
 * an absent stage) — both are checked for defense in depth against relying on just one.
 */
function stageEntry(mode: string, hash: string): ConflictStageEntry | null {
  if (!mode || /^0+$/.test(mode) || !hash || /^0+$/.test(hash)) return null;
  return { sha: hash, mode };
}

/**
 * Classify a conflicted path's stage-presence combination straight from git's own status XY
 * vocabulary (see `ConflictStageCombination`'s doc comment for why this is preferred over
 * re-deriving the same information by hand from raw stage presence). `default` never triggers
 * for a real git version but exists so an unrecognized code degrades to the most common shape
 * (`both-modified`) instead of throwing — FR-62/FR-74 read fresh from disk on every call and must
 * never crash on an unusual-but-real repository state.
 */
export function classifyStageCombination(xy: string): ConflictStageCombination {
  switch (xy) {
    case "UU":
      return "both-modified";
    case "AU":
      return "added-by-us";
    case "UA":
      return "added-by-them";
    case "AA":
      return "both-added";
    case "DU":
      return "deleted-by-us";
    case "UD":
      return "deleted-by-them";
    case "DD":
      return "both-deleted";
    default:
      return "both-modified";
  }
}

async function getBlobSize(cwd: string, sha: string): Promise<number | null> {
  try {
    const { stdout } = await runGit(["cat-file", "-s", sha], { cwd });
    const n = Number(stdout.trim());
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

/**
 * `git diff <blob> <blob>` compares two blob objects directly — no pathspec, no tree context
 * needed, and (unlike `unstaged`/`staged` diffs in `diff.ts`) no fsmonitor guard needed either,
 * since this never touches the working tree or refreshes the index; it only ever reads two
 * already-resolved object-database blobs. Mirrors `diff.ts`'s `getFileDiff()` numstat-then-patch
 * two-step guard pattern (binary/changed-line/byte-size checks before any full patch text is
 * fetched) so conflict-diff content gets the exact same FR-21/FR-22 guarantees as every other
 * diff surface in this module.
 */
async function blobToBlobDiff(
  cwd: string,
  shaA: string,
  shaB: string,
  options: { maxChangedLines: number; maxFileSizeBytes: number; contextLines: number },
): Promise<FileDiffResult> {
  assertFullSha(shaA, "Blob SHA");
  assertFullSha(shaB, "Blob SHA");

  const numstatArgs = ["diff", "--no-color", "--numstat", ...withEndOfOptions([shaA, shaB])];
  const { stdout: numstatOut } = await runGit(numstatArgs, { cwd });
  const { isBinary, changedLines } = parseNumstat(numstatOut);

  if (isBinary) {
    return { status: "binary", isBinary: true };
  }
  if (changedLines > options.maxChangedLines) {
    return { status: "too-large", isBinary: false, reason: "changed-lines", changedLineCount: changedLines };
  }

  const [sizeA, sizeB] = await Promise.all([getBlobSize(cwd, shaA), getBlobSize(cwd, shaB)]);
  const maxSize = Math.max(sizeA ?? 0, sizeB ?? 0);
  if (maxSize > options.maxFileSizeBytes) {
    return { status: "too-large", isBinary: false, reason: "file-size", fileSizeBytes: maxSize };
  }

  const patchArgs = ["diff", "--no-color", `-U${options.contextLines}`, ...withEndOfOptions([shaA, shaB])];
  const { stdout: patchText } = await runGit(patchArgs, { cwd });
  const hunks = parseUnifiedDiffHunks(patchText);

  if (hunks.length === 0 && /^Binary files /m.test(patchText)) {
    return { status: "binary", isBinary: true };
  }

  return { status: "ok", isBinary: false, hunks };
}

async function isBinaryBlobPair(cwd: string, shaA: string, shaB: string): Promise<boolean> {
  try {
    const { stdout } = await runGit(
      ["diff", "--no-color", "--numstat", ...withEndOfOptions([shaA, shaB])],
      { cwd },
    );
    return parseNumstat(stdout).isBinary;
  } catch {
    return false;
  }
}

// -------------------------------------------------------------------------------------------
// FR-79: rename conflict detection.
// -------------------------------------------------------------------------------------------

interface RenameCommitPair {
  /** Commit whose content stage-2 ("ours") corresponds to — see `RebaseOperationDetail`'s doc comment for why this isn't always HEAD. */
  oursCommit: string | null;
  theirsCommit: string | null;
}

/** Which two commits to diff a merge-base against for rename detection, per operation kind (FR-61's same per-operation mapping, reused here). Null fields mean "can't determine — skip rename detection for this operation," a documented best-effort limit. */
function resolveRenameCommitPair(state: RepositoryState): RenameCommitPair {
  const detail = state.inProgressOperationDetail;
  if (!detail) return { oursCommit: null, theirsCommit: null };
  switch (detail.kind) {
    case "merge":
      return { oursCommit: detail.headSha, theirsCommit: detail.mergeHeadSha };
    case "rebase":
      return { oursCommit: detail.ontoSha, theirsCommit: detail.currentCommitSha };
    case "cherry-pick":
    case "revert":
      return { oursCommit: state.headSha, theirsCommit: detail.targetSha };
    case "am":
    case "bisect":
      return { oursCommit: null, theirsCommit: null };
  }
}

/**
 * Parse `git diff --find-renames --name-status -z <a> <b>` for its rename ("R...") records —
 * mirrors `changedFiles.ts`'s `getChangedFiles` token-consumption loop (a rename/copy record
 * carries two paths, an ordinary record carries one), since both parse the same `--name-status
 * -z` shape. `--find-copies` is deliberately not passed here (only renames are FR-79's concern),
 * so a "C" record is never actually produced, but the two-path branch still handles one
 * defensively in case that ever changes.
 */
function parseRenameRecords(stdout: string): { oldPath: string; newPath: string; similarity?: number }[] {
  const tokens = stdout.split("\0").filter((t) => t.length > 0);
  const renames: { oldPath: string; newPath: string; similarity?: number }[] = [];
  let i = 0;
  while (i < tokens.length) {
    const statusToken = tokens[i++]!;
    if (statusToken[0] === "R" || statusToken[0] === "C") {
      const oldPath = tokens[i++];
      const newPath = tokens[i++];
      if (oldPath === undefined || newPath === undefined) break;
      if (statusToken[0] === "R") {
        const m = statusToken.match(/\d+/);
        renames.push({ oldPath, newPath, similarity: m ? Number(m[0]) : undefined });
      }
      continue;
    }
    const p = tokens[i++];
    if (p === undefined) break;
  }
  return renames;
}

/**
 * FR-79: detect rename conflicts by diffing the merge-base of the two sides being combined
 * against each side (with rename detection enabled), then keeping only renames whose new path is
 * itself a currently-conflicted path. Best-effort: returns an empty map (never throws) when a
 * merge-base can't be resolved (e.g. unrelated-histories merge/rebase) or when the operation kind
 * has no well-defined commit pair (`resolveRenameCommitPair`).
 */
export async function detectRenameConflicts(
  cwd: string,
  state: RepositoryState,
  conflictedPaths: ReadonlySet<string>,
): Promise<Map<string, ConflictRenameSide[]>> {
  const result = new Map<string, ConflictRenameSide[]>();
  const { oursCommit, theirsCommit } = resolveRenameCommitPair(state);
  if (!oursCommit || !theirsCommit) return result;
  if (!FULL_SHA_RE.test(oursCommit) || !FULL_SHA_RE.test(theirsCommit)) return result;

  let mergeBase: string;
  try {
    const { stdout } = await runGit(
      ["merge-base", ...withEndOfOptions([oursCommit, theirsCommit])],
      { cwd },
    );
    mergeBase = stdout.trim();
    if (!FULL_SHA_RE.test(mergeBase)) return result;
  } catch {
    return result; // e.g. unrelated histories — no merge-base to diff from.
  }

  const addSide = (renames: { oldPath: string; newPath: string; similarity?: number }[], side: "ours" | "theirs") => {
    for (const r of renames) {
      if (!conflictedPaths.has(r.newPath)) continue;
      const list = result.get(r.newPath) ?? [];
      list.push({ side, oldPath: r.oldPath, newPath: r.newPath, similarity: r.similarity });
      result.set(r.newPath, list);
    }
  };

  try {
    const [oursDiff, theirsDiff] = await Promise.all([
      runGit(
        ["diff", "--find-renames", "--name-status", "-z", ...withEndOfOptions([mergeBase, oursCommit])],
        { cwd },
      ),
      runGit(
        ["diff", "--find-renames", "--name-status", "-z", ...withEndOfOptions([mergeBase, theirsCommit])],
        { cwd },
      ),
    ]);
    addSide(parseRenameRecords(oursDiff.stdout), "ours");
    addSide(parseRenameRecords(theirsDiff.stdout), "theirs");
  } catch {
    // Best-effort — leave whatever was already added (or nothing) rather than throw.
  }

  return result;
}

// -------------------------------------------------------------------------------------------
// FR-62/FR-63/FR-74: getConflictedFiles — always a fresh read, no cached client state.
// -------------------------------------------------------------------------------------------

/**
 * FR-62/FR-63: every conflicted path's classification and stage content, sourced live from
 * `git status --porcelain=v2`'s unmerged records (never cached — a fresh call re-reads the index
 * every time, matching FR-74/FR-62's "never cached client state" requirement). `state` must be a
 * freshly-read `RepositoryState` (its `inProgressOperationDetail` drives FR-79's rename
 * detection); pass the same one `Repository.refreshState()`/`getState()` already gives you.
 */
export async function getConflictedFiles(
  cwd: string,
  workdir: string,
  state: RepositoryState,
): Promise<ConflictedFileInfo[]> {
  const { stdout } = await runGit(
    withFsmonitorNeutralized(["status", "--porcelain=v2", "-z", "--untracked-files=all"]),
    { cwd: workdir },
  );
  const raw = parseUnmergedRecords(stdout);
  if (raw.length === 0) return [];

  const conflictedPaths = new Set(raw.map((r) => r.path));
  const renameMap = await detectRenameConflicts(cwd, state, conflictedPaths).catch(
    () => new Map<string, ConflictRenameSide[]>(),
  );

  return Promise.all(
    raw.map(async (entry): Promise<ConflictedFileInfo> => {
      const base = stageEntry(entry.mode1, entry.hash1);
      const ours = stageEntry(entry.mode2, entry.hash2);
      const theirs = stageEntry(entry.mode3, entry.hash3);
      const isSubmodule = [entry.mode1, entry.mode2, entry.mode3].includes("160000");

      let isBinary = false;
      if (!isSubmodule) {
        if (ours && theirs) isBinary = await isBinaryBlobPair(cwd, ours.sha, theirs.sha);
        else if (base && ours) isBinary = await isBinaryBlobPair(cwd, base.sha, ours.sha);
        else if (base && theirs) isBinary = await isBinaryBlobPair(cwd, base.sha, theirs.sha);
      }

      return {
        path: entry.path,
        stageCombination: classifyStageCombination(entry.xy),
        isSubmodule,
        isBinary,
        rename: renameMap.get(entry.path) ?? null,
        base,
        ours,
        theirs,
      };
    }),
  );
}

// -------------------------------------------------------------------------------------------
// FR-64: three-way comparison content for one conflicted file.
// -------------------------------------------------------------------------------------------

/**
 * FR-64/FR-77/FR-78/FR-80: comparison content for one already-classified conflicted file. A
 * submodule gitlink conflict (FR-77) never gets an attempted text diff — all three fields come
 * back null, by design, since there is no meaningful line-level content to compare for a gitlink.
 * A binary conflict (FR-80) still returns a result per pair (each is a `BinaryFileDiff`, reusing
 * `DiffView`'s existing convention) rather than null, so the UI can render its established
 * "Binary file" state. A delete/modify conflict (FR-78) naturally yields a null diff for
 * whichever pair is missing a stage — e.g. `baseToOurs` is null when `ours` is absent
 * (deleted-by-us) — the UI is expected to render FR-78's explicit "Deleted in X / modified in Y"
 * copy for that case rather than a blank/broken diff pane.
 */
export async function getConflictFileDiff(
  cwd: string,
  file: Pick<ConflictedFileInfo, "base" | "ours" | "theirs" | "isSubmodule">,
  options: DiffOptions = {},
): Promise<ConflictFileDiff> {
  if (file.isSubmodule) {
    return { baseToOurs: null, baseToTheirs: null, oursToTheirs: null };
  }

  const diffOpts = {
    maxChangedLines: options.maxChangedLines ?? DEFAULT_MAX_CHANGED_LINES,
    maxFileSizeBytes: options.maxFileSizeBytes ?? DEFAULT_MAX_FILE_SIZE_BYTES,
    contextLines: options.contextLines ?? DEFAULT_CONTEXT_LINES,
  };

  const [baseToOurs, baseToTheirs, oursToTheirs] = await Promise.all([
    file.base && file.ours ? blobToBlobDiff(cwd, file.base.sha, file.ours.sha, diffOpts) : Promise.resolve(null),
    file.base && file.theirs ? blobToBlobDiff(cwd, file.base.sha, file.theirs.sha, diffOpts) : Promise.resolve(null),
    file.ours && file.theirs ? blobToBlobDiff(cwd, file.ours.sha, file.theirs.sha, diffOpts) : Promise.resolve(null),
  ]);

  return { baseToOurs, baseToTheirs, oursToTheirs };
}

// -------------------------------------------------------------------------------------------
// FR-61: concrete, per-operation-type ours/theirs labels — computed once per operation, reused
// across every conflicted file (never the bare words "ours"/"theirs" in UI-facing text).
// -------------------------------------------------------------------------------------------

function abbrev(sha: string | null): string | null {
  return sha ? sha.slice(0, 7) : null;
}

function withAt(name: string, sha: string | null): string {
  const short = abbrev(sha);
  return short ? `${name} @ ${short}` : name;
}

/**
 * FR-61: build the two labels UI must show instead of raw "ours"/"theirs", for whichever
 * operation `state.inProgressOperationDetail` describes. Pure/synchronous — everything it needs
 * is already on `RepositoryState`/`InProgressOperationDetail`, no extra git calls. Returns null
 * when there's no in-progress operation, or for `"am"`/`"bisect"` (neither produces the kind of
 * merge-style ours/theirs conflict this labeling exists for).
 *
 * Crucially, index stage 2 is ALWAYS "ours" and stage 3 is ALWAYS "theirs" in raw git plumbing
 * terms, for every operation kind — see `RebaseOperationDetail`'s doc comment. What this function
 * computes is only which HUMAN-MEANINGFUL side (your branch vs. the target/incoming) each of
 * those two fixed stages corresponds to, which is where merge and rebase genuinely diverge
 * (FR-61's "roles are inverted" behavior).
 */
export function computeConflictSideLabels(state: RepositoryState): ConflictSideLabels | null {
  const detail = state.inProgressOperationDetail;
  if (!detail) return null;

  switch (detail.kind) {
    case "merge": {
      const ours: ConflictSideLabel = {
        label: state.currentBranch
          ? `Your branch (${withAt(state.currentBranch, detail.headSha)})`
          : withAt("HEAD", detail.headSha),
        refName: state.currentBranch,
        sha: detail.headSha,
      };
      const theirs: ConflictSideLabel = {
        label: detail.incomingRef
          ? `Incoming (${withAt(detail.incomingRef, detail.mergeHeadSha)})`
          : withAt("Incoming", detail.mergeHeadSha),
        refName: detail.incomingRef,
        sha: detail.mergeHeadSha,
      };
      return { ours, theirs };
    }
    case "rebase": {
      // Inverted from merge: stage 2 ("ours") is the onto/target branch's progress; stage 3
      // ("theirs") is the user's own original commit being replayed.
      const ours: ConflictSideLabel = {
        label: detail.ontoRef ? `Onto (${withAt(detail.ontoRef, detail.ontoSha)})` : withAt("Onto", detail.ontoSha),
        refName: detail.ontoRef,
        sha: detail.ontoSha,
      };
      const theirs: ConflictSideLabel = {
        label: detail.originalBranch
          ? `Your branch (${withAt(detail.originalBranch, detail.currentCommitSha)})`
          : withAt("Your commit", detail.currentCommitSha),
        refName: detail.originalBranch,
        sha: detail.currentCommitSha,
      };
      return { ours, theirs };
    }
    case "cherry-pick":
    case "revert": {
      const verb = detail.kind === "cherry-pick" ? "Cherry-picking" : "Reverting";
      const ours: ConflictSideLabel = {
        label: state.currentBranch
          ? `Your branch (${withAt(state.currentBranch, state.headSha)})`
          : withAt("HEAD", state.headSha),
        refName: state.currentBranch,
        sha: state.headSha,
      };
      const theirs: ConflictSideLabel = {
        label: withAt(
          `${verb}${detail.targetSubject ? ` "${detail.targetSubject}"` : ""}`,
          detail.targetSha,
        ),
        refName: null,
        sha: detail.targetSha,
      };
      return { ours, theirs };
    }
    case "am":
    case "bisect":
      return null;
  }
}

// -------------------------------------------------------------------------------------------
// FR-66: conflict marker scanning — the safety check git itself never performs.
// -------------------------------------------------------------------------------------------

const MARKER_PREFIXES = ["<<<<<<<", "|||||||", "=======", ">>>>>>>"] as const;

/**
 * FR-66: scan a working-tree file for literal, unresolved conflict marker lines. Returns
 * `{ hasMarkers: false, markerLines: [] }` when the file doesn't exist (a legitimate "the user
 * resolved this by deleting the file" state, handled by `markConflictResolved`) or is binary (a
 * binary conflict, FR-80, has no marker-based resolution path at all, so scanning its bytes as
 * text would be meaningless and could spuriously match).
 *
 * Throws `SymlinkEscapesWorkdirError` (does NOT swallow it into a false "no markers" result) if
 * `filePath`'s working-tree entry — or an intermediate directory component of it — is a symlink
 * resolving outside `workdir`: unlike every other outcome here, this is a refusal, not a benign
 * "nothing to scan" state, since silently reading through it would be an arbitrary-local-file-read
 * primitive (see `resolveRealPathWithinWorkdir`'s doc comment). Reads via the realpath it
 * validates, never the pre-symlink-resolution path, so the bytes scanned are guaranteed to be the
 * same ones this check just approved.
 */
export async function scanConflictMarkers(workdir: string, filePath: string): Promise<ConflictMarkerScanResult> {
  const realPath = await resolveRealPathWithinWorkdir(workdir, filePath);
  if (realPath === null) {
    return { hasMarkers: false, markerLines: [] };
  }

  let raw: Buffer;
  try {
    raw = await fs.readFile(realPath);
  } catch {
    return { hasMarkers: false, markerLines: [] };
  }

  // Mirrors git's own "NUL byte in the first chunk" binary heuristic.
  if (raw.subarray(0, 8000).includes(0)) {
    return { hasMarkers: false, markerLines: [] };
  }

  const lines = raw.toString("utf8").split(/\r\n|\r|\n/);
  const markerLines: number[] = [];
  lines.forEach((line, idx) => {
    if (MARKER_PREFIXES.some((p) => line.startsWith(p))) markerLines.push(idx + 1);
  });
  return { hasMarkers: markerLines.length > 0, markerLines };
}

async function stageResolvedFile(workdir: string, filePath: string): Promise<void> {
  const scan = await scanConflictMarkers(workdir, filePath);
  if (scan.hasMarkers) {
    throw new ConflictMarkersRemainError(filePath, scan.markerLines);
  }
  await runGit(withFsmonitorNeutralized(["add", "--", filePath]), { cwd: workdir, mutatesRepository: true });
}

/**
 * Matches git's own refusal when `checkout --ours`/`--theirs` has nothing to check out for that
 * side (e.g. accept-ours on a deleted-by-us conflict). Verified directly (git 2.x, 2026-08-30):
 * the real message is `error: path '<path>' does not have {our,their} version` — the other
 * phrasings here are defensive alternates for older/different git builds, not verified live.
 */
const NO_CONTENT_ON_SIDE_RE =
  /does not have (?:our|their) version|does not exist in|did not match any file|no such path|pathspec .* did not match/i;

/**
 * FR-65/FR-66/FR-78: whole-file "Accept Ours"/"Accept Theirs". `side` is git's own literal
 * `--ours`/`--theirs` (index stage 2/3) — see `computeConflictSideLabels`'s doc comment for why
 * the UI-facing label attached to each of these can differ per operation kind while the
 * underlying stage/flag mapping here never does.
 *
 * When the chosen side has no content at all (e.g. accept-ours on a deleted-by-us conflict —
 * FR-78's "Delete file" action), `git checkout --ours/--theirs` fails since there is nothing to
 * check out; this is translated into staging the deletion directly (`git rm -f --`), which is the
 * correct resolution rather than an error. Otherwise: checks out the chosen stage's content into
 * the working tree, scans it for leftover conflict markers (FR-66 — defense in depth; content
 * checked out straight from git's own index should never itself contain marker text, but this
 * keeps a single safe code path for every route that ends in `git add`), and only then stages it.
 */
export async function acceptConflictSide(
  workdir: string,
  filePath: string,
  side: "ours" | "theirs",
): Promise<void> {
  assertPathWithinWorkdir(workdir, filePath);
  const flag = side === "ours" ? "--ours" : "--theirs";

  try {
    await runGit(withFsmonitorNeutralized(["checkout", flag, "--", filePath]), {
      cwd: workdir,
      mutatesRepository: true,
    });
  } catch (err) {
    if (err instanceof GitCommandError && NO_CONTENT_ON_SIDE_RE.test(err.stderr)) {
      await runGit(withFsmonitorNeutralized(["rm", "-f", "--", filePath]), {
        cwd: workdir,
        mutatesRepository: true,
      });
      return;
    }
    throw err;
  }

  await stageResolvedFile(workdir, filePath);
}

/**
 * FR-65/FR-66: "Mark as resolved" — for a file the user edited by hand (removing conflict
 * markers themselves) rather than via `acceptConflictSide`. Refuses (throws
 * `ConflictMarkersRemainError`, makes no `git add` call) when markers remain — this is FR-66's
 * core safety behavior: git's own `git add` does not perform this check, so this module must.
 * When the file no longer exists on disk (the user resolved a delete/modify conflict by deleting
 * it themselves), stages that deletion (`git rm -f --`) instead of failing on a missing path.
 *
 * Existence is checked via `resolveRealPathWithinWorkdir` (not a plain `fs.access`), for the same
 * reason `scanConflictMarkers` needs it: a symlink escaping the working directory must be refused
 * outright rather than treated as either "exists" or "doesn't exist" by an unguarded filesystem
 * call that quietly follows it. `stageResolvedFile` below runs `scanConflictMarkers` on the same
 * path anyway, so this is defense in depth (an existence check leaks far less than a content
 * read), not the only place this is enforced.
 */
export async function markConflictResolved(workdir: string, filePath: string): Promise<void> {
  const realPath = await resolveRealPathWithinWorkdir(workdir, filePath);

  if (realPath === null) {
    await runGit(withFsmonitorNeutralized(["rm", "-f", "--", filePath]), {
      cwd: workdir,
      mutatesRepository: true,
    });
    return;
  }

  await stageResolvedFile(workdir, filePath);
}

// -------------------------------------------------------------------------------------------
// FR-68/FR-69/FR-70/FR-71: abort / continue.
// -------------------------------------------------------------------------------------------

/**
 * FR-68/FR-69: abort whichever operation is in progress (`merge --abort` / `rebase --abort` /
 * `cherry-pick --abort` / `revert --abort`, plus `am --abort` for completeness — not itself named
 * in the spec's FR-68 list, but `InProgressOperation` already types `"am"` and the same abort
 * shape applies). `git rebase --quit` is never exposed as an affordance anywhere in this module
 * (FR-69) — there is no code path here that can reach it. Throws `NoOperationInProgressError` for
 * `null` or `"bisect"` (bisect gets no abort/continue affordances this pass — see spec
 * Non-goals). Any other failure (including git refusing the abort, e.g. because a manual commit
 * already closed the operation) is a plain `GitCommandError` surfaced with git's stderr verbatim
 * — never caught, translated, or retried here.
 */
export async function abortInProgressOperation(cwd: string, operation: InProgressOperation): Promise<void> {
  if (operation === null || operation === "bisect") {
    throw new NoOperationInProgressError("abort", operation);
  }
  await runGit(withFsmonitorNeutralized([operation, "--abort"]), { cwd, mutatesRepository: true });
}

/** GIT_EDITOR=true is the standard cross-platform no-op editor idiom (a POSIX shell builtin /
 * coreutils binary that exits 0 without touching the file git hands it) — git always invokes the
 * configured editor through its own bundled shell, including on Git for Windows, so this works
 * identically on every platform this module runs on (verified in `tests/conflicts.test.ts`).
 * GIT_SEQUENCE_EDITOR is set defensively too, though interactive rebase (which is what actually
 * consults it) is out of this spec's scope. */
const NO_INTERACTIVE_EDITOR_ENV = { GIT_EDITOR: "true", GIT_SEQUENCE_EDITOR: "true" } as const;

/**
 * FR-70/FR-71: continue whichever operation is in progress, never spawning an interactive
 * external editor (FR-70 — Electron's `child_process` has no TTY to host one). Client-side
 * blocked (FR-71, defense in depth beyond git's own `--continue` refusal, which only catches
 * unresolved index conflicts) unless `WorkingDirectoryChanges.conflicted` is empty AND FR-66's
 * marker scan finds nothing in every currently-staged path — throws `ContinueBlockedError` naming
 * every blocking path when either check fails, and makes no `--continue` call in that case.
 * Throws `NoOperationInProgressError` for `null`/`"bisect"`, same as `abortInProgressOperation`.
 */
export async function continueInProgressOperation(
  cwd: string,
  workdir: string,
  operation: InProgressOperation,
): Promise<void> {
  if (operation === null || operation === "bisect") {
    throw new NoOperationInProgressError("continue", operation);
  }

  const changes = await getWorkingDirectoryChanges(workdir);
  const blockingPaths = new Set(changes.conflicted.map((f) => f.path));

  const markerScans = await Promise.all(
    changes.staged.map(async (f) => ({ path: f.path, scan: await scanConflictMarkers(workdir, f.path) })),
  );
  for (const { path, scan } of markerScans) {
    if (scan.hasMarkers) blockingPaths.add(path);
  }

  if (blockingPaths.size > 0) {
    throw new ContinueBlockedError(Array.from(blockingPaths));
  }

  await runGit(withFsmonitorNeutralized([operation, "--continue"]), {
    cwd,
    extraEnv: NO_INTERACTIVE_EDITOR_ENV,
    mutatesRepository: true,
  });
}
