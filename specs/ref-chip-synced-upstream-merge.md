# Ref-chip: merge a local branch with its exactly-synced upstream into one chip

## Problem

A local branch and its remote-tracking upstream, sitting on the same commit and fully in sync
(neither ahead nor behind), always render as two independent chips today (`buildRefChips()`,
`refChips.ts`). That's the common, unremarkable state for an actively-fetched repo — "this branch,
and yes, its remote copy is identical" — but it costs a second chip's worth of gutter width and,
once a third ref lands on the same commit, forces the "+N" collapse (`specs/ref-chip-gutter-
legibility.md` FR-408) a beat earlier than necessary. Raised directly by the user while reviewing
the "+N" popover-icon fix (`fix/ref-collapse-popover-icons`): "if I got main and got remote/main
and they're at the same level (fetch), why not just put both icons in the same place?"

## Target user

Any user with at least one fetched remote whose local branch is currently up to date with its
configured upstream — a very common state, not an edge case.

## Must-have behavior

- **FR-1 — Detect "exactly synced with a real, configured upstream."** `listBranches()` (already
  called by `useDivergedBranches.ts`) already returns, per local branch: `upstreamName` (the
  configured upstream's short name, e.g. `"origin/main"`, or `null`), `upstreamGone` (upstream
  configured but its remote-tracking ref no longer exists on disk), and `ahead`/`behind` (`number |
  null`). A branch is "exactly synced" iff `upstreamName != null && !upstreamGone && ahead === 0 &&
  behind === 0`.
- **FR-2 — Reuse the existing fetch, add a second derived map alongside the existing diverged set.**
  `useDivergedBranches.ts` already does exactly one `listBranches()` call per refresh and derives
  the `diverged` set from it — broaden its return value to
  `{ diverged: ReadonlySet<string>; syncedUpstream: ReadonlyMap<string, string> }` (local branch
  name → its upstream's short name, only for "exactly synced" branches per FR-1), computed from the
  SAME already-fetched response. No new IPC call, no new git process spawn. Every existing caller of
  the hook's return value (currently used only as `divergedBranchNames` directly) updates to read
  `.diverged` instead of the hook's old bare return.
- **FR-3 — Merge in `buildRefChips()`.** New optional param `syncedUpstreamByBranch: ReadonlyMap<string,
  string> = new Map()` (mirrors `divergedBranchNames`'s own existing optional-param convention).
  When processing a `local-branch` decoration whose name is a key in this map, look for a
  `remote-branch` decoration ALSO in `commit.refs` whose `.name` equals the mapped upstream short
  name (not just "any remote-branch decoration" — must be the actual configured upstream, matched by
  name). If found: emit ONE `RefChipSpec` for the pair (not two) — the local decoration stays
  `decoration`, plus a new `syncedRemote: RefDecoration | null` field carrying the matched
  remote-branch decoration; that remote decoration is consumed and never separately pushed to the
  `chips` array. If no matching remote-branch decoration is on this commit (upstream synced but
  simply not decorating this exact commit — can't happen for the branch's own tip, but guard anyway),
  falls through to today's single-chip behavior, `syncedRemote: null`. Tags, detached HEAD, and any
  local branch NOT in the synced map are entirely unaffected — still exactly today's per-decoration
  behavior.
- **FR-4 — `RefChip.tsx` renders both icons when `syncedRemote` is set.** Two icons before the
  label — the existing local-branch icon (`IconBranches`) immediately followed by the remote-tracking
  icon (`IconRefRemote`), both `size={14}`, `gap` matching the existing icon-to-label gap (no new
  token) — then ONE label (the local branch's own name, never doubled/duplicated). Existing
  `filled`/`detached`/`diverged` props behave exactly as today (a synced-merged chip can still be
  `filled` when it's the checked-out branch). New chip modifier class `gh-refchip--synced-upstream`
  for the double-icon flex layout only — no color, no fill, consistent with this component's
  existing "never color alone" policy.
- **FR-5 — Accessible label states the merge explicitly.** `refChipAccessibleLabel()` gains an
  optional `syncedRemoteName?: string` param; when present, appends
  `` ` (synced with ${syncedRemoteName})` `` to the existing string (e.g. `"local branch: main
  (synced with origin/main)"`) — never relies on the two icons alone to convey the merge (this
  system's "never color/icon alone" policy extended to this new case). `diverged` and
  `syncedRemote` are mutually exclusive in practice (a diverged branch is by definition not
  `ahead===0 && behind===0`), but the function should not assume that invariant — if both were
  somehow true, `diverged`'s suffix takes precedence (diverged is the more actionable state).
- **FR-6 — Collapse-trigger arithmetic needs no code change.** `specs/ref-chip-gutter-legibility.md`
  FR-408's `chips.length >= 2` already operates on the POST-merge `chips` array — a merged pair
  naturally counts as one entry, so the collapse mechanism, the "+N" popover, and the HEAD-badge
  `iconOnly` crowding fix all continue working exactly as already shipped, with no changes needed
  to `CommitRow.tsx`'s collapse logic itself (FR-409's visible-slot priority — filled, then
  detached-HEAD, then `chips[0]` — is unaffected: a merged chip is just one entry like any other,
  and can itself be the `filled` one).
- **FR-7 — The "+N" popover's own per-row icon (this session's `fix/ref-collapse-popover-icons`
  change) also needs the double-icon treatment** when a collapsed row happens to be a merged
  synced-upstream chip — reuse the same two-icon rendering, not just the single `TYPE_ICON` lookup.

## Non-goals

- Merging two LOCAL branches, or a branch with a same-named tag — only a local branch + its own
  actual configured upstream remote-tracking ref.
- Any special treatment for "ahead only" or "behind only" (fast-forwardable, one direction) —
  unaffected, stays two separate chips exactly as today; only the EXACT `ahead===0 && behind===0`
  case merges.
- Any change to `divergedBranchNames`'s own existing diverged-glyph behavior (FR-326) — untouched,
  still its own independent signal, now just sourced from the same broadened hook return value.
- Any new IPC call or git process spawn — reuses the exact `listBranches()` call already being made.

## Acceptance criteria

1. A local branch and its exactly-synced upstream on the same commit render as ONE chip with two
   icons (branch-fork then cloud) and one label — not two chips, not collapsed via "+N" unless a
   third real ref also lands on that commit (FR-3/FR-6).
2. A local branch that's ahead-only, behind-only, or fully diverged from its upstream (or has no
   upstream at all) renders exactly as today — two separate chips, no merge (FR-1/FR-3).
3. The merged chip's `aria-label`/`title` states both the branch name and the synced-upstream name
   in words, e.g. "local branch: main (synced with origin/main)" — never relies on seeing two icons
   to know this (FR-5).
4. The "+N" popover, when a collapsed row is itself a merged synced-upstream chip, shows both icons
   for that row too, not just the local-branch icon (FR-7).
5. No new IPC call or git process spawn is introduced — `useDivergedBranches.ts` still makes exactly
   one `listBranches()` call per refresh (FR-2).
6. Real-Electron screenshot verification: a repo with a local branch fetched and fully in sync with
   its upstream (`git fetch` after no local changes) shows one merged chip with both icons legible
   in both themes — not sufficient to verify via DOM/class assertions alone, consistent with this
   area's established convention.
7. Every existing test referencing `useDivergedBranches`'s return value, `buildRefChips()`,
   `RefChip`, or `refChipAccessibleLabel()` continues to pass, updated only where the hook's return
   shape or new optional params require it — no unrelated behavior change.
