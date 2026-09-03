# PRD: Amend Last Commit

Status: draft — small, contained addition; not part of the v1 build order (v1 is complete per
`CLAUDE.md`)
Owner: product-manager
Sequencing: git-core-engineer first (new git logic in `packages/git-core`), then ui-graphics
builds the composer UI against it — same "new git logic goes first" rule `AGENTS.md` states.

Extends `specs/stage-unstage-diff.md`'s FR-25 (`createCommit`) and its own commit composer
(`ChangesPanel.tsx`/`useChangesPanel.ts`). That spec's Non-goals section explicitly named this:
"Amend last commit. Simple enough to add later; kept out to hold v1 scope." — this spec is that
promised fast-follow, not new scope invented from nothing.

## Problem

A developer who just committed and then notices a typo in the message, or realizes they forgot
to stage a file, has to leave GitHydra for a terminal and run `git commit --amend` — even though
GitHydra already has every piece needed to do this in-app (a commit composer, staging, and
`createCommit`). This is one of the most frequent everyday git actions (fixing the commit you
just made, before anyone else has seen it) and today GitHydra can't do it at all.

## Target user

Same as `specs/stage-unstage-diff.md`: a developer working against any local-only, GitHub/GitLab/
Bitbucket/self-hosted, or no-remote repo, using the Changes panel's existing commit composer.

## Must-have behavior

### Data & git semantics (git-core-engineer) — extends `packages/git-core`

- FR-148: New `amendCommit(cwd, options: CreateCommitOptions)` in `commitChanges.ts`, reusing
  FR-25's exact `CreateCommitOptions`/`CreateCommitResult` shape (subject + optional body) —
  no new type needed. Runs `git commit --amend --quiet -F -`, message piped via stdin exactly
  like `createCommit` (never `-m`/string concatenation, same rationale as FR-25's doc comment).
  Never passes `--reset-author`/`--author` — git's own default amend behavior (keep the original
  author identity/date, refresh the committer identity/date to now) is used unconditionally; this
  spec does not expose authorship editing (see Non-goals). Works whether or not anything is
  currently staged: with nothing staged, the amend only changes the message; with staged content,
  that content is folded into the same commit alongside the message change — both are valid,
  single-commit outcomes, exactly like plain `git commit --amend` from a terminal.
- FR-149: New `NoCommitToAmendError` (added to `errors.ts`, alongside `StashOnUnbornHeadError`'s
  precedent). `amendCommit` checks HEAD state first and refuses — making no `git commit --amend`
  call at all — when HEAD is unborn (no commits yet in this repository), since there is nothing
  to amend.
- FR-150: `amendCommit` reuses `commitChanges.ts`'s existing `missingCommitIdentityFields` check
  and throws the existing `MissingCommitIdentityError` under the same conditions FR-25 already
  does (an amend still produces a new commit object, so committer identity is still required).
- FR-151: New `AmendBlockedByOperationError` (added to `errors.ts`). `amendCommit` refuses up
  front — making no git call — when `detectInProgressOperation()` (`repository.ts`) reports a
  merge/rebase/cherry-pick/revert/am/bisect already in progress, mirroring the precedent
  `OperationAlreadyInProgressError` already set for cherry-pick (FR-103): amending HEAD mid-
  operation is a different, confusing action from continuing or aborting that operation, and
  should be refused the same way, before ever reaching git.
- FR-152: `amendCommit` reuses `commitChanges.ts`'s existing `hasCommitHook` heuristic exactly as
  `createCommit` does: a pre-commit/commit-msg hook rejecting the amend throws the existing
  `CommitHookRejectedError` with the hook's raw stderr preserved — no new error type needed here.
- FR-153: No network call anywhere in `amendCommit` (identical guarantee to FR-26) — behavior is
  identical regardless of remote host (GitHub/GitLab/Bitbucket/self-hosted) or absence of one.
  A repository-level wrapper `amendCommit(options)` is added to the `GitRepository` class
  (`index.ts`) the same way `createCommit` already is — same signature shape, same placement
  convention, plumbing straight to the module-level function above.

