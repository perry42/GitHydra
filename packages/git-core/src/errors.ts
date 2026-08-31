/**
 * Error types for git-core. We throw loudly and specifically rather than
 * swallowing failures — a caller (UI layer) should always be able to tell
 * "this repo is empty" apart from "git isn't installed" apart from
 * "that SHA doesn't exist".
 */

/** A `git` invocation exited non-zero, or failed to spawn. */
export class GitCommandError extends Error {
  constructor(
    message: string,
    public readonly args: readonly string[],
    public readonly exitCode: number | null,
    public readonly stderr: string,
  ) {
    super(message);
    this.name = "GitCommandError";
  }
}

/** The path given does not resolve to a git repository (no .git, not bare, etc). */
export class NotAGitRepositoryError extends Error {
  constructor(public readonly path: string) {
    super(`Not a git repository (or any parent up to mount point): ${path}`);
    this.name = "NotAGitRepositoryError";
  }
}

/** No `git` executable could be resolved to an absolute path on PATH (or via GIT_EXEC_PATH). */
export class GitNotFoundError extends Error {
  constructor() {
    super(
      "Could not find a `git` executable on PATH. GitHydra requires git installed and " +
        "on PATH (or GIT_EXEC_PATH pointing at a valid installation).",
    );
    this.name = "GitNotFoundError";
  }
}

/** The installed `git` binary is missing or older than our minimum supported version. */
export class UnsupportedGitVersionError extends Error {
  constructor(
    public readonly found: string | null,
    public readonly minimum: string,
  ) {
    super(
      found
        ? `git ${found} is installed, but GitHydra requires git >= ${minimum} (needed for safe argument handling via --end-of-options).`
        : `git was not found on PATH. GitHydra requires git >= ${minimum}.`,
    );
    this.name = "UnsupportedGitVersionError";
  }
}

/** Caller passed a value that must never reach a shelled-out git argument unvalidated (e.g. a malformed SHA). */
export class InvalidArgumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidArgumentError";
  }
}

/** FR-25: `createCommit` was called with nothing staged (index matches HEAD, or empty index on an unborn branch). */
export class NothingStagedError extends Error {
  constructor() {
    super("Nothing is staged to commit. Stage at least one file before committing.");
    this.name = "NothingStagedError";
  }
}

/** FR-25: `createCommit` was called but `user.name` and/or `user.email` is not configured anywhere git would read it from. */
export class MissingCommitIdentityError extends Error {
  constructor(public readonly missing: readonly ("name" | "email")[]) {
    super(
      `Cannot commit: git identity is not configured (missing ${missing
        .map((field) => `user.${field}`)
        .join(" and ")}). Set it with \`git config user.name "..."\` / ` +
        '`git config user.email "..."` (locally, or --global for all repos).',
    );
    this.name = "MissingCommitIdentityError";
  }
}

/**
 * FR-25: a pre-commit or commit-msg hook rejected the commit (`git commit` exited non-zero
 * with an executable pre-commit/commit-msg hook present, after `NothingStagedError` and
 * `MissingCommitIdentityError` were already ruled out). `stderr` is git's/the hook's raw
 * output, always preserved verbatim.
 */
export class CommitHookRejectedError extends Error {
  constructor(public readonly stderr: string) {
    super(`Commit rejected by a pre-commit/commit-msg hook:\n${stderr.trim()}`);
    this.name = "CommitHookRejectedError";
  }
}

/**
 * FR-35: a proposed branch name failed `git check-ref-format --branch <name>`, checked
 * before any mutating `git branch`/`git switch -c` call is attempted (so no partial/corrupt
 * ref is ever left behind for an invalid name).
 */
export class InvalidRefNameError extends Error {
  constructor(
    public readonly name: string,
    public readonly reason: string,
  ) {
    super(`"${name}" is not a valid branch name: ${reason}`);
    this.name = "InvalidRefNameError";
  }
}

/**
 * FR-38/39: `git switch`/`git switch --detach`/`git switch -c` refused because the switch
 * would overwrite uncommitted local changes. `conflictingPaths` is a best-effort parse of the
 * file list git printed; `stderr` always carries git's full, unmodified message so no
 * information is lost even if the parse misses a path (e.g. a future git version rewording
 * the message).
 */
export class BranchSwitchConflictError extends Error {
  constructor(
    public readonly targetBranch: string,
    public readonly conflictingPaths: readonly string[],
    public readonly stderr: string,
  ) {
    super(
      `Cannot switch to "${targetBranch}": uncommitted changes would be overwritten` +
        (conflictingPaths.length ? ` (${conflictingPaths.join(", ")})` : "") +
        `.\n${stderr.trim()}`,
    );
    this.name = "BranchSwitchConflictError";
  }
}

