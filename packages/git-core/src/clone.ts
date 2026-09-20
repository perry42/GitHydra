// SPDX-License-Identifier: GPL-3.0-or-later
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  checkGitVersion,
  withAmbientSshCommandNeutralized,
  withDangerousTransportsBlocked,
  withEndOfOptions,
} from "./gitProcess";
import { CloneDestinationIsSymlinkError, InvalidArgumentError } from "./errors";
import { runNetworkGitProcess } from "./fetch";
import { isErrnoException } from "./pathSafety";
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
 * FR-355 (bug fix, 2026-09-20 code-review pass): before ever invoking `git clone`, this attempts
 * to create `destination` itself via `fs.mkdir(destination, { recursive: true })`. This USED to be
 * non-recursive, on the theory that it should mirror `git clone`'s own single-level destination
 * creation — but that theory was wrong: verified directly against real git (2.31.1) that
 * `git clone <repo> level1/level2>`, with NEITHER `level1` NOR `level2` existing yet, succeeds —
 * real git creates every missing intermediate directory itself. The old non-recursive `fs.mkdir`
 * instead threw a raw `ENOENT` for that exact case (a real scenario: a user typing, or editing a
 * Browse-suggested, destination like `D:\Projects\newproject\my-repo` where `newproject` doesn't
 * exist yet), which the surrounding catch below didn't special-case, so it propagated straight to
 * the user as an unhelpful raw filesystem error string with `git clone` never even invoked.
 *
 * `{ recursive: true }` changes `fs.mkdir`'s semantics in a way that matters a great deal for the
 * safety logic this function already had (verified empirically in this environment, node's own
 * `fs.mkdir`, rather than assumed from docs — see this package's git-core-engineer investigation
 * for the full matrix): unlike the non-recursive form, it does NOT throw `EEXIST` when
 * `destination` already exists as a directory, OR as a symlink pointing at one — it just silently
 * resolves (see below for exactly what it resolves to). It still throws `EEXIST` when `destination`
 * exists as a non-directory entry (e.g. a plain file) it refuses to treat as "already there".
 *
 * `fs.mkdir({recursive:true})`'s own return value is exactly what's needed to track this
 * correctly — it resolves to the FIRST (topmost) directory path it had to create (which, for a
 * destination with missing intermediate parents, can be an ANCESTOR of `destination`, not
 * `destination` itself), or `undefined` if the full path already existed and nothing was created.
 * `createdRootDir` below captures that value (not a plain boolean, unlike before) — exactly ONE
 * outcome is tracked, explicitly, at this exact moment, never re-derived later:
 *  - A path was returned: THIS call is the one that brought that directory (and everything below
 *    it down to and including `destination`) into existence, for THIS clone. If anything below
 *    then fails for any reason (a genuine git failure, `checkGitVersion()`'s own failure, a
 *    timeout, or a caller cancellation), that ENTIRE returned subtree — which this call alone
 *    created, and which can therefore hold nothing this call didn't itself just write into it — is
 *    removed again (best-effort; see the catch below), not just the `destination` leaf, so a
 *    cleaned-up failed clone never leaves behind now-empty intermediate directories it just
 *    created either. The one case this does NOT run for is success: a completed clone's
 *    destination (and every directory created to reach it) is obviously kept.
 *  - `undefined` was returned, OR the call threw `EEXIST`: this call is NOT the creator of
 *    anything — `destination` already existed (as a directory, a symlink-to-directory, or, for the
 *    `EEXIST` case, some other non-directory entry). `destination` is left completely alone in
 *    every subsequent code path in this function, including on cancellation/failure — this is the
 *    FR-355 guarantee that a pre-existing directory the user pointed at (even one that happens to
 *    be empty) is never deleted. Any other `fs.mkdir` failure (e.g. `EACCES`, or `ENOTDIR` for an
 *    intermediate path segment that's a plain file) propagates directly as-is — a real, actionable
 *    filesystem error, not something this module has any typed wrapper for.
 *
 * security note (closing a gap `{recursive:true}` would otherwise silently reopen): because
 * `{recursive:true}` no longer throws `EEXIST` for a symlink-to-directory already sitting at
 * `destination`, the TOCTOU race-symlink re-check below (originally only reachable from inside the
 * `EEXIST` catch) now runs unconditionally whenever nothing was created — covering both the
 * `undefined`-return case and the `EEXIST`-throw case identically — rather than being gated behind
 * a thrown `EEXIST` that a raced-in symlink might no longer produce.
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

  // FR-355 (recursive, 2026-09-20 fix): see this function's own doc comment above for the full
  // contract this drives, including exactly why `createdRootDir` is a path-or-null rather than a
  // boolean now, and why the TOCTOU re-check below must run for BOTH outcomes that mean "nothing
  // was created" (an `undefined` return, or a thrown `EEXIST`) rather than only from inside a
  // caught `EEXIST` the way the old non-recursive implementation gated it.
  let createdRootDir: string | null = null;
  let nothingWasCreated = false;
  try {
    const created = await fs.mkdir(resolvedDestination, { recursive: true });
    if (created !== undefined) {
      createdRootDir = created;
    } else {
      nothingWasCreated = true;
    }
  } catch (err) {
    if (!isErrnoException(err) || err.code !== "EEXIST") {
      throw err;
    }
    nothingWasCreated = true;
  }

  if (nothingWasCreated) {
    // security-review (2026-09-18, LOW, TOCTOU follow-up — still applies verbatim under
    // `{recursive:true}`, see the doc comment above for why this can no longer live only inside an
    // `EEXIST` catch): the lstat above can miss a symlink planted at resolvedDestination in the
    // window between it and this mkdir. Re-check here, immediately before git ever touches the
    // path, so that window can't slip a symlink through.
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
  //
  // code-review pass (2026-09-20): investigated whether this argv also needs
  // `NEUTRALIZE_LOCAL_HOOK_CONFIG`/`withFsmonitorNeutralized()` (`gitProcess.ts`) — the
  // `-c core.fsmonitor=false` guard `status`/`diff`/`add`/`restore`/`clean`/`commit` all already
  // apply, for the SAME ambient-config-execution threat class `withAmbientSshCommandNeutralized()`
  // above exists for, just against a different config key. Concluded NO — this is NOT needed here
  // — verified empirically (not assumed), mirroring exactly how `NEUTRALIZE_LOCAL_HOOK_CONFIG`
  // itself was originally verified (`tests/workingDirStatus.test.ts`'s "fsmonitor
  // argument-injection guard" describe block's "[vulnerability demonstration]" test): a raw,
  // completely UNGUARDED `git clone` (no `-c` override of any kind) into a subdirectory of an
  // ambient repository whose *local* `.git/config` sets a malicious `core.fsmonitor` command never
  // executes that command during the clone's post-transfer checkout — real git 2.31.1.windows.1,
  // reproduced twice. A combined positive-control run in the same script, against the SAME ambient
  // repository, confirmed the harness itself was capable of detecting an executed ambient hook (a
  // raw `git ls-remote`/`fetch` run directly with `cwd` INSIDE that repo, or a subdirectory of it,
  // reliably triggers a manually-set malicious `core.sshCommand`/`core.fsmonitor`) — so this is a
  // real negative result for `clone()`'s own checkout step specifically, not a harness that simply
  // can't observe hook execution. `tests/clone.test.ts`'s "clone() (code-review 2026-09-20): does
  // NOT need core.fsmonitor neutralization" describe block encodes this exact proof as a permanent
  // regression test, so a future git version that changes this behavior fails loudly here instead
  // of silently reopening the gap.
  //
  // Why this is the expected result, not a fluke: `core.fsmonitor`'s entire purpose is answering
  // "what's changed since the index's last known-good state" so a status/add/commit-family command
  // can skip re-hashing untouched files — it only has something meaningful to consult when an
  // EXISTING index is being read or refreshed. A fresh `git clone` builds its index from scratch,
  // writing every file straight from the just-transferred pack with nothing pre-existing to
  // "refresh against" — there is no prior index state for the hook to answer a question about, so
  // git's own checkout path evidently has no reason to invoke it, matching the observed behavior.
  // If a future clone-related feature in this module ever calls a genuine `status`/`add`-family
  // command against the freshly-cloned working tree (none does today — `clone()` is a single
  // `git clone` invocation and nothing else, per `CLONE_ARGV_NON_GOALS` above), THAT call would
  // need `withFsmonitorNeutralized()` applied to itself, the same as every other such call in this
  // package already does — this conclusion is scoped to `git clone`'s own internal checkout step
  // only, not a blanket "fsmonitor is never a concern for this module" claim.
  const args = withDangerousTransportsBlocked(
    withAmbientSshCommandNeutralized([
      "clone",
      "--progress",
      ...withEndOfOptions([url, resolvedDestination]),
    ]),
  );

  const cloneCwd = path.dirname(resolvedDestination);

  try {
    // code-review fix (2026-09-20): `clone()` is uniquely reachable with ZERO repositories ever
    // opened (GitHydra's landing screen) — every other network primitive (`fetchRemote()`/
    // `pull()`/`push()`) only becomes reachable after `Repository.open()`, which itself calls
    // `checkGitVersion()` before anything else (see `repository.ts`'s `resolveRepositoryPaths()`),
    // so those get this guarantee for free. Nothing in `clone()`'s own call path previously
    // checked or awaited git's version before spawning `git clone`, even though this module's own
    // `--end-of-options` argument-injection defense (`withEndOfOptions()`, used just above)
    // implicitly assumes git >= `MIN_GIT_VERSION` — see `gitProcess.ts`'s own header comment.
    //
    // Placement: deliberately AFTER every destination-safety check above (the symlink lstat, the
    // recursive `fs.mkdir`) rather than at the very top of this function, mirroring
    // `resolveRepositoryPaths()`'s own precedent (`repository.ts`) of running its cheap, spawn-free
    // local checks — `pathExists()`, then the fs-only `fastCheckRepositoryDiscovery()` — BEFORE its
    // own `checkGitVersion()` call, which in turn runs before the first real git subprocess. Those
    // checks above are pure `fs` calls (never a `git` spawn) so there's no ordering hazard running
    // them first, and doing so means `checkGitVersion()` — like every git spawn in this function —
    // gets a `cwd` (`cloneCwd`, `destination`'s parent) that's now GUARANTEED to exist (created, if
    // it didn't already, by the recursive `fs.mkdir` above) rather than one that might not, which
    // would make `git --version` itself fail to spawn (`ENOENT` on the `cwd`) and get misreported
    // as `UnsupportedGitVersionError` instead of the real "destination's parent doesn't exist"
    // problem. Placed inside this same `try` (immediately before the real `git clone` spawn,
    // rather than in its own separate `try`) so a version-check failure gets the exact same
    // `createdRootDir` cleanup any other post-mkdir failure already gets below — never leaves an
    // empty directory behind for this reason either.
    await checkGitVersion(cloneCwd, options.signal);

    await runNetworkGitProcess(args, cloneCwd, CLONE_REMOTE_LABEL, options.signal, options.onProgress);
  } catch (err) {
    // security-review (2026-09-18, MEDIUM): no bespoke redaction needed here anymore — every error
    // this call can throw (`GitCommandError`, `GitCommandTimeoutError`, `OperationCancelledError`)
    // now redacts its own `.message`/`.args`/`.stderr` centrally, in its own constructor
    // (`errors.ts`). See those constructors' doc comments for the full history of why this used to
    // be a bespoke patch here and why that's now redundant. `UnsupportedGitVersionError`
    // (`checkGitVersion()`'s own failure, above) carries no destination/URL content at all, so it
    // never needed this either.
    if (createdRootDir) {
      // Best-effort only: cleanup failing (e.g. a file the just-killed git process still has a
      // handle open on, on Windows) must never mask the REAL error/cancellation this call is
      // already about to (re)throw — the caller needs to see that, not a secondary filesystem
      // error about tidying up. `maxRetries`/`retryDelay` give a just-killed child process a
      // realistic window to actually release its handles first, mirroring `tests/testRepo.ts`'s
      // own `cleanup()` precedent for the identical race. Removes `createdRootDir` — the topmost
      // directory THIS call created (see the FR-355 doc comment above for why that can be an
      // ancestor of `resolvedDestination`, not just `resolvedDestination` itself) — not
      // `resolvedDestination` alone, so a failed clone into a freshly-created nested path never
      // leaves behind now-empty intermediate directories this call itself just created either.
      await fs.rm(createdRootDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {
        /* best-effort cleanup only — see comment above. */
      });
    }
    throw err;
  }

  return { path: resolvedDestination };
}
