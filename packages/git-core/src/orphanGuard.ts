// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Detached-HEAD orphan guard (specs/branch-panel-drag-merge.md FR-430).
 *
 * Git prints "you are leaving N commit(s) behind, not connected to any of your branches" when
 * HEAD is detached, has commits no branch/tag/remote-tracking ref reaches, and you switch away.
 * Because `switchBranch()`/`switchToCommit()` discard stderr on success, GitHydra used to swallow
 * that warning. This module lets the UI ask BEFORE leaving:
 *
 *  - `getOrphanedHeadCommits()` — read-only; what would be left behind?
 *  - `createBranchAtCommit()`   — narrow "save these commits" path for the dialog/banner.
 *  - `assertHeadStillDetachedAt()` — used by branches.ts inside the mutation queue so the
 *    confirmation the user gave is bound to the exact commit they were shown (`HeadMovedError`).
 *
 * Limits (by design, see README): a checkout done in the user's own terminal cannot be guarded,
 * and reset/pull/rebase while detached are out of scope.
 */
import { runGit, runGitAllowingExitCodes } from "./gitProcess";
import { getRepositoryState } from "./repository";
import {
  GitCommandError,
  GitCommandTimeoutError,
  HeadMovedError,
  InvalidArgumentError,
} from "./errors";

/** Max commits examined/counted; `total` saturates here and `totalIsCapped` is set. */
export const ORPHAN_COUNT_CAP = 1000;
/** Max commits returned in `shown`. */
export const ORPHAN_SHOWN_MAX = 5;
/** Subjects are truncated to this many code points. */
export const ORPHAN_SUBJECT_MAX_LENGTH = 120;
/** Deliberately shorter than DEFAULT_GIT_TIMEOUT_MS: this runs before a user-initiated checkout. */
export const ORPHAN_QUERY_TIMEOUT_MS = 10_000;

/** Full object id: 40 (SHA-1) or 64 (SHA-256) lowercase hex digits. */
export const FULL_OID_RE = /^[0-9a-f]{40,64}$/;

export interface OrphanedCommit {
  sha: string;
  shortSha: string;
  /** Sanitized: control chars/bidi overrides stripped, truncated to ORPHAN_SUBJECT_MAX_LENGTH. */
  subject: string;
}

/**
 * - `"orphaned"`: HEAD is detached and `total` >= 1 commits are reachable from HEAD but from no
 *   branch/tag/remote-tracking ref. The UI must show the leave-commits-behind dialog.
 * - `"none"`: definitively nothing to warn about (see `reason`).
 * - `"unknown"`: the check failed or timed out. FAIL CLOSED: the UI MUST treat this like
 *   `"orphaned"` (ask the user), never like `"none"`.
 */
export type OrphanedHeadStatus = "orphaned" | "none" | "unknown";

export type OrphanedHeadReason =
  | "orphaned"
  | "attached"
  | "unborn"
  | "bare"
  | "operation-in-progress"
  | "no-orphans"
  | "timeout"
  | "error";

export interface OrphanedHeadResult {
  status: OrphanedHeadStatus;
  reason: OrphanedHeadReason;
  /** The detached HEAD commit; null when not applicable or not resolved. */
  headSha: string | null;
  /** Number of orphaned commits, capped at ORPHAN_COUNT_CAP. 0 unless status is "orphaned". */
  total: number;
  totalIsCapped: boolean;
  /** Newest-first, at most ORPHAN_SHOWN_MAX. */
  shown: OrphanedCommit[];
}

function emptyResult(
  status: OrphanedHeadStatus,
  reason: OrphanedHeadReason,
  headSha: string | null = null,
): OrphanedHeadResult {
  return { status, reason, headSha, total: 0, totalIsCapped: false, shown: [] };
}

