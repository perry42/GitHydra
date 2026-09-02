import * as fs from "node:fs/promises";
import type { GitChildProcess } from "./gitProcess";
import {
  runGit,
  runGitAllowingExitCodes,
  spawnGit,
  withEndOfOptions,
  withFsmonitorNeutralized,
} from "./gitProcess";
import { GitCommandError, InvalidArgumentError } from "./errors";
import { EMPTY_TREE_SHA, HEX_SHA_RE } from "./changedFiles";
import { parseNumstat, DEFAULT_MAX_FILE_SIZE_BYTES } from "./diff";
import { assertPathWithinWorkdir, resolveWithinWorkdir } from "./pathSafety";
import { readHistoryBoundarySet, resolveRepositoryPaths } from "./repository";
import { LOG_FORMAT, RS, parseRecord, validateShaLike, type CommitPager } from "./commitLog";
import type { BlameCommitInfo, BlameLine, BlameResult, CommitInfo, CommitLogPage } from "./types";

/**
 * FR-123 through FR-130 (specs/blame.md): read-only blame ("who wrote this line, and when") and
 * paged file-history ("how has this file evolved") support.
 *
 * Deliberately reuses several already-shipped conventions rather than re-deriving them:
 *  - `diff.ts`'s guard-before-fetch discriminated-result shape (binary/too-large detected before
 *    any full content is materialized) and its `DEFAULT_MAX_FILE_SIZE_BYTES` threshold/
 *    `parseNumstat()` binary/size sniffing.
 *  - `pathSafety.ts`'s `assertPathWithinWorkdir()` containment check for the no-revision
 *    (working-tree) blame path, same as `diff.ts`'s untracked source and `staging.ts` require.
 *  - `commitLog.ts`'s NUL-delimited log-record format/parser (`LOG_FORMAT`/`parseRecord`) and its
 *    `CommitPager` (`readPage(count)`/`close()`) contract for `getFileHistory()`'s dedicated
 *    `git log --follow` read path — NOT routed through `CommitLogReader`'s `--all`-based
 *    multi-ref walker, mirroring the same reasoning `findCommitsBySha()` already established for
 *    SHA lookups: `--follow` requires exactly one revision + one path, a fundamentally different
 *    shape of query than a full-graph walk.
 *  - `commitLog.ts`'s `isHistoryBoundary` shallow/graft-boundary convention, both for
 *    `getFileHistory()`'s `CommitInfo` results and (via porcelain's own `boundary` marker) for
 *    `getFileBlame()`'s per-line `isBoundary`.
 *
 * No network calls anywhere in this module (FR-130) — true by construction: every function here
 * only ever shells out to the local `git` binary via `gitProcess.ts`.
 */

const ZERO_SHA = "0".repeat(40);

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/**
 * Reconstruct an ISO-8601-strict timestamp (matching `commitLog.ts`'s `--date=iso-strict`
 * shape, e.g. "2024-01-01T12:34:56+09:00") from porcelain's separate `author-time` (unix epoch
 * seconds) and `author-tz` (e.g. "+0900"/"-0500") fields — `--date` has no effect on
 * `--porcelain`'s machine-readable timestamp fields, so this reconstruction has to happen here
 * rather than being requestable from git directly. Computed using UTC getters throughout so the
 * result is independent of the host machine's own local timezone.
 */
function formatIsoWithOffset(epochSeconds: number, tzRaw: string): string {
  const trimmed = tzRaw.trim();
  const sign = trimmed.startsWith("-") ? -1 : 1;
  const digits = trimmed.replace(/^[+-]/, "").padStart(4, "0");
  const offsetHours = Number(digits.slice(0, 2)) || 0;
  const offsetMinutes = Number(digits.slice(2, 4)) || 0;
  const offsetTotalMinutes = sign * (offsetHours * 60 + offsetMinutes);

  const epochMs = (Number.isFinite(epochSeconds) ? epochSeconds : 0) * 1000;
  const shifted = new Date(epochMs + offsetTotalMinutes * 60_000);

  const yyyy = shifted.getUTCFullYear();
  const MM = pad2(shifted.getUTCMonth() + 1);
  const dd = pad2(shifted.getUTCDate());
  const HH = pad2(shifted.getUTCHours());
  const mm = pad2(shifted.getUTCMinutes());
  const ss = pad2(shifted.getUTCSeconds());
  const offSign = offsetTotalMinutes < 0 ? "-" : "+";
  const offH = pad2(Math.floor(Math.abs(offsetTotalMinutes) / 60));
  const offM = pad2(Math.abs(offsetTotalMinutes) % 60);

  return `${yyyy}-${MM}-${dd}T${HH}:${mm}:${ss}${offSign}${offH}:${offM}`;
}

