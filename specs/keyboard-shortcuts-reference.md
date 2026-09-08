# Keyboard shortcuts reference screen

## Problem

`specs/keyboard-shortcuts-command-palette.md` shipped a global keybinding layer and a Ctrl/Cmd+K
Command Palette, but that spec's own Non-goals explicitly excluded a dedicated shortcuts/help
reference — "the palette itself is the closest thing to discoverability." That's not enough on its
own: the palette is transient (type, act, gone) and only reachable by a user who already knows to
press Ctrl/Cmd+K in the first place. There is still no single place a user can open to see, at their
own pace, the full list of what keyboard shortcuts exist and what they do — including the two direct
bindings (Ctrl/Cmd+K itself, and the Ctrl+Tab/Ctrl+Shift+Tab tab-cycle) that structurally can't
appear as palette entries at all (`commands.ts`'s own doc comment: opening the palette is palette UI
state, not an invocable command). A user coming from GitKraken/Sourcetree/Fork/any editor with a "?"
or "keyboard shortcuts" help screen expects one here too.

## Target user

Any GitHydra user, on any git host or none — pure local UI/interaction layer, identical regardless
of repo state, host, or remote presence, same as the parent spec.

## Must-have behavior

- FR-231: A new registry command, `"view-keyboard-shortcuts"` (label "Keyboard shortcuts"), added to
  the existing single command registry (`getCommands()` in `commands.ts`) — not a hand-maintained
  parallel list. It carries a direct keybinding, `Ctrl/Cmd+/`, and `isAvailable: () => true` (always
  present, repo open or not — see FR-233 for why availability doesn't gate this feature at all). Its
  `run` opens the reference screen via a new `openKeyboardShortcuts: () => void` field on
  `CommandContext`. Because it's an ordinary registry command with a keybinding, it needs **zero**
  new dispatch code: `useGlobalKeybindings`'s existing generic "look up by keybinding in the
  registry" loop (the same one that already fires `Ctrl+R`/`Ctrl+Enter` for "Refresh commit
  graph"/"Commit staged changes") handles `Ctrl/Cmd+/` automatically, and because it's a registry
  command it also appears in the Command Palette's own filtered list automatically. This gives it
  two entry points for free from one definition: the direct keybinding, and finding it inside the
  palette once a user has discovered Ctrl/Cmd+K. This is a deliberate reuse of FR-226/FR-227's
  existing mechanism, not a parallel one — it does not reopen FR-224's "fixed list" non-goal, which
  was specifically about selection-dependent actions (stage a file, cherry-pick a commit) the palette
  has no target-selection mechanism for; this command needs no target.
- FR-232: The reference screen is a centered modal overlay following the exact same convention as
  `NewBranchDialog`/`CreateStashDialog`/`ConfirmDialog`/`CommandPalette` (`role="dialog"`,
  `aria-modal="true"`, `Escape`-to-close, click-outside-to-close). Unlike the palette it has no text
  input to focus on open (nothing to type) — focus lands on the dialog container or an explicit close
  affordance instead.
- FR-233: The screen renders the **full** command registry, deliberately **ignoring each command's
  `isAvailable` predicate** — a reference shows everything the app can ever do, not just what's
  actionable in this exact moment (the opposite philosophy from FR-225's palette filtering, and a
  deliberate, spec'd deviation from it). Concretely: "Commit staged changes", "New branch…", "New
  stash…", and "Refresh commit graph" all appear even when no repo is open, even though the palette
  would hide every one of them in that state.
- FR-234: Each registry command gets a new required `category` field (`"tabs" | "view" | "git" |
  "general"`), assigned once per command inside `commands.ts` itself (the same single source of
  truth as everything else in the registry — not a second, independently-maintained grouping map
  elsewhere). The reference screen groups its rows under four headings, in this fixed order:
  - **Tabs** — New tab / Open repository, Close current tab, Switch to tab, Next/previous tab
  - **View** — Toggle Branches sidebar, Toggle Changes panel, Toggle Stashes panel, Toggle theme
  - **Git actions** — New branch, New stash, Commit staged changes, Refresh commit graph
  - **General** — Open Command Palette, Keyboard shortcuts
  Within a category, rows are shown in registration order (the registry's own array order) — no
  further sort. This is a fixed, small (~14-row) v1 list; alphabetizing within a category is not
  required.
- FR-235: The registry's per-tab `"switch-to-tab:<id>"` entries (one per currently open tab, per
  FR-224) are collapsed into a **single generic "Switch to tab" row** on this screen, with no
  keybinding shown, regardless of how many tabs happen to be open (0, 1, or many) — a reference
  screen is a stable, non-transient view of what the app can do, not a live readout of this session's
  open tabs, and there is no keybinding to switch to a specific tab anyway (only palette-selection or
  clicking `TabBar`).
- FR-236: Two additional static rows are shown that are **not** registry commands, because they
  can't be (per `commands.ts`'s own doc comment: opening the palette and relative tab-cycling each
  have no single fixed target/action to register) — this is exactly the gap a reference screen adds
  over the palette alone:
  - "Open Command Palette" — `Ctrl/Cmd+K` (shown under **General**)
  - "Next / previous tab" — `Ctrl+Tab` / `Ctrl+Shift+Tab` (`Cmd` variant on macOS) (shown under
    **Tabs**)
  These two rows' labels and key combos are defined in exactly one place (a small exported constant
  alongside `getCommands` in `commands.ts`, doc-commented as "must stay in sync with
  `useGlobalKeybindings.ts`'s hardcoded handling of these two non-registry bindings" — the one piece
  of unavoidable duplication in this feature, called out explicitly rather than left implicit for a
  future reviewer to rediscover).
