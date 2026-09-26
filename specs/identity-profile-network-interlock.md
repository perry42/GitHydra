# Spec: Identity-Profile Apply/Remove ↔ In-Flight Network-Op Interlock

Status: draft — ready for implementation. Small, already-decided fix (`ROADMAP.md`'s "No interlock
between identity-profile apply/remove and an in-flight fetch/pull/push/clone" entry), not a new
feature area. No git-core changes; entirely a `packages/desktop` UI-layer fix, following the exact
precedent `lib/pushEligibility.ts`/`lib/pullEligibility.ts` already established for "disabled, with a
stated reason, while X is running."

## Problem

`IdentityProfilesDialog`'s Apply and Remove actions (`specs/git-identity-profiles.md` FR-330/FR-336)
have no awareness of whether a fetch, pull, or push is currently running against the same open repo.
A user can apply a different identity profile (changing `user.name`/`user.email`/`core.sshCommand`)
or remove the currently-applied one while, say, a push's child `git` process is still mid-flight —
which SSH key/committer identity that in-flight push actually used can then end up inconsistent with
whatever the UI shows as "current" the moment the apply/remove call resolves. Not a data-integrity or
privilege issue (per the ROADMAP finding: git reads config once per invocation, and config writes are
lock-protected) — a UX-consistency issue only. Already decided by product: disable Apply/Remove while
a network op targets the open repo, mirroring the app's existing "operation already in progress"
disabled-with-reason convention (`pushEligibility.ts`/`pullEligibility.ts`).

## Target user

Any GitHydra user with `IdentityProfilesDialog` open against a repo that also has a remote —
i.e., anyone using more than one git identity across repos, on any host (GitHub/GitLab/Bitbucket/
self-hosted) or none.

## Must-have behavior

- **FR-380: Definition of "a network op targets the open repo."** The interlock reads exactly the
  three existing, already-live signals `App.tsx` computes for the currently active tab —
  `fetchAction.isFetching`, `pullAction.isPulling`, `pushAction.isPushing` (`useFetchAction.ts`/
  `usePullAction.ts`/`usePushAction.ts`) — the SAME single-instance flags that already disable the
  Toolbar's own Fetch/Pull/Push buttons for the active tab. No new "which tab does this op belong to"
  tracking is introduced: since these three hooks are each one instance owned by `App`, not one per
  tab, and `IdentityProfilesDialog` is only ever rendered against the currently active tab's
  `repoPath` (it already closes on any open-repo change — see `App.tsx`'s existing effect resetting
  `identityProfilesOpen`), reading these three flags is definitionally "does a network op target the
  repo this dialog is currently showing." This spec does not change, and does not need to resolve,
  whatever these three hooks' flags mean across a tab switch — that is pre-existing, already-shipped
  behavior (`specs/multi-repo-tabs.md`) this fix inherits as-is, not something reopened here.
- **FR-381: Clone is explicitly excluded from this interlock's condition**, despite being named in
  the ROADMAP entry. `CloneDialog` always targets a not-yet-open destination path — never the
  already-open repo `IdentityProfilesDialog`'s "This repository" section is showing status for — and
  `git clone` itself refuses to write into a non-empty destination directory, so a concurrent clone
  can never coincide with the already-open repo's own directory. There is nothing for this interlock
  to gate against for clone; no clone-related check is added anywhere in this fix.
- **FR-382: New pure function** `computeIdentityNetworkOpDisabledReason(isFetching: boolean,
  isPulling: boolean, isPushing: boolean): string | null`, added to the existing
  `packages/desktop/src/lib/identityNotices.ts` (not a new file — same module that already owns
  `IdentityProfilesDialog`'s other pure reason/notice functions, FR-378/FR-379). Checked in this exact
  priority order (matches the Toolbar's own left-to-right Fetch/Pull/Push button order) and returns
  the first that applies:
  1. `isFetching` → `"a fetch"`
  2. `isPulling` → `"a pull"`
  3. `isPushing` → `"a push"`
  4. none → `null`
- **FR-383: `App.tsx` passes this computed value down** to `IdentityProfilesDialog` as a new prop,
  `networkOpDisabledReason: string | null`, computed once per render as
  `computeIdentityNetworkOpDisabledReason(fetchAction.isFetching, pullAction.isPulling,
  pushAction.isPushing)` — all three values already exist in scope in `App.tsx` at the point
  `IdentityProfilesDialog` is rendered (no new state).
- **FR-384: Apply button (`ProfileRow`) disabling.** `IdentityProfilesDialog` forwards
  `networkOpDisabledReason` down to each `ProfileRow`. The Apply button's `disabled` expression
  becomes `!repoOpen || busy || Boolean(networkOpDisabledReason)` (was `!repoOpen || busy`). Reason
  priority for the button's `title` (never color-only, matching this dialog's existing convention):
  1. `!repoOpen` → existing copy, "Open a repository to apply this profile." (unchanged)
  2. `busy` (this dialog's OWN apply/remove call is running) → no title needed; the button's own
     label already reads "Working…" (unchanged)
  3. `networkOpDisabledReason` set → **"Disabled while {networkOpDisabledReason} is in progress on
     this repository."** (e.g. "Disabled while a push is in progress on this repository.")
  4. none of the above → no title (unchanged)
- **FR-385: Remove button disabling.** In `IdentityProfilesDialog`'s "This repository" section, the
  "Remove applied profile" button's `disabled` expression becomes `application.busy ||
  Boolean(networkOpDisabledReason) || !hasAnyManaged` (was `application.busy || !hasAnyManaged`).
  Reason priority for its `title`:
  1. `application.busy` → no title needed (unchanged — this button has no busy-specific label change
     today and this fix doesn't add one)
  2. `networkOpDisabledReason` set → identical copy pattern as FR-384's item 3: **"Disabled while
     {networkOpDisabledReason} is in progress on this repository."**
  3. `!hasAnyManaged` → existing copy, "No GitHydra-applied identity to remove from this repository."
     (unchanged)
  4. none of the above → no title (unchanged)
- **FR-386: Live re-evaluation, no polling.** Because `networkOpDisabledReason` is derived directly
  from `fetchAction.isFetching`/`pullAction.isPulling`/`pushAction.isPushing` — each already a plain
  React state value that flips the instant its own hook's `runFetch`/`runPull`/`requestPush` starts
  and the instant it settles — Apply/Remove flip disabled/enabled in the same render pass as the
  Toolbar's own Fetch/Pull/Push buttons, with no new subscription, polling, or IPC round-trip added.

## Non-goals

- **No reverse interlock.** This fix is explicitly one-directional, matching the already-decided
  product call verbatim ("disable apply/remove while a network op targets the open repo"): it does
  **not** disable Fetch/Pull/Push while an identity apply/remove is running. Rationale: apply/remove
  is a fast, synchronous pair of local `git config` writes (typically resolving in low tens of
  milliseconds), not a long-running operation a user would realistically try to start a network op
  underneath — the risk this ROADMAP entry closes is specifically "changing identity during a slow
  network op," not the reverse. Reopening this direction is a separate, future product decision, not
  folded into this fix.
- **No new "which tab" infrastructure.** As covered in FR-380, this fix adds no new per-tab tracking
  of network-op state — it reuses the exact three flags that already exist, exactly as they already
  behave across a tab switch today. If a future fix changes what `isFetching`/`isPulling`/`isPushing`
  mean across a tab switch, this interlock inherits that change automatically with no code here
  needing to change.
- **No git-core changes.** `applyIdentityProfile()`/`removeIdentityProfileApplication()` are
  untouched — this is a client-side disabled-with-reason gate only, identical in kind to
  `pushEligibility.ts`/`pullEligibility.ts`'s own client-side-only gating (their own doc comments
  explain why git-core deliberately doesn't enforce these itself).
- **No change to what an already-in-flight op does with the identity it started with.** A fetch,
  pull, or push that was already running before this interlock disabled Apply/Remove keeps running
  and keeps using whatever identity/SSH config was in effect at the moment IT started — this fix
  never cancels, restarts, or re-authenticates an in-flight op, and never retroactively changes what
  it used.
- **No credential-storage changes of any kind.** Nothing about how SSH keys or credentials are
  stored, read, or validated changes — see `specs/git-identity-profiles.md`'s own Non-goals for the
  full list this fix inherits unmodified.
- **No new toast/banner.** The existing disabled-button-plus-`title` pattern is the entire feedback
  surface — no new `StatusBanner` entry, no new dismissible notice.

## Acceptance criteria

1. With a repo open and a fetch in flight (`fetchAction.isFetching === true`), every profile row's
   Apply button in `IdentityProfilesDialog` is disabled with the title "Disabled while a fetch is in
   progress on this repository."; the moment the fetch settles (success or failure), every Apply
   button re-enables in the same render with no manual refresh or dialog reopen needed.
2. Same as AC1, substituted for an in-flight pull ("a pull") and an in-flight push ("a push") —
   verified independently for each of the three ops.
3. The "Remove applied profile" button shows the identical FR-385 behavior: disabled with the
   matching "Disabled while {op} is in progress on this repository." title while any of
   fetch/pull/push is in flight, re-enabling the instant it settles (assuming `hasAnyManaged` is
   otherwise true).
4. When two network ops happen to be in flight simultaneously (e.g. a fetch started, then a pull
   started before the fetch settled), the shown reason follows FR-382's fixed priority — fetch beats
   pull beats push — verified by triggering fetch-then-pull and confirming the title still reads "a
   fetch" until the fetch specifically settles, then re-evaluates.
5. Clicking Apply or Remove while `networkOpDisabledReason` is set makes zero `applyIdentityProfile`/
   `removeIdentityProfileApplication` IPC calls — verified the button's `onClick` handler is
   unreachable (native `disabled` attribute), not merely that the call happens to no-op.
6. With no network op in flight, Apply/Remove behave exactly as before this fix (no regression to
   the existing `!repoOpen`/`busy`/`!hasAnyManaged` disabled-reason paths, each independently
   verified still showing their original copy unchanged).
7. Opening `CloneDialog` and starting a clone, with `IdentityProfilesDialog` also open against an
   already-open, unrelated repo, does NOT disable that repo's Apply/Remove buttons — confirming
   FR-381's clone exclusion is real, not just documented.
8. A black-box test confirms `computeIdentityNetworkOpDisabledReason` is a pure function (no IPC, no
   git-core import) — called directly with each of the 8 boolean combinations of
   (isFetching, isPulling, isPushing) returns exactly the FR-382 priority-ordered result for each.
9. Toolbar's own Fetch/Pull/Push buttons are unaffected by this fix — they still disable/enable
   purely on their own `isFetching`/`isPulling`/`isPushing`, with no new dependency on
   `IdentityProfilesDialog`'s open/closed state (proving FR-386/Non-goals' "no reverse interlock").
