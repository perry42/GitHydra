// SPDX-License-Identifier: GPL-3.0-or-later
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { withDangerousTransportsBlocked, withEndOfOptions } from "./gitProcess";
import { InvalidArgumentError } from "./errors";
import { runNetworkGitProcess } from "./fetch";
import { redactGitCredentials } from "./credentialRedaction";
import type { FetchProgressEvent } from "./types";

/**
 * specs/online-sync-clone.md — git-core surface for FR-352 through FR-355/FR-357: `clone()`, the
 * fifth and last online-sync milestone phase (specs/online-sync-clone.md's own header — "reuses
 * Phase 1's already-proven progress/cancel/credential-failure infrastructure rather than being
 * where that infrastructure is built for the first time").
 *
 * Composed entirely from:
 *  - `runNetworkGitProcess()` (`fetch.ts`, FR-354) for the actual spawn — the EXACT same
 *    cancellable-with-`AbortSignal`, progress-callback (`FetchProgressEvent`, reused unrenamed —
 *    `git clone --progress` emits the identical `<Stage>: NN% (a/b)` shaped lines `git fetch
 *    --progress`/`git push --progress` already do, PLUS the client-side "Receiving objects"/
 *    "Resolving deltas" lines `FetchProgressEvent`'s own doc comment (types.ts) already documents
 *    as observed from `clone` specifically — no new parsing logic needed), and
 *    credential-redaction-at-construction (FR-357, reusing FR-323/324's classification/redaction
 *    verbatim) infrastructure `fetchRemote()`/`push()` already established. No parallel
 *    implementation of any of that exists here.
 *  - `withDangerousTransportsBlocked()`/`withEndOfOptions()` (`gitProcess.ts`) for the same
 *    `ext::`/`fd::` transport guard and argument-injection protection every other network call in
 *    this package already applies — arguably even more directly load-bearing here than for
 *    `fetchRemote()`/`push()`, since `url` is the literal argv value a caller passes, not a
 *    pre-existing configured remote name a malicious repo's `.git/config` would have to plant
 *    first (FR-352).
 *
 * FR-352: `git clone <url> <destination>` — plain, no flags beyond `--progress` (for FR-354's
 * progress reporting) and the two positional args. See this module's `CLONE_ARGV_NON_GOALS`
 * comment below for the closed set of flags this module must never add.
 */

export interface CloneOptions {
  /** specs/online-sync-fetch.md FR-322's same `AbortSignal` mechanism, reused unmodified — see
   * `runNetworkGitProcess()`'s doc comment (`fetch.ts`). Aborting terminates the underlying
   * `git clone` process via the same SIGTERM-then-SIGKILL escalation every other cancellable
   * invocation in this package uses. */
  signal?: AbortSignal;
  /** FR-354: called once per parsed stderr line, in order, as `git clone --progress` runs — the
   * identical shape/timing contract `fetchRemote()`'s/`push()`'s `onProgress` already have. Never
   * called after this call's promise has settled (success, error, or cancellation). */
  onProgress?: (event: FetchProgressEvent) => void;
}

export interface CloneResult {
  /** The resolved, absolute destination path the repository was cloned into — always
   * `path.resolve(destination)`, so a caller that passed a relative path gets back the same
   * absolute path this module actually invoked `git clone` against (FR-356's data dependency: the
   * caller opens this exact path as a new tab). */
  path: string;
}

/** Tag every `FetchProgressEvent` this module produces with — `git clone` (unlike `fetchRemote()`/
 * `push()`, which each act on one already-*named* configured remote) has no caller-supplied remote
 * name to carry; the newly-cloned repository's remote is unconditionally named "origin" by git
 * itself (no `--origin` flag is ever passed — see the non-goals comment below), so that's the
 * accurate, real label to tag these events with. */
const CLONE_REMOTE_LABEL = "origin";

