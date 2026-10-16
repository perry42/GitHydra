# Uniform banner look: no side stripe on alerts, notices, banners and cards

Status: BUILT, not merged (feat/worktrees-ui; product-manager decision 2026-10-13 under the owner's instruction "it must be uniform, ask the product manager what we want"; the owner's screenshot review is still the gate; known gaps: no `--gh-warning-ink` token, success banners keep the neutral class, the conflict editor's marker strip has its own look). Owner: product-manager. Extends `DESIGN.md` (status-message component language) and `ROADMAP.md` "Side-stripe accents - design review (2026-10-13)", which this spec turns into a slice. Lands BEFORE the worktree UI slice (`specs/worktrees.md` FR-634) so worktree banners are never the odd ones out. FR numbers FR-645..648 (grepped across `specs/`, `ROADMAP.md`, `docs/`: free).

## Problem
The shipped alert/notice/banner classes mark their status with a 3 px coloured left border (`.gh-status-banner*`, `.gh-op-banner*`, `.gh-changes-panel__notice`). A thick side stripe is colour-only, is flagged by the design hook and by both Impeccable reviewers, and the worktree feature's banners deliberately use the icon + tint + border look. Two looks in one app would be wrong; the owner wants one.

## Decision
One look, app-wide: **an icon, a light status tint (about 10 percent) and a plain 1 px border, with text-safe ink tokens. No side stripe on alerts, notices, banners or cards.** Row and line state bars (selected row, diff cursor/range, conflict gutter bars, `.gh-cf-cus`/`.gh-cf-stray`) are markers, not banners, and stay (DESIGN.md sanctions them, each paired with a non-colour cue).

## Target user
Every GitHydra user who reads a status, error or notice banner: it must read the same everywhere and never by colour alone.

## Must-have behavior
- **FR-645 No stripes.** No alert, notice or banner class has a left/side border thicker than 1 px, a coloured `border-left`, a `box-shadow: inset Npx 0 0` stripe, or a pseudo-element stripe. In scope (the classes found by the 2026-10-13 review, to be re-grepped at build): `.gh-status-banner*` (`StatusBanner.css` ~L13, `border-left: 3px solid transparent`), `.gh-op-banner*` (~L92), `.gh-changes-panel__notice` (`ChangesPanel.css` ~L238 and the accent bar near L273/L282 if it is a notice), and `.gh-cf-empty` (`ConflictEditor.css` ~L246) ONLY if it still has a stripe after the others. Out of scope and unchanged: the row and line state bars (`DiffView.css` ~L336/345, `ConflictEditor.css` ~L37-87, `ChangesPanel.css` selected-row bars).
- **FR-646 The one look.** Every banner shows an `aria-hidden` icon (one per status: info, success, warning, error), a ~10 percent status tint (`color-mix(in srgb, var(--gh-status-X) 10%, var(--gh-surface))`) and a plain 1 px border, all from existing tokens; icon colours use the text-safe ink tokens (`--gh-serious-ink`, `--gh-critical-ink`, ...). The meaning is readable without colour: the icon shape and the text differ per status. Class names, `role` and `aria-live` attributes are unchanged.
- **FR-647 Contrast and crispness.** Text-safe ink on the tint meets 4.5:1 in light and dark; the 1 px border stays crisp at 2x scale. Verified with real screenshots, not only computed values.
- **FR-648 State bars untouched.** Row and line state bars are not modified by this slice.

## Non-goals
Redesigning banner copy or auto-dismiss rules (`specs/auto-dismiss-status-messages.md`); changing which component shows which message; the proposed `--gh-ink-muted-text` token and the primary-button contrast (tracked separately in `specs/worktrees.md` Open questions).

## Components that use banners (re-grep `StatusBanner`, `gh-op-banner`, `gh-changes-panel__notice`, `gh-cf-empty` at build so none is missed)
`StatusBanner` (shared), `PushStatusBanner`, `FetchStatusBanner`, `PullStatusBanner`, `CloneDialog`, `CherryPickEmptyResultNotice`, `ConflictResolutionView`, `LeftBehindBanner`, `ChangesPanel` (notice), the operation banner in `App.tsx`, `ConflictEditor` (`.gh-cf-empty`, conditional); the e2e files `App.pull`, `App.dragCommitMenu`, `App.cherryPick` assert on banner content or height.

## Order and cost
1. `.gh-changes-panel__notice` first as the pilot (about 30 min); check a real screenshot.
2. `.gh-status-banner*` (about 1 to 1.5 h): the shared component, so it carries most of the visual change.
3. `.gh-op-banner*`; then `.gh-cf-empty` only if needed.
4. Add the `DESIGN.md` rule and update the StatusBanner text: "No side-stripe borders on alerts, notices, banners or cards. A banner is an icon, a light status tint (about 10 percent) and a plain 1px border, with text-safe ink tokens. Inset bars are allowed only as row or line state markers (graph, diff, changes rows), and each must be paired with a non-colour cue (icon, text or shape)." Add the banner to the "Where to look" table; move the ROADMAP item to `docs/roadmap-archive.md` once shipped.
The icon and the 1 px border change banner heights slightly: every e2e that counts banner height is rerun on the BUILT app (`npm run build` from the root first) and each changed expectation is updated deliberately with a one-line reason, never loosened.

## Acceptance criteria
1. Real screenshots (light, dark, and one at 2x scale) of each banner-using component in its info, warning and error states, attached for the owner's review; the component list above is complete.
2. All existing jsdom tests pass; every e2e that asserts banner height is rerun on the built app and any changed height has a one-line reason in the test.
3. A stylesheet-text guard test fails when a `border-left` wider than 1 px, a coloured side border or `box-shadow: inset Npx 0 0` appears in the banner classes listed in FR-645 (pinned-CSS pattern, as `EditorPane.layout.test.ts`); row/line bar rules are explicitly allow-listed.
4. `role` and `aria-*` attributes of each banner are unchanged (the existing a11y tests stay green); each banner status has an icon plus text.
5. The worktree UI banners (`specs/worktrees.md` FR-634) use the same component and classes and look identical to the others in a side-by-side screenshot; they add no styling of their own.

## Security
No new input, IPC or network; CSS and icon changes only.

## Review log
- 2026-10-13: written from the PM's decision memo. Independent review not run (CSS-only scope); the screenshot review in AC 1 is the owner's gate.
