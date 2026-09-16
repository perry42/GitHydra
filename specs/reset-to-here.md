# PRD: Reset Current Branch/HEAD to Here

Status: draft — ready for implementation. V2's second item, scoped to run in parallel with online
sync Phase 1 (`ROADMAP.md`, 2026-09-16), not queued behind it. No credentials, no network.

Builds on three already-shipped pieces rather than inventing new ones: the commit graph's own
already-stubbed entry point (`CommitGraph.tsx`, `{ label: "Reset current branch to here…",
disabled: true }`); `specs/drag-commit-menu.md`'s `computeCommitPairRelationship()`
(`commitPairs.ts`, FR-295), reused verbatim for ancestry-aware confirmation copy; and
`specs/branch-management.md`'s two-tier confirmation escalation precedent (FR-52).

## Problem

A developer who wants to move the current branch (or detached `HEAD`) back to an earlier commit —
undo the last few commits after a bad local sequence, discard a botched experiment, or reset to a
known-good point — has to drop to a terminal today. `git reset` is also one of git's most
misunderstood commands: three real modes (`--soft`/`--mixed`/`--hard`) with very different
consequences hidden behind one verb, and `--hard` in particular is the single easiest way to
destroy uncommitted work with no prompt at all, since git itself never asks for confirmation before
any reset mode. GitHydra needs a UI that makes the real distinction between the modes visible and
chosen, not defaulted or hidden, and that makes the one form of genuine, unrecoverable data loss
(`--hard` against a dirty working tree) impossible to trigger by accident.

## Target user

Same as every prior spec: any GitHydra user working in the commit graph, on any repo shape (local,
GitHub/GitLab/Bitbucket/self-hosted, bare, worktrees) — including a detached-`HEAD` session, where
this feature still applies (it moves `HEAD` directly rather than a branch ref) and is a normal,
common way back to a recovery point.

## Must-have behavior

### Data & git semantics (git-core-engineer) — new `packages/git-core` surface (e.g. `reset.ts`)

- **FR-359**: New `resetCurrentBranch(targetSha: string, mode: "soft" | "mixed" | "hard")`. Runs
  exactly one of `git reset --soft <targetSha>`, `git reset --mixed <targetSha>`, or
  `git reset --hard <targetSha>` — the mode flag is always passed explicitly, never a bare
  `git reset <sha>`, so behavior is never left to git's own default-flag inference. Always acts on
  the current `HEAD` (attached branch or detached) — takes no target-branch parameter and never
  checks out a different branch first, unlike `specs/drag-commit-menu.md`'s Merge/Rebase (FR-309):
  this feature's entry point (FR-366) only ever appears in the context of "the branch/HEAD I'm
  already on," so there is nothing to check out.
- **FR-360**: Refuses up front — making no `git reset` call at all — when
  `detectInProgressOperation()` (`repository.ts`) is already non-null, mirroring
  `specs/drag-commit-menu.md` FR-297/298's exact precedent. Reuses `OperationAlreadyInProgressError`
  (`errors.ts`), widening its `requestedAction` union to add `"reset"` (defaulting unchanged, so
  every existing call site is unaffected). A user with a genuine merge/rebase/cherry-pick/revert/am/
  bisect in progress must Abort or Continue via the existing operation banner before resetting —
  reset is never offered as a shortcut around that.
- **FR-361**: `targetSha` is validated against the existing full-SHA check (`HEX_SHA_RE`,
  `commitPairs.ts`'s convention, FR-296's precedent) before any git call; `InvalidArgumentError` on
  failure.
- **FR-362**: `withFsmonitorNeutralized()` (`gitProcess.ts`) is applied for `mixed` and `hard` (both
  touch the index and/or working tree) but **not** for `soft` (touches neither) — the same
  touches-the-working-tree-or-not distinction FR-43 already draws between `git switch` and
  `git branch` create/delete. Argv arrays only, `shell: false`, `targetSha` passed through
  `withEndOfOptions()`.
- **FR-363**: No network call anywhere in `resetCurrentBranch()`; identical behavior regardless of
  remote host or absence of one.
- **FR-364**: New read-only `countCommitsExclusiveToHead(targetSha, headSha)` — a single
  `git rev-list --count <targetSha>..<headSha>` call, used only to preview the reset's impact before
  the user confirms; makes no mutating call. Never throws: any failure (unresolvable SHA, a
  shallow-clone boundary, etc.) degrades to `null` (unknown count) rather than blocking the dialog —
  the UI falls back to non-numeric wording when this is `null` (FR-368). This one query is correct
  for all four ancestry shapes without branching logic: it naturally returns 0 when `targetSha` is a
  descendant of `headSha` (nothing lost), the exact "commits being undone" count when `targetSha` is
  an ancestor, the branch-unique count on a diverged pair, and `HEAD`'s full commit count on
  genuinely unrelated histories.