/** True for a Node `fs` error carrying a string `.code` (a `NodeJS.ErrnoException`) — same helper
 * `pathSafety.ts` already has privately; duplicated here (rather than exported/shared) since it's a
 * two-line structural type guard, not meaningfully reusable logic. */
function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return typeof err === "object" && err !== null && typeof (err as { code?: unknown }).code === "string";
}

/**
 * security-review (Phase 5/Clone, Critical): unlike `fetchRemote()`/`push()` — whose argv only ever
 * carries a pre-configured remote *name* — `clone()`'s argv holds the caller-supplied `url` as a
 * literal positional value (see `CLONE_ARGV_NON_GOALS` below). `runNetworkGitProcess()`'s own
 * `GitCommandError`/`GitCommandTimeoutError` construction (`gitProcess.ts`) builds `.message` by
 * interpolating raw `args.join(" ")` — that's already safe for `fetchRemote()`/`push()` (no
 * credential can ever be in their argv), but for `clone()` a credential embedded directly in `url`
 * (`https://ghp_xxx@github.com/o/r.git`, discouraged but real) would otherwise reach `.message`
 * completely unredacted, including via `GitCommandTimeoutError` — which has no `.stderr` field at
 * all, so a caller reading only `.message` (exactly what `useCloneAction.ts`'s no-`stderr` fallback
 * does) would render the raw token verbatim. `.stderr` itself is NOT touched here: `fetch.ts`'s
 * `runNetworkGitProcess()` already redacts it via `redactGitCredentials()` before ever constructing
 * the `GitCommandError` (see that module's own comment above its `child.on("close", ...)` handler) —
 * redacting it again here would be redundant, not incorrect, but this function intentionally only
 * touches `.message` to keep the fix scoped to the one field that's actually unsafe.
 *
 * Mutates and rethrows the SAME error object (rather than constructing a new one) so every
 * `instanceof`/`.name` check a caller already relies on (`useCloneAction.ts`, `main.ts`'s
 * `serializeError()`) keeps working completely unchanged — `Error.prototype.message` is an
 * ordinary writable property, not frozen or defined via a getter, for every error type this module
 * can throw (verified against `errors.ts`: `GitCommandError`/`GitCommandTimeoutError` both just call
 * `super(message)`).
 */
function redactCredentialsFromErrorMessage<E>(err: E): E {
  if (err instanceof Error && typeof err.message === "string") {
    err.message = redactGitCredentials(err.message);
  }
  return err;
}

/**
 * FR-352 through FR-355/FR-357: clone `url` into `destination`.
 *
 * FR-353: never silently merges into or overwrites existing content. This module makes NO attempt
 * to pre-check whether `destination` is "empty enough" to clone into — that decision, and its exact
 * wording, is left entirely to `git clone` itself, whose own refusal (`GitCommandError.stderr`,
 * e.g. `fatal: destination path '...' already exists and is not an empty directory.`) is surfaced
 * to the caller completely verbatim (redacted only for an embedded credential, same as every other
 * `GitCommandError` this package throws for a network call).
 *
 * FR-355: before ever invoking `git clone`, this attempts to create `destination` itself
 * (`fs.mkdir`, non-recursive — mirrors `git clone`'s own single-level destination-creation
 * behavior; an intermediate missing parent directory is not this module's job to create). Exactly
 * ONE outcome of that attempt is tracked, explicitly, as a plain boolean captured at this exact
 * moment — never re-derived later by inspecting the directory's contents:
 *  - It succeeded: THIS call is the one that brought `destination` into existence, as an empty
 *    directory, for THIS clone. If anything below then fails for any reason (a genuine git
 *    failure, a timeout, or a caller cancellation), `destination` — which this call alone created,
 *    and which can therefore hold nothing this call didn't itself just write into it — is removed
 *    again (best-effort; see the `finally`-adjacent catch below) before the error/cancellation is
 *    rethrown. The one case this does NOT run for is success: a completed clone's destination is
 *    obviously kept.
 *  - It failed with `EEXIST` (`destination` already existed, whether as an empty directory, a
 *    non-empty directory, or even a plain file): this call is NOT the creator. `destination` is
 *    left completely alone in every subsequent code path in this function, including on
 *    cancellation/failure — this is the FR-355 guarantee that a pre-existing directory the user
 *    pointed at (even one that happens to be empty) is never deleted. Any other `fs.mkdir` failure
 *    (e.g. `EACCES`, or `ENOENT` for a missing parent) propagates directly as-is — a real,
 *    actionable filesystem error, not something this module has any typed wrapper for.
 *
 * FR-357: a credential failure (or any other network failure) surfaces as the identical
 * `GitCommandError` shape (already credential-redacted, FR-324) `fetchRemote()`/`push()` already
 * throw — classify it with `classifyGitNetworkError()`, the exact same function, with zero new
 * classification rules added for clone specifically.
 *
 * Throws `InvalidArgumentError` (no filesystem or git call made at all) for an empty/whitespace-
 * only `url` or `destination`.
 */
