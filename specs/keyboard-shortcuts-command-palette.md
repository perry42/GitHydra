# Keyboard shortcuts and command palette

## Problem

GitHydra has no app-wide keyboard-shortcut layer and no command palette today — verified directly
against the code, not assumed: the only existing `keydown` handling anywhere in
`packages/desktop/src` is local to individual modal components (`NewBranchDialog`,
`CreateStashDialog`, `ConfirmDialog`, `ContextMenu` each wire their own `Escape`-to-close handler),
and there is no global listener, no registry of actions, and no palette UI anywhere in the app.
Every action — refresh, commit, toggle a panel, switch tabs, open a dialog — requires reaching for
the mouse and finding the right toolbar button, panel toggle, or menu item, every time. Technical
users coming from GitKraken, Sourcetree, Fork, or general editor tooling (VS Code's `Ctrl/Cmd+K`
command palette convention in particular) expect keyboard-first access to frequent actions as a
baseline capability, not a v2 nicety.

## Target user

Any GitHydra user, on any git host or none (GitHub/GitLab/Bitbucket/self-hosted/local-only) — this
is pure local UI/interaction layer with no dependency on repo state, host, or remote presence.
Particularly valuable for users who already know git well and work across several open tabs/repos
in one sitting, where reaching for the mouse for every routine action (refresh, commit, switch tab)
adds up.

## Must-have behavior

- FR-221: A new global keyboard-shortcut layer, mounted once at the app root, active whenever the
  app window has focus and no modal dialog/menu is currently capturing keyboard input. It defers to
  the existing local `keydown` handlers already owned by `NewBranchDialog`/`CreateStashDialog`/
  `ConfirmDialog`/`ContextMenu` — checked via the same dialog-visibility state `App.tsx` already
  tracks (`showCreateStashDialog`, etc.) — not a new focus-trap mechanism invented for this feature.
- FR-222: `Ctrl+K` (`Cmd+K` on macOS) opens a **Command Palette** overlay: a text input (focused
  immediately) filtering a list of named commands as the user types, `Up`/`Down` arrow keys move a
  highlighted selection (wrapping at either end), `Enter` executes the highlighted command and
  closes the palette, `Escape` closes the palette with no action taken.
- FR-223: The palette's command list is generated from a single new command registry module (e.g.
  `packages/desktop/src/lib/commands.ts`), not scattered ad hoc `keydown` checks. Each entry
  declares: an `id`, a display `label`, an optional keybinding string, an `isAvailable(context)`
  predicate, and a `run(context)` callback. Both the palette (FR-222) and the direct-keybinding
  layer (FR-226) read from this one registry, so each command is defined exactly once regardless of
  how many ways it can be triggered.
- FR-224: The v1 registry covers exactly these commands, each invoking its existing handler
  verbatim — no new business logic written for this feature:
  - New tab / Open repository (`repoTabs.openNewTab`)
  - Close current tab (`repoTabs.closeTab`)
  - Switch to tab — one entry per currently open tab, labeled with that tab's repo name
    (`repoTabs.activateTab`)
  - Refresh commit graph (`refreshEverything`, respecting its existing `canRefresh`/`isRefreshing`
    guard)
  - Toggle theme (`toggleTheme`)
  - Toggle Branches sidebar (`onToggleBranches` — only when a repo is open)
  - Toggle Changes panel (`toggleChangesPanel` — only when a repo is open and the toggle is shown)
  - Toggle Stashes panel (`toggleStashPanel` — only when a repo is open, the toggle is shown, and
    `stashDisabledReason` is `null`)
  - New branch (opens the existing `NewBranchDialog` — only when a repo is open)
  - New stash (opens the existing `CreateStashDialog` — only when a repo is open)
  - Commit staged changes (invokes the Changes panel's existing commit action directly — only when
    the Changes panel is open and its own existing Commit-button-enabled conditions are met: a
    non-empty message and at least one staged file)
- FR-225: A command's `isAvailable` predicate governs both (a) whether it appears in the palette
  list at all — unavailable commands are hidden entirely, never shown-and-disabled, since the
  palette is a list of what can be done right now, not a discoverability surface teaching a gesture
  (a deliberately different convention from the cherry-pick/compare context-menu items' own
  show-disabled-with-tooltip pattern) — and (b) whether its direct keybinding, if any, fires; an
  unavailable command's keybinding is a silent no-op, never a console error or a broken action.
