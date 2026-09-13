// SPDX-License-Identifier: GPL-3.0-or-later
import type { BoundChild, GitChildProcess } from "./gitProcess";
import { armEscalation, spawnGit, runGit, withEndOfOptions, optionEquals } from "./gitProcess";
import { GitCommandError, InvalidArgumentError, OperationCancelledError, ReaderResumeMismatchError } from "./errors";
import type { CommitInfo, CommitLogFilter, CommitLogPage, RefDecoration, ResumeCommitLogFrom } from "./types";

// NUL (0x00) as the record separator between commits. Unlike the RS control character
// (0x1e) this used to use, a literal NUL byte cannot appear anywhere in a commit's
// metadata/message: git's object storage is NUL-terminated-C-string based, so it's
// impossible to create a commit whose message contains a real NUL byte. RS has no such
// guarantee — a commit message legally containing a literal 0x1e byte (verified: git
// preserves it byte-for-byte) would desync split()'s record boundaries and cause
// getCompleteRecords()/parseRecord() to silently drop that commit (and potentially the
// one after it) from history. NUL closes that gap.
//
// We can't embed a literal NUL byte inside the `--format=` argv string we hand to
// spawn() — Node rejects any argv/env string containing an embedded NUL outright
// (throws synchronously: "must be a string without null bytes"). Instead we use git's
// own `%x00` pretty-format placeholder: the text "%x00" (plain ASCII, safe in argv)
// instructs git itself to emit an actual 0x00 byte into ITS stdout at that position, so
// the NUL only ever exists in git's output stream, never in the argv we pass to it.
export const RS = "\x00"; // the literal byte we split parsed stdout on
const RS_FORMAT_TOKEN = "%x00"; // the argv-safe token that makes git emit that byte
const FS = "\x1f"; // field separator between fields within a commit

// Field order must match parseRecord() below exactly.
const LOG_FIELDS = ["%H", "%h", "%P", "%an", "%ae", "%ad", "%cn", "%ce", "%cd", "%s", "%b"];
/** Exported so `blame.ts`'s dedicated `git log --follow` read path (FR-129) can reuse the exact
 * same record format/parser instead of re-deriving a second one. */
export const LOG_FORMAT = `${RS_FORMAT_TOKEN}${LOG_FIELDS.join(FS)}`;

const HEX_SHA_RE = /^[0-9a-fA-F]{4,40}$/;

function buildMessage(subject: string, body: string): string {
  const trimmedBody = body.trim();
  return trimmedBody ? `${subject}\n\n${trimmedBody}` : subject;
}

/** Parse one record (delimited by the RS byte, i.e. NUL — see RS above; already stripped by the caller) into a CommitInfo (refs/isHistoryBoundary filled in later). Exported for `blame.ts`'s reuse (FR-129). */
export function parseRecord(record: string, boundarySet: ReadonlySet<string>): CommitInfo | null {
  if (!record) return null;
  // Split with a cap so a stray field-separator byte inside the free-text body (the last
  // field) can't shift the fixed-position fields before it; anything past field 10 is
  // rejoined into the body.
  const parts = record.split(FS);
  if (parts.length < LOG_FIELDS.length) return null;

  const [sha, abbrevSha, parentsRaw, authorName, authorEmail, authorDate, committerName, committerEmail, committerDate, subject] =
    parts;
  // git's %b always ends with exactly one trailing newline (part of how it normalizes
  // stored commit messages); strip that for a UI-friendly value. Internal formatting/blank
  // lines within the body are preserved.
  const body = parts.slice(10).join(FS).replace(/\n+$/, "");

  if (!sha) return null;

  const parents = parentsRaw ? parentsRaw.split(" ").filter(Boolean) : [];

  return {
    sha,
    abbrevSha: abbrevSha || sha.slice(0, 7),
    parents,
    authorName: authorName ?? "",
    authorEmail: authorEmail ?? "",
    authorDate: authorDate ?? "",
    committerName: committerName ?? "",
    committerEmail: committerEmail ?? "",
    committerDate: committerDate ?? "",
    subject: subject ?? "",
    body,
    message: buildMessage(subject ?? "", body),
    refs: [],
    isHistoryBoundary: boundarySet.has(sha),
  };
}

