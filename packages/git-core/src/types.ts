/** Public data model shared across the git-core module and its consumers (UI layer). */

export type RefType = "local-branch" | "remote-branch" | "tag" | "head";

export interface RefDecoration {
  /** Short display name, e.g. "main", "origin/main", "v1.2.0". */
  name: string;
  /** Fully qualified ref, e.g. "refs/heads/main". null for the synthetic HEAD decoration. */
  fullName: string | null;
  type: RefType;
  /** True for an annotated tag (target already dereferenced to the commit it points at). */
  isAnnotatedTag?: boolean;
  /** True when this ref is itself a symbolic ref (e.g. refs/remotes/origin/HEAD -> origin/main). */
  isSymbolic?: boolean;
}

/** A ref as read from the repo, independent of any particular commit. */
export interface RefInfo {
  fullName: string;
  shortName: string;
  type: Exclude<RefType, "head">;
  /** The commit SHA this ref ultimately points at (tags are dereferenced to their target commit). */
  targetCommitSha: string;
  isAnnotatedTag: boolean;
  isSymbolic: boolean;
  /** Only set for remote-tracking branches, e.g. "origin". */
  remoteName?: string;
}

export interface CommitInfo {
  sha: string;
  abbrevSha: string;
  /** Full parent SHAs, in parent order. Empty for a root commit. 2 for a normal merge, 3+ for octopus. */
  parents: string[];
  authorName: string;
  authorEmail: string;
  /** ISO 8601 strict, in the original author timezone offset. */
  authorDate: string;
  committerName: string;
  committerEmail: string;
  /** ISO 8601 strict, in the original committer timezone offset. */
  committerDate: string;
  subject: string;
  body: string;
  /** subject + "\n\n" + body, trimmed — convenience for callers that just want "the message". */
  message: string;
  /** Refs (branches/tags/HEAD) that point directly at this commit. Populated by the caller that has ref context. */
  refs: RefDecoration[];
  /**
   * True if this commit is a shallow-clone / grafted history boundary: it has no parents
   * in this repo's object database even though it is not a true root commit upstream.
   * The UI must render this differently from a genuine root (FR-4 / edge cases: shallow clones).
   */
  isHistoryBoundary: boolean;
}

export type InProgressOperation =
  | "merge"
  | "rebase"
  | "am"
  | "cherry-pick"
  | "revert"
  | "bisect"
  | null;

export interface RepositoryState {
  /** Absolute, resolved path to the repo's git dir (per-worktree: contains HEAD, index, MERGE_HEAD, etc). */
  gitDir: string;
  /** Absolute path to the git dir shared across worktrees (contains refs/, objects/, packed-refs). */
  commonGitDir: string;
  /** Working tree root, or null for a bare repository. */
  workdir: string | null;
  isBare: boolean;
  isShallow: boolean;
  /** True if this git dir belongs to a linked worktree rather than the main working tree. */
  isWorktree: boolean;
  /** True when there are zero commits reachable from any ref (fresh `git init`). */
  isEmpty: boolean;
  /** True when HEAD is a symbolic ref to a branch that has no commits yet. */
  isUnbornHead: boolean;
  /** True when HEAD does not point at a branch tip (checked out a commit/tag/arbitrary SHA directly). */
  isDetachedHead: boolean;
  /** Branch short name if HEAD is attached to a branch (born or unborn), else null. */
  currentBranch: string | null;
  /** The commit HEAD currently resolves to, or null if unborn/empty. */
  headSha: string | null;
  inProgressOperation: InProgressOperation;
}

export interface ChangedFile {
  /** Current path (for renames/copies, the new path). */
  path: string;
  /** Previous path, only set for renames/copies. */
  oldPath?: string;
  status:
    | "added"
    | "modified"
    | "deleted"
    | "renamed"
    | "copied"
    | "type-changed"
    | "unmerged"
    | "unknown";
  /** Similarity percentage for renames/copies (0-100), when git reports one. */
  similarity?: number;
}

export interface CommitLogFilter {
  /**
   * Restrict to specific refs/revisions (branch names, tags, SHAs) instead of the full `--all` ref graph.
   * Defaults to every local branch, remote-tracking branch, tag, and HEAD (FR-1).
   */
  refs?: string[];
  /** Substring match against "Name <email>" (git's --author). */
  author?: string;
  /** Substring match against the full commit message (git's --grep, fixed-string). */
  messageSubstring?: string;
  /** Case-insensitive message/author search. Defaults to true (search-bar friendly). */
  caseInsensitive?: boolean;
  /** Full (40-char) or abbreviated (>=4 char) hex commit SHA. When set, all other filters are ignored — see docs. */
  sha?: string;
  /** ISO 8601 date/time or any string git's --since accepts. */
  dateFrom?: string;
  /** ISO 8601 date/time or any string git's --until accepts. */
  dateTo?: string;
  /** Only commits that touched this path (or one of these paths). */
  paths?: string[];
}

