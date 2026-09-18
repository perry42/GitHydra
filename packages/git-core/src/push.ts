// SPDX-License-Identifier: GPL-3.0-or-later
import { runGit, withDangerousTransportsBlocked, withEndOfOptions } from "./gitProcess";
import { GitCommandError, InvalidArgumentError } from "./errors";
import { validateBranchName } from "./branches";
import { readConfigValue, buildBranchConfigKey } from "./pull";
import { runNetworkGitProcess } from "./fetch";
import type { FetchProgressEvent, PushOutcome } from "./types";

/**
 * specs/online-sync-push.md — git-core surface for FR-344 through FR-350: `push()`, the ONLY
 * function in this package that ever mutates a remote. This is the highest-risk primitive in the
 * whole V2 online-sync milestone (see the spec's own opening line) — a security review of this
 * file must confirm no code path can ever reach `--force`/`-f`/`--force-with-lease`/`--delete`/
 * `--tags`/`--all`/`--mirror` (see `tests/noNetworkCalls.test.ts`'s dedicated
 * "specs/online-sync-push.md: push() argv/network surface" describe block — a black-box
 * argv-inspection proof, same technique as the rest of that file — acceptance criterion 6).
 *
 * Composed entirely from:
 *  - `runNetworkGitProcess()` (`fetch.ts`, FR-348) for the actual spawn — the EXACT same
 *    cancellable-with-`AbortSignal`, progress-callback (`FetchProgressEvent`, reused unrenamed —
 *    see that function's own doc comment for why), and credential-redaction-at-construction
 *    infrastructure `fetchRemote()` already established. No parallel implementation of any of
 *    that exists here.
 *  - `readConfigValue()`/`buildBranchConfigKey()` (`pull.ts`) to read (never write)
 *    `branch.<name>.remote`/`branch.<name>.merge` — the same technique `pull()` already uses to
 *    resolve a branch's configured upstream, reused rather than re-implemented.
 *  - `validateBranchName()` (`branches.ts`) for defense-in-depth argument-injection rejection of
 *    `localBranchName` (its `check-ref-format --branch` call plus its leading-`-` guard), even
 *    though `withEndOfOptions()` below was separately verified (2026-09-17, real git
 *    2.31.1.windows.1) to already stop a `-`-prefixed remote name or refspec from ever being
 *    misparsed as a flag (git instead fails closed with `fatal: strange pathname '...' blocked`)
 *    — never relying on a single layer alone for argv safety, matching this package's blanket
 *    convention.
 *  - `classifyGitNetworkError()` (`networkErrorClassification.ts`) for FR-346's non-fast-forward
 *    classification: this module does NOT throw a bespoke typed error for a rejected push — it
 *    throws the identical `GitCommandError` shape `fetchRemote()` already throws (stderr already
 *    redacted, FR-324), and the caller classifies it the exact same way it already classifies a
 *    failed fetch (FR-323), now with one more closed-set outcome
 *    (`"push-rejected-non-fast-forward"`) added there specifically for this. This is the most
 *    literal reading of FR-348's "no parallel implementation" for the classification shape, not
 *    just the transport shape.
 *
 * FR-350 (tags are never pushed as a side effect): trivially true by construction — every argv
 * this module ever builds names exactly one explicit local-branch source and one explicit
 * destination-branch refspec (or `--set-upstream <remote> <branch>`); no code path here ever adds
 * `--tags`, `--all`, or `--mirror`, and a plain `<local>:<remote-branch>` refspec pushes only that
 * one branch ref — never any tag, regardless of what tags exist locally.
 */

export interface PushOptions {
  /** specs/online-sync-fetch.md FR-322's same `AbortSignal` mechanism, reused unmodified — see
   * `runNetworkGitProcess()`'s doc comment (`fetch.ts`). Aborting terminates the underlying
   * `git push` process via the same SIGTERM-then-SIGKILL escalation every other cancellable
   * invocation in this package uses. */
  signal?: AbortSignal;
  /** FR-348: called once per parsed stderr line, in order, as `git push --progress` runs — the
   * identical shape/timing contract `fetchRemote()`'s `onProgress` already has. Never called after
   * this call's promise has settled (success, error, or cancellation). */
  onProgress?: (event: FetchProgressEvent) => void;
}

/** `refs/heads/<name>` is a hardcoded-literal-prefixed argv token, same "a fixed prefix makes the
 * whole token safe regardless of content" reasoning `pull.ts`'s `buildBranchConfigKey()` already
 * documents — `branchName` can never make this token begin with `-`. Still passed through
 * `withEndOfOptions()` below anyway, purely for consistency with this package's blanket
 * convention on revision-like arguments. */
function localBranchRef(branchName: string): string {
  return `refs/heads/${branchName}`;
}

/** `git rev-parse --verify -q <ref>` — the branch's current tip SHA, or `null` if it doesn't
 * exist as a real local branch. A `GitCommandTimeoutError`/`OperationCancelledError` is never
 * folded into this `null` fallback — only an ordinary `GitCommandError` (git's own "no such ref"
 * refusal) is, mirroring `upstream.ts`'s/`pull.ts`'s identical convention for a normal, expected
 * "doesn't resolve" outcome. */