/** Exported for `blame.ts`'s `getFileHistory()` (FR-129), which validates its `revision` argument
 * the same permissive-but-safe way `buildRevisionArgs()` below validates `filter.refs`. */
export function validateShaLike(value: string, label: string): void {
  if (!/^[A-Za-z0-9._/-]+$/.test(value)) {
    throw new InvalidArgumentError(`Invalid ${label}: ${JSON.stringify(value)}`);
  }
}

/**
 * Build the revision-selection portion of `git log`'s argv from a filter. Does NOT handle
 * `sha` (that's a direct lookup, not a log walk — see findCommitsBySha) or `paths` (appended
 * separately, after a literal `--`, by the caller).
 */
function buildRevisionArgs(filter: CommitLogFilter | undefined): string[] {
  const refs = filter?.refs;
  if (refs && refs.length > 0) {
    for (const r of refs) validateShaLike(r, "ref/revision");
    return withEndOfOptions(refs);
  }
  // FR-1: full local ref graph — all local branches, remote-tracking branches, tags, and HEAD.
  // `--exclude` only affects the traversal flags (`--all`/`--branches`/etc.) that come AFTER
  // it on the command line (see git-log(1) / git-rev-list(1)), so it must precede `--all` here.
  // refs/stash is internally a real commit (with up to 3 parents: the pre-stash HEAD, the
  // index tree, and optionally an untracked-files tree) carrying a synthetic message like
  // "WIP on <branch>: ..." / "index on ..." — never meant to appear as graph-visible history.
  return ["--exclude=refs/stash", "--all"];
}

function buildFilterArgs(filter: CommitLogFilter | undefined): string[] {
  if (!filter) return [];
  const args: string[] = [];
  const caseInsensitive = filter.caseInsensitive ?? true;

  if (filter.author) {
    args.push(optionEquals("--author", filter.author));
  }
  if (filter.messageSubstring) {
    args.push(optionEquals("--grep", filter.messageSubstring), "--fixed-strings");
  }
  if (filter.author || filter.messageSubstring) {
    if (caseInsensitive) args.push("--regexp-ignore-case");
  }
  if (filter.dateFrom) {
    args.push(optionEquals("--since", filter.dateFrom));
  }
  if (filter.dateTo) {
    args.push(optionEquals("--until", filter.dateTo));
  }
  return args;
}

/** Common interface both the streaming reader and the small prefetched-results pager implement. */
export interface CommitPager {
  readPage(count: number): Promise<CommitLogPage>;
  close(): void;
}

export interface CreateCommitLogReaderOptions {
  refsBySha?: Map<string, RefDecoration[]>;
  headSha?: string | null;
  historyBoundary?: ReadonlySet<string>;
  /**
   * specs/repo-open-feedback-fixes.md FR-197: bound for this reader's ENTIRE lifetime (not a
   * per-`readPage`-call signal) — when supplied (from a still-in-flight cancellable `openRepo`
   * attempt's `startReader` phase), aborting it terminates the underlying long-lived `git log`
   * child process via the same `child_process.spawn({signal})` integration every other call in
   * this package uses, SIGKILL-escalated the same way (see `ensureStarted()`/`close()`, and
   * `gitProcess.ts`'s `armEscalation()`, which both now reuse). Harmless for the reader's entire
   * post-open lifetime if the signal is never aborted (the ordinary case) — an `AbortSignal` that
   * never fires has no effect at all.
   */
  signal?: AbortSignal;
}

/**
 * A pull-based, paged reader over a repo's commit history (FR-3). Backed by a single
 * long-lived `git log` process whose stdout we read incrementally and pause between pages —
 * this means paging through a 1,000,000-commit repo never requires buffering more than the
 * commits actually requested, and never re-walks history from the start on each page (unlike
 * a naive `--skip=N` approach, which is O(n) per page).
 *
 * Not safe for concurrent `readPage` calls — a reader represents one sequential scan.
 */