export interface CommitLogPage {
  commits: CommitInfo[];
  /** True if there is no more history to read after this page. */
  done: boolean;
}

/**
 * Working-tree status counts, derived from `git status --porcelain=v1 --untracked-files=all`
 * (FR-18's uncommitted-changes pseudo-node). Shape matches `packages/desktop/shared/ipcContract.ts`'s
 * `WorkingDirectoryStatus` exactly so the desktop package can consume this type directly.
 */
export interface WorkingDirectoryStatus {
  /** True if staged + unstaged + untracked + conflicted > 0. */
  hasChanges: boolean;
  /** Count of paths with a staged (index vs HEAD) change. */
  staged: number;
  /** Count of paths with an unstaged (worktree vs index) change. */
  unstaged: number;
  /** Count of untracked paths. */
  untracked: number;
  /** Count of paths with an unresolved merge conflict. */
  conflicted: number;
}

/** Which working-directory bucket a `WorkingDirectoryFileChange` belongs to (FR-19). */
export type FileChangeCategory = "staged" | "unstaged" | "untracked" | "conflicted";

/**
 * A single path's working-directory change (FR-19), one level more detailed than
 * `WorkingDirectoryStatus`'s counts. The same path can appear in both a `staged` and an
 * `unstaged` entry (staged one edit, then edited again) — each is reported independently.
 */
export interface WorkingDirectoryFileChange {
  /** Current path (for renames/copies, the new path). */
  path: string;
  /** Previous path — only set for a `staged`/`unstaged` entry that git detected as a rename/copy. */
  oldPath?: string;
  /** Same status vocabulary as `ChangedFile`. Conflicted entries are always reported as "unmerged". */
  status: ChangedFile["status"];
  category: FileChangeCategory;
  /** Similarity percentage for renames/copies (0-100), when git reports one. */
  similarity?: number;
}

/**
 * Per-file working-directory change list (FR-19), split the same way `WorkingDirectoryStatus`'s
 * counts are. Conflicted paths (FR-27) are always their own category, never mixed into
 * `staged`/`unstaged`, and are not derived from `RepositoryState.inProgressOperation` — they're
 * read directly from `git status`, which stays correct even in less common cases (e.g. a
 * conflict left over after `git rebase --continue`, before the rebase itself finishes).
 */
export interface WorkingDirectoryChanges {
  staged: WorkingDirectoryFileChange[];
  unstaged: WorkingDirectoryFileChange[];
  untracked: WorkingDirectoryFileChange[];
  conflicted: WorkingDirectoryFileChange[];
}

/** One line of a unified diff hunk (FR-20). */
export type DiffLineType = "context" | "add" | "remove";

export interface DiffLine {
  type: DiffLineType;
  /** Line content, without the leading unified-diff marker character (' ', '+', or '-'). */
  content: string;
  /** 1-based line number in the old (before) version, or null for an added line. */
  oldLineNumber: number | null;
  /** 1-based line number in the new (after) version, or null for a removed line. */
  newLineNumber: number | null;
}

export interface DiffHunk {
  /** Raw hunk header, e.g. "@@ -12,6 +12,8 @@ someFunction() {". */
  header: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
}

/** A normal, renderable text diff (FR-20). */
export interface TextFileDiff {
  status: "ok";
  isBinary: false;
  hunks: DiffHunk[];
}

/** FR-21: no line-level patch is produced for a binary file. */
export interface BinaryFileDiff {
  status: "binary";
  isBinary: true;
}

/** FR-22: the diff exceeded a size guard before a full patch was ever generated. */
export interface TooLargeFileDiff {
  status: "too-large";
  isBinary: false;
  reason: "changed-lines" | "file-size";
  /** Total added+removed line count, when `reason` is "changed-lines". */
  changedLineCount?: number;
  /** Size in bytes of the larger side of the diff, when `reason` is "file-size". */
  fileSizeBytes?: number;
}

export type FileDiffResult = TextFileDiff | BinaryFileDiff | TooLargeFileDiff;

export interface DiffOptions {
  /** Guard threshold for FR-22. Default 5000. */
  maxChangedLines?: number;
  /** Guard threshold for FR-22, in bytes. Default 2 * 1024 * 1024 (2MB). */
  maxFileSizeBytes?: number;
  /** Unified-diff context line count. Default 3 (git's own default), passed explicitly so
   * behavior doesn't depend on the user's local `diff.context` git config. */
  contextLines?: number;
}

/** FR-25: create-commit input. */
export interface CreateCommitOptions {
  /** Commit subject line. Required, non-empty after trimming. */
  subject: string;
  /** Optional commit body, separated from the subject by a blank line (standard git convention). */
  body?: string;
}

export interface CreateCommitResult {
  sha: string;
}
