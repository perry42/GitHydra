# Customizable keyboard shortcuts (rebinding)

## Problem

Every keybinding in GitHydra today is fixed at build time — `commands.ts`'s `getCommands()` returns a
hardcoded `keybindings: KeyCombo[]` per command, read verbatim by both the Command Palette's shortcut
hints and `useGlobalKeybindings.ts`'s document-level `keydown` lookup loop. `keyboard-shortcuts-
command-palette.md`'s own Non-goals named this explicitly: "v1 ships one fixed, curated set... a
rebinding settings UI is a distinct, materially larger feature — not required to deliver real daily
value now." That's no longer true — technical users coming from GitKraken/Sourcetree/Fork/VS Code
expect to remap any shortcut to match muscle memory from another tool or resolve a personal collision
(e.g. an OS-level or another-app binding on the same combo), and there is still no way to do that.

## Target user

Any GitHydra user, on any git host or none — pure local renderer preference layer, identical
regardless of repo state, host, or remote presence. Same audience as the parent palette/reference
specs.

## Must-have behavior

- FR-394: A new persisted override store, `useKeybindingOverrides()`
  (`packages/desktop/src/hooks/useKeybindingOverrides.ts`), following the exact try/catch-guarded
  `localStorage` read/write pattern `useLayoutPreferences.ts`/`useTheme.ts` already use — **global,
  not per-repo** (same scope as those two). Storage key `githydra:keybindings:overrides`. Shape:
  `Record<commandId, KeyCombo[] | "unbound">` — a command id mapped to an array is a custom rebinding
  (replacing its default entirely, see FR-396); mapped to the literal sentinel `"unbound"` means the
  user explicitly cleared that command's shortcut with no replacement; a command id absent from the
  map inherits its registry-default `keybindings` unchanged.
- FR-395: A new pure function, `applyKeybindingOverrides(commands: Command[], overrides:
  KeybindingOverrides): Command[]`, producing a new array with each command's `keybindings` replaced
  per FR-394's map (every other field untouched). This is the **one** place the override is applied —
  `useGlobalKeybindings`'s lookup loop, `CommandPalette`'s shortcut-hint rendering, and
  `KeyboardShortcutsScreen`'s row rendering all call this over `getCommands(ctx)`'s raw output rather
  than reading `keybindings` directly, so there is never a second, independently-patched call site
  (the same "one registry, read from everywhere" principle `CLAUDE.md`'s Conventions section already
  establishes for `commands.ts` itself).
- FR-396: **Scope of rebindable commands.** Every command `getCommands()` returns is eligible for a
  custom binding, regardless of whether it ships a default one today (e.g. "New branch…", which has
  none, can be given one) — **except** the dynamic `switch-to-tab:<id>` entries (a per-open-tab id
  isn't stable across restarts, so persisting an override keyed to it is meaningless). The two
  `STATIC_SHORTCUT_ROWS` rows (`Open Command Palette` / `Ctrl+K`, `Next / previous tab` / `Ctrl+Tab` /
  `Ctrl+Shift+Tab`) are explicitly **out of scope for v1** — permanently fixed, never shown with an
  Edit affordance — because `useGlobalKeybindings.ts` special-cases them ahead of (not through) the
  registry lookup loop; making them rebindable requires restructuring that dispatch order, a
  materially larger change than the value of moving two bindings a user is unlikely to want to change.
- FR-397: The two combos FR-396 excludes (`Ctrl/Cmd+K`, `Ctrl/Cmd+Tab`, `Ctrl/Cmd+Shift+Tab`) are
  **reserved**: attempting to capture any of them as a new binding for any command is rejected inline
  ("Reserved — used to open the Command Palette." / "...to switch tabs.") and nothing is saved.
  Attempting to assign any other already-bound combo (default or custom, on a different command)
  triggers FR-399's conflict flow instead of a silent double-bind.
- FR-398: Every custom binding **must include the platform's primary modifier** (`mod: true`,
  Ctrl/Cmd) — a bare single key or a Shift-only combo is rejected inline ("Shortcuts must include Ctrl
  (Cmd on macOS).") and not saved. Reason: `useGlobalKeybindings.ts`'s document-level `keydown`
  listener has no focused-element/text-input guard today — every shipped binding is safe from
  clobbering normal typing (in the commit-message box, a branch-name field, etc.) only because it
  already requires the modifier held (the one grandfathered exception, bare `F5` on Windows/Linux, is
  a fixed registry default, never itself a user-assignable target for a *different* command). This
  rule closes that gap for anything newly user-assignable.
- FR-399: **Conflict detection/resolution.** Attempting to save a captured combo already bound
  (default or custom) to a *different* command shows an inline, non-modal warning naming the
  conflicting command by label (e.g. `"Ctrl+Shift+P is already used by "Pull"."`) with two explicit
  actions: **Reassign** (removes that exact combo from the conflicting command — if that leaves it
  with zero combos, it becomes unbound, not silently restored to any other default — then assigns the
  combo to the command being edited) and **Cancel** (returns to capture state, nothing saved). No
  silent overwrite ever happens without the user seeing which command they're taking the binding from.
- FR-400: **Per-command "Reset to default."** A row currently carrying any override (rebound or
  explicitly unbound) shows a small "Reset to default" action that removes just that command's entry
  from the override map, immediately reverting it to the registry's shipped default. No confirmation
  dialog — non-destructive and instantly reversible, unlike `ConfirmDialog`'s ambit (irreversible git
  operations).
- FR-401: **One global "Reset all shortcuts to default"** action in the screen's header (alongside the
  existing close button) that clears the entire override map in one step. This one **does** route
  through `ConfirmDialog` (unlike FR-400) — it's a single action that could silently discard several
  deliberate customizations at once; per-row reset stays confirmation-free because its blast radius is
  the one row the user is already looking at.
- FR-402: The existing read-only `KeyboardShortcutsScreen` becomes the one screen for both viewing and
  editing — no separate settings surface. **Confirmed 2026-09-27** via the `impeccable` skill: this
  app's established pattern is reusing one existing surface for a related capability rather than
  growing a second bespoke screen (`ConfirmDialog` reused for every destructive action,
  `ConflictResolutionView` reused unmodified across merge/rebase/stash/cherry-pick conflicts, etc.),
  Operate mode prioritizes task efficiency over generic app-settings conventions, and this exact
  audience (developers already fluent in tools like VS Code) already knows this precise pattern from
  VS Code's own Keyboard Shortcuts editor — one searchable list, inline per-row edit affordance, no
  separate settings page. A dedicated second screen would be disproportionate weight for "rebind one
  key" and would cost a new navigation path for a feature this small. Each eligible row (FR-396) gains
  a small icon-only "Edit" ghost button (matching `DESIGN.md`'s existing `34px` icon-only ghost button
  convention) that, on
  click, replaces that row's shortcut display with a "Press a key combination…" capture state,
  rendered via the visual-redesign spec's `KeyCap` component in a distinct "listening" treatment (e.g.
  dashed border instead of solid) so it reads as "waiting for input," not "this is the assigned key."
  Capturing a keydown while listening previews the combo live without saving; `Escape` cancels the
  capture (reverts to the prior display, no save); clicking outside the row or moving focus away
  confirms/saves the just-captured combo if valid (FR-397/398/399 checks run at this point), or
  silently reverts if nothing was captured.
- FR-403: While any row is in the FR-402 capture/listening state, the global keybinding layer and the
  palette's own opening gesture remain suspended exactly as they already are for the whole time this
  screen is open (`anyModalDialogOpen`) — capture needs only its own local `keydown` listener on the
  row, the same pattern `NewBranchDialog`'s local Escape handler already establishes, not a new
  suspension mechanism.
- FR-404: `CommandPalette`'s shortcut hints and every direct keybinding dispatch reflect the current
  effective bindings (defaults with FR-394's overrides applied) immediately, everywhere, with no
  "restart required" step and no drift between what the edit screen shows and what actually fires.
- FR-405: Global scope, not per-repo — one shared set of custom bindings across every open tab/repo,
  matching `useTheme.ts`/`useLayoutPreferences.ts`'s existing scope for other preferences.

## Non-goals

- Rebinding the two structurally hardcoded static bindings (`Ctrl/Cmd+K`, `Ctrl+Tab`/
  `Ctrl+Shift+Tab`) — FR-396/397.
- Per-repo or per-profile keybinding sets — one global set only (FR-405).
- Multiple simultaneous custom combos per command (e.g. keeping a default *and* adding a second custom
  combo) — a custom binding always fully replaces that command's effective `keybindings` array;
  "additional binding without discarding the default" is a fast-follow, not built now.
- Binding to bare/unmodified keys or any combo without the primary modifier held (FR-398) — the one
  narrow exception (bare `F5`) stays a fixed, non-user-assignable registry default.
- Import/export or cross-machine sync of a custom keybinding set — pure local `localStorage`, same as
  every other preference in this app; no backend, no account, no telemetry (this was never realistically
  at risk here, but confirmed against `PRODUCT.md`'s non-negotiables regardless).
- Rebinding coverage for target-dependent, non-palette actions (per-file stage/discard, cherry-pick,
  Compare-2-commits context-menu items, etc.) — unchanged from the parent palette spec's own
  Non-goals; those aren't registry commands today, and adding them is out of scope for this feature.
- Any change to the Command Palette's own search/filter/navigation behavior beyond showing the
  (possibly customized) shortcut hint.
- Detecting or warning about a collision with an OS-level or Electron-application-menu-level shortcut
  outside this app's own renderer reach — outside the renderer's reach, the same boundary the parent
  spec already draws for "firing while a native OS dialog... has focus."

## Acceptance criteria

1. Opening the edit screen, clicking "Edit" next to "New branch…" (no default keybinding today),
   pressing `Ctrl+Shift+B`, and confirming persists a custom binding: the row shows `Ctrl`+`Shift`+`B`
   keycap chips; pressing that combo anywhere in the app (no dialog open) opens `NewBranchDialog`
   exactly as the existing toolbar affordance would; the Command Palette's own row for "New branch…"
   shows the same new hint.
2. Rebinding "Refresh commit graph" (ships two default combos, `Ctrl/Cmd+R` and, Windows/Linux, `F5`)
   to a single new combo replaces both previous combos — afterward neither `Ctrl+R` nor `F5` triggers a
   refresh, only the new combo does, and the row shows exactly the one new combo.
3. Attempting to rebind "Toggle theme" to `Ctrl+P` when "Pull" already uses `Ctrl+P` shows the FR-399
   conflict warning naming "Pull" by label. Clicking "Cancel" leaves both commands' bindings unchanged
   and returns to capture state. In a separate run, clicking "Reassign" removes `Ctrl+P` from "Pull"
   (leaving it with no keybinding, since it had only the one) and assigns it to "Toggle theme."
4. Attempting to capture bare `B` or `Shift+B` (no primary modifier) as a new binding is rejected
   inline with an explicit message; nothing is saved; the row reverts to its previous display.
5. Attempting to capture `Ctrl+K`, `Ctrl+Tab`, or `Ctrl+Shift+Tab` as a new binding for any command is
   rejected inline as reserved; nothing is saved.
6. A command carrying a custom override shows "Reset to default"; clicking it immediately reverts that
   row (and actual firing behavior) to the registry's shipped default, with no confirmation dialog.
7. "Reset all shortcuts to default" (screen header) opens `ConfirmDialog`; confirming clears every
   custom override in one step — verified across at least two previously-customized rows reverting
   simultaneously in the same test.
8. A command explicitly set to "unbound" fires from neither the global keydown layer via keybinding
   (there is none) nor accidentally from some fallback default — but remains fully reachable via the
   Command Palette (selecting it from the filtered list still executes it; only its direct-keydown path
   is gone). Its row shows no keycap chips, only a "Reset to default" action.
9. All customizations persist across an app relaunch (real `localStorage`, not in-memory-only) —
   closing and reopening the app (or, in test, remounting `App` fresh against the same `localStorage`)
   shows the same effective bindings as before close.
10. No IPC call or git process spawn is introduced anywhere in this feature — pure renderer state plus
    `localStorage`, verified the same way `keyboard-shortcuts-command-palette.md` AC12 verifies its own
    no-new-calls guarantee.
11. Works identically regardless of git host, repo state, or bare-repo status — a global,
    repo-independent preference layer exactly like `useTheme`'s/`useLayoutPreferences`'s existing ones.