export class CommitLogReader implements CommitPager {
  private child: GitChildProcess | null = null;
  private buffered = "";
  private ended = false;
  private errored: Error | null = null;
  private readonly refsBySha: Map<string, RefDecoration[]>;
  private readonly headSha: string | null;
  private readonly historyBoundary: ReadonlySet<string>;
  private readonly repoPath: string;
  private readonly args: string[];
  private readonly signal: AbortSignal | undefined;
  private started = false;
  /**
   * specs/repo-open-feedback-fixes.md finding (security-reviewer + test-agent, post-FR-197): the
   * ACTUAL signal this reader spawns `git log` with — distinct from the caller-supplied
   * `this.signal` above. Aborted whenever EITHER `this.signal` aborts OR `close()` is called
   * explicitly (see the constructor and `close()` below), so both cancellation paths get the exact
   * same SIGTERM-then-SIGKILL escalation (`armEscalation()`, `gitProcess.ts`) every other
   * cancellable git invocation in this package already gets — closing a reader with no external
   * `signal` in play at all (the common case: a reader the caller is just done with) must be able
   * to trigger the same escalation as a caller-initiated cancellation, which a bare reuse of
   * `this.signal` (possibly `undefined`) could never do.
   */
  private readonly killController = new AbortController();
  /** Set from the child's own `"exit"` event — see `armTimeout()`'s identical field in
   * `gitProcess.ts` for why this must be `"exit"`-driven, never `child.killed`-driven: a
   * hostile/broken `git log` (or a repo hook it shells out to) can trap and ignore the primary
   * kill signal, in which case `child.killed` flips `true` well before the process actually dies. */
  private processExited = false;
  private escalation: { clear: () => void } | null = null;

  constructor(repoPath: string, filter: CommitLogFilter | undefined, options: CreateCommitLogReaderOptions = {}) {
    this.repoPath = repoPath;
    this.refsBySha = options.refsBySha ?? new Map();
    this.headSha = options.headSha ?? null;
    this.historyBoundary = options.historyBoundary ?? new Set();
    this.signal = options.signal;

    // Wire the caller-supplied signal (if any) into `killController` so aborting it kills the
    // spawned `git log` exactly as it always has, while ALSO letting `close()` (below) trigger the
    // identical kill+escalation path even when no caller signal was ever supplied.
    if (this.signal) {
      if (this.signal.aborted) {
        this.killController.abort();
      } else {
        this.signal.addEventListener("abort", () => this.killController.abort(), { once: true });
      }
    }

    const args = ["log", `--format=${LOG_FORMAT}`, "--date=iso-strict", "--encoding=UTF-8", "--topo-order"];
    args.push(...buildFilterArgs(filter));
    args.push(...buildRevisionArgs(filter));
    if (filter?.paths && filter.paths.length > 0) {
      args.push("--", ...filter.paths);
    }
    this.args = args;
  }

