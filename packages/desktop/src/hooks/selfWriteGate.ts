// SPDX-License-Identifier: GPL-3.0-or-later
import type { RefInfo, RepositoryState } from "@githydra/git-core";

/**
 * specs/self-write-refresh-suppression.md AC5 fix.
 *
 * The bug this module exists to close: `useRepositoryGraph`'s confirming read (`refreshRefs`,
 * called after an app-initiated checkout/switch) used to take a fresh, unscoped snapshot of ALL
 * current ref/HEAD state and unconditionally trust the whole thing as "what GitHydra itself just
 * confirmed". If an external process wrote a ref while that mutation was in flight and its write
 * landed before the confirming read, the confirming read observed both changes at once and folded
 * the external one into the new baseline — silently erasing any trace of it (no banner, ever).
 *
 * The fix: never trust the *entire* fresh snapshot as self-caused. Instead, diff it against the
 * snapshot captured immediately before the mutating call was issued, and check whether that diff
 * is EXACTLY what the specific operation was expected to produce (from the operation's own return
 * value, e.g. `SwitchResult.sha` — never guessed). Only an exact match is silently absorbed; any
 * additional/unexpected ref change means something else wrote to the repo concurrently, and that
 * must still surface as `hasExternalChanges`.
 */

/** A comparable point-in-time snapshot of ref/HEAD state — either the baseline captured right
 * before a mutating call is issued (`beginMutation`), or a fresh confirming read taken after
 * (`refreshRefs`/the idle watcher check). */
export interface RefHeadSnapshot {
  state: RepositoryState;
  refs: RefInfo[];
}

/**
 * The exact ref/HEAD outcome a specific app-initiated mutation is expected to produce. Always
 * derived from the mutation's own return value plus what its caller already knows about the
 * operation it issued (e.g. the branch name argument for `switchBranch`) — never guessed or timed.
 */
export interface ExpectedRefOutcome {
  /** HEAD sha the operation is expected to leave the repo at. */
  sha: string | null;
  /** HEAD's attached branch after the operation, or `null` for a detached HEAD. */
  currentBranch: string | null;
}

function refsByFullName(refs: RefInfo[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const r of refs) m.set(r.fullName, r.targetCommitSha);
  return m;
}

/** The "nothing should have changed" expectation — used when a gated operation never reached its
 * own success path (e.g. a failed `switchBranch`) and so has no real expected outcome to diff
 * against; the correct expectation there is that ref/HEAD state is unchanged from before the call,
 * not "skip checking altogether". */
export function noChangeExpected(pre: RefHeadSnapshot): ExpectedRefOutcome {
  return { sha: pre.state.headSha, currentBranch: pre.state.currentBranch };
}

/**
 * True when `post` contains ANY ref/HEAD change beyond exactly what `expected` says the operation
 * itself was supposed to produce — i.e. something else (a concurrent external process) also wrote
 * to the repo during the window between `pre` and `post`. A checkout/switch never moves any ref's
 * target, only what HEAD points to, so any ref add/remove/retarget is always unexpected here;
 * likewise HEAD/currentBranch landing anywhere other than exactly `expected` is unexpected, even if
 * it happens to look like a plausible outcome — GitHydra itself didn't confirm it.
 *
 * Returns `false` (never flags) when `pre` is `null` — nothing to diff against (only possible
 * before the very first confirmed read of a freshly-opened repo), so this deliberately never
 * false-positives rather than guessing.
 */
export function hasUnexpectedRefChange(
  pre: RefHeadSnapshot | null,
  post: RefHeadSnapshot,
  expected: ExpectedRefOutcome,
): boolean {
  if (!pre) return false;
  if (post.state.headSha !== expected.sha) return true;
  if ((post.state.currentBranch ?? null) !== expected.currentBranch) return true;
  if (post.state.isDetachedHead !== (expected.currentBranch === null)) return true;

  const preRefs = refsByFullName(pre.refs);
  const postRefs = refsByFullName(post.refs);
  if (preRefs.size !== postRefs.size) return true;
  for (const [name, sha] of preRefs) {
    if (postRefs.get(name) !== sha) return true;
  }
  return false;
}

/**
 * A settle check for operations whose exact outcome genuinely can't be predicted in advance — a
 * cherry-pick step (an arbitrary number of commits), or a merge/rebase Continue/Abort (an
 * arbitrary conflict-resolution history) — but which are still only ever permitted to move the
 * *currently-checked-out* ref. Unlike `hasUnexpectedRefChange`, this never compares HEAD's sha
 * against a specific expected value (there isn't one to compare against); instead it pins every
 * *other* ref, plus which branch is checked out and whether HEAD is detached, to `pre` exactly,
 * and only exempts the one ref the operation itself is allowed to advance. A second process
 * moving any other branch/tag, switching branches, or detaching/attaching HEAD during the
 * operation's in-flight window is still flagged — see specs/self-write-refresh-suppression.md
 * AC5's "must not create false negatives" non-goal, which a bare "skip the check" implementation
 * would have violated (this function exists specifically to avoid that).
 *
 * Returns `false` (never flags) when `pre` is `null`, matching `hasUnexpectedRefChange`'s own
 * convention.
 */
export function hasUnexpectedRefChangeBeyondCurrentBranch(
  pre: RefHeadSnapshot | null,
  post: RefHeadSnapshot,
): boolean {
  if (!pre) return false;
  if (post.state.isDetachedHead !== pre.state.isDetachedHead) return true;
  if ((post.state.currentBranch ?? null) !== (pre.state.currentBranch ?? null)) return true;

  // Detached HEAD has no branch ref to exempt — the operation still isn't allowed to move any
  // *named* ref (only HEAD itself, which isn't in this list), so no exemption is needed here.
  const allowedRefName = pre.state.currentBranch ? `refs/heads/${pre.state.currentBranch}` : null;

  const preRefs = refsByFullName(pre.refs);
  const postRefs = refsByFullName(post.refs);
  if (preRefs.size !== postRefs.size) return true;
  // The exempted ref must still exist and must match HEAD exactly — not just be "some ref that's
  // absent from the loop below". A same-size delta (the checked-out branch's ref deleted while an
  // unrelated same-named-elsewhere ref was added) would otherwise pass the loop's size/per-name
  // checks undetected, since the loop below never inspects `postRefs` for names *not* in `preRefs`.
  if (allowedRefName && postRefs.get(allowedRefName) !== post.state.headSha) return true;
  for (const [name, sha] of preRefs) {
    if (name === allowedRefName) continue;
    if (postRefs.get(name) !== sha) return true;
  }
  return false;
}
