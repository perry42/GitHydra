import type { GitChildProcess } from "./gitProcess";
import { spawnGit, runGit, withEndOfOptions, optionEquals } from "./gitProcess";
import { GitCommandError, InvalidArgumentError } from "./errors";
import type { CommitInfo, CommitLogFilter, CommitLogPage, RefDecoration } from "./types";

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
  private started = false;

  constructor(repoPath: string, filter: CommitLogFilter | undefined, options: CreateCommitLogReaderOptions = {}) {
    this.repoPath = repoPath;
    this.refsBySha = options.refsBySha ?? new Map();
    this.headSha = options.headSha ?? null;
    this.historyBoundary = options.historyBoundary ?? new Set();

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
      this.errored = new GitCommandError(`Failed to run git log: ${err.message}`, this.args, null, "");
    });
    child.on("close", (code) => {
      this.ended = true;
      if (code !== null && code !== 0 && !this.errored) {
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

  /** Terminate the underlying git process. Always call this when done with a reader (or use readAll/collect helpers that do it for you). */
  close(): void {
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

  let candidates: string[];
  if (shaOrPrefix.length === 40) {
    candidates = [shaOrPrefix.toLowerCase()];
  } else {
    try {
      const { stdout } = await runGit(["rev-parse", "--disambiguate=" + shaOrPrefix], { cwd: repoPath });
      candidates = stdout.split("\n").map((s) => s.trim()).filter(Boolean);
    } catch {
      candidates = [];
    }
  }
  if (candidates.length === 0) return [];

  // Candidate lists sharing an abbreviated prefix are always tiny (a handful at most), so a
  // per-candidate type check is simpler and cheap enough — no need for `cat-file --batch-check`.
  const commitShas: string[] = [];
  for (const oid of candidates) {
    try {
      const { stdout } = await runGit(["cat-file", "-t", oid], { cwd: repoPath });
      if (stdout.trim() === "commit") commitShas.push(oid);
    } catch {
      // not a valid/reachable object — skip.
    }
  }
  if (commitShas.length === 0) return [];

  const args = ["log", "--no-walk", `--format=${LOG_FORMAT}`, "--date=iso-strict", "--encoding=UTF-8"];
  args.push(...withEndOfOptions(commitShas));
  const { stdout } = await runGit(args, { cwd: repoPath });

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