function stripAngleBrackets(s: string): string {
  return s.replace(/^</, "").replace(/>$/, "");
}

const BLAME_HEADER_RE = /^([0-9a-f]{40}) (\d+) (\d+)(?: \d+)?$/;

interface BlameCommitMetaDraft {
  authorName: string;
  authorEmail: string;
  authorTime: string;
  authorTz: string;
  summary: string;
}

/**
 * Parse `git blame --porcelain`'s output into `BlameLine[]` (FR-124/126/127). Exported for direct
 * unit testing, mirroring `diff.ts`'s `parseUnifiedDiffHunks()` convention.
 *
 * Porcelain shape (per line-group): a header line `<sha> <origline> <finalline> [<count>]`,
 * followed — ONLY the first time a given sha appears in the output — by that commit's metadata
 * block (`author `/`author-mail `/`author-time `/`author-tz `/`committer-*`/`summary `, optionally
 * `previous <sha> <path>` and/or a standalone `boundary` line), then (always, every time, even on
 * repeat) a `filename <path>` line, then the actual content line prefixed with a single literal
 * tab character.
 *
 * `historyBoundary` (default empty) is the same shallow/grafted-commit SHA set
 * `commitLog.ts`'s `readHistoryBoundarySet()` produces, and is the sole source of truth this
 * function uses for `isBoundary` (FR-127) — porcelain's own standalone `boundary` line is parsed
 * but deliberately NOT used for that purpose: verified directly against real git that it's
 * ambiguous, set identically for a genuine (non-shallow) root commit as for a true shallow/graft
 * boundary, with no combination of flags (including `--root`, which git's own docs describe as
 * suppressing exactly this marker) that disambiguates the two from porcelain output alone. The
 * on-disk `.git/shallow`/`.git/info/grafts` cross-reference this module already has to compute
 * (matching `commitLog.ts`'s `parseRecord()` precedent) is unambiguous and reused here instead.
 */
export function parsePorcelainBlame(
  stdout: string,
  historyBoundary: ReadonlySet<string> = new Set(),
): BlameLine[] {
  const rawLines = stdout.split("\n");
  if (rawLines.length > 0 && rawLines[rawLines.length - 1] === "") rawLines.pop();

  const metaCache = new Map<string, BlameCommitMetaDraft>();
  const result: BlameLine[] = [];

  let i = 0;
  while (i < rawLines.length) {
    const headerLine = rawLines[i];
    const m = headerLine !== undefined ? BLAME_HEADER_RE.exec(headerLine) : null;
    if (!m) {
      // Defensive: skip anything unexpected rather than crash on a not-quite-well-formed line.
      i++;
      continue;
    }
    const sha = m[1]!;
    const finalLineNumber = Number(m[3]);
    i++;

    let meta = metaCache.get(sha);
    if (!meta) {
      let authorName = "";
      let authorEmail = "";
      let authorTime = "";
      let authorTz = "";
      let summary = "";
      while (i < rawLines.length && !(rawLines[i] ?? "").startsWith("filename ")) {
        const l = rawLines[i]!;
        if (l.startsWith("author-mail ")) authorEmail = stripAngleBrackets(l.slice("author-mail ".length));
        else if (l.startsWith("author-time ")) authorTime = l.slice("author-time ".length);
        else if (l.startsWith("author-tz ")) authorTz = l.slice("author-tz ".length);
        else if (l.startsWith("author ")) authorName = l.slice("author ".length);
        else if (l.startsWith("summary ")) summary = l.slice("summary ".length);
        // else: committer-*/previous/boundary/etc — not part of BlameCommitInfo (see this
        // function's doc comment for why porcelain's own `boundary` line is intentionally
        // ignored), or not needed here at all — skip.
        i++;
      }
      meta = { authorName, authorEmail, authorTime, authorTz, summary };
      metaCache.set(sha, meta);
    }

    // "filename <path>" is always present for every record (first-time or repeat) — consume it.
    if (i < rawLines.length && (rawLines[i] ?? "").startsWith("filename ")) {
      i++;
    }

    const rawContent = i < rawLines.length ? (rawLines[i] ?? "") : "";
    const content = rawContent.startsWith("\t") ? rawContent.slice(1) : rawContent;
    i++;

    const isUncommitted = sha === ZERO_SHA;
    const commit: BlameCommitInfo = {
      sha,
      abbrevSha: sha.slice(0, 7),
      authorName: meta.authorName,
      authorEmail: meta.authorEmail,
      authorDate: formatIsoWithOffset(Number(meta.authorTime), meta.authorTz),
      summary: meta.summary,
      isBoundary: historyBoundary.has(sha),
      isUncommitted,
    };
    result.push({ content, lineNumber: finalLineNumber, commit });
  }

  return result;
}