async function resolveLocalBranchSha(cwd: string, branchName: string): Promise<string | null> {
  try {
    const { stdout } = await runGit(
      ["rev-parse", "--verify", "-q", ...withEndOfOptions([localBranchRef(branchName)])],
      { cwd },
    );
    const trimmed = stdout.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch (err) {
    if (err instanceof GitCommandError) return null;
    throw err;
  }
}

/** Strips a `refs/heads/` prefix, leaving anything else (defensively) untouched — `branch.<name>
 * .merge` is always a full `refs/heads/...` ref for a real branch-tracking upstream, but this
 * degrades gracefully rather than throwing if some other tool ever wrote something unexpected
 * there. */
function shortBranchNameFromRef(ref: string): string {
  const prefix = "refs/heads/";
  return ref.startsWith(prefix) ? ref.slice(prefix.length) : ref;
}

/**
 * FR-344/FR-345: push `localBranchName` to `remoteName`.
 *
 * If `localBranchName` already has a configured upstream FOR `remoteName` specifically
 * (`branch.<name>.remote === remoteName` and `branch.<name>.merge` resolves) — FR-344 — this runs
 * `git push <remote> <localBranch>:<upstreamBranch>`: an EXPLICIT `<src>:<dest>` refspec built
 * from the branch's own already-configured tracking target, never a bare
 * `git push <remote> <localBranch>` left for `push.default`/ambient config to resolve
 * ambiguously. This also correctly handles the (rare but real) case where a local branch tracks a
 * differently-named remote branch.
 *
 * Otherwise — including a branch that IS tracked, but to a *different* remote than the one
 * requested here — FR-345 treats this as "no configured upstream yet for this remote" and
 * publishes it via `--set-upstream <remote> <localBranch>` (a plain, same-named push), after which
 * `getUpstreamBranch()`/`listBranches()`'s ahead/behind fields compute correctly with zero further
 * manual config. Re-pointing a branch's default upstream to a newly-chosen remote via this path is
 * the correct, intended outcome of the user explicitly choosing that remote to push to (FR-345's
 * "remote picker" — a single-remote repo defaults to it with no extra click) — this module has no
 * separate concept of "already tracked, but not to this remote" that would justify refusing.
 *
 * Throws `InvalidArgumentError` (no git call made) for an empty `remoteName`/`localBranchName`, or
 * a `localBranchName` that fails `validateBranchName()`'s syntax check or doesn't currently exist
 * as a real local branch. Throws `GitCommandTimeoutError`/`OperationCancelledError` per
 * `runNetworkGitProcess()`'s own contract (FR-348, reused unmodified). Any other git-level failure
 * — including a non-fast-forward rejection (FR-346) — surfaces as a plain `GitCommandError` with
 * already-credential-redacted `stderr` (FR-324's same redaction-at-construction guarantee
 * `fetchRemote()` has); the caller is expected to run that `stderr` through
 * `classifyGitNetworkError()` exactly as it already does for a failed fetch, which now includes
 * the `"push-rejected-non-fast-forward"` outcome specifically for this case. This module never
 * auto-retries with any force flag, and offers no escalation path at all — by design, per the
 * spec's own non-goals.
 */
export async function push(
  cwd: string,
  remoteName: string,
  localBranchName: string,
  options: PushOptions = {},
): Promise<PushOutcome> {
  if (!remoteName || !remoteName.trim()) {
    throw new InvalidArgumentError("push requires a non-empty remote name.");
  }
  if (!localBranchName || !localBranchName.trim()) {
    throw new InvalidArgumentError("push requires a non-empty local branch name.");
  }
  // Defense in depth (see this module's own doc comment) — makes no `git push` call at all for a
  // syntactically-invalid branch name.
  await validateBranchName(cwd, localBranchName);

  const localSha = await resolveLocalBranchSha(cwd, localBranchName);
  if (!localSha) {
    throw new InvalidArgumentError(`"${localBranchName}" is not a local branch in this repository.`);
  }

  const upstreamRemote = await readConfigValue(cwd, buildBranchConfigKey(localBranchName, "remote"));
  const upstreamMergeRef = await readConfigValue(cwd, buildBranchConfigKey(localBranchName, "merge"));
  const trackedForThisRemote = upstreamRemote === remoteName && !!upstreamMergeRef;

  if (trackedForThisRemote) {
    const upstreamShortName = shortBranchNameFromRef(upstreamMergeRef!);
    // A single, explicit `<src>:<dest>` refspec token — never two separate argv entries — so a
    // value starting with `-` could never be split into an independently-parsed flag even without
    // `withEndOfOptions()` below (same `optionEquals()`-style reasoning `gitProcess.ts` already
    // documents for value-bearing flags).
    const refspec = `${localBranchName}:${upstreamShortName}`;
    const args = withDangerousTransportsBlocked([
      "push",
      "--progress",
      ...withEndOfOptions([remoteName, refspec]),
    ]);
    await runNetworkGitProcess(args, cwd, remoteName, options.signal, options.onProgress);
    return {
      kind: "pushed",
      remoteName,
      localBranch: localBranchName,
      remoteBranch: upstreamShortName,
      sha: localSha,
    };
  }

  const args = withDangerousTransportsBlocked([
    "push",
    "--progress",
    "--set-upstream",
    ...withEndOfOptions([remoteName, localBranchName]),
  ]);
  await runNetworkGitProcess(args, cwd, remoteName, options.signal, options.onProgress);
  return {
    kind: "set-upstream",
    remoteName,
    localBranch: localBranchName,
    remoteBranch: localBranchName,
    sha: localSha,
  };
}