### Rendering & interaction (ui-graphics) — `packages/desktop`

- FR-154: A new `amendCommit` IPC channel is added to `IPC_CHANNELS` and `preload.ts`'s
  `GitHydraApi`, mirroring `createCommit`'s existing entry exactly (same `CreateCommitOptions`
  argument, one narrow typed method, no generic passthrough — per `preload.ts`'s existing
  security comment).
- FR-155: The commit composer (`ChangesPanel.tsx`/`useChangesPanel.ts`) gets an "Amend last
  commit" checkbox next to the Subject field. It is disabled, with an explanatory
  `title`/tooltip, when HEAD is unborn or an operation is in progress — surfacing FR-149/FR-151's
  guard client-side (reusing whatever repo-state signals `App.tsx` already has for unborn-HEAD
  and in-progress-operation detection) before a git call is ever attempted, not just relying on
  the error round-trip.
- FR-156: Checking the box first captures whatever the user had already typed into Subject/Body
  as a draft, then replaces both fields with HEAD's current exact subject/body (reusing the same
  `CommitInfo` shape already used to populate the DetailPanel — no new git-core read needed
  beyond what already exists for showing a commit's message). Unchecking it again before
  submitting restores the captured draft verbatim, including an empty draft — never silently
  discards in-progress typing.
- FR-157: While the box is checked, `canCommit` no longer requires `stagedCount > 0` (a pure
  message-only amend with nothing staged is valid) but still requires a non-empty trimmed
  subject, same as today. The primary button's label changes from "Commit" to "Amend Commit"
  while checked, reverting to "Commit" when unchecked.
- FR-158: Before actually submitting an amend, if the current branch — per `listBranches()`'s
  existing `isCurrent`/`upstreamName`/`upstreamGone`/`ahead` fields (already fetched for the
  Branches panel per `specs/branch-management.md` FR-33; no new git-core call required for this)
  — has a present upstream (`upstreamName !== null && !upstreamGone`) and `ahead === 0`, show a
  confirmation step warning that this commit may already be shared/pushed, before calling
  FR-148/FR-154. No warning is shown when there is no upstream configured at all, or when
  `ahead >= 1` (meaning HEAD itself is already an unpushed commit). Exact plumbing of the
  branch-list data into the commit composer (shared App-level state vs. an additional cheap
  local-only `listBranches()` call) is ui-graphics's implementation call.
- FR-159: The warning is a confirm-or-cancel step, not a block — confirming proceeds with the
  amend; canceling makes no git call and leaves the composer exactly as it was, mirroring FR-31's
  discard-confirmation pattern (an explicit step, never a silent refusal, never a silent
  auto-proceed).
- FR-160: On a successful amend, the composer resets (subject, body, and the amend checkbox all
  clear) and the same two refresh calls a normal commit already makes fire again
  (`onWorkingDirChanged`, `onCommitCreated`) — the Changes panel and the graph (if open) both
  reflect the new HEAD SHA in place of the old one.
- FR-161: A failed amend (hook rejection, missing identity, or an FR-149/FR-151 guard error
  reached as a late race — e.g. another process started a rebase between render and submit)
  surfaces through the composer's existing `commitError` state, the same error UI a failed normal
  commit already uses — no new error surface designed for this.

### Edge cases & constraints

Bare repo: no Changes panel content at all, so no amend affordance either (unchanged, existing
behavior). Detached HEAD: amend proceeds normally and updates HEAD directly with no branch ref
involved, exactly as a terminal `git commit --amend` would — no special-cased UI. Amending a
merge commit (HEAD has 2+ parents): works exactly like amending any other commit (message-only,
or with newly staged content folded in) — no special-cased block or warning beyond FR-158's
generic pushed-commit check. Very long or non-ASCII commit messages: same handling as FR-25,
no new limit introduced here.

## Non-goals (v1)