type ExistenceResult = { size: number } | "not-found";

/** FR-125/FR-128: existence + size for the working-tree (no-revision) blame path. Uses `fs.lstat`
 * — same rationale as `diff.ts`'s `statWorkdirFileSize()`: a symlink is sized as itself (its
 * target-path string), never silently followed. */
async function resolveWorkdirExistenceAndSize(cwd: string, relPath: string): Promise<ExistenceResult> {
  const resolved = resolveWithinWorkdir(cwd, relPath); // re-validates containment (FR-128), defense in depth
  try {
    const stat = await fs.lstat(resolved);
    if (!stat.isFile() && !stat.isSymbolicLink()) return "not-found"; // e.g. a directory
    return { size: stat.size };
  } catch {
    return "not-found";
  }
}

/** FR-125: existence + size for a historical-revision blame path, via a tree-object read (no
 * working-tree/index involvement at all — same as `diff.ts`'s commit-mode `getBlobSizeAt()`). */
async function resolveRevisionExistenceAndSize(
  cwd: string,
  revision: string,
  relPath: string,
): Promise<ExistenceResult> {
  try {
    const args = ["cat-file", "-s", ...withEndOfOptions([`${revision}:${relPath}`])];
    const { stdout } = await runGit(args, { cwd });
    const n = Number(stdout.trim());
    return Number.isFinite(n) ? { size: n } : "not-found";
  } catch {
    return "not-found";
  }
}

/** FR-125: cheap binary check via `git diff --numstat`, reusing `diff.ts`'s `parseNumstat()` —
 * git itself does the (potentially large) file read on its own side; only a bounded numstat
 * summary line ever reaches this process, never full content. */
async function checkIsBinary(cwd: string, revision: string | null, relPath: string): Promise<boolean> {
  if (revision === null) {
    // Mirrors diff.ts's "untracked" source exactly: --no-index compares two filesystem paths
    // directly and does not touch the index, so no fsmonitor neutralization is needed here.
    const { stdout } = await runGitAllowingExitCodes(
      ["diff", "--no-color", "--no-index", "--numstat", "--", "/dev/null", relPath],
      { cwd },
      [0, 1],
    );
    return parseNumstat(stdout).isBinary;
  }
  const args = [
    "diff",
    "--no-color",
    "--numstat",
    ...withEndOfOptions([EMPTY_TREE_SHA, revision]),
    "--",
    relPath,
  ];
  const { stdout } = await runGit(args, { cwd });
  return parseNumstat(stdout).isBinary;
}

function buildBlameArgs(revision: string | null, relPath: string): string[] {
  // --first-parent: blame at/through a merge commit follows only the first parent, matching
  // getCommitFileDiff()'s/getChangedFiles()'s existing first-parent-only merge convention
  // (README "Design notes"). No --root here — see parsePorcelainBlame()'s doc comment for why
  // isBoundary is derived from the on-disk shallow/graft set instead of porcelain's own
  // (ambiguous) "boundary" line.
  const args = ["blame", "--porcelain", "--first-parent"];
  if (revision !== null) {
    // Unlike `git log`/`git diff`, `git blame`'s own option parser does NOT support
    // `--end-of-options` — verified directly (it exits 129 with a usage error regardless of
    // where the flag is placed). Safe to append `revision` directly without it regardless:
    // `getFileBlame()` already validated `revision` against `HEX_SHA_RE` above, which can never
    // produce a string starting with `-`, so it can never be misparsed as a flag by git's
    // argument scanner in the first place.
    args.push(revision);
  }
  args.push("--", relPath);
  return args;
}

