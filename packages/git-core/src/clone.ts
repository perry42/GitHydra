// SPDX-License-Identifier: GPL-3.0-or-later
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  withAmbientSshCommandNeutralized,
  withDangerousTransportsBlocked,
  withEndOfOptions,
} from "./gitProcess";
import { CloneDestinationIsSymlinkError, InvalidArgumentError } from "./errors";
import { runNetworkGitProcess } from "./fetch";
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
 *  - `withAmbientSshCommandNeutralized()` (`gitProcess.ts`; security-review, 2026-09-18): `clone()`'s
 *    own dedicated use, unlike anything `fetchRemote()`/`push()` need — see that function's doc
 *    comment for the full threat (a malicious `core.sshCommand` planted in an unrelated repo that
 *    merely happens to be an ANCESTOR directory of `destination`, discovered via git's own upward
 *    config search against this call's `cwd`).
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
 * `GitCommandError` shape (already credential-redacted, FR-324 — and, as of the 2026-09-18
 * cross-phase security audit, redacted centrally by `GitCommandError`'s/`GitCommandTimeoutError`'s/
 * `OperationCancelledError`'s own constructors, `errors.ts`, rather than by a bespoke patch this
 * module used to apply in its own catch block; see those constructors' doc comments) `fetchRemote()`/
 * `push()` already throw — classify it with `classifyGitNetworkError()`, the exact same function,
 * with zero new classification rules added for clone specifically.
 *
 * security-review (2026-09-18, cross-phase online-sync audit, MEDIUM): before ever attempting
 * `fs.mkdir`, this `fs.lstat`s `destination` and refuses (`CloneDestinationIsSymlinkError`, no
 * filesystem write and no git call made at all) if it already exists as a SYMLINK — see that error
 * type's own doc comment (`errors.ts`) for why `fs.mkdir`'s own `EEXIST` alone can't distinguish
 * "a real pre-existing directory" from "a symlink pointing elsewhere," and why proceeding anyway
 * would let git silently write the whole clone into wherever the symlink points, outside the folder
 * the user chose.
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

  // security-review (2026-09-18, MEDIUM): checked BEFORE any fs.mkdir/git call — see this
  // function's own doc comment and CloneDestinationIsSymlinkError's (errors.ts) for why this must
  // run first, ahead of (and independent from) the fs.mkdir-based EEXIST check below. The lstat
  // itself is wrapped separately from the symlink check below it, so a genuine lstat failure
  // (ENOENT — destination doesn't exist yet, the common/expected case) can never be conflated with
  // "lstat succeeded and it turned out to be a symlink."
  let destinationLstat: import("node:fs").Stats | null = null;
  try {
    destinationLstat = await fs.lstat(resolvedDestination);
  } catch (err) {
    if (!isErrnoException(err) || err.code !== "ENOENT") {
      throw err;
    }
    // Destination doesn't exist at all yet — nothing to check; fs.mkdir below will create it fresh.
  }
  if (destinationLstat?.isSymbolicLink()) {
    const target = await fs.readlink(resolvedDestination).catch(() => "(unreadable)");
    throw new CloneDestinationIsSymlinkError(resolvedDestination, target);
  }

  // FR-355: see this function's own doc comment above for the full contract this flag drives.
  let createdDestination = false;
  try {
    await fs.mkdir(resolvedDestination);
    createdDestination = true;
  } catch (err) {
    if (!isErrnoException(err) || err.code !== "EEXIST") {
      throw err;
    }
    // security-review (2026-09-18, LOW, TOCTOU follow-up): the lstat above can miss a symlink
    // planted at resolvedDestination in the window between it and this mkdir — mkdir just sees
    // EEXIST for any directory entry, symlink included, without dereferencing it. Re-check here,
    // immediately before git ever touches the path, so that window can't slip a symlink through.
    const raceLstat = await fs.lstat(resolvedDestination);
    if (raceLstat.isSymbolicLink()) {
      const target = await fs.readlink(resolvedDestination).catch(() => "(unreadable)");
      throw new CloneDestinationIsSymlinkError(resolvedDestination, target);
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
  //
  // security-review (2026-09-18, HIGH): `withAmbientSshCommandNeutralized()` composes with
  // `withDangerousTransportsBlocked()` here — both are `-c` overrides prepended to the SAME argv,
  // so order between the two doesn't matter to git, but this call is `clone()`'s own dedicated use
  // (see that function's doc comment, `gitProcess.ts`, for why `fetchRemote()`/`push()` don't apply
  // it too).
  const args = withDangerousTransportsBlocked(
    withAmbientSshCommandNeutralized([
      "clone",
      "--progress",
      ...withEndOfOptions([url, resolvedDestination]),
    ]),
  );

  try {
    await runNetworkGitProcess(
      args,
      path.dirname(resolvedDestination),
      CLONE_REMOTE_LABEL,
      options.signal,
      options.onProgress,
    );
  } catch (err) {
    // security-review (2026-09-18, MEDIUM): no bespoke redaction needed here anymore — every error
    // this call can throw (`GitCommandError`, `GitCommandTimeoutError`, `OperationCancelledError`)
    // now redacts its own `.message`/`.args`/`.stderr` centrally, in its own constructor
    // (`errors.ts`). See those constructors' doc comments for the full history of why this used to
    // be a bespoke patch here and why that's now redundant.
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