export async function clone(url: string, destination: string, options: CloneOptions = {}): Promise<CloneResult> {
  if (!url || !url.trim()) {
    throw new InvalidArgumentError("clone requires a non-empty URL.");
  }
  if (!destination || !destination.trim()) {
    throw new InvalidArgumentError("clone requires a non-empty destination path.");
  }

  const resolvedDestination = path.resolve(destination);

  // FR-355: see this function's own doc comment above for the full contract this flag drives.
  let createdDestination = false;
  try {
    await fs.mkdir(resolvedDestination);
    createdDestination = true;
  } catch (err) {
    if (!isErrnoException(err) || err.code !== "EEXIST") {
      throw err;
    }
    // Already exists (empty, non-empty, or even a plain file) — left completely alone. Whether
    // `git clone` can proceed into it is for git's own refusal (FR-353) to decide, not this
    // module — see the doc comment above.
  }

  // CLONE_ARGV_NON_GOALS (specs/online-sync-clone.md Non-goals, acceptance criterion 6): this
  // argv is the ONLY place this module ever builds a `git clone` invocation, and it must never
  // gain `--depth` (shallow clones), `--recurse-submodules`, `--mirror`, or `--bare` — "simplest
  // correct form only, this pass" per the spec's own wording. `tests/noNetworkCalls.test.ts`'s
  // "specs/online-sync-clone.md: clone() argv/network surface" describe block is the black-box
  // mechanical proof.
  const args = withDangerousTransportsBlocked([
    "clone",
    "--progress",
    ...withEndOfOptions([url, resolvedDestination]),
  ]);

  try {
    await runNetworkGitProcess(
      args,
      path.dirname(resolvedDestination),
      CLONE_REMOTE_LABEL,
      options.signal,
      options.onProgress,
    );
  } catch (err) {
    // security-review (Phase 5/Clone, Critical): redact BEFORE anything else touches this error —
    // both the cleanup path below and the rethrow itself must only ever see/propagate the redacted
    // message. See `redactCredentialsFromErrorMessage()`'s own doc comment for exactly what this
    // defends against and why `.stderr` doesn't need the same treatment here.
    redactCredentialsFromErrorMessage(err);
    if (createdDestination) {
      // Best-effort only: cleanup failing (e.g. a file the just-killed git process still has a
      // handle open on, on Windows) must never mask the REAL error/cancellation this call is
      // already about to (re)throw — the caller needs to see that, not a secondary filesystem
      // error about tidying up. `maxRetries`/`retryDelay` give a just-killed child process a
      // realistic window to actually release its handles first, mirroring `tests/testRepo.ts`'s
      // own `cleanup()` precedent for the identical race.
      await fs.rm(resolvedDestination, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {
        /* best-effort cleanup only — see comment above. */
      });
    }
    throw err;
  }

  return { path: resolvedDestination };
}
