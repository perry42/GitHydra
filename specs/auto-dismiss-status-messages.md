# PRD: Auto-dismiss for plain success banners

Status: approved by the user (2026-09-30), scoped by product-manager.
Owner: product-manager. Builds on `specs/online-sync-fetch.md`, `online-sync-pull.md`,
`online-sync-push.md` (the three "done" banners) and supersedes one non-goal in
`specs/graph-head-indicator-and-refresh-alerting.md`. FR numbers continue from FR-439.

## Problem
Fetch, Pull and Push each leave a neutral "done" banner ("Already up to date", "Pushed main to
origin/main") that stays until the user clicks Dismiss. For the common, uneventful outcome that is
pure noise: the banner has told the user what it had to, and every repeated sync stacks one more
thing to close by hand.

## Target user
Anyone who fetches/pulls/pushes often and wants the routine "it worked" confirmation to get out of
the way, without ever losing a message they need to act on or read carefully.

## Must-have
- **FR-440:** Only these plain success/info "done" banners auto-dismiss: `FetchStatusBanner` (every
  remote ok, at most 2 result lines; or "No remotes configured"), `PullStatusBanner` (every
  non-error outcome: up to date, fast-forwarded, rebased, merge commit) and `PushStatusBanner`
  ("Pushed X to Y", "Published X and set upstream").
- **FR-441:** Delay is 6s for short one-liners; copy longer than ~80 characters adds ~40ms per extra
  character, capped at 10s (`autoDismissDelayFor`).
- **FR-442:** Removal is instant: no fade or animation, so it is inherently reduced-motion safe.
- **FR-443:** The manual Dismiss button stays. The banner keeps `role="status"` (and `aria-live` where
  it already had it). Appearing or disappearing never moves focus.
- **FR-444:** The timer pauses while the pointer hovers the banner, while focus is inside it, and
  while the window is unfocused or the document hidden. On resume the FULL delay restarts.
- **FR-445:** Starting a new Fetch/Pull/Push cancels any pending timer (the hook is keyed on the
  feature's sequence counter and only active in the success phase), so a stale timer can never dismiss
  a newer banner.
- **FR-446:** Mechanism is one small shared hook, `hooks/useAutoDismiss.ts`, reusing
  `.gh-status-banner` and the existing `onDismiss` wiring in `App.tsx`.
- **FR-447 (never auto-dismiss):** errors and warnings, in-flight banners, anything with an action
  button other than Dismiss, `role="alert"`, repo-state banners (operation in progress, detached HEAD,
  bare, shallow), `LeftBehindBanner`, `CherryPickEmptyResultNotice`, the reset-undo banner, the
  "History changed outside GitHydra" banner, any Fetch result in which ANY remote failed, and a
  multi-remote fetch success list longer than 2 lines.

## Non-goals
- No toast stack, container, queue or overlay; no settings toggle; no fade/slide animation.
- No auto-dismiss for any other surface. Audit (2026-09-30) of `packages/desktop/src/components`
  found no other plain-success banner; the Clone dialog's completion is a dialog flow, not a banner.

## Acceptance criteria
1. With fake timers, a success banner is gone ~6s after it appears.
2. Hover at 5s holds the banner until the pointer leaves, then a full new delay runs.
3. Focus on Dismiss pauses; blur restarts the full delay.
4. Never auto-dismisses (one test each): fetch with a failed remote, fetch list > 2 lines, pull error,
   push rejection, operation banner, left-behind banner, reset-undo banner, history-changed banner,
   in-flight banners.
5. A new fetch/pull/push at 3s after a previous banner clears that banner's pending timer.
6. Reduced-motion: removal is instant (there is no animation at all).
7. `role="status"` is kept.
8. Window blur at 4s pauses; refocus restarts the full delay.
9. Manual Dismiss before the timer works and the timer does not fire again.
Tests: `packages/desktop/src/hooks/useAutoDismiss.test.tsx`; real-Electron check:
`packages/desktop/e2e-playwright/electron/autoDismissBanner.spec.ts`.
