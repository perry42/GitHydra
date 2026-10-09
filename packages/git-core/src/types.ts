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
  /** True for a symbolic ref. Always unset/false here: `listRefs()` excludes symrefs (e.g. a remote's `HEAD` alias); `RefInfo.isSymbolic` keeps the real value. */
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
 * FR-58: detail for an in-progress merge. `headSha`/`headSubject` are HEAD at the conflict ("ours";
 * FR-61 doesn't invert this for a merge). `incomingRef` is parsed best-effort from `MERGE_MSG`'s first
 * line ("Merge branch|remote-tracking branch|tag|commit '<name>'"); null if missing or unmatched, never a guess.
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
 * FR-58: detail for an in-progress rebase, from `rebase-merge/` or `rebase-apply/` state files.
 *
 * FR-61's ours/theirs inversion is labeling only: stage 2 is always git's literal `--ours` (HEAD at
 * the paused step) and stage 3 is `--theirs` (the commit being replayed) for every operation. For a
 * rebase that makes stage 2 the onto/target side and stage 3 the user's own commit, the reverse of a
 * merge. This type carries no label strings; callers build them from `originalBranch`/`ontoSha`/
 * `ontoRef` and the replayed commit.
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
 * FR-58: detail for an in-progress cherry-pick. FR-105 (specs/cherry-pick.md) fields are read fresh
 * from disk on every call, never cached (FR-74):
 *  - `isEmptyResult`: the paused step's diff is already in `HEAD` (no conflicts, nothing staged to
 *    commit); see `computeCherryPickIsEmptyResult()` in `repository.ts`.
 *  - `remainingAfterCurrent`: queued `pick` lines in `.git/sequencer/todo` excluding the paused step;
 *    null with no sequencer state (single-commit pick or nothing in progress). No total like rebase's
 *    because git's cherry-pick sequencer never persists one (specs/cherry-pick.md "A sharp edge worth
 *    stating plainly").
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
  /** FR-58: detail matching `inProgressOperation`, or null when none (and for `"bisect"`, which has no extra fields). Read fresh from disk (FR-74), never cached. */
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
 * specs/instant-tab-revisit.md FR-245: optional `createCommitLogReader()` argument that fast-forwards a
 * new reader past commits the caller already has cached, so its first `readPage()` returns what page
 * two of a fresh reader would.
 *
 * `skip` and `sha` together keep this safe: skipping by count alone could splice mismatched data if
 * history changed under the cache, so the result is verified against `sha` (see
 * `ReaderResumeMismatchError`). `skip` is normally `PAGE_SIZE` (a shorter cached page means nothing to resume).
 */
export interface ResumeCommitLogFrom {
  /** Number of already-cached commits to fast-forward past before the first page is returned. */
  skip: number;
  /** The sha of the `skip`-th (last cached) commit; the fast-forward result is verified against it before any page is returned. */
  sha: string;
}

/**
 * Working-tree status counts from `git status --porcelain=v1 --untracked-files=all` (FR-18). Shape
 * matches `packages/desktop/shared/ipcContract.ts`'s `WorkingDirectoryStatus`.
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
 * A single path's working-directory change (FR-19). The same path can appear as both `staged` and
 * `unstaged` (edited again after staging); each is reported independently.
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
 * Per-file change list (FR-19), split like `WorkingDirectoryStatus`. Conflicted paths (FR-27) are their
 * own category, read from `git status` rather than `inProgressOperation`, so they stay correct in edge
 * cases (e.g. a conflict left after `rebase --continue`).
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

/** specs/hunk-line-staging.md FR-452: why a file's diff cannot be staged/unstaged/discarded in part. */
export type PartialStagingIneligibleReason =
  | "untracked"
  | "added"
  | "deleted"
  | "renamed"
  | "mode-change"
  | "type-change"
  | "symlink"
  | "binary"
  | "too-large"
  | "submodule"
  | "conflicted"
  | "non-utf8"
  | "no-changes"
  | "not-a-file"
  /** specs/hunk-line-staging.md FR-481: combined view only; per-line staged state could not be proven exactly. */
  | "ambiguous";