- FR-237: A new App-owned boolean, `shortcutsOpen` (parallel to `showCreateStashDialog`/
  `newBranchRequest`, not a third bespoke hook-owned toggle like `paletteOpen`), is folded into
  `App.tsx`'s existing `anyModalDialogOpen` from the moment this feature lands — the same aggregate
  boolean that already suspends the entire global keybinding layer (FR-221) while any dialog,
  panel-local `ConfirmDialog`, or `ContextMenu` is open. This is the exact lift-up pattern the two
  prior review rounds (security-reviewer, then test-agent) each had to retrofit onto a gap in this
  same check — landing it correctly here from the start rather than leaving a third instance of that
  bug for a future round to find.
- FR-238: All keybinding text on the screen (including the two FR-236 static rows) is rendered via
  the existing `keyComboLabel` helper (`packages/desktop/src/lib/platform.ts`) — the same
  Cmd/Ctrl-translation the palette's own shortcut hints use, not a second, independently-maintained
  label formatter. Note: as of `feature/f5-refresh-keybinding`, "Refresh commit graph" carries two
  combos (`Ctrl/Cmd+R` and, Windows/Linux only, bare `F5`) via `Command.keybindings: KeyCombo[]` —
  render every combo in that array (joined, e.g. "Ctrl+R / F5"), the same way `CommandPalette.tsx`
  already does, not just the first one.

## Non-goals

- **A Toolbar button or Electron application-menu entry point.** v1 ships exactly the two entry
  points FR-231 gives for free (direct keybinding, palette entry) — no new Toolbar icon. The
  toolbar's icon count was already fixed by the "chrome hierarchy" design pass
  (`DESIGN.md`/`ROADMAP.md`) and this feature does not reopen that.
