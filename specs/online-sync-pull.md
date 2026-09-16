# PRD: Online Sync — Pull

Status: draft — **Phase 3 of 5** of V2's online-sync milestone. Depends on Phase 1
(`specs/online-sync-fetch.md`'s fetch primitive) and reuses the already-shipped merge/rebase
conflict-resolution UI wholesale — **this phase adds no new conflict UX.**

Sequencing: git-core-engineer builds first (compose pull from existing primitives); ui-graphics
builds second (pull action + strategy control, wiring into the existing conflict/operation-banner
components).

## Problem

Fetch (Phase 1) tells a developer their branch is behind; there is still no way to actually bring
those commits in without leaving GitHydra for a terminal `git pull`.

## Target user

Same as Phase 1 — developers who need their current branch brought up to date with its upstream,
via merge or rebase depending on their own (or the repo's) configured preference.

## Must-have behavior

- **FR-338:** `pull()` in `packages/git-core` is composed from EXISTING primitives, never a literal
  `git pull` subprocess call: Phase 1's `fetchRemote()` for the current branch's upstream remote,
  followed by either `mergeCommit()` or `rebaseCommitOnto()` (both already shipped,
  `drag-commit-menu.md` FR-297/298) targeting the freshly-fetched upstream ref. This guarantees a
  pull-triggered conflict reaches the identical, already-tested
  `ConflictResolutionView`/operation-banner/Continue/Abort flow with zero new code.
- **FR-339:** The integrate strategy default follows the repo's own existing git config exactly as
  real `git pull` would (`pull.rebase`, `branch.<name>.rebase`), never a GitHydra-imposed default —
  with an explicit per-pull override control in the UI for that one pull only. This feature never
  writes those config keys.
- **FR-340:** If the current branch can fast-forward, no merge or rebase step runs at all — a plain
  ref update, matching git's own behavior and producing zero conflict UI.
- **FR-341:** Pull only ever acts on the current branch and its own configured upstream — matching
  `git pull`'s own scope. No "pull a different branch while staying checked out elsewhere"
  affordance.
- **FR-342:** Pull never discards local commits. The rebase branch always uses the already-shipped
  rebase's existing abort/continue contract, and a failed or aborted pull-triggered merge/rebase
  returns the branch to its exact pre-pull commit. (This is already guaranteed by the reused
  components; this FR asserts the guarantee holds when reached via pull, not only via the graph's
  own drag-menu entry point.)
- **FR-343:** Pull is available from the Toolbar + Command Palette, disabled with a stated reason
  when there is no configured upstream, a bare repo, an unborn HEAD, or an operation already in
  progress — matching the app's existing disabled-with-reason convention.

## Non-goals

- **Auto-pull** on any implicit trigger.
- **Squash-pull or any non-default integrate strategy.**
- **Pulling into a branch other than the current one.**
- **Resolving conflicts differently than the shipped merge/rebase UI already does** — no new
  conflict interaction is designed or built here.

## Acceptance criteria

1. Pulling a fast-forwardable branch moves HEAD forward with zero conflict UI and no merge/rebase
   invocation.
2. Pulling a diverged branch with the repo's config set to merge produces a real merge commit via
   the existing `mergeCommit()` path — verified by the resulting commit having two parents.
3. Pulling the same divergence with rebase selected replays local commits via the existing
   `rebaseCommitOnto()` path — verified via the resulting linear history and rewritten commit SHAs.
4. A conflicting pull shows the exact same `ConflictResolutionView` component already used by a
   manual merge (same class names and behavior, not a lookalike) — confirmed by reusing that spec's
   own test assertions against a pull-triggered conflict.
5. Aborting a pull-triggered merge/rebase leaves the branch's tip SHA identical to what it was
   immediately before Pull was clicked.
6. No `--force`, `-f`, or any destructive flag ever appears in argv for any pull-related spawn call
   — verified via the same black-box argv-inspection technique `noNetworkCalls.test.ts` already
   uses.
7. Zero network calls beyond the one fetch per pull — no incidental second fetch, no push.