- FR-226: Direct (non-palette) global keybindings ship for exactly four commands, chosen as the
  highest-frequency actions where a dedicated key beats "open palette, type, Enter":
  - `Ctrl/Cmd+K` — open the Command Palette (FR-222)
  - `Ctrl/Cmd+Enter` — commit staged changes (fires only when available, per FR-225)
  - `Ctrl/Cmd+R` — refresh the commit graph
  - `Ctrl+Tab` / `Ctrl+Shift+Tab` (`Cmd` variant on macOS) — activate the next / previous open tab,
    wrapping past the last/first
  Every other registry command is palette-only in v1 (see Non-goals).
- FR-227: One shared modifier-translation helper maps every "Ctrl" binding above to "Cmd" on macOS
  and leaves it as "Ctrl" on Windows/Linux — not per-platform-duplicated key-check logic scattered
  across each binding.
- FR-228: The palette overlay follows this app's existing modal-dialog visual/interaction
  conventions (the shared pattern `NewBranchDialog`/`CreateStashDialog`/`ConfirmDialog` already
  establish: centered overlay, focus trap, `Escape`-to-close, click-outside-to-close) rather than
  inventing a new overlay pattern for this one feature.
- FR-229: While the palette's filter input is focused and the palette is open, the global
  keybinding layer (FR-226) is suspended — typing "r", "k", pressing `Enter`, or pressing `Tab`
  inside the palette is treated purely as filter text entry / list navigation, never as also
  triggering Refresh, reopening the palette, committing, or switching tabs.
- FR-230: No new IPC or `git-core` surface. Every v1 registry command (FR-224) invokes a handler
  that already exists in the app today — this feature is pure renderer/app-level wiring, same shape
  as `specs/repo-list.md`'s and `specs/restore-tabs-on-relaunch.md`'s precedent.

## Non-goals

- **User-customizable/remappable keybindings.** v1 ships one fixed, curated set (FR-226 for direct
  bindings; the full registry via the palette for everything else). A rebinding settings UI is a
  distinct, materially larger feature — not required to deliver real daily value now.
- **Searching commit history (SHA/author/message/date/path) from the palette.** That's
  `FilterBar.tsx`'s job — a different tool for a different kind of lookup (data, not actions) — and
  is deliberately not merged into this palette. This feature does not touch `FilterBar.tsx` at all,
  including its currently-open "dated look" design gap (`ROADMAP.md`), which remains exactly as-is
  and unresolved by this spec.
- **Replacing or restyling the Toolbar.** The toolbar's visual hierarchy was already fixed by the
  "chrome hierarchy" design pass (`DESIGN.md`) — confirmed by inspecting `Toolbar.tsx`, which today
  has five buttons in two clearly separated role clusters, not the "six identical buttons" the
  original floater note described. This spec doesn't reduce toolbar button count or claim to fix
  overcrowding; that complaint is already resolved by earlier work, not by this feature.
- **Replacing any existing right-click context menu** (cherry-pick, Compare 2 commits, branch-row
  actions). Context menus remain their own entry point; the palette is additive, not a replacement.
- **Drag-one-commit-onto-another contextual action menu.** A separate, already-tracked floater
  (`ROADMAP.md`) with its own unrelated interaction mechanism — not built here.
- **Command coverage beyond FR-224's fixed list** — e.g. per-file stage/unstage/discard, starting a
  merge/rebase, cherry-pick, Compare 2 commits. These require a specific selected target (a file, a
  commit, a pair of commits) that the palette has no mechanism to supply yet; adding them without a
  target-selection step would produce broken or no-op entries. A natural fast-follow once the core
  palette mechanism (FR-222/223) is proven, not required for this pass.
- **Firing while a native OS dialog or the Electron application menu bar has focus.** Outside the
  renderer's reach — same boundary every existing dialog's local `keydown` handler already respects.

## Acceptance criteria

1. Pressing `Ctrl+K` (`Cmd+K` on macOS) with a repo open opens the Command Palette with its text
   input focused and the full currently-available command list visible, unfiltered.
2. Typing narrows the visible list to commands whose label matches the typed text; text matching no
   command shows an explicit "No matching commands" state, never a blank list with no explanation.