- **A search/filter input inside the reference screen itself.** The v1 list is ~14 rows across four
  fixed categories — short enough to scan without a filter box. Revisit only if the registry grows
  materially (e.g. once FR-224's selection-dependent-action fast-follow lands).
- **User-customizable/remappable keybindings.** Unchanged from the parent spec's Non-goals — this is
  a read-only reference, not a rebinding UI.
- **Any "currently available / unavailable" visual distinction per row** (e.g. greying out "Commit
  staged changes" when no repo is open). FR-233 already decided this screen shows everything,
  unconditionally, with no per-row state — adding a second visual treatment on top of "shown or not"
  is unnecessary complexity for a v1-sized list.
- **Printing, exporting, or generating a shareable cheat-sheet image/PDF.** In-app overlay only.
- **Touching `FilterBar.tsx` or any right-click context menu's action list.** Same boundary the
  parent spec drew — this screen documents global keyboard shortcuts and palette commands, not
  every mouse-driven affordance in the app.

## Acceptance criteria

1. Pressing `Ctrl+/` (`Cmd+/` on macOS) while no modal dialog is open opens the reference screen as a
   centered overlay. `Escape` or clicking outside the overlay closes it with no other effect.
2. Opening the Command Palette (`Ctrl/Cmd+K`), typing to filter down to "Keyboard shortcuts", and
   pressing `Enter` closes the palette and opens the reference screen — identical result to selecting
   "New branch…" opening `NewBranchDialog`.
3. With no repo open (the empty landing state), the reference screen still lists every command in the
   registry, including repo-scoped ones ("Commit staged changes", "New branch…", "New stash…",
   "Refresh commit graph") — none are hidden, in contrast to the Command Palette itself, which in
   this same state would show only "New tab / Open repository…" per FR-225.
4. Rows are grouped under exactly four headings — Tabs, View, Git actions, General — in that order;
   every row shows its label, and a keybinding (via `keyComboLabel`) only when it has one (e.g.
   "Switch to tab" and "New tab / Open repository…" show no keybinding text). "Refresh commit graph"
   shows both of its combos (e.g. "Ctrl+R / F5" on Windows/Linux, "Cmd+R" only on macOS).
5. Exactly one "Switch to tab" row appears regardless of whether 0, 1, or 5 tabs are currently open —
   never one row per open tab.
6. Two rows appear on this screen that never appear in the Command Palette's own list: "Open Command
   Palette" (`Ctrl/Cmd+K`) under General, and "Next / previous tab" (`Ctrl+Tab` / `Ctrl+Shift+Tab`,
   `Cmd` variant on macOS) under Tabs.
7. While any existing modal dialog (New Branch, New Stash, a branch delete/force-delete Confirm
   dialog, a panel-local Confirm dialog, a `ContextMenu`, or the Command Palette itself) is open,
   pressing `Ctrl/Cmd+/` does not open the reference screen (silent no-op, same treatment as every
   other FR-226/FR-231 direct keybinding under `anyModalDialogOpen`). Symmetrically, while the
   reference screen is open, `Ctrl/Cmd+K`, `Ctrl/Cmd+R`/`F5`, `Ctrl/Cmd+Enter`, and `Ctrl+Tab`/
   `Ctrl+Shift+Tab` are all silent no-ops — none of them act "through" the open reference screen.
8. All keybinding labels on the screen render `Cmd` on macOS and `Ctrl` on Windows/Linux, verified on
   both branches — via the same `keyComboLabel`/`isMac` helpers the palette already uses, not new
   platform-detection logic.
9. No IPC call or git process spawn is introduced — this screen is a pure static render of
   already-in-memory data (the registry plus the two FR-236 constants), verified the same way
   `keyboard-shortcuts-command-palette.md` AC12 verifies its own no-new-calls guarantee.
10. Works identically regardless of git host (GitHub/GitLab/Bitbucket/self-hosted/local-only), remote
    presence, or bare-repo status — already covered by AC3's "no repo open" case, the most
    host-agnostic state the app has.

## References

- `specs/keyboard-shortcuts-command-palette.md` — FR-221 (dialog-suppression/`anyModalDialogOpen`),
  FR-223/224 (the one command registry), FR-225 (the palette's *opposite* availability philosophy,
  deliberately not reused here per FR-233), FR-226/227 (the direct-keybinding + platform-translation
  mechanism this spec's `Ctrl/Cmd+/` binding reuses verbatim), FR-228 (the modal-overlay convention
  this spec's FR-232 also follows). Its own Non-goals section is what this spec exists to fill in.
- `packages/desktop/src/lib/commands.ts` — `getCommands()`, the `Command`/`CommandContext`
  interfaces this spec extends (`category` field, `"view-keyboard-shortcuts"` entry,
  `openKeyboardShortcuts` context field) rather than duplicates. Note the `keybindings: KeyCombo[]`
  shape (plural, an array) landed via `feature/f5-refresh-keybinding` — build against that shape,
  not the singular `keybinding: KeyCombo` the parent spec originally described.
- `packages/desktop/src/hooks/useGlobalKeybindings.ts` — the existing generic keybinding-lookup loop
  FR-231's `Ctrl/Cmd+/` rides on with no new dispatch code, and the hardcoded `Ctrl/Cmd+K`/tab-cycle
  handling FR-236's two static rows must stay labeled consistently with.
- `packages/desktop/src/lib/platform.ts` — `keyComboLabel`/`isMac`/`matchesKeyCombo`, reused verbatim
  (FR-238).
- `packages/desktop/src/App.tsx` — `anyModalDialogOpen` and its sibling dialog-visibility booleans
  (`showCreateStashDialog`, `newBranchRequest`, `changesPanelDialogOpen`, `commitGraphContextMenuOpen`,
  `detailPanelContextMenuOpen`, etc.) — the exact pattern this spec's new `shortcutsOpen` (FR-237)
  follows, and the exact aggregate this spec folds into rather than inventing a fourth suppression
  path.
- `packages/desktop/src/components/CommandPalette/CommandPalette.tsx`,
  `NewBranchDialog/NewBranchDialog.tsx`, `ConfirmDialog/ConfirmDialog.tsx` — the modal-overlay
  convention FR-232 follows.
