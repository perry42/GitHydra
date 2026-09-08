# Remember last-selected file within a tab

## Problem

A tab already remembers its selected commit and which right panel (Changes/DetailPanel/etc.) is
open (`useRepoTabs.ts`'s `RepoTabRemembered`), but not which specific file was selected inside
that panel's file list. `ChangesPanel` remounts on every tab switch (`App.tsx`'s
`key={graph.openSequence}`), and `DetailPanel`'s own auto-select effect re-fires whenever the
active commit's sha changes — which a tab switch away-and-back always triggers via
`graph.selectCommit()`. Both always land back on the *first* file (`files[0]` / first-diffable
entry), silently discarding whichever specific file the user was actually looking at. For a commit
or working-directory change touching many files, switching tabs to check something else and coming
back means re-finding and re-clicking the same file every time.

## Target user

Any GitHydra user working across multiple open tabs in one session (the common case now that
`specs/multi-repo-tabs.md` and `specs/restore-tabs-on-relaunch.md` make multi-tab, multi-session
usage the norm) who reviews a specific file's diff, switches tabs, and comes back expecting to
still be looking at that file — no dependency on git host or remote presence, since this is pure
local per-tab UI state.

## Must-have behavior

- FR-215: `RepoTabRemembered` gains a new field capturing the last file selected in whichever
  file-list panel was open — a path for DetailPanel's commit file list, and a
  `{ category: "staged" | "unstaged" | "untracked"; path: string }` pair (reusing
  `useChangesPanel.ts`'s existing `SelectedFile` shape) for ChangesPanel's working-directory file
  list. Persisted through the exact same `SESSION_TABS_KEY` `localStorage` payload
  `restore-tabs-on-relaunch.md` already writes — no new storage key, no new persistence mechanism.
- FR-216: Whenever a tab is backgrounded (an ordinary tab switch, a `closeTab`-triggered adjacent
  reactivation, or the app quitting), the currently-selected file — if any, in whichever panel is
  open — is captured into that tab's `remembered` state, at the same point `selectedSha`/`filter`/
  `showAllRefs`/`rightPanel` already are (`snapshotActiveTab` and equivalents in `useRepoTabs.ts`).
- FR-217: On tab activation (an ordinary switch, `closeTab`'s adjacent reactivation, or app-relaunch
  restoration) where `remembered.rightPanel === "commit"`: if a remembered file path exists and is
  present in the freshly-loaded commit's changed-file list, DetailPanel selects and loads that
  file's diff instead of auto-selecting `files[0]`. If the remembered path is absent, or no longer
  present in that commit's file list, falls back to the existing `files[0]` auto-select
  (`detailpanel-auto-diff.md` Must-have #1, unchanged).
- FR-218: On tab activation where `remembered.rightPanel === "changes"`: if a remembered
  `{category, path}` exists and that file is still present in that category of the freshly-loaded
  working-directory changes, ChangesPanel selects and loads that file's diff instead of
  auto-selecting the first diffable entry. If the remembered file is absent, or no longer diffable
  in that category (staged since unstaged, discarded, committed, moved to Conflicted), falls back
  to the existing Staged → Unstaged → Untracked first-entry auto-select
  (`detailpanel-auto-diff.md` Must-have #2, unchanged).
- FR-219: This restoration only ever fires at tab-activation time (FR-217/FR-218's trigger). It
  does not change, and must not regress, the already-shipped, deliberate behavior for ordinary
  same-tab commit-to-commit navigation within one continuous session
  (`specs/detailpanel-auto-diff.md`'s Non-goals / AC9, and `useChangesPanel.ts`'s `reloadToken`
  re-select-first behavior): clicking commit A, then commit B, then commit A again in the *same*
  tab with no tab switch in between continues to reset to `files[0]` on every reselection, exactly
  as today.
- FR-220: Pure renderer/app-level state — no `git-core` or IPC contract change, same shape as
  `specs/repo-list.md`/`specs/restore-tabs-on-relaunch.md`'s persisted-state additions. No new git
  calls or network calls anywhere in this feature; restoring a remembered file reuses data already
  fetched by the existing commit-detail / working-directory-changes load path (the "is this file
  still present" check in FR-217/FR-218 is a lookup against data already in memory, never a
  separate git read keyed on the remembered path).

## Non-goals

- Remembering a file selection across ordinary same-tab commit reselection (no tab switch
  involved) — explicitly out of scope; this preserves `specs/detailpanel-auto-diff.md`'s existing,
  deliberate Non-goal/AC9 decision rather than re-litigating it. The ROADMAP intake note's
  "reselecting the same commit" phrasing conflated this with the real cross-tab gap; this spec
  scopes strictly to the tab-switch case.
- **Remember last search/filter per repo.** Separate item, explicitly on hold pending a scoping
  conversation with the user (`ROADMAP.md`) — not touched here.
- Remembering scroll position within the file list or the diff pane. Consistent with
  `restore-tabs-on-relaunch.md`'s own Non-goals ("everything else is cheap to refetch/re-derive on
  activation").
- StashPanel's own per-stash file selection (`useStashDiff.ts`). `rightPanel` already includes a
  `"stashes"` value, but the ROADMAP ask and the current gap are specifically about
  Changes/DetailPanel; extending the same pattern to StashPanel later is a natural, low-cost
  follow-up but not required for this pass.
- Any change to which file auto-selects on a genuinely fresh tab with no prior remembered
  selection — still `files[0]` / first-diffable-entry, unchanged from
  `specs/detailpanel-auto-diff.md`.
- Any new error/loading UI for a "file no longer exists" case — this is a silent, graceful fallback
  to the existing default selection (FR-217/FR-218), not a new visible state.

## Acceptance criteria

1. Open a commit with 3+ changed files in DetailPanel, click the 2nd (non-first) file, switch to a
   different tab, then switch back — the 2nd file's diff is showing again, with no additional
   click, not `files[0]`.
2. In ChangesPanel, select a non-first file in the Unstaged section, switch tabs and back — the
   same file (same category + path) is reselected, not the first diffable entry.
3. Within a single tab and session (no tab switch), clicking commit A, then commit B, then commit A
   again continues to show commit A's `files[0]` each time — unchanged by this feature.
4. If the remembered file no longer exists in the restored commit's file list, or the remembered
   working-directory file is no longer present/diffable in its remembered category (staged,
   discarded, committed, or moved to Conflicted since it was last viewed), tab activation falls
   back to the existing default selection (`files[0]` / first-diffable-entry) rather than erroring,
   showing a blank diff, or throwing.
5. Closing a tab that had a non-default file selected and reactivating the adjacent tab is
   unaffected — the adjacent tab's own remembered file (if any) is what replays, never the closed
   tab's.
6. Quitting the app with the active tab showing a non-default file selection, then relaunching,
   restores that same file's diff on that tab automatically (it's the eagerly-activated tab per
   `restore-tabs-on-relaunch.md` FR-210) — no extra click, via the same `SESSION_TABS_KEY` payload,
   no new storage key.
7. A tab whose `rightPanel` is `"none"` or `"stashes"` round-trips through a tab switch with no
   error regardless of whatever remembered-file value happens to be present (unused, harmlessly
   carried).
8. No additional git process spawns or IPC calls are introduced by this feature beyond what the
   existing commit-select / tab-activation path already performs — verified the same way
   `restore-tabs-on-relaunch.md` AC3 verifies its own lazy-activation call-count guarantee.
9. Works identically regardless of git host (GitHub/GitLab/Bitbucket/self-hosted/local-only) or
   remote presence, including a bare repository's Changes-panel-not-applicable case.

## References

- `packages/desktop/src/hooks/useRepoTabs.ts` — `RepoTabRemembered`, `snapshotActiveTab`,
  `activateTabCore`, `closeTab`'s adjacent-reactivation path: this feature extends exactly these,
  no new mechanism.
- `packages/desktop/src/hooks/useChangesPanel.ts` — `SelectedFile`/`DiffableCategory` (reused
  verbatim for FR-215's Changes-panel shape), `firstDiffableEntry`'s existing fallback order
  (FR-218's fallback, unchanged), `selectFile`.
- `packages/desktop/src/components/DetailPanel/DetailPanel.tsx` — the `currentSha`-keyed
  `useLayoutEffect` (lines 128-145) that FR-217 extends with a one-time remembered-path check.
- `specs/detailpanel-auto-diff.md` — Must-have #1/#2 (the first-file/first-diffable-entry
  auto-select this feature falls back to, unchanged) and its Non-goals/AC9 (the same-tab
  reselection behavior this feature explicitly does not touch, per this spec's Non-goals).
- `specs/restore-tabs-on-relaunch.md` FR-208/FR-210/FR-211 — the `SESSION_TABS_KEY` persistence
  and replay-on-activation mechanism this feature's FR-215/FR-217/FR-218 extend; that spec's own
  Non-goals already named this item as "orthogonal... can land in either order."
- `specs/repo-list.md` — the shipped precedent for pure renderer/app-level persisted state with no
  `git-core`/IPC contract change, same pattern this spec follows.