// Code points removed/replaced in commit subjects: C0 controls (0-0x1F), DEL and C1 (0x7F-0x9F),
// line/paragraph separators (0x2028/9) become spaces. Dropped entirely: bidi marks/overrides/
// isolates (0x61C, 0x200E/F, 0x202A-E, 0x2066-9), BOM (0xFEFF), and zero-width/invisible characters
// (0x200B-D, 0x2060-4, 0xAD, 0x180E, 0x34F, Hangul fillers, tag characters 0xE0000-E007F, variation
// selectors 0xFE00-F and 0xE0100-E01EF) - all usable to spoof what a dialog displays.
// Written as numeric ranges, not regex literals, so no invisible characters live in this file.
function isDropped(cp: number): boolean {
  return (
    cp === 0x061c || cp === 0x200e || cp === 0x200f || cp === 0xfeff ||
    (cp >= 0x202a && cp <= 0x202e) || (cp >= 0x2066 && cp <= 0x2069) ||
    (cp >= 0x200b && cp <= 0x200d) || (cp >= 0x2060 && cp <= 0x2064) ||
    cp === 0xad || cp === 0x180e || cp === 0x34f || cp === 0x115f || cp === 0x1160 ||
    cp === 0x3164 || cp === 0xffa0 ||
    (cp >= 0xe0000 && cp <= 0xe007f) ||
    (cp >= 0xfe00 && cp <= 0xfe0f) || (cp >= 0xe0100 && cp <= 0xe01ef)
  );
}
function isControl(cp: number): boolean {
  return cp <= 0x1f || (cp >= 0x7f && cp <= 0x9f) || cp === 0x2028 || cp === 0x2029;
}

/** Input examined before truncation, so even an unbounded string costs bounded work. */
const SANITIZE_INPUT_LIMIT = 4096;

/** Exported for tests. Strip control/bidi/invisible characters and truncate a commit subject for display. */
export function sanitizeSubject(raw: string): string {
  let out = "";
  for (const ch of raw.length > SANITIZE_INPUT_LIMIT ? raw.slice(0, SANITIZE_INPUT_LIMIT) : raw) {
    const cp = ch.codePointAt(0)!;
    if (isDropped(cp)) continue;
    out += isControl(cp) ? " " : ch;
  }
  const cleaned = out.replace(/ {2,}/g, " ").trim();
  const codePoints = Array.from(cleaned);
  if (codePoints.length <= ORPHAN_SUBJECT_MAX_LENGTH) return cleaned;
  return codePoints.slice(0, ORPHAN_SUBJECT_MAX_LENGTH).join("") + String.fromCodePoint(0x2026);
}

/** `symbolic-ref -q HEAD`: exit 0 -> attached to a branch (true), exit 1 -> detached (false). Else throws. */
async function isHeadAttached(cwd: string, signal?: AbortSignal): Promise<boolean> {
  const { exitCode } = await runGitAllowingExitCodes(["symbolic-ref", "-q", "HEAD"], { cwd, signal }, [0, 1]);
  return exitCode === 0;
}

/**
 * Commits reachable from a detached HEAD but from no branch, tag or remote-tracking ref.
 * Read-only; never throws for git failures (returns `status: "unknown"` instead — see
 * `OrphanedHeadStatus`). A stash-only commit still counts as orphaned: `refs/stash` is never
 * consulted, only `--branches --tags --remotes`.
 */