  private ensureStarted(): void {
    if (this.started) return;
    this.started = true;
    // Ordering matters and must exactly mirror `armTimeout()`'s own sequencing in gitProcess.ts:
    // `armEscalation()` MUST be called BEFORE `spawnGit()` — see `armEscalation()`'s own doc
    // comment for the full reasoning. In short: `armEscalation()`'s "abort" listener must be
    // registered on `killController.signal` before `child_process.spawn()`'s own internal
    // abort-integration listener gets added to that SAME signal (which happens synchronously
    // inside `spawnGit()` below, since it's passed as `signal`). Both listeners fire, in
    // registration order, within the SAME synchronous `AbortSignal.abort()` dispatch — if
    // `spawnGit()` ran first, its listener's synchronous `child.kill()` + `"error"` emission would
    // trigger our own `"error"` handler's `escalation.clear()` call BEFORE `armEscalation`'s own
    // listener ever got its turn in that same dispatch, permanently removing it unfired — meaning
    // the SIGKILL escalation timer would never even get armed, for every single cancellation.
    // `getBoundChild`/`isProcessExited` are lazy callbacks precisely so `armEscalation()` can be
    // armed before the child (and its own "exit" listener, registered right after spawning below)
    // actually exist yet.
    let boundChild: BoundChild | null = null;
    this.escalation = armEscalation(
      this.killController.signal,
      () => boundChild,
      () => this.processExited,
    );
    let child: ReturnType<typeof spawnGit>;
    try {
      child = spawnGit(this.args, { cwd: this.repoPath, signal: this.killController.signal });
    } catch (err) {
      // Matches every analogous spawn call site in gitProcess.ts (runGitTask et al.): a
      // synchronous spawn failure (in practice, only `resolveGitExecutablePath()` throwing
      // `GitNotFoundError`, e.g. git removed from PATH mid-session) must still clear the
      // just-armed escalation timer's "abort" listener, and must still be captured into
      // `this.errored` rather than thrown here — `fillUntil()`/`readPage()` only ever observe
      // failure via `this.errored` (never via `ensureStarted()` itself throwing), so bypassing
      // that capture would surface an unwrapped, inconsistent error shape to callers.
      this.escalation?.clear();
      this.errored = this.killController.signal.aborted
        ? new OperationCancelledError(this.args)
        : err instanceof Error
          ? new GitCommandError(`Failed to run git log: ${err.message}`, this.args, null, "")
          : new GitCommandError("Failed to run git log", this.args, null, "");
      this.ended = true;
      return;
    }
    this.child = child;
    boundChild = child;
    child.once("exit", () => {
      this.processExited = true;
    });
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
      this.ended = true;
      this.escalation?.clear();
      // specs/repo-open-feedback-fixes.md FR-197/199: `spawn(..., {signal})`'s own abort
      // integration reports an aborted child via this same "error" event (an `AbortError`), not a
      // distinct one of its own — checked via `this.killController.signal.aborted` (never by
      // parsing `err`'s message/name, matching every other `wasCancelled()` check in
      // `gitProcess.ts`) so a caller-requested cancellation OR an explicit `close()` call (both of
      // which abort `killController` — see the constructor/`close()`) surfaces as the same typed,
      // distinct `OperationCancelledError` every other cancellable call in this package throws,
      // never a generic `GitCommandError`.
      this.errored = this.killController.signal.aborted
        ? new OperationCancelledError(this.args)
        : new GitCommandError(`Failed to run git log: ${err.message}`, this.args, null, "");
    });
    child.on("close", (code) => {
      this.ended = true;
      this.escalation?.clear();
      if (this.errored) return;
      if (this.killController.signal.aborted) {
        // Belt-and-suspenders, same reasoning as `gitProcess.ts`'s own timeout/cancellation
        // handling: don't rely on "error" firing before "close" across every platform/Node version.
        this.errored = new OperationCancelledError(this.args);
        return;
      }
      if (code !== null && code !== 0) {
        const stderr = Buffer.concat(stderrChunks).toString("utf8");
        this.errored = new GitCommandError(
          `git log exited with code ${code}: ${stderr.trim()}`,
          this.args,
          code,
          stderr,
        );
      }
    });
  }

  private enrich(commit: CommitInfo): CommitInfo {
    const refs = [...(this.refsBySha.get(commit.sha) ?? [])];
    if (this.headSha && commit.sha === this.headSha) {
      refs.unshift({ name: "HEAD", fullName: null, type: "head" });
    }
    commit.refs = refs;
    return commit;
  }

  /**
   * Split the current buffer into fully-received records plus (if the process hasn't finished
   * writing) a possibly-incomplete trailing chunk that must not be treated as a real record yet
   * — stdout can be delivered in arbitrary chunks that don't align with record boundaries.
   */
  private getCompleteRecords(): { complete: string[]; incompleteTail: string | null } {
    const parts = this.buffered.split(RS);
    // parts[0] is whatever preceded the first RS — always "" for well-formed output.
    const records = parts.slice(1);
    if (this.ended) {
      return { complete: records, incompleteTail: null };
    }
    if (records.length === 0) {
      return { complete: [], incompleteTail: null };
    }
    return { complete: records.slice(0, -1), incompleteTail: records[records.length - 1] ?? "" };
  }

  /** Wait until either `count` complete records are buffered, the process ends, or it errors. */
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

  /** Read the next `count` commits. `done: true` means there is no more history after this page. */
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
      .filter((c): c is CommitInfo => c !== null)
      .map((c) => this.enrich(c));

    const done = this.ended && remaining.length === 0;
    return { commits, done };
  }

  /**
   * Terminate the underlying git process. Always call this when done with a reader (or use
   * readAll/collect helpers that do it for you).
   *
   * specs/repo-open-feedback-fixes.md finding (security-reviewer + test-agent): aborts
   * `killController` (rather than only calling `child.kill()` directly, as this used to) so an
   * explicit `close()` — not just a caller-supplied `signal` aborting — gets the exact same
   * SIGTERM-then-`TIMEOUT_SIGKILL_GRACE_MS`-then-SIGKILL escalation every other cancellable git
   * invocation in this package gets (see `killController`'s own doc comment above). Safe to call
   * even before `ensureStarted()` has ever run (nothing spawned yet): aborting first just means
   * the eventual `spawnGit(..., { signal })` call receives an already-aborted signal and kills the
   * process immediately after spawning, same as any other already-aborted signal handed to
   * `child_process.spawn` — and safe to call more than once (idempotent: aborting an
   * already-aborted `AbortController` is a no-op).
   */
  close(): void {
    this.killController.abort();
    if (this.child && !this.child.killed) {
      this.child.kill();
    }
  }
}