- **FR-365**: Reuses `computeCommitPairRelationship(targetSha, headSha)` (`commitPairs.ts`,
  `specs/drag-commit-menu.md` FR-295) unmodified to classify which of the four ancestry
  relationships applies, purely to select the correct confirmation-copy variant (FR-368). No new
  ancestry logic is added to git-core for this feature.
- No bare-repo-specific or unborn-`HEAD`-specific check is added inside `resetCurrentBranch()`
  itself — the UI layer (FR-366) is the actual, deliberate gate preventing bare repos from ever
  reaching this call at all, and an unborn `HEAD` has no commit rows to right-click on in the first
  place (the graph is empty), so that state is naturally unreachable rather than specially handled.

### Rendering & interaction (ui-graphics) — `packages/desktop`

- **FR-366**: Wire up the existing stubbed context-menu item (`CommitGraph.tsx`, currently
  `{ label: "Reset current branch to here…", disabled: true }`). Label becomes dynamic, matching
  this exact file's own established convention for `cherryPickTargetLabel`
  (`repoState?.currentBranch ?? "HEAD (detached)"`): **"Reset `{branch}` to here…"** when attached
  to a branch, **"Reset HEAD to here…"** when detached. Disabled, with the reason surfaced via
  `title` (FR-317's precedent — never color-only, never unexplained), when: the repository is bare
  ("No working tree — reset isn't available in a bare repository."), or an operation is already in
  progress ("Resolve or abort the {operation} in progress before resetting."). **Never** disabled
  merely because the target commit is already the current `HEAD` commit, and never disabled or
  restricted based on ancestry — any commit in the graph, including one with no shared history with
  the current branch, is a valid target (see FR-368's fourth copy variant).
- **FR-367**: Selecting the item opens a new modal dialog (e.g. `ResetBranchDialog`) showing the
  target commit's abbreviated SHA and subject line, and three mutually exclusive mode options, each
  with its own one-line, git-accurate consequence description (not marketing copy):
  - **Soft** — "Move `{branch}` here. Keep all changes from the undone commits staged, ready to
    re-commit."
  - **Mixed** — "Move `{branch}` here. Keep all changes from the undone commits, but unstaged."
  - **Hard** — "Move `{branch}` here. Permanently discard all changes from the undone commits, and
    any uncommitted changes to tracked files. Untracked files are not touched."

  **All three are real, separately-selectable options — never a single "reset" action that silently
  picks one, and Hard is never pre-selected or hidden behind an "advanced" toggle.** Soft is the
  pre-selected default on open, per the roadmap's explicit "default to a non-destructive form"
  instruction. Mixed is included deliberately, not dropped as a confusing third option: it's a real,
  commonly-reached-for git behavior distinct from both neighbors (unstages rather than re-stages),
  and GitKraken — this project's own named UI-parity bar (`CLAUDE.md`) — exposes exactly this same
  Soft/Mixed/Hard three-way choice, so a technical user coming from any mainstream visual git client
  already expects it. `git reset --keep`/`--merge` are not offered (see Non-goals).
- **FR-368**: Below the mode options, one impact line computed once from FR-364/365 when the dialog
  opens:
  - Target is an ancestor of `HEAD` (the common backward case): **"N commit(s) will no longer be on
    `{branch}`."**
  - `HEAD` is an ancestor of target (forward case): **"No commits will be lost — `{branch}` moves
    forward, nothing is undone."**
  - Diverged, real shared history: **"`{branch}` will move to a divergent commit. N commit(s)
    currently unique to `{branch}` will no longer be reachable from it."**
  - No common ancestor: **"This commit shares no history with `{branch}`. All N of `{branch}`'s
    current commit(s) will no longer be reachable from it."** — rendered with the same `critical`
    token emphasis (`DESIGN.md`) used for the most severe warnings elsewhere.
  - Target is exactly the current `HEAD` commit: replaces the above with **"No commits are being
    undone — `{branch}` is already here."**
  - When FR-364's count is `null` (read failed), the same sentences render without the number (e.g.
    "Some commit(s) will no longer be on `{branch}`.") rather than showing a broken/undefined count
    or blocking the dialog.
- **FR-369**: A live "uncommitted changes" danger callout, shown **only** when Hard is the currently
  selected mode **and** `workingDirStatus.staged + workingDirStatus.unstaged +
  workingDirStatus.conflicted > 0`. Names the exact counts (e.g. "3 staged and 2 unstaged change(s)
  will be permanently discarded") and states plainly: **"Untracked files are not affected."** This
  callout never appears for Soft or Mixed, regardless of working-tree state — neither mode ever
  touches the working tree — and never appears for Hard when the working tree is clean.
- **FR-370**: Mode-specific enabling, evaluated against `targetSha === repoState.headSha`: **Soft
  and Mixed are disabled**, with reason "Already at this commit — nothing to reset," when the target
  is exactly the current `HEAD` commit (both are genuine no-ops there). **Hard stays enabled** at
  `HEAD` — this is the intentional, standard "discard all uncommitted changes" affordance
  (equivalent to a bare `git reset --hard`) — with FR-368's "already here" copy and, if triggered,
  FR-369's callout as the dialog's only substantive warning.
- **FR-371**: Clicking the dialog's primary action:
  - **Soft or Mixed, any target**: calls `resetCurrentBranch(targetSha, mode)` immediately. The
    dialog itself — an explicit mode choice plus an explicit click — is the confirmation; no nested
    dialog, since neither mode can ever lose uncommitted work.
  - **Hard, danger callout (FR-369) not showing** (clean working tree): calls
    `resetCurrentBranch(targetSha, "hard")` immediately, same reasoning — the only thing at stake is
    commits becoming unreachable, mitigated by the Undo affordance (FR-374/375).
  - **Hard, danger callout showing** (dirty working tree): does **not** reset yet. Opens a second,
    `destructive: true` `ConfirmDialog` (the existing shared component, reused verbatim — no new
    dialog component), mirroring `specs/branch-management.md` FR-52's exact two-tier escalation
    shape. It restates the exact counts, states plainly this step cannot be undone from GitHydra,
    and its confirm button is labeled to state the action (e.g. "Discard changes and reset"), not a
    bare "Confirm." Only confirming *that* dialog calls `resetCurrentBranch(targetSha, "hard")`.
    Canceling either dialog makes no git call and leaves `HEAD`, the index, and the working tree
    unchanged.
- **FR-372**: Standard post-success refresh — commit graph, `HEAD`/current-branch decoration
  (`specs/commit-graph.md` FR-17), `ChangesPanel`, Toolbar working-dir badges, and the operation
  banner — matching the established `specs/branch-management.md` FR-56 precedent. No restart or
  manual refresh required.
- **FR-373**: A new hook (e.g. `useResetActions.ts`, matching this codebase's one-hook-per-mutating-
  feature convention — `useBranchActions`/`useCherryPickActions`/`useStashActions`) owns opening/
  closing the dialog, both confirmation layers, the `resetCurrentBranch` call, and FR-374's undo-
  banner state.
- **FR-374**: On a successful reset, capture — *before* the mutating call, from already-loaded state,
  no new git read — the pre-reset `headSha`, its subject (from the already-loaded `CommitInfo` for
  that SHA if currently in the graph's loaded page, else `null`), `currentBranch`/detached status,
  and the mode just used. On success, push a new, dismissible banner onto `StatusBanner`'s existing
  banner stack (same visual/dismiss treatment as its existing `operationError` entry — no new
  component), reading e.g.: *"Reset `{branch}` to `{targetAbbrevSha}`. `{previousAbbrevSha}`
  (`{previousSubject}`) is still reachable."* with an inline **Undo** button. This is a deliberate,
  explicit exception to `specs/drag-commit-menu.md`'s "no toast on a successful action" non-goal —
  justified specifically because, unlike that feature, this one has a real, actionable recovery step
  to offer, not a cosmetic confirmation; success here also visibly removes something from the graph,
  which a plain refresh alone doesn't explain.
- **FR-375**: The Undo button re-invokes the **exact same gated reset flow** (FR-369's danger
  callout and FR-371's second-tier `ConfirmDialog` fully re-evaluated, never bypassed) with `mode`
  fixed to whatever the original reset used and `targetSha` fixed to the captured previous SHA —
  i.e., undo is "reset back with the same mode," not an unconditional hard reset. This means undoing
  a Soft/Mixed reset can never itself discard uncommitted work, and undoing a Hard reset still
  triggers FR-369/371's full escalation if the working tree is dirty *again* at the moment Undo is
  clicked (e.g. the user made new edits in between) — Undo is never a one-click bypass of the same
  safety gates a fresh reset would go through.
- **FR-376**: The undo banner clears on: (a) explicit dismiss, (b) immediately after a successful
  Undo, or (c) the next repository-state refresh that observes `headSha` no longer equal to the SHA
  this reset produced (literally `targetSha`) — covering a new commit, a branch switch, another
  reset, or any other action that moved `HEAD` since. This closes a real, distinct trap: without it,
  clicking "Undo" after unrelated intervening `HEAD` movement would silently reset past that later
  state, under a button whose entire premise is "undo the one thing that just happened."
- **FR-377**: No network call anywhere in the full menu → dialog → reset (→ undo) flow; identical
  behavior on repos configured against GitHub, GitLab, Bitbucket, a self-hosted remote, and a purely
  local repo with no remote.

### Edge cases

Detached `HEAD` is fully supported and unrestricted — the dialog's copy substitutes "HEAD" for
`{branch}` throughout, and since no branch ref is involved, a Hard reset here has nothing to make
"unreachable from a branch" beyond `HEAD`'s own reflog. Bare repos disable the entry point entirely
(FR-366) rather than exposing a partial subset of modes. Unborn `HEAD` / a zero-commit repo has no
commit rows to trigger this from at all — no special-case gating needed. Worktrees need no
additional handling: the current branch is by definition checked out only in *this* worktree (git
disallows the same branch in two worktrees at once), and reset only ever touches this worktree's own
`HEAD`/index/working tree.

## Non-goals (v1 of this feature)

- **A target-branch picker, or resetting any branch other than the current one.** Matches
  `specs/drag-commit-menu.md` FR-299's "always acts on current HEAD, no picker" precedent. Moving a
  *different* branch's pointer is a distinct operation this feature doesn't attempt — switch to it
  first via the existing Branches panel/ref-chip Checkout.
- **Any ancestry-based restriction on which commits are valid targets.** Any commit in the graph is
  eligible, including one on an unrelated line of history — matching git's own permissiveness. The
  ancestry-aware copy (FR-368) communicates consequence; it never blocks a choice.
- **`git reset --keep` or `--merge`.** Real git flags, but narrow-purpose and not part of
  GitKraken/Sourcetree/Fork's own reset UI either. Soft/Mixed/Hard cover the entire mainstream use
  case; a fourth/fifth option here is scope creep.
- **Auto-stash-and-reset.** A dirty working tree is never silently stashed on the user's behalf
  before a reset — matches `specs/branch-management.md`'s existing "no auto-stash" non-goal for
  `git switch`. A user who wants to preserve uncommitted work before a Hard reset should stash it
  first via the already-shipped Stash feature.
- **A Command Palette entry or a direct keybinding.** Matches
  `specs/keyboard-shortcuts-command-palette.md`'s own existing non-goal for exactly this class of
  action (requires a specific selected target the palette has no mechanism to supply) — the same
  carve-out, not a new gap introduced by this spec.
- **A persisted, cross-session undo history, or an in-app reflog browser.** FR-374/375's Undo
  affordance lives only in memory for the current tab/session; closing the tab or the app loses it.
  Git's own reflog remains the durable fallback, which is what the roadmap's "reflog-based recovery"
  language scoped this to — a general "browse and restore any past HEAD position" tool is a
  materially larger, separate feature.
- **Adding this action anywhere besides the commit-row context menu** (not the ref-chip menu, not
  the Branches panel, not a multi-select bulk action). One deliberate entry point, matching where
  the stub already lived.
- **Rename/relabel of the already-existing "Create branch here…" item as a "non-destructive
  alternative" to reset.** It already exists and already serves that role
  (`specs/branch-management.md` FR-49/54).

## Acceptance criteria

1. On a repo with a current branch, the context-menu item reads "Reset `{branch}` to here…"; in a
   detached-`HEAD` session it reads "Reset HEAD to here…" — verified on both.
2. On a bare repository, the item is disabled with a reason naming the missing working tree; no
   dialog opens on click. Same for a repository with a merge/rebase/cherry-pick/revert/am/bisect
   already in progress, with a reason naming that operation.
3. Opening the dialog on any commit shows all three modes (Soft/Mixed/Hard) simultaneously, each
   with its own distinct one-line description, Soft pre-selected — verified that Hard is never the
   default and is never hidden behind a secondary disclosure.
4. Choosing Soft and confirming runs `git reset --soft` verified via: the branch ref moves to the
   target SHA (`git rev-parse <branch>`), the index and working tree are byte-for-byte unchanged
   from immediately before (`git diff --cached` / `git diff` reflect the undone commits' full
   content as staged), and no working-tree file is touched.
5. Choosing Mixed and confirming runs `git reset --mixed`: the branch ref moves, the index now
   matches the target commit's tree, and the undone commits' changes appear as unstaged
   modifications in the working tree — verified via `git status --porcelain`.
6. Choosing Hard on a clean working tree resets immediately with a single dialog click (no second
   confirmation): the branch ref, index, and working tree all match the target commit exactly —
   verified via `git status --porcelain` reporting clean and `git diff <target> HEAD` reporting
   nothing.
7. Choosing Hard with staged and/or unstaged tracked-file changes present shows the exact counts in
   a danger callout and requires a second, separately-worded `ConfirmDialog` before any git call is
   made; canceling either dialog leaves `HEAD`, the index, and every working-tree file byte-for-byte
   unchanged.
8. Confirming that second dialog performs the hard reset, and afterward: every previously-tracked
   uncommitted change is gone, but a coexisting untracked file present before the reset still exists
   afterward, unmodified — explicit verification that "untracked files are not affected" is real
   git behavior, not just claimed copy.
9. Soft and Mixed are both disabled, with an "already at this commit" reason, when the right-clicked
   commit is exactly the current `HEAD` commit; Hard remains enabled there and, with a dirty tracked
   working tree, still routes through the same FR-369/371 escalation as any other Hard reset.
10. The impact line reads correctly for all four ancestry relationships between the target and
    current `HEAD` (verified via a fixture repo covering ancestor, descendant, diverged, and
    unrelated-history pairs) plus the fifth "already here" case, including the correct commit count
    in each — and falls back to non-numeric wording without crashing when the count read is forced
    to fail.
11. After any successful reset, the commit graph, `HEAD`/branch decoration, `ChangesPanel`, and
    Toolbar all reflect the new state with no app restart or manual refresh.
12. A success banner appears naming the previous SHA and its subject with an Undo button; clicking
    Undo re-runs the identical mode against the previous SHA and restores the exact prior branch/
    `HEAD` position — verified for a Soft-then-undo, Mixed-then-undo, and Hard-then-undo(clean-tree)
    sequence each returning `git rev-parse HEAD` to its original value.
13. Undoing a Hard reset when the working tree has since become dirty again shows the exact same
    danger callout and second-tier confirmation FR-369/371 would show for a fresh Hard reset — Undo
    never performs an unconfirmed hard reset.
14. The undo banner disappears (without ever having been clicked) once any other action moves
    `HEAD` away from the SHA the reset produced — verified by resetting, then making a new commit
    (or performing another branch switch), then confirming the stale Undo banner is gone rather than
    still offered.
15. The context-menu item is unaffected by, and imposes no restriction based on, the ancestry
    relationship between the right-clicked commit and the current branch — verified by successfully
    opening and completing the flow against a commit on a completely unrelated line of history, with
    the fourth-variant copy (FR-368) shown.
16. Zero outbound network requests occur across the full menu → dialog → reset → undo flow, on
    repos configured against GitHub, GitLab, Bitbucket, a self-hosted remote, and a purely local
    repo with no remote.
17. In a detached-`HEAD` session, the entire flow behaves identically to the attached-branch case
    with "HEAD" substituted for the branch name throughout, and no branch ref is created or moved.
18. Re-running the Command Palette's existing test suite
    (`specs/keyboard-shortcuts-command-palette.md`) passes unchanged — this feature adds no palette
    entry and no new global keybinding.

## Security review

**Yes, a standard security-reviewer pass is required**, per `AGENTS.md`'s normal workflow — but this
is a materially different risk profile from the online-sync work: no credentials, no network calls,
and no new attack surface from an untrusted remote host. The two things actually worth a close look:
(1) the same argv-array/`shell: false`/`withEndOfOptions()` discipline already required of every
other mutating git-core call, applied to `resetCurrentBranch`'s `targetSha` argument before it
reaches `git reset`; and (2) that FR-369/371's danger-callout-and-escalation logic can't be raced or
bypassed by a stale `workingDirStatus` read — i.e., confirm the dirty-working-tree check that gates
the second confirmation dialog is evaluated against a sufficiently fresh read, not a snapshot that
could be stale by the time the user clicks confirm.
