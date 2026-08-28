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
