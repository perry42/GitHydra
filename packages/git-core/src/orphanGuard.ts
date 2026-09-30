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
// line/paragraph separators (0x2028/9) become spaces; bidi marks/overrides/isolates (0x61C,
// 0x200E/F, 0x202A-E, 0x2066-9) and BOM (0xFEFF) are dropped (Trojan-Source style spoofing).
// Written as numeric ranges, not regex literals, so no invisible characters live in this file.
function isBidiOrBom(cp: number): boolean {
  return (
    cp === 0x061c || cp === 0x200e || cp === 0x200f || cp === 0xfeff ||
    (cp >= 0x202a && cp <= 0x202e) || (cp >= 0x2066 && cp <= 0x2069)
  );
}
function isControl(cp: number): boolean {
  return cp <= 0x1f || (cp >= 0x7f && cp <= 0x9f) || cp === 0x2028 || cp === 0x2029;
}

/** Exported for tests. Strip control/bidi characters and truncate a commit subject for display. */
export function sanitizeSubject(raw: string): string {
  let out = "";
  for (const ch of raw) {
    const cp = ch.codePointAt(0)!;
    if (isBidiOrBom(cp)) continue;
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

    // Every argv token is a constant literal; nothing repo- or user-controlled is interpolated.
    // `--exclude=refs/stash` is unnecessary: it only filters --branches/--tags/--remotes, none of
    // which ever include refs/stash. Output per commit: "commit <sha>\n<short>\0<subject>\n".
    const { stdout } = await runGit(
      [
        "rev-list",
        `--max-count=${ORPHAN_COUNT_CAP + 1}`,
        "--format=%h%x00%s",
        "HEAD",
        "--not",
        "--branches",
        "--tags",
        "--remotes",
      ],
      { cwd: repoPath, signal },
    );

    const commits = parseRevListFormat(stdout);
    if (commits === null) return emptyResult("unknown", "error", headSha);
    if (commits.length === 0) return emptyResult("none", "no-orphans", headSha);

    return {
      status: "orphaned",
      reason: "orphaned",
      headSha,
      total: Math.min(commits.length, ORPHAN_COUNT_CAP),
      totalIsCapped: commits.length > ORPHAN_COUNT_CAP,
      shown: commits.slice(0, ORPHAN_SHOWN_MAX),
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