/**
 * A `CommitPager` over an already-fetched, small, in-memory list of commits — used for the
 * SHA-lookup filter path (see findCommitsBySha), where results are always a handful of
 * commits rather than a history to stream, but callers still want the uniform paged shape.
 */
export class PrefetchedCommitPager implements CommitPager {
  private offset = 0;
  constructor(private readonly commits: readonly CommitInfo[]) {}

  async readPage(count: number): Promise<CommitLogPage> {
    if (count <= 0) throw new InvalidArgumentError("readPage count must be positive");
    const slice = this.commits.slice(this.offset, this.offset + count);
    this.offset += slice.length;
    return { commits: slice, done: this.offset >= this.commits.length };
  }

  close(): void {
    // Nothing to release — no child process.
  }
}

/**
 * specs/instant-tab-revisit.md FR-245: fast-forwards `pager` past `resumeAfter.skip` commits
 * in place, so the caller's next `readPage()` call on it returns exactly what page *two* of a
 * from-scratch reader would have. See `ResumeCommitLogFrom`'s doc comment (types.ts) for the
 * full contract this implements.
 *
 * Deliberately implemented purely against the public `CommitPager` interface (`readPage`) rather
 * than reaching into `CommitLogReader`'s internal stdout buffering: this makes the fast-forward
 * correct BY CONSTRUCTION — it consumes from the exact same record stream `readPage` itself would
 * have served, so there is no separate "skip" code path that could desync from the real one — and
 * it works uniformly for every `CommitPager` implementation (the live streaming
 * `CommitLogReader`, the tiny in-memory `PrefetchedCommitPager`), not just one of them.
 *
 * Throws `ReaderResumeMismatchError` — WITHOUT closing `pager` itself; that's the caller's job,
 * see `Repository.createCommitLogReader()` — if the walk ends before `resumeAfter.skip` commits
 * are found, or if the commit actually found at that position doesn't match
 * `resumeAfter.sha`. Never returns any commit data on a mismatch: a caller must not be able to
 * mistake a resumed reader's first post-mismatch page for genuinely-contiguous history.
 */