/**
 * FR-40: `git branch -d <name>` refused because the branch has commits not yet merged
 * anywhere reachable. Distinguishable from any other delete failure so the UI can offer an
 * explicit, separately-confirmed escalation to `forceDeleteBranch` (FR-41) rather than a
 * generic error.
 */
export class BranchNotFullyMergedError extends Error {
  constructor(
    public readonly branchName: string,
    public readonly stderr: string,
  ) {
    super(
      `Branch "${branchName}" is not fully merged. Force-delete it if you're sure you want ` +
        `to discard its commits.`,
    );
    this.name = "BranchNotFullyMergedError";
  }
}

/**
 * FR-42: a delete or switch was refused because the branch is currently checked out — either
 * in this same worktree, or (per `git worktree list`) a different one. `worktreePath` is the
 * path git named in its own refusal message, when it provided one.
 */
export class BranchCheckedOutError extends Error {
  constructor(
    public readonly branchName: string,
    public readonly worktreePath: string | null,
    public readonly stderr: string,
  ) {
    super(
      worktreePath
        ? `Branch "${branchName}" is checked out at "${worktreePath}" and cannot be deleted from here.`
        : `Branch "${branchName}" is currently checked out and cannot be deleted.`,
    );
    this.name = "BranchCheckedOutError";
  }
}

/**
 * A resolved working-tree path — or an intermediate directory component of it — is a symlink
 * whose target resolves (via `fs.realpath`) outside the repository's working directory. Thrown
 * by `pathSafety.ts`'s `resolveRealPathWithinWorkdir` and refused BEFORE any content read is
 * attempted: a malicious repo can make a tracked/conflicted path's working-tree entry a symlink
 * (git blob mode `120000`) pointing at `~/.ssh/id_rsa` or anywhere else the process can read, and
 * without this check a feature like conflict-marker scanning — which reads working-tree file
 * bytes directly with `fs.readFile`, not through git's own path-confined plumbing — would happily
 * read and return that target's content. `path` is the original repository-relative path that was
 * requested; `realPath` is the fully symlink-resolved location it was found to escape to (kept
 * for diagnostics only — this error's own message is the only thing that should ever reach a UI).
 */
export class SymlinkEscapesWorkdirError extends Error {
  constructor(
    public readonly path: string,
    public readonly realPath: string,
  ) {
    super(
      `Refusing to read "${path}": it resolves through a symlink to a location outside the ` +
        `repository's working directory.`,
    );
    this.name = "SymlinkEscapesWorkdirError";
  }
}

/**
 * FR-66: `acceptOurs`/`acceptTheirs`/`markConflictResolved` refuse to stage a conflicted file
 * that still contains a literal conflict marker line (`<<<<<<<`/`=======`/`>>>>>>>`/`|||||||`) —
 * git itself does not validate this, so this module must. No `git add`/`git checkout --ours`/
 * `--theirs` call is ever made when this is thrown; the file is left exactly as it was.
 */
export class ConflictMarkersRemainError extends Error {
  constructor(
    public readonly path: string,
    public readonly markerLines: readonly number[],
  ) {
    super(
      `Cannot mark "${path}" as resolved: conflict markers still present in this file ` +
        `(line${markerLines.length === 1 ? "" : "s"} ${markerLines.join(", ")}).`,
    );
    this.name = "ConflictMarkersRemainError";
  }
}

/**
 * FR-71: `continueInProgressOperation` is client-side blocked (defense in depth beyond git's own
 * `--continue` refusal, which only catches unresolved index conflicts, not leftover marker text
 * in an already-staged file) unless `WorkingDirectoryChanges.conflicted` is empty AND FR-66's
 * marker scan finds nothing in every currently-staged path. `blockingPaths` names the specific
 * file(s) so the UI can point at exactly what's still unresolved.
 */
export class ContinueBlockedError extends Error {
  constructor(public readonly blockingPaths: readonly string[]) {
    super(
      `Cannot continue: unresolved conflict(s) remain in ${blockingPaths.join(", ")}.`,
    );
    this.name = "ContinueBlockedError";
  }
}

/**
 * FR-68/FR-69: `abortInProgressOperation`/`continueInProgressOperation` were called with no
 * operation in progress (`null`), or with `"bisect"` — bisect is already typed by
 * `InProgressOperation` but intentionally gets no abort/continue affordance this pass (it
 * produces no merge-style conflicts; see spec Non-goals). `git rebase --quit` is never exposed as
 * an affordance at all (FR-69) — there is no operation/argument that reaches it from this module.
 */
export class NoOperationInProgressError extends Error {
  constructor(public readonly requested: "abort" | "continue", public readonly operation: string | null) {
    super(
      operation === "bisect"
        ? `Cannot ${requested} a bisect from this view — bisect has no conflict-resolution affordances.`
        : `Cannot ${requested}: no merge/rebase/cherry-pick/revert is in progress.`,
    );
    this.name = "NoOperationInProgressError";
  }
}
