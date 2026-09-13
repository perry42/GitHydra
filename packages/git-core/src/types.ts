// SPDX-License-Identifier: GPL-3.0-or-later
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

/**
 * FR-58: rich, read-only detail for an in-progress merge, extending the bare `"merge"` tag from
 * `InProgressOperation`. `headSha`/`headSubject` are HEAD as of the conflict (the "ours" side —
 * FR-61 does not invert this mapping for a plain merge). `incomingRef` is parsed best-effort from
 * `MERGE_MSG`'s first line ("Merge branch '<name>'" / "Merge remote-tracking branch '<name>'" /
 * "Merge tag '<name>'" / "Merge commit '<name>'") — null when MERGE_MSG is missing or doesn't
 * match one of those forms (e.g. a custom merge message), never a guess.
 */
export interface MergeOperationDetail {
  kind: "merge";
  headSha: string | null;
  headSubject: string | null;
  mergeHeadSha: string;
  mergeHeadSubject: string | null;
  incomingRef: string | null;
}

/**
 * FR-58: rich, read-only detail for an in-progress rebase, from `rebase-merge/` (git's default
 * "merge" backend) or `rebase-apply/` (the `--apply`/am-based backend) state files.
 *
 * FR-61's "ours"/"theirs" inversion is a LABELING concern only, not a different stage lookup —
 * index stage 2 is always git's own literal `--ours` (HEAD at the paused step) and stage 3 is
 * always `--theirs` (the commit currently being replayed), for every operation kind. What changes
 * for a rebase is which human-meaningful side each stage corresponds to: stage 2 (HEAD) is the
 * `onto`/target branch's progress, and stage 3 is the user's own original commit being replayed
 * — the reverse of a plain merge, where stage 2 is "your branch" and stage 3 is "incoming".
 * `originalBranch`/`ontoSha`/`ontoRef` and the replayed commit (see `getConflictedFiles`'s use of
 * this type) are what a caller uses to build FR-61's concrete labels; this type itself carries no
 * label strings.
 */
export interface RebaseOperationDetail {
  kind: "rebase";
  /** Short branch name being rebased (from `head-name`), or null when rebasing a detached HEAD. */
  originalBranch: string | null;
  /** Null only in a defensively-corrupt `.git` state where the `onto` state file is missing/unparseable. */
  ontoSha: string | null;
  ontoSubject: string | null;
  /** Short ref name (branch/tag) pointing at `ontoSha`, when one exists on disk. Best-effort. */
  ontoRef: string | null;
  /** SHA of the commit currently being replayed (paused on conflict), when resolvable. */
  currentCommitSha: string | null;
  currentCommitSubject: string | null;
  /** 1-based current step, from `rebase-merge/msgnum` or `rebase-apply/next`. Null if unreadable. */
  currentStep: number | null;
  /** Total step count, from `rebase-merge/end` or `rebase-apply/last`. Null if unreadable. */
  totalSteps: number | null;
}

/**
 * FR-58: rich, read-only detail for an in-progress cherry-pick or revert.
 *
 * FR-105 extends this (specs/cherry-pick.md) with two fields sourced fresh from disk on EVERY
 * read, never cached — same convention `RepositoryState.inProgressOperationDetail` already
 * follows for everything else here (FR-74):
 *  - `isEmptyResult`: true when the paused step's diff is already fully reflected in `HEAD` —
 *    `WorkingDirectoryChanges.conflicted` is empty AND nothing is staged that this step needs
 *    committed. See `repository.ts`'s `computeCherryPickIsEmptyResult()` for the concrete
 *    detection, verified directly against real git's own empty-cherry-pick behavior.
 *  - `remainingAfterCurrent`: count of still-queued `pick` lines in `.git/sequencer/todo`,
 *    EXCLUDING the currently-paused step itself (git leaves the paused step's own `pick` line as
 *    `todo`'s first entry until it succeeds) — `null` when no sequencer state exists (a
 *    single-commit cherry-pick, which never creates `sequencer/` at all, or nothing in progress).
 *    Deliberately NOT a `currentStep`/`totalSteps` pair like `RebaseOperationDetail` — see
 *    specs/cherry-pick.md's "A sharp edge worth stating plainly" for why git's cherry-pick
 *    sequencer never persists an originally-requested total the way rebase's `end` file does.
 */