export async function fastForwardCommitPager(pager: CommitPager, resumeAfter: ResumeCommitLogFrom): Promise<void> {
  const { skip, sha } = resumeAfter;
  if (skip < 0) throw new InvalidArgumentError("resumeAfter.skip must not be negative");
  if (skip === 0) {
    // Nothing to fast-forward past. A zero-row cache is not a real fast-path-hit case in
    // practice (FR-242's cache is never eligible when empty), but this is still strictly correct
    // either way: nothing has been consumed yet, so there is nothing that could have desynced.
    return;
  }
  let consumed = 0;
  let lastSha: string | null = null;
  while (consumed < skip) {
    const page = await pager.readPage(skip - consumed);
    if (page.commits.length === 0) {
      throw new ReaderResumeMismatchError(skip, sha, consumed, lastSha);
    }
    consumed += page.commits.length;
    lastSha = page.commits[page.commits.length - 1]!.sha;
    if (page.done && consumed < skip) {
      throw new ReaderResumeMismatchError(skip, sha, consumed, lastSha);
    }
  }
  if (lastSha !== sha) {
    throw new ReaderResumeMismatchError(skip, sha, consumed, lastSha);
  }
}

/**
 * Direct SHA / SHA-prefix lookup (FR-7's SHA filter). This is intentionally NOT part of the
 * streaming `git log` walk: `git log <sha>` means "history starting FROM <sha>", which is a
 * different operation than "find the commit(s) whose SHA matches this prefix". We resolve
 * the prefix to candidate object ids via `rev-parse --disambiguate`, keep only commit objects,
 * and fetch their metadata directly — bounded work regardless of repo size.
 */
export async function findCommitsBySha(
  repoPath: string,
  shaOrPrefix: string,
  options: CreateCommitLogReaderOptions = {},
): Promise<CommitInfo[]> {
  if (!HEX_SHA_RE.test(shaOrPrefix)) {
    throw new InvalidArgumentError(`Not a valid hex SHA/prefix: ${JSON.stringify(shaOrPrefix)}`);
  }

  // specs/repo-open-feedback-fixes.md FR-197: threaded through every `runGit` call below —
  // options.signal (part of CreateCommitLogReaderOptions) is populated by `Repository.
  // createCommitLogReader()` from a still-in-flight cancellable `openRepo` attempt's own signal.
  // A caller cancellation must surface as `OperationCancelledError`, never be silently folded
  // into one of this function's own "not found"/"skip" fallbacks below.
  const signal = options.signal;

  let candidates: string[];
  if (shaOrPrefix.length === 40) {
    candidates = [shaOrPrefix.toLowerCase()];
  } else {
    try {
      const { stdout } = await runGit(["rev-parse", "--disambiguate=" + shaOrPrefix], { cwd: repoPath, signal });
      candidates = stdout.split("\n").map((s) => s.trim()).filter(Boolean);
    } catch (err) {
      if (err instanceof OperationCancelledError) throw err;
      candidates = [];
    }
  }
  if (candidates.length === 0) return [];

  // Candidate lists sharing an abbreviated prefix are always tiny (a handful at most), so a
  // per-candidate type check is simpler and cheap enough — no need for `cat-file --batch-check`.
  const commitShas: string[] = [];
  for (const oid of candidates) {
    try {
      const { stdout } = await runGit(["cat-file", "-t", oid], { cwd: repoPath, signal });
      if (stdout.trim() === "commit") commitShas.push(oid);
    } catch (err) {
      if (err instanceof OperationCancelledError) throw err;
      // not a valid/reachable object — skip.
    }
  }
  if (commitShas.length === 0) return [];

  const args = ["log", "--no-walk", `--format=${LOG_FORMAT}`, "--date=iso-strict", "--encoding=UTF-8"];
  args.push(...withEndOfOptions(commitShas));
  const { stdout } = await runGit(args, { cwd: repoPath, signal });

  const boundary = options.historyBoundary ?? new Set<string>();
  const refsBySha = options.refsBySha ?? new Map<string, RefDecoration[]>();
  const headSha = options.headSha ?? null;

  return stdout
    .split(RS)
    .slice(1)
    .map((r) => parseRecord(r, boundary))
    .filter((c): c is CommitInfo => c !== null)
    .map((c) => {
      const refs = [...(refsBySha.get(c.sha) ?? [])];
      if (headSha && c.sha === headSha) refs.unshift({ name: "HEAD", fullName: null, type: "head" });
      c.refs = refs;
      return c;
    });
}
