import * as fs from "node:fs/promises";
import * as path from "node:path";
import { runGit, runGitAllowingExitCodes, runGitWithInput, withFsmonitorNeutralized } from "./gitProcess";
import {
  CommitHookRejectedError,
  GitCommandError,
  InvalidArgumentError,
  MissingCommitIdentityError,
  NothingStagedError,
} from "./errors";
import type { CreateCommitOptions, CreateCommitResult } from "./types";

/**
 * `git diff --cached --quiet` exits 0 when the index matches HEAD (nothing staged), 1 when it
 * differs. This also works correctly on an unborn branch (no HEAD yet): git compares the index
 * against the empty tree automatically in that case, so a freshly-`git add`ed file on a brand
 * new repo is still correctly detected as "something staged".
 */
async function hasStagedChanges(cwd: string): Promise<boolean> {
  const { exitCode } = await runGitAllowingExitCodes(
    withFsmonitorNeutralized(["diff", "--cached", "--quiet"]),
    { cwd },
    [0, 1],
  );
  return exitCode === 1;
}

async function missingCommitIdentityFields(cwd: string): Promise<("name" | "email")[]> {
  const missing: ("name" | "email")[] = [];
  const [name, email] = await Promise.all([
    runGit(["config", "--get", "user.name"], { cwd })
      .then((r) => r.stdout.trim())
      .catch(() => ""),
    runGit(["config", "--get", "user.email"], { cwd })
      .then((r) => r.stdout.trim())
      .catch(() => ""),
  ]);
  if (!name) missing.push("name");
  if (!email) missing.push("email");
  return missing;
}

/**
 * Best-effort signal for "did a hook most likely cause this `git commit` failure": true if an
 * existing pre-commit or commit-msg hook file is present in the repo's configured hooks
 * directory (respecting `core.hooksPath`). git gives no machine-readable signal distinguishing
 * a hook rejection from any other `git commit` failure, so this is a heuristic, not a
 * certainty — but by the time it's consulted, `createCommit` has already ruled out the other
 * two named failure modes (nothing staged, missing identity), so a residual failure with a
 * hook present is overwhelmingly likely to be that hook. Either way, the raw stderr is always
 * preserved and surfaced to the caller (as `GitCommandError.stderr` or
 * `CommitHookRejectedError.stderr`), so no information is lost even if the classification here
 * is wrong.
 */
async function hasCommitHook(cwd: string): Promise<boolean> {
  try {
    const { stdout } = await runGit(["rev-parse", "--git-path", "hooks"], { cwd });
    const hooksDir = path.resolve(cwd, stdout.trim());
    for (const name of ["pre-commit", "commit-msg"]) {
      try {
        await fs.access(path.join(hooksDir, name));
        return true;
      } catch {
        // try the next candidate hook name
      }
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * FR-25: create a commit from currently-staged content. The message is always piped via stdin
 * (`git commit -F -`) — never `-m`/string concatenation — so a message that happens to start
 * with `-`, or contains any other shell/flag-like content, can never be misparsed as an option
 * or reach a shell.
 *
 * Throws (never a raw crash):
 *  - `InvalidArgumentError` — `subject` is empty/whitespace-only.
 *  - `NothingStagedError` — the index matches HEAD (nothing to commit).
 *  - `MissingCommitIdentityError` — `user.name` and/or `user.email` is unset.
 *  - `CommitHookRejectedError` — a pre-commit/commit-msg hook exists and the commit still
 *    failed after the checks above passed (see `hasCommitHook`'s doc comment for the caveat).
 *  - `GitCommandError` — any other failure, with git's raw stderr attached.
 *
 * Makes no network call (FR-26): `git commit` never touches a remote.
 */
export async function createCommit(
  cwd: string,
  options: CreateCommitOptions,
): Promise<CreateCommitResult> {
  const subject = options.subject.trim();
  if (!subject) {
    throw new InvalidArgumentError("Commit subject must not be empty.");
  }

  if (!(await hasStagedChanges(cwd))) {
    throw new NothingStagedError();
  }

  const missing = await missingCommitIdentityFields(cwd);
  if (missing.length > 0) {
    throw new MissingCommitIdentityError(missing);
  }

  const body = options.body?.trim();
  const message = body ? `${subject}\n\n${body}\n` : `${subject}\n`;

  try {
    await runGitWithInput(withFsmonitorNeutralized(["commit", "--quiet", "-F", "-"]), { cwd }, message);
  } catch (err) {
    if (err instanceof GitCommandError && (await hasCommitHook(cwd))) {
      throw new CommitHookRejectedError(err.stderr);
    }
    throw err;
  }

  const { stdout } = await runGit(["rev-parse", "HEAD"], { cwd });
  return { sha: stdout.trim() };
}