export type PartialStagingEligibility = { eligible: true } | { eligible: false; reason: PartialStagingIneligibleReason };

/**
 * specs/hunk-line-staging.md FR-479: one line of the combined (HEAD vs worktree) diff. `staged` and
 * `discardable` are only meaningful for add/remove lines; context lines always carry false/false.
 * - add: `staged` = the line is in the index; unstaged = it exists only in the worktree.
 * - remove: `staged` = the deletion is in the index; unstaged = the line is still in the index but
 *   gone from the worktree.
 * - `discardable` = unstaged (discard only touches worktree-vs-index state). A staged line that was edited
 *   again in the worktree leaves an index-only line the combined diff cannot show, so such a file is
 *   reported as `separate`/"ambiguous" instead and nothing in it is offered for discard.
 */
export interface CombinedDiffLine extends DiffLine {
  staged: boolean;
  discardable: boolean;
}

export interface CombinedDiffHunk extends Omit<DiffHunk, "lines"> {
  lines: CombinedDiffLine[];
  /** none = no changed line staged, all = every changed line staged, else some (the UI's mixed dash). */
  stagedState: "none" | "some" | "all";
}

/** FR-479/481: either the combined view, or the caller must fall back to separate Staged/Unstaged diffs. */
export type CombinedFileDiffResult =
  | {
      mode: "combined";
      hunks: CombinedDiffHunk[];
      /** FR-449: covers HEAD blob id, index blob id, worktree bytes hash and `contextLines`. Send it back with every selection. */
      fingerprint: string;
    }
  | { mode: "separate"; reason: PartialStagingIneligibleReason };

/** Addresses one line of a combined diff: index into `hunks`, then into that hunk's `lines`. */
export interface CombinedLineRef {
  hunkIndex: number;
  lineIndex: number;
}