3. `Down`/`Up` moves a highlighted row through the filtered list, wrapping at either end; `Enter`
   executes the highlighted command and closes the palette; `Escape` closes the palette with no
   action taken.
4. With 3 tabs open, the palette lists one "Switch to tab" entry per open tab, each labeled with
   that tab's repo name; selecting one activates that tab via the existing `activateTab` path
   (identical result to clicking it in `TabBar`, including existing lazy-load-on-activation).
5. With no repo open (the empty landing state), the palette lists only commands valid at that
   state (e.g. "New tab / Open repository") — every repo-scoped command (Refresh, Toggle Branches,
   Commit, etc.) is absent from the list entirely, never present-but-disabled.
6. `Ctrl/Cmd+Enter` commits staged changes using the Changes panel composer's current message,
   exactly when the existing Commit button would be enabled (repo open, Changes panel open,
   non-empty message, at least one staged file) — identical result to clicking that button. Outside
   those conditions, it is a silent no-op: no error, no empty commit.
7. `Ctrl/Cmd+R` triggers the same `refreshEverything` refresh as clicking the Toolbar's Refresh
   button, respecting the same `canRefresh`/`isRefreshing` guard — no double-refresh from holding
   the key or pressing it mid-refresh.
8. `Ctrl+Tab` / `Ctrl+Shift+Tab` (`Cmd` variant on macOS) cycles to the next/previous open tab,
   wrapping past the last/first, and has no effect when only one tab is open.
9. While the Command Palette's filter input is focused, typing any character (including "k", "r",
   `Enter`, `Tab`) is treated as filter text entry / list navigation only — none of FR-226's direct
   keybindings additionally fire as a side effect.
10. Opening any existing modal dialog (New Branch, New Stash, the discard/delete Confirm dialog)
    suppresses the Command Palette and every FR-226 direct keybinding while that dialog is open —
    pressing `Ctrl+K` while `NewBranchDialog` is open does not also open the palette underneath it.
11. On macOS every keybinding in this spec uses `Cmd` instead of `Ctrl`; on Windows/Linux, `Ctrl` —
    verified via the shared modifier-translation helper (FR-227), not per-platform-duplicated logic.
12. No IPC call or git process spawn is introduced beyond what each reused handler already performs
    when triggered via its existing UI — verified the same way `restore-tabs-on-relaunch.md` AC3 /
    `remember-last-selected-file.md` AC8 verify their own no-new-calls guarantees.
13. Works identically regardless of git host (GitHub/GitLab/Bitbucket/self-hosted/local-only) or
    remote presence, and in a bare repository — repo-scoped commands requiring a working directory
    (e.g. Commit) are simply absent from the list per FR-225/AC5's availability rule, never
    shown-and-broken.

## References

- `packages/desktop/src/components/NewBranchDialog/NewBranchDialog.tsx`,
  `CreateStashDialog/CreateStashDialog.tsx`, `ConfirmDialog/ConfirmDialog.tsx`,
  `ContextMenu/ContextMenu.tsx` — the existing local-`keydown`/modal-overlay conventions FR-221 and
  FR-228 extend rather than reinvent.
- `packages/desktop/src/App.tsx` — `refreshEverything`, `toggleTheme`, `toggleChangesPanel`,
  `toggleStashPanel`, `setRightPanel`, `showCreateStashDialog` and sibling dialog-visibility state —
  the exact handlers/state FR-224's registry entries and FR-221's dialog-defer check reuse verbatim.
- `packages/desktop/src/hooks/useRepoTabs.ts` — `openNewTab`, `closeTab`, `activateTab` — reused
  verbatim by FR-224's tab-related commands and FR-226's `Ctrl+Tab` cycling.
- `packages/desktop/src/components/Toolbar/Toolbar.tsx` and `DESIGN.md`'s "chrome hierarchy" design
  pass entry — confirms the toolbar-overcrowding complaint referenced in the original `ROADMAP.md`
  floater wording is already resolved, not something this spec needs to (or should) address.
- `specs/repo-list.md`, `specs/restore-tabs-on-relaunch.md` — the shipped precedent for pure
  renderer/app-level features with no `git-core`/IPC contract change, same pattern FR-230 follows.
- `ROADMAP.md`'s "Floaters" section — this spec's originating entry, including the now-corrected
  toolbar-overcrowding note above.