export interface CherryPickOperationDetail {
  kind: "cherry-pick";
  targetSha: string;
  targetSubject: string | null;
  isEmptyResult: boolean;
  remainingAfterCurrent: number | null;
}

export interface RevertOperationDetail {
  kind: "revert";
  targetSha: string;
  targetSubject: string | null;
}

/** `git am` (mailbox apply) — same on-disk shape as `rebase-apply`, minus the merge/rebase framing. */
export interface AmOperationDetail {
  kind: "am";
  currentStep: number | null;
  totalSteps: number | null;
}

/** Bisect is already typed by `InProgressOperation` but gets no detail object (see spec Non-goals: "no banner copy/actions in this pass"). */
export interface BisectOperationDetail {
  kind: "bisect";
}

export type InProgressOperationDetail =
  | MergeOperationDetail
  | RebaseOperationDetail
  | CherryPickOperationDetail
  | RevertOperationDetail
  | AmOperationDetail
  | BisectOperationDetail
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
  /**
   * FR-58: rich detail matching `inProgressOperation`'s kind, or null when there is none (or for
   * `"bisect"`, which intentionally carries a detail object with no further fields this pass).
   * Always read fresh from disk alongside `inProgressOperation` (FR-74) — never cached.
   */
  inProgressOperationDetail: InProgressOperationDetail;
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
 * specs/instant-tab-revisit.md FR-245: optional `Repository.createCommitLogReader()` argument
 * that fast-forwards a freshly-created reader past commits a caller already has from an
 * in-memory cache (e.g. a fast-path-reactivated tab's cached first page, `useRepositoryGraph.ts`),
 * so the reader's very first `readPage()` call returns exactly what page *two* of a from-scratch
 * reader would have — never re-serving a commit the caller already showed, never skipping one.
 *
 * `skip` and `sha` together (not `skip` alone) are what make this safe: fast-forwarding by count
 * alone would silently splice mismatched data onto the wrong position if the repo's history
 * changed underneath the cache between when it was captured and when this is called (should be
 * prevented by the caller's own fresh-comparison gate, but never trusted blindly here — see
 * `ReaderResumeMismatchError`). `skip` is normally the exact number of rows the caller's cache
 * holds (in practice always `PAGE_SIZE`, since a shorter cached page means `hasMore` was already
 * false and there is nothing to resume for); `sha` is the sha of the `skip`-th (last cached) row.
 */
export interface ResumeCommitLogFrom {
  /** Number of already-cached commits to fast-forward past before the first page is returned. */
  skip: number;
  /** The sha the caller's cache says is the `skip`-th commit (its last already-shown row) — the
   * fast-forward result is verified against this before any page is ever returned. */
  sha: string;
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

// ---------------------------------------------------------------------------------------------
// Image diff preview (specs/image-diff-preview.md, FR-139 through FR-143). See imageDiff.ts for
// the implementation these types describe.
// ---------------------------------------------------------------------------------------------

/**
 * FR-140: one side (old or new) of an image-eligible file's change, base64-encoded for direct use
 * in a `data:${mimeType};base64,${base64}` URI on the UI side — this module builds the
 * ingredients only, never the URI string itself. `mimeType` is derived from that side's own
 * qualifying extension (see `isImageEligiblePath()`), which can legitimately differ from the
 * other side's for a rename that also changed extension (e.g. `.png` renamed to `.jpg`).
 */
export interface ImageBlob {
  base64: string;
  byteSize: number;
  mimeType: string;
}

/**
 * FR-140/FR-141: image-specific counterpart to `FileDiffResult`, for a file `isImageEligiblePath()`
 * (FR-139) says is image-eligible. `old`/`new` are independently `null` exactly when that side of
 * the change doesn't exist (an added file: `old` is null; a deleted file: `new` is null) — never
 * both `null` for a genuine change. FR-141's 25MB-per-side size guard is checked before either
 * side's bytes are read/base64-encoded, so `"too-large"` never carries partial content for either
 * side, even the one that was actually small enough.
 */
export type ImageDiffResult =
  | { status: "ok"; old: ImageBlob | null; new: ImageBlob | null }
  | { status: "too-large"; side: "old" | "new" | "both" };

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

/**
 * FR-33: one local branch as returned by `listBranches()`. Ahead/behind and upstream fields
 * reflect the state of the remote-tracking ref already on disk as of the last fetch performed
 * outside GitHydra (FR-45/FR-57) — never live, never triggers network access.
 */
export interface LocalBranchInfo {
  /** Short name, e.g. "main". */
  name: string;
  /** Fully qualified ref, e.g. "refs/heads/main". */
  fullName: string;
  tipSha: string;
  tipSubject: string;
  tipAuthorName: string;
  tipAuthorEmail: string;
  /** ISO 8601 strict, original author timezone offset. */
  tipAuthorDate: string;
  /** ISO 8601 strict, original committer timezone offset. */
  tipCommitterDate: string;
  /** True if this is the branch HEAD currently resolves to, in the worktree `listBranches()` was called against. */
  isCurrent: boolean;
  /**
   * Absolute path of the *other* worktree this branch is checked out in, cross-referenced
   * against `git worktree list --porcelain` (FR-33). Null when not checked out elsewhere.
   * (A branch can also be checked out in the *current* worktree — that's `isCurrent`, not this.)
   */
  checkedOutInWorktree: string | null;
  /** Configured upstream's short name (e.g. "origin/main"), or null if none is configured. */
  upstreamName: string | null;
  /** True when an upstream is configured but its remote-tracking ref no longer exists on disk (git's "gone"). */
  upstreamGone: boolean;
  /** Commits on this branch not reachable from its upstream. Null when there is no usable upstream. */
  ahead: number | null;
  /** Commits on the upstream not reachable from this branch. Null when there is no usable upstream. */
  behind: number | null;
}

/** FR-34: one remote-tracking branch as returned by `listRemoteBranches()`. */
export interface RemoteBranchInfo {
  /** Short name without the remote prefix, e.g. "feature-x" for "origin/feature-x". */
  name: string;
  /** Fully qualified ref, e.g. "refs/remotes/origin/feature-x". */
  fullName: string;
  remoteName: string;
  tipSha: string;
  tipSubject: string;
  tipAuthorName: string;
  tipAuthorEmail: string;
  tipAuthorDate: string;
  tipCommitterDate: string;
}

/** FR-35/36/37: input for `createBranch()`. */
export interface CreateBranchOptions {
  /** Validated with `git check-ref-format --branch` before any mutating call (FR-35). */
  name: string;
  /**
   * Local branch, remote-tracking branch, tag, or raw commit SHA. Defaults to HEAD when
   * omitted. On an unborn-HEAD (zero-commit) repo with no explicit `startPoint`, the
   * underlying `git branch`/`git switch -c` call itself fails (surfaced as a plain
   * `GitCommandError`, since git has no HEAD commit to default to) — there is no separate
   * typed error for this; callers should check `RepositoryState.isUnbornHead` up front instead
   * (matches the empty-repo handling `commit-graph.md` already established).
   */
  startPoint?: string;
  /** FR-36: switch the working tree to the new branch as part of the same call (`git switch -c`). */
  switchToIt?: boolean;
  /**
   * FR-37: explicitly force (`true`) or suppress (`false`) tracking of a remote-tracking
   * start point. Leave undefined to let `createBranch` auto-detect: when `startPoint` resolves
   * to a remote-tracking ref, tracking is wired automatically; otherwise no tracking flag is
   * passed (git's own default behavior applies).
   */
  track?: boolean;
}

export interface CreateBranchResult {
  name: string;
  fullName: string;
  /** The new branch's tip commit SHA (equal to the resolved start point). */
  sha: string;
  /** True if the working tree's HEAD was moved to the new branch as part of this call. */
  switched: boolean;
}

/** FR-38/39: result of switching HEAD (to a branch, or detached to a commit-ish). */
export interface SwitchResult {
  /** The commit SHA HEAD now resolves to. */
  sha: string;
}

// ---------------------------------------------------------------------------------------------
// Merge/rebase conflict resolution (specs/merge-rebase-conflict-resolution.md, FR-58 through
// FR-80). See conflicts.ts for the implementation these types describe.
// ---------------------------------------------------------------------------------------------

/**
 * FR-63: which index stages (1 = common ancestor, 2 = "ours"/HEAD-at-conflict, 3 =
 * "theirs"/incoming) are present for a conflicted path, taken directly from git's own
 * `git status`/`ls-files -u` XY vocabulary rather than re-derived. Both-added/both-deleted are
 * included alongside the spec's four named categories (both-modified, added-by-us/them,
 * deleted-by-us/them) because they are real, reachable combinations `git ls-files -u` reports —
 * a path with only a common-ancestor stage (both sides deleted it, e.g. as part of a rename
 * elsewhere) must still be classified as *something*, not silently dropped or miscategorized as
 * one of the other six.
 */
export type ConflictStageCombination =
  | "both-modified"
  | "added-by-us"
  | "added-by-them"
  | "both-added"
  | "deleted-by-us"
  | "deleted-by-them"
  | "both-deleted";

/** One present index stage's blob/gitlink metadata for a conflicted path. */
export interface ConflictStageEntry {
  /** Blob SHA (or, for a submodule gitlink, the recorded commit SHA) at this stage. */
  sha: string;
  /** Octal file mode as git reports it, e.g. "100644", "100755", "120000" (symlink), "160000" (submodule gitlink). */
  mode: string;
}

/**
 * FR-79: one side's rename contribution to a rename conflict (rename/rename or rename/modify),
 * detected by diffing the merge-base against each side with rename detection enabled and
 * filtering to paths that also appear in the conflicted-file list. Best-effort: absent (the
 * conflicted file's `rename` field is null) when a merge-base can't be resolved (e.g. an
 * unrelated-histories merge) or neither side shows a rename touching this path.
 */
export interface ConflictRenameSide {
  /**
   * Which side performed this rename, in FR-61's stage terms (stage 2 = "ours"/HEAD-at-conflict,
   * stage 3 = "theirs"/incoming) — see `ConflictSideLabels` for the human-facing label to pair
   * this with, resolved separately per operation kind.
   */
  side: "ours" | "theirs";
  oldPath: string;
  newPath: string;
  similarity?: number;
}

/**
 * FR-63/FR-77/FR-78/FR-79/FR-80: one conflicted path's classification and raw stage content,
 * everything a caller needs to decide which resolution UI to render. Content itself (for FR-64's
 * comparison view) is fetched separately via `getConflictFileDiff()` — this type only carries
 * metadata (blob SHAs/modes), never inlined file content, keeping this cheap to compute for every
 * conflicted path up front.
 */
export interface ConflictedFileInfo {
  path: string;
  stageCombination: ConflictStageCombination;
  /** FR-77: true when any present stage's mode is the submodule gitlink mode (160000) — render as three candidate SHAs, no text diff, whole-file accept-ours/accept-theirs only. */
  isSubmodule: boolean;
  /** FR-80: true when content-sniffing (numstat) finds this an undiffable binary file on whichever stage(s) exist — whole-file accept-ours/accept-theirs only, no marker-based resolution path. */
  isBinary: boolean;
  /** FR-79: non-null when this path participates in a detected rename conflict on at least one side. */
  rename: ConflictRenameSide[] | null;
  /** Stage 1 (common ancestor). Null for an add/add or both-deleted-shaped combination that has no base. */
  base: ConflictStageEntry | null;
  /** Stage 2 — always git's own literal "ours"/HEAD-at-conflict (FR-61; see `RebaseOperationDetail`'s doc comment for why this is a fixed stage regardless of operation kind). Null for a deleted-by-us combination. */
  ours: ConflictStageEntry | null;
  /** Stage 3 — always git's own literal "theirs"/incoming-being-applied. Null for a deleted-by-them combination. */
  theirs: ConflictStageEntry | null;
}

/** FR-61: a labeled side of a conflict — UI must always show this, never the bare words "ours"/"theirs". */
export interface ConflictSideLabel {
  /** Human-readable label, e.g. "Your branch (feature-x @ a1b2c3d)" or "Incoming (main @ d4e5f6a)". */
  label: string;
  /** Short ref/branch name backing this side, when resolvable. Null for a detached HEAD, a raw-SHA merge, etc. */
  refName: string | null;
  /** The commit SHA this side corresponds to, when known. */
  sha: string | null;
}

/**
 * FR-61: concrete labels for index stage 2 ("ours") and stage 3 ("theirs") for the CURRENT
 * in-progress operation. Computed once per operation (not per file) via
 * `computeConflictSideLabels()` in conflicts.ts, since the mapping is the same for every
 * conflicted path in a given operation.
 */
export interface ConflictSideLabels {
  ours: ConflictSideLabel;
  theirs: ConflictSideLabel;
}

/**
 * FR-64: three-way (or two-way, when a stage is absent) comparison content for one conflicted
 * file, reusing `FileDiffResult`'s existing binary/too-large/ok shape so the UI's `DiffView`
 * needs no new rendering path. Each field is null when the underlying stage pair isn't both
 * present (e.g. `baseToOurs` is null for an add/add conflict, which has no base stage).
 */
export interface ConflictFileDiff {
  /** Stage 1 -> stage 2 ("ours"). */
  baseToOurs: FileDiffResult | null;
  /** Stage 1 -> stage 3 ("theirs"). */
  baseToTheirs: FileDiffResult | null;
  /** Stage 2 -> stage 3, direct ours/theirs comparison — always computed when both stages exist, in addition to the base-relative diffs above. */
  oursToTheirs: FileDiffResult | null;
}

/** FR-66: result of scanning a working-tree file for literal, unresolved conflict marker lines. */
export interface ConflictMarkerScanResult {
  hasMarkers: boolean;
  /** 1-based line numbers where a marker (`<<<<<<<`, `=======`, `>>>>>>>`, or diff3's `|||||||`) was found. */
  markerLines: number[];
}

// ---------------------------------------------------------------------------------------------
// Stash (specs/stash.md, FR-81 through FR-92). See stash.ts for the implementation these types
// describe.
// ---------------------------------------------------------------------------------------------

/**
 * FR-81: one entry from `git stash list`, read fresh from disk on every call — no cached
 * authoritative copy, same convention every other list-style function in this module follows.
 */
export interface StashInfo {
  /** The `N` in `stash@{N}` — 0 is always the most recently created stash. */
  index: number;
  /** Fully qualified stash reference, e.g. "stash@{0}". */
  ref: string;
  /** The stash commit's own SHA. */
  sha: string;
  /**
   * git's own default message ("WIP on <branch>: <sha> <subject>", or "WIP on (no branch): ..."
   * for a detached-HEAD stash) verbatim, OR — when this stash was created with a custom message
   * (`-m`) — that custom message exactly as supplied, with git's "On <branch>: " wrapper stripped
   * back out. See `parseStashSubject()` in stash.ts for the exact parsing rule.
   */
  message: string;
  /**
   * Branch this stash was created on, parsed from git's own default message only. Null for a
   * custom message (never parsed out, by this module's contract — see `message` above) or for a
   * stash created from a detached HEAD.
   */
  branch: string | null;
  /** ISO 8601 strict creation date/time. */
  date: string;
  /** The commit this stash was created against (its first parent, i.e. pre-stash HEAD). Null only in a defensively-corrupt state where no parent could be parsed. */
  parentSha: string | null;
}

/** FR-84: input for `createStash()`. */
export interface CreateStashOptions {
  /** Optional custom message. Empty/omitted uses git's own default "WIP on ..." message. */
  message?: string;
  /**
   * Explicit subset of currently-changed paths to stash (file-level only — see the spec's
   * "Non-goals: hunk-level partial stash"). Omitted/empty stashes every eligible changed path. A
   * requested path that is currently conflicted, already clean, or (when `includeUntracked` is
   * false) untracked is silently excluded rather than erroring per-path (mirrors
   * `stageAllFiles()`'s tolerant-enumeration convention in `staging.ts`) — the call only fails
   * (`NothingEligibleToStashError`) when every requested path ends up excluded this way.
   */
  paths?: string[];
  /** `git stash push --include-untracked`. Defaults to false, matching git's own default. */
  includeUntracked?: boolean;
}

export interface CreateStashResult {
  ref: string;
  sha: string;
}

/**
 * FR-85/FR-86/FR-87: outcome of `applyStash()`/`popStash()`. A conflict is detected the same way
 * every other conflict in this module is — a fresh `getWorkingDirectoryChanges().conflicted`
 * read, live index-stage state, never operation-type detection — NOT by fabricating an
 * in-progress-operation state. See stash.ts's module doc comment for why that distinction matters
 * specifically for stash (a stash-apply/pop conflict produces no `MERGE_HEAD`-equivalent state at
 * all, unlike merge/rebase/cherry-pick/revert).
 */
export type StashApplyOutcome =
  | { status: "applied" }
  | { status: "conflict"; conflictedPaths: string[] };

/** FR-83: one file a stash would change if applied, with its diff content inline. */
export interface StashDiffFile {
  /** Current path (for renames/copies, the new path). */
  path: string;
  /** Previous path, only set for renames/copies. */
  oldPath?: string;
  status: ChangedFile["status"];
  /** Similarity percentage for renames/copies (0-100), when git reports one. */
  similarity?: number;
  /** True when this file was captured as an untracked file (`--include-untracked`) rather than being an ordinarily tracked change. */
  isUntracked: boolean;
  diff: FileDiffResult;
}

/** FR-83: the full set of files one stash would change, with diff content per file computed up front (never touches the working tree or index). */
export interface StashDiffResult {
  files: StashDiffFile[];
}

// ---------------------------------------------------------------------------------------------
// Blame & file history (specs/blame.md, FR-123 through FR-130). See blame.ts for the
// implementation these types describe.
// ---------------------------------------------------------------------------------------------

/**
 * FR-124/FR-126/FR-127: one blamed line's commit attribution, parsed from `git blame
 * --porcelain`'s per-record metadata block.
 */
export interface BlameCommitInfo {
  /** Full 40-hex commit SHA, or the all-zero SHA for an uncommitted line (see `isUncommitted`). */
  sha: string;
  /** First 7 hex characters of `sha` — porcelain output doesn't carry a separate abbreviation, so this is computed locally, same fallback `commitLog.ts`'s `parseRecord()` uses. */
  abbrevSha: string;
  /** FR-126: git's own literal "Not Committed Yet" string when `isUncommitted` is true — passed through, never reworded. */
  authorName: string;
  /** FR-126: git's own literal "not.committed.yet" for an uncommitted line — passed through, never reworded. */
  authorEmail: string;
  /** ISO 8601 strict, in the original author timezone offset — reconstructed from porcelain's separate `author-time`/`author-tz` fields the same way `commitLog.ts`'s `--date=iso-strict` values are shaped, so both line up for a caller comparing them. For an uncommitted line this is git's own literal current-time snapshot, not a real commit date (FR-126: never treated as real commit metadata by the UI). */
  authorDate: string;
  /** The commit's subject line (empty string for an uncommitted line — porcelain gives no summary for one). */
  summary: string;
  /**
   * FR-127: true for a shallow-clone / grafted history boundary commit, mirroring
   * `CommitInfo.isHistoryBoundary` — the UI must render this differently from a genuine root
   * commit, never silently as one. Always false for an uncommitted line.
   */
  isBoundary: boolean;
  /**
   * FR-126: true when this line has no real commit — a working-tree edit that hasn't been
   * committed yet. `sha` is porcelain's real all-zero boundary SHA in this case (never a
   * synthesized `CommitInfo`); `authorName`/`authorEmail` are git's own literal placeholder text.
   */
  isUncommitted: boolean;
}

/** FR-124: one line of a blamed file. */
export interface BlameLine {
  /** Line content, with no trailing newline. */
  content: string;
  /** 1-based line number in the blamed revision's version of the file. */
  lineNumber: number;
  commit: BlameCommitInfo;
}

/** FR-124: a normal, renderable blame result. */
export interface OkBlameResult {
  status: "ok";
  lines: BlameLine[];
}

/** FR-124/FR-125: no line-level attribution is produced for a binary file. */
export interface BinaryBlameResult {
  status: "binary";
}

/** FR-124/FR-125: the file exceeded the byte-size guard before `git blame`'s full run was ever invoked. */
export interface TooLargeBlameResult {
  status: "too-large";
  reason: "file-size";
  fileSizeBytes: number;
}

/** FR-124: the file does not exist at the requested revision (or, for `revision: null`, in the current working tree). */
export interface NotFoundBlameResult {
  status: "not-found";
}

/** FR-124: a valid, zero-length file — a real state, not an error. */
export interface EmptyBlameResult {
  status: "empty";
}

/**
 * FR-124: discriminated blame result, mirroring `FileDiffResult`'s existing binary/too-large/ok
 * convention (see `diff.ts`) so `BlamePanel` can reuse the same non-content-state rendering
 * pattern `DiffView` already established.
 */
export type BlameResult =
  | OkBlameResult
  | BinaryBlameResult
  | TooLargeBlameResult
  | NotFoundBlameResult
  | EmptyBlameResult;