- **Amending any commit other than HEAD.** That's an interactive-rebase "edit" operation — a
  materially larger scope (`specs/merge-rebase-conflict-resolution.md` doesn't cover this either)
  and a separate future spec if prioritized.
- **Changing authorship** (`--author`/`--reset-author`). Not exposed anywhere in this spec; git's
  own default amend behavior (keep original author, refresh committer) is used unconditionally.
- **Any push/force-push automation, or a prompt to push after amending.** GitHydra has no
  push/pull yet (tracked separately as V2's headline item) — FR-158's warning is purely
  informational, based on local remote-tracking data already on disk, per product principles (no
  network call this spec introduces or requires).
- **Hunk-level control over what gets folded into the amend.** Reuses whatever is already staged
  via existing file-level staging (FR-23) — no new staging granularity invented here.
- **Any special UI/blocking for amending merge commits** beyond git's own default behavior.
- **Telemetry on amend usage.** None, by default, per product principles.

## Acceptance criteria

1. With HEAD present and the Changes panel open, checking "Amend last commit" pre-fills Subject/
   Body with HEAD's exact current commit message; unchecking it again without submitting restores
   whatever was in those fields immediately before checking it (including empty fields).
2. Submitting with amend checked, zero staged files, and an edited subject produces a new HEAD
   SHA (different from the pre-amend SHA) carrying the new subject, with the commit's tree/file
   content unchanged from before — a message-only amend.
3. Submitting with amend checked and 1+ files staged produces exactly one new HEAD SHA that
   contains both the message change and the staged content folded together — no second, separate
   commit is created.
4. The amend checkbox is disabled, with an explanatory tooltip, on an unborn-HEAD repository (no
   commits yet); attempting to interact with it has no effect and triggers no git call.
5. The amend checkbox is disabled, with an explanatory tooltip, while a merge/rebase/cherry-pick/
   revert is in progress; attempting to interact with it has no effect and triggers no git call.
6. When the current branch has a present, configured upstream and `ahead === 0`, submitting an
   amend shows a confirmation warning that the commit may already be shared/pushed before any git
   call is made; confirming proceeds with the amend, canceling makes no git call and leaves the
   original commit and composer state untouched.
7. When the current branch has no upstream configured, or is ahead of its upstream by 1 or more
   commits, submitting an amend proceeds directly with no warning shown.
8. After a successful amend, the composer clears (subject, body, and the amend checkbox all
   reset) and the commit graph (if open) shows the new commit SHA at the same position in history
   the old one occupied.
9. A commit-msg/pre-commit hook rejecting an amend surfaces the same hook-rejection error state
   the existing regular-commit flow already uses (FR-25/FR-32) — not a crash, not swallowed.
10. Zero outbound network requests occur at any point across checking amend, viewing the pushed-
    commit warning, and submitting — verified against repos configured with GitHub, GitLab,
    Bitbucket, and self-hosted remotes, and a purely local repo with no remote.
11. Amending while HEAD is detached updates HEAD directly with no branch-ref involvement, exactly
    as a terminal `git commit --amend` would — no crash, no special-cased error.

## References

- `specs/stage-unstage-diff.md` FR-25/FR-26 — the `createCommit` contract this spec extends
  (message-via-stdin convention, identity/hook error precedent, no-network guarantee).
- `packages/git-core/src/commitChanges.ts` (`hasStagedChanges`, `missingCommitIdentityFields`,
  `hasCommitHook`) — the exact helpers `amendCommit` reuses rather than reimplementing.
- `packages/git-core/src/errors.ts` — `StashOnUnbornHeadError` and `OperationAlreadyInProgressError`,
  the naming/structure precedent `NoCommitToAmendError`/`AmendBlockedByOperationError` follow.
- `specs/branch-management.md` FR-33 (`LocalBranchInfo`'s `ahead`/`upstreamName`/`upstreamGone`
  fields) — the existing, already-fetched data FR-158's pushed-commit warning reuses with no new
  git-core call.
- `packages/desktop/src/components/ChangesPanel/ChangesPanel.tsx` and
  `packages/desktop/src/hooks/useChangesPanel.ts` — the existing commit composer this spec
  extends in place.
- `packages/desktop/electron/preload.ts` — the "one narrow typed method per operation" convention
  FR-154's new IPC channel follows exactly.
