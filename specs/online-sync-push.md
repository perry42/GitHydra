# PRD: Online Sync — Push

Status: draft — **Phase 4 of 5** of V2's online-sync milestone, and the highest-risk of the four
sync primitives: it is the only one that mutates the shared remote. Depends on Phase 1
(`specs/online-sync-fetch.md`'s diverged indicator + credential-failure UX) and Phase 2
(`specs/git-identity-profiles.md`) both already shipped.

Sequencing: git-core-engineer builds first (push plumbing, non-fast-forward classification);
ui-graphics builds second (push action, upstream-setup picker, rejection messaging).
**security-reviewer review required before merge — confirm no code path can reach a force flag**;
see `specs/online-sync-security-flags.md`.

## Problem

A developer can commit (v1) and pull (Phase 3) but still cannot publish their work from GitHydra —
the last remaining step of the core clone/fetch/pull/push loop.

## Target user

Same as prior phases — developers pushing an existing tracked branch, or publishing a brand-new
local branch for the first time, against any host or self-hosted remote.

## Must-have behavior

- **FR-344:** `push(remote, localBranch)` runs `git push <remote> <localBranch>:<upstreamBranch>`
  for an already-tracked branch. Plain push only — see Non-goals for the force/delete exclusions,
  which are a confirmed product decision for this phase, not an oversight.
- **FR-345:** Pushing a branch with no configured upstream yet uses
  `--set-upstream <remote> <branch>`, with a remote picker shown only when more than one remote
  exists (single-remote repos default to it with no extra click).
- **FR-346:** A non-fast-forward rejection is classified distinctly from other push failures (parse
  git's real "rejected... non-fast-forward" stderr) and surfaced as a specific, actionable message
  — "the remote has commits you don't have; pull first" — pointing at Phase 3's Pull action.
  **Never** auto-retries with any force flag, and never offers a one-click "force it" escalation.
- **FR-347:** Phase 1's diverged indicator gates and captions the push action: pushing while the
  local branch is BEHIND its upstream shows a warning before the push is even attempted (since git
  will reject it anyway), rather than letting the user discover divergence only via a failed push.
- **FR-348:** Push progress/cancel and credential-failure classification reuse Phase 1's exact
  infrastructure — no parallel implementation.
- **FR-349:** Push is available from the Toolbar + Command Palette, disabled with a stated reason
  for a bare repo, detached HEAD, unborn HEAD, or an operation in progress.
- **FR-350:** Tags are **never** pushed as an automatic side effect of a branch push. Publishing a
  tag, if ever built, is a separate explicit action.

## Non-goals

- **Force push in any form** (`--force`, `--force-with-lease`, `-f`) — confirmed product decision.
  An explicit non-goal, not a deferred-with-intent-to-revisit-soon item.
- **Deleting a remote branch or tag** (`git push origin --delete`, `:branch`) — confirmed product
  decision, same as above.
- **`--tags`, `--all`, `--mirror`.**
- **Any "just fix it for me" escalation after a rejected push.**
- **Branch-protection-rule awareness** — a host-specific server-side concept, permanently out of
  scope (same reasoning as `branch-management.md`'s equivalent non-goal).

## Acceptance criteria

1. Pushing a fast-forwardable local branch succeeds; the remote's actual ref (verified against the
   bare fixture) matches the pushed local tip, and the local remote-tracking ref updates to match.
2. Pushing a brand-new local branch with no upstream sets it via `--set-upstream`, and its
   ahead/behind subsequently computes correctly with zero manual config needed.
3. Pushing a branch whose remote has diverged is rejected; the UI shows the specific "pull first"
   message; the remote's ref is unchanged afterward.
4. Attempting to push while behind (FR-347) shows the pre-attempt warning before the push call is
   made.
5. A credential failure during push shows the identical classified-message / collapsible-raw-stderr
   UI Phase 1 established, with any credential embedded in the remote URL redacted.
6. A black-box argv-inspection test (mirroring `noNetworkCalls.test.ts`'s technique) confirms
   `--force`, `-f`, `--delete`, and `--mirror` never appear in any push-related spawn call — across
   the clean-push, non-fast-forward-rejected, and new-branch-with-upstream code paths.
7. Zero network calls beyond the single push attempt — no incidental fetch or pull triggered as a
   side effect.