/**
 * FR-123/124/125/126/127/128: blame a single file, either the current working-tree content
 * (`revision: null` — includes uncommitted edits, FR-126) or as of a historical commit
 * (`revision: <sha>`). Guards against binary content and an oversized file BEFORE `git blame`'s
 * full run is ever invoked (FR-125), returning a `BlameResult` discriminated the same way
 * `diff.ts`'s `FileDiffResult` is.
 */
export async function getFileBlame(
  cwd: string,
  path: string,
  revision: string | null,
): Promise<BlameResult> {
  if (!path || !path.trim()) {
    throw new InvalidArgumentError("File path must not be empty.");
  }

  if (revision !== null) {
    if (!HEX_SHA_RE.test(revision)) {
      throw new InvalidArgumentError(`Not a valid hex SHA: ${JSON.stringify(revision)}`);
    }
  } else {
    // FR-128: reject a no-revision blame path that resolves outside the working directory,
    // before any filesystem read is attempted.
    assertPathWithinWorkdir(cwd, path);
  }

  const existence =
    revision === null
      ? await resolveWorkdirExistenceAndSize(cwd, path)
      : await resolveRevisionExistenceAndSize(cwd, revision, path);
  if (existence === "not-found") {
    return { status: "not-found" };
  }
  if (existence.size === 0) {
    return { status: "empty" };
  }

  // FR-125: binary check before any size guard or full blame run.
  if (await checkIsBinary(cwd, revision, path)) {
    return { status: "binary" };
  }

  // FR-125: absolute byte-size guard, reusing diff.ts's DEFAULT_MAX_FILE_SIZE_BYTES value.
  if (existence.size > DEFAULT_MAX_FILE_SIZE_BYTES) {
    return { status: "too-large", reason: "file-size", fileSizeBytes: existence.size };
  }

  const args = buildBlameArgs(revision, path);
  // Only the no-revision path reads/refreshes working-tree+index state (to tell committed lines
  // apart from uncommitted ones) — a historical-revision blame reads two existing tree objects
  // and needs no such guard, same distinction diff.ts's DiffSource plan already draws.
  const finalArgs = revision === null ? withFsmonitorNeutralized(args) : args;

  // FR-127: only computed once the guards above have passed (never wasted on a binary/too-large/
  // not-found/empty result) — see parsePorcelainBlame()'s doc comment for why this on-disk set,
  // not porcelain's own "boundary" line, is the isBoundary source of truth.
  const { commonGitDir } = await resolveRepositoryPaths(cwd);
  const historyBoundary = await readHistoryBoundarySet(commonGitDir);

  const { stdout } = await runGit(finalArgs, { cwd });

  return { status: "ok", lines: parsePorcelainBlame(stdout, historyBoundary) };
}

/**
 * FR-129: a paged reader over `git log --follow --format=<...> <revision> -- <path>`, matching
 * `CommitPager`'s `readPage(count)`/`close()` contract exactly. A dedicated read path rather than
 * going through `CommitLogReader`'s `--all`-based multi-ref walk — `--follow` requires exactly
 * one revision + one path, a fundamentally different query shape (same reasoning
 * `findCommitsBySha()` already established for direct SHA lookups). Pre-rename history is
 * included by default (git's own `--follow` behavior, no extra flag needed). Never used
 * `--first-parent` here (unlike `getFileBlame()`): file history is meant to surface every commit
 * that touched the file, including ones that only arrived via a merge's non-first-parent side.
 */
class FileHistoryReader implements CommitPager {
  private child: GitChildProcess | null = null;
  private buffered = "";
  private ended = false;
  private errored: Error | null = null;
  private started = false;
  private readonly args: string[];