export async function getOrphanedHeadCommits(repoPath: string): Promise<OrphanedHeadResult> {
  // One overall 10s budget for the whole check, enforced through a caller-style signal (which
  // `armTimeout` honors in place of the per-call default), so getRepositoryState's own probes are
  // bounded too.
  const signal = AbortSignal.timeout(ORPHAN_QUERY_TIMEOUT_MS);
  try {
    const state = await getRepositoryState(repoPath, signal);
    if (state.isBare || !state.workdir) return emptyResult("none", "bare");
    if (state.inProgressOperation !== null) return emptyResult("none", "operation-in-progress");

    // Detached detection is by exit code, never by parsing localized text.
    if (await isHeadAttached(repoPath, signal)) return emptyResult("none", "attached");

    let headSha: string;
    try {
      const { stdout } = await runGit(["rev-parse", "--verify", "-q", "HEAD"], {
        cwd: repoPath,
        signal,
      });
      headSha = stdout.trim();
    } catch (err) {
      if (err instanceof GitCommandError && err.exitCode === 1) return emptyResult("none", "unborn");
      throw err;
    }
    if (!FULL_OID_RE.test(headSha)) return emptyResult("unknown", "error");

    // Every argv token below is a constant literal; nothing repo- or user-controlled is
    // interpolated. `--exclude=refs/stash` is unnecessary: it only filters --branches/--tags/
    // --remotes, none of which ever include refs/stash.
    //
    // Two calls so stdout is BOUNDED whatever the repository contains (a hostile repo can hold
    // ~1000 unreferenced commits with multi-MB subjects): (1) `--count` prints one integer;
    // (2) at most ORPHAN_SHOWN_MAX rows, each subject cut by git itself to ~200 columns.
    const { stdout: countOut } = await runGit(
      [
        "rev-list",
        "--count",
        `--max-count=${ORPHAN_COUNT_CAP + 1}`,
        "HEAD",
        "--not",
        "--branches",
        "--tags",
        "--remotes",
      ],
      { cwd: repoPath, signal },
    );
    const countText = countOut.trim();
    if (!/^[0-9]{1,6}$/.test(countText)) return emptyResult("unknown", "error", headSha);
    const count = Number(countText);
    if (count === 0) return emptyResult("none", "no-orphans", headSha);

    // Output per commit: "commit <sha>\n<short>\0<subject>\n". `%<(200,trunc)` pads/truncates the
    // subject to 200 columns (padding is trimmed by sanitizeSubject); `%h` and the header are fixed size.
    const { stdout } = await runGit(
      [
        "rev-list",
        `--max-count=${ORPHAN_SHOWN_MAX}`,
        "--format=%h%x00%<(200,trunc)%s",
        "HEAD",
        "--not",
        "--branches",
        "--tags",
        "--remotes",
      ],
      { cwd: repoPath, signal },
    );

    const shown = parseRevListFormat(stdout);
    // The two reads are separate; if the repo changed between them (or output is malformed) fail closed.
    if (shown === null || shown.length === 0) return emptyResult("unknown", "error", headSha);

    return {
      status: "orphaned",
      reason: "orphaned",
      headSha,
      total: Math.min(count, ORPHAN_COUNT_CAP),
      totalIsCapped: count > ORPHAN_COUNT_CAP,
      shown,
    };
  } catch (err) {
    const timedOut = signal.aborted || err instanceof GitCommandTimeoutError;
    return emptyResult("unknown", timedOut ? "timeout" : "error");
  }
}

/** Strict parse; returns null on ANY deviation so the caller fails closed. */
function parseRevListFormat(stdout: string): OrphanedCommit[] | null {
  if (stdout === "") return [];
  const lines = stdout.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  if (lines.length % 2 !== 0) return null;
  const out: OrphanedCommit[] = [];
  for (let i = 0; i < lines.length; i += 2) {
    const header = lines[i]!;
    const payload = lines[i + 1]!;
    if (!header.startsWith("commit ")) return null;
    const sha = header.slice("commit ".length).trim();
    if (!FULL_OID_RE.test(sha)) return null;
    const nul = payload.indexOf("\0");
    if (nul === -1) return null;
    const shortSha = payload.slice(0, nul);
    if (!/^[0-9a-f]{4,64}$/.test(shortSha)) return null;
    out.push({ sha, shortSha, subject: sanitizeSubject(payload.slice(nul + 1)) });
  }
  return out;
}

/** Lower-case and validate a caller-supplied `expectedDetachedHeadSha`. Throws `InvalidArgumentError`. */
export function normalizeExpectedSha(sha: string): string {
  const lowered = typeof sha === "string" ? sha.toLowerCase() : "";
  if (!FULL_OID_RE.test(lowered)) {
    throw new InvalidArgumentError("expectedDetachedHeadSha must be a full 40- or 64-character hex commit id");
  }
  return lowered;
}

/**
 * Re-verify, at the moment a guarded mutation is about to run, that HEAD is STILL detached at
 * exactly `expectedSha` (already normalized). Must be called from inside `runInMutationQueue()`.
 * Throws `HeadMovedError` otherwise; any git failure propagates (fail closed: no checkout).
 */
export async function assertHeadStillDetachedAt(cwd: string, expectedSha: string): Promise<void> {
  const attached = await isHeadAttached(cwd);
  let actual: string | null = null;
  try {
    const { stdout } = await runGit(["rev-parse", "--verify", "-q", "HEAD"], { cwd });
    actual = stdout.trim().toLowerCase() || null;
  } catch (err) {
    if (!(err instanceof GitCommandError && err.exitCode === 1)) throw err;
  }
  if (attached || actual !== expectedSha) throw new HeadMovedError(expectedSha, actual, attached);
}