/** A normal, renderable text diff (FR-20). */
export interface TextFileDiff {
  status: "ok";
  isBinary: false;
  hunks: DiffHunk[];
  /**
   * specs/hunk-line-staging.md FR-449: sha256 of the raw diff bytes; only set for unstaged/staged
   * sources. Send it back with the selection so a changed file is refused, not re-mapped.
   */
  fingerprint?: string;
  /** FR-452: whether hunk/line operations apply; only set for unstaged/staged sources. */
  partialStaging?: PartialStagingEligibility;
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

// Image diff preview (specs/image-diff-preview.md, FR-139 through FR-143); see imageDiff.ts.

/**
 * FR-140: one side of an image change, base64-encoded for a `data:${mimeType};base64,${base64}` URI
 * (built UI-side). `mimeType` comes from that side's own extension (see `isImageEligiblePath()`), so it
 * can differ across a rename that changed extension.
 */
export interface ImageBlob {
  base64: string;
  byteSize: number;
  mimeType: string;
}

/**
 * FR-140/FR-141: image counterpart to `FileDiffResult` for `isImageEligiblePath()` files (FR-139).
 * `old`/`new` are null when that side doesn't exist (added/deleted file), never both null. FR-141's
 * 25MB-per-side guard runs before any bytes are read, so `"too-large"` carries no partial content.
 */
export type ImageDiffResult =
  | { status: "ok"; old: ImageBlob | null; new: ImageBlob | null }
  | { status: "too-large"; side: "old" | "new" | "both" };

export interface DiffOptions {
  /** Guard threshold for FR-22. Default 5000. */
  maxChangedLines?: number;
  /** Guard threshold for FR-22, in bytes. Default 2 * 1024 * 1024 (2MB). */
  maxFileSizeBytes?: number;
  /** Unified-diff context lines. Default 3 (git's own), passed explicitly so local `diff.context` config can't change it. */
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
 * FR-33: one local branch from `listBranches()`. Upstream/ahead/behind reflect the remote-tracking ref
 * already on disk (FR-45/FR-57); never live, no network.
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
  /** Absolute path of the *other* worktree this branch is checked out in (`git worktree list --porcelain`, FR-33); null if none. The current worktree is `isCurrent`. */
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
   * Local/remote-tracking branch, tag, or commit SHA; defaults to HEAD. On an unborn HEAD with no
   * `startPoint` the git call fails as a plain `GitCommandError` (no typed error); check
   * `RepositoryState.isUnbornHead` first.
   */
  startPoint?: string;
  /** FR-36: switch the working tree to the new branch as part of the same call (`git switch -c`). */
  switchToIt?: boolean;
  /** FR-37: force (`true`) or suppress (`false`) tracking; undefined auto-tracks when `startPoint` is a remote-tracking ref, else passes no flag. */
  track?: boolean;
  /**
   * Only meaningful with `switchToIt`. Full commit id of the detached HEAD the user confirmed; the
   * create-and-switch aborts with `HeadMovedError` unless HEAD is still detached exactly there
   * (checked inside the same queued mutation). See `orphanGuard.ts`.
   */
  expectedDetachedHeadSha?: string;
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

// Merge/rebase conflict resolution (specs/merge-rebase-conflict-resolution.md, FR-58 through FR-80); see conflicts.ts.

/**
 * FR-63: which index stages (1 = base, 2 = "ours"/HEAD, 3 = "theirs"/incoming) exist for a conflicted
 * path, taken from git's own `status`/`ls-files -u` vocabulary. Includes both-added/both-deleted beyond
 * the spec's four named cases because `git ls-files -u` really reports them and they must not be
 * dropped or miscategorized.
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
 * FR-79: one side's rename in a rename/rename or rename/modify conflict, found by diffing the
 * merge-base against each side with rename detection. Best-effort: the file's `rename` is null when no
 * merge-base resolves (e.g. unrelated histories) or neither side renamed this path.
 */
export interface ConflictRenameSide {
  /** Which side renamed, in FR-61 stage terms (2 = "ours", 3 = "theirs"); see `ConflictSideLabels` for labels. */
  side: "ours" | "theirs";
  oldPath: string;
  newPath: string;
  similarity?: number;
}

/**
 * FR-63/FR-77/FR-78/FR-79/FR-80: one conflicted path's classification and stage metadata (blob
 * SHAs/modes only; content comes from `getConflictFileDiff()`, FR-64), cheap to compute for every path up front.
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
 * FR-61: labels for stage 2 ("ours") and stage 3 ("theirs") of the current operation; computed once
 * per operation by `computeConflictSideLabels()` (conflicts.ts), not per file.
 */
export interface ConflictSideLabels {
  ours: ConflictSideLabel;
  theirs: ConflictSideLabel;
}

/**
 * FR-64: three-way (two-way when a stage is absent) comparison for one conflicted file, reusing
 * `FileDiffResult` so `DiffView` needs no new path. Each field is null unless both stages of its pair
 * exist (e.g. `baseToOurs` for add/add).
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

/** specs/edit-in-diff.md FR-559: one index stage of a conflicted file as text for the block editor. */
export interface ConflictSideContent {
  status: "ok" | "absent" | "binary" | "not-utf8" | "too-large" | "submodule";
  sha: string | null;
  mode: string | null;
  /** Non-null only when `status === "ok"`. */
  text: string | null;
}

/** Stage 1 (base, absent for add/add), stage 2 (ours), stage 3 (theirs); pair with `getConflictSideLabels()` for display (FR-61). */
export interface ConflictSides {
  base: ConflictSideContent;
  ours: ConflictSideContent;
  theirs: ConflictSideContent;
}

// Stash (specs/stash.md, FR-81 through FR-92); see stash.ts.

/** FR-81: one `git stash list` entry, read fresh from disk on every call. */
export interface StashInfo {
  /** The `N` in `stash@{N}` — 0 is always the most recently created stash. */
  index: number;
  /** Fully qualified stash reference, e.g. "stash@{0}". */
  ref: string;
  /** The stash commit's own SHA. */
  sha: string;
  /**
   * git's default message ("WIP on <branch>: ...", "WIP on (no branch): ..." when detached) verbatim,
   * or for a `-m` stash the custom message with git's "On <branch>: " wrapper stripped; see
   * `parseStashSubject()` in stash.ts.
   */
  message: string;
  /** Branch from git's default message only; null for a custom message or a detached-HEAD stash. */
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
   * Subset of changed paths to stash (file-level only; specs/stash.md "Non-goals: hunk-level partial
   * stash"). Omitted/empty stashes everything eligible. Requested paths that are conflicted, clean, or
   * (without `includeUntracked`) untracked are silently excluded, like `stageAllFiles()`; only when all
   * are excluded does it fail (`NothingEligibleToStashError`).
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
 * FR-85/FR-86/FR-87: outcome of `applyStash()`/`popStash()`. A conflict is detected from a fresh
 * `getWorkingDirectoryChanges().conflicted` read, not operation-type detection, since stash apply/pop
 * leaves no `MERGE_HEAD`-like state (see stash.ts's module doc).
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

// Blame & file history (specs/blame.md, FR-123 through FR-130); see blame.ts.

/** FR-124/FR-126/FR-127: one blamed line's commit attribution, from `git blame --porcelain`. */
export interface BlameCommitInfo {
  /** Full 40-hex commit SHA, or the all-zero SHA for an uncommitted line (see `isUncommitted`). */
  sha: string;
  /** First 7 hex chars of `sha`; porcelain has no abbreviation, so computed locally like `commitLog.ts`'s `parseRecord()`. */
  abbrevSha: string;
  /** FR-126: git's own literal "Not Committed Yet" string when `isUncommitted` is true — passed through, never reworded. */
  authorName: string;
  /** FR-126: git's own literal "not.committed.yet" for an uncommitted line — passed through, never reworded. */
  authorEmail: string;
  /** ISO 8601 strict in the author's timezone, rebuilt from porcelain's `author-time`/`author-tz` to match `commitLog.ts`. For an uncommitted line it's git's current-time snapshot, not a real commit date (FR-126). */
  authorDate: string;
  /** The commit's subject line (empty string for an uncommitted line — porcelain gives no summary for one). */
  summary: string;
  /** FR-127: shallow/grafted history boundary, mirroring `CommitInfo.isHistoryBoundary`; UI must not render it as a genuine root. Always false for uncommitted lines. */
  isBoundary: boolean;
  /** FR-126: line is an uncommitted working-tree edit. `sha` is porcelain's all-zero SHA; `authorName`/`authorEmail` are git's placeholder text. */
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

/** FR-124: discriminated blame result, mirroring `FileDiffResult`'s binary/too-large/ok convention (`diff.ts`) so `BlamePanel` can reuse `DiffView`'s non-content rendering. */
export type BlameResult =
  | OkBlameResult
  | BinaryBlameResult
  | TooLargeBlameResult
  | NotFoundBlameResult
  | EmptyBlameResult;

/**
 * specs/online-sync-fetch.md FR-323: closed set of outcomes `classifyGitNetworkError()` sorts a failed
 * network command's stderr into; anything new falls into `"unknown"` until a real observed reason
 * justifies a member.
 *
 *  - `"ssh-key-rejected"`: `Permission denied (publickey)`.
 *  - `"host-key-verification-failed"`: `Host key verification failed.` (unknown or changed host key;
 *    OpenSSH emits the same line for both).
 *  - `"https-auth-failed"`: HTTPS credentials missing (GitHydra never prompts) or rejected as invalid/expired.
 *  - `"host-unreachable"`: DNS failure, connection refused, or timeout, over either transport.
 *  - `"repository-not-found"`: `fatal: repository '<url>' not found`. GitHub/Bitbucket return it both for
 *    a nonexistent URL and a private repo the credentials can't see, so it isn't folded into
 *    `"https-auth-failed"`; the message names both causes.
 *  - `"push-rejected-non-fast-forward"`: specs/online-sync-push.md FR-346; stderr has
 *    `! [rejected] ... (non-fast-forward)` or `(fetch first)` (same meaning: diverged, pull first).
 *    Push's most common failure and never a connectivity/credential problem, so it gets its own message.
 *  - `"unknown"`: nothing above matched; see `ClassifiedGitNetworkError.rawStderr`.
 */
export type GitNetworkErrorKind =
  | "ssh-key-rejected"
  | "host-key-verification-failed"
  | "https-auth-failed"
  | "host-unreachable"
  | "repository-not-found"
  | "push-rejected-non-fast-forward"
  | "unknown";

/**
 * specs/online-sync-fetch.md FR-323: `classifyGitNetworkError()`'s result. `message` is a short,
 * actionable pointer to the user's OWN SSH agent / credential helper / git config, never a claim
 * GitHydra stores or manages credentials (FR-325). `rawStderr` has already passed through
 * `redactGitCredentials()` (FR-324), so it is safe to display even for `"unknown"`, where it is the
 * main thing shown.
 */
export interface ClassifiedGitNetworkError {
  readonly kind: GitNetworkErrorKind;
  readonly message: string;
  readonly rawStderr: string;
}

// Fetch (specs/online-sync-fetch.md, FR-320 through FR-322/FR-328); see fetch.ts. FR-326/327 are UI scope.

/**
 * FR-322: one progress update parsed from a `git fetch --progress` stderr stream, tagged with
 * `remoteName` so `fetchAllRemotes()`'s shared `onProgress` can tell remotes apart. `--progress` is
 * passed explicitly because git hides its meter when stderr isn't a TTY.
 *
 * Verified against git 2.31.1 over file://, git:// and HTTPS: lines look like
 * `[remote: ]<Stage>: NN% (a/b)[, done.]`, separated by `\r` mid-stage and `\n` on completion
 * (`fetch.ts` splits both). Fetch was never seen printing client-side "Receiving objects"/"Resolving
 * deltas" (unlike clone), only the remote's "Enumerating/Counting/Compressing"; `parseFetchProgressLine`
 * still accepts a bare `<Stage>: NN% (a/b)` defensively, but callers must not assume "Receiving
 * objects" appears.
 */
export interface FetchProgressEvent {
  remoteName: string;
  /** Best-effort stage label (e.g. "Counting objects"), git's wording verbatim. Null when the line didn't match `<Stage>: NN% (a/b)`; still forwarded via `raw`, never dropped. */
  stage: string | null;
  /** 0-100 when this line reported one, else null. */
  percent: number | null;
  /** The raw stderr line, already through `redactGitCredentials()` (FR-324); safe to display or log. */
  raw: string;
}

/** FR-321: one remote's outcome from `fetchAllRemotes()`; per-remote so one failure never blends with another's (see `fetchAllRemotes`, `fetch.ts`). */
export type FetchRemoteOutcome =
  | { remoteName: string; status: "ok" }
  | { remoteName: string; status: "error"; error: ClassifiedGitNetworkError };

/** FR-321: result of fetching every listed remote. `outcomes` is empty (not an error) when none are configured. */
export interface FetchAllRemotesResult {
  outcomes: FetchRemoteOutcome[];
}

// Push (specs/online-sync-push.md, FR-344 through FR-350); see push.ts.

/**
 * FR-344/FR-345: `push()`'s result. `"pushed"`: tracked branch pushed to its configured upstream via an
 * explicit `<local>:<upstream>` refspec (never a bare `git push <remote> <local>` left to
 * `push.default`). `"set-upstream"`: branch with no upstream for `remoteName` published via
 * `--set-upstream <remote> <local>`, after which ahead/behind compute with no further config.
 */
export type PushOutcome =
  | { kind: "pushed"; remoteName: string; localBranch: string; remoteBranch: string; sha: string }
  | { kind: "set-upstream"; remoteName: string; localBranch: string; remoteBranch: string; sha: string };