  constructor(
    private readonly repoPath: string,
    revision: string,
    path: string,
    private readonly historyBoundary: ReadonlySet<string>,
  ) {
    this.args = [
      "log",
      "--follow",
      `--format=${LOG_FORMAT}`,
      "--date=iso-strict",
      "--encoding=UTF-8",
      "--topo-order",
      ...withEndOfOptions([revision]),
      "--",
      path,
    ];
  }

  private ensureStarted(): void {
    if (this.started) return;
    this.started = true;
    const child = spawnGit(this.args, { cwd: this.repoPath });
    this.child = child;
    child.stdout.setEncoding("utf8");

    const stderrChunks: Buffer[] = [];
    child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

    child.stdout.on("data", (chunk: string) => {
      this.buffered += chunk;
    });
    child.stdout.on("end", () => {
      this.ended = true;
    });
    child.on("error", (err) => {
      this.errored = new GitCommandError(`Failed to run git log --follow: ${err.message}`, this.args, null, "");
    });
    child.on("close", (code) => {
      this.ended = true;
      if (code !== null && code !== 0 && !this.errored) {
        const stderr = Buffer.concat(stderrChunks).toString("utf8");
        this.errored = new GitCommandError(
          `git log --follow exited with code ${code}: ${stderr.trim()}`,
          this.args,
          code,
          stderr,
        );
      }
    });
  }

  private getCompleteRecords(): { complete: string[]; incompleteTail: string | null } {
    const parts = this.buffered.split(RS);
    const records = parts.slice(1);
    if (this.ended) {
      return { complete: records, incompleteTail: null };
    }
    if (records.length === 0) {
      return { complete: [], incompleteTail: null };
    }
    return { complete: records.slice(0, -1), incompleteTail: records[records.length - 1] ?? "" };
  }

  private async fillUntil(count: number): Promise<void> {
    this.ensureStarted();
    while (!this.errored) {
      const { complete } = this.getCompleteRecords();
      if (complete.length >= count || this.ended) return;
      await new Promise<void>((resolve) => {
        const onData = () => {
          cleanup();
          resolve();
        };
        const onEnd = () => {
          cleanup();
          resolve();
        };
        const cleanup = () => {
          this.child?.stdout.off("data", onData);
          this.child?.stdout.off("end", onEnd);
        };
        this.child?.stdout.once("data", onData);
        this.child?.stdout.once("end", onEnd);
      });
    }
  }

  async readPage(count: number): Promise<CommitLogPage> {
    if (count <= 0) throw new InvalidArgumentError("readPage count must be positive");
    await this.fillUntil(count);
    if (this.errored) throw this.errored;

    const { complete, incompleteTail } = this.getCompleteRecords();
    const take = Math.min(count, complete.length);
    const consumed = complete.slice(0, take);
    const remaining = complete.slice(take);

    const remainderParts = incompleteTail !== null ? [...remaining, incompleteTail] : remaining;
    this.buffered = remainderParts.length > 0 ? RS + remainderParts.join(RS) : "";

    const commits = consumed
      .map((r) => parseRecord(r, this.historyBoundary))
      .filter((c): c is CommitInfo => c !== null);

    const done = this.ended && remaining.length === 0;
    return { commits, done };
  }

  close(): void {
    if (this.child && !this.child.killed) {
      this.child.kill();
    }
  }
}

/**
 * FR-129: open a paged file-history reader for `path` starting from `revision` (a branch/tag/SHA
 * — validated the same permissive-but-injection-safe way `commitLog.ts`'s ref filters are, then
 * always passed through `--end-of-options`). Caller must call `.close()` on the returned reader
 * when done, same contract as `Repository.createCommitLogReader()`'s result (AC13: never fully
 * materializes a long-lived file's entire history up front).
 */
export async function getFileHistory(cwd: string, revision: string, path: string): Promise<CommitPager> {
  if (!path || !path.trim()) {
    throw new InvalidArgumentError("File path must not be empty.");
  }
  if (!revision || !revision.trim()) {
    throw new InvalidArgumentError("Revision must not be empty.");
  }
  validateShaLike(revision, "revision");

  const { commonGitDir } = await resolveRepositoryPaths(cwd);
  const historyBoundary = await readHistoryBoundarySet(commonGitDir);

  return new FileHistoryReader(cwd, revision, path, historyBoundary);
}
