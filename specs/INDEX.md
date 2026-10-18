# Spec index

How to use: (1) find the feature below, or `grep -rn "FR-123" specs/` to find the spec that defines a requirement. (2) Open ONE spec, not all of them.
(3) FR numbers are mostly unique across specs, with exceptions noted below (ref-chip-synced-upstream-merge and self-write-refresh-suppression use local FR-1..7 / FR-6a..c; addendum specs own no numbers of their own).
Highest FR in use: **FR-648** (banner-uniform-look), so the next free number is **FR-649**. Re-check: `grep -rhoE "FR-[0-9]+" specs | sort -t- -k2 -n -u | tail -1`.
Status as of 2026-10-12: shipped = built and merged; partly = shipped with open follow-ups in `ROADMAP.md`. Shipped history: `docs/roadmap-archive.md`. Visual system: `DESIGN.md` (Where-to-look table at top).

## Graph
- [commit-graph](commit-graph.md) — commit graph visualization: lanes, nodes, ref chips, scrolling, filtering — FR-1..18 — shipped
- [graph-head-indicator-and-refresh-alerting](graph-head-indicator-and-refresh-alerting.md) — HEAD position marker; when refresh alerts show (addendum, revised by live-refresh) — cites FR-59 — shipped
- [ref-chip-gutter-legibility](ref-chip-gutter-legibility.md) — ref-chip type glyphs and multi-chip "+N" collapse — FR-406..413 — shipped
- [ref-chip-gutter-redesign](ref-chip-gutter-redesign.md) — wider chip gutter, visible border, literal type icon — FR-414..417 — shipped
- [ref-chip-synced-upstream-merge](ref-chip-synced-upstream-merge.md) — merge a local branch and its synced upstream into one chip — local FR-1..7 — shipped
- [find-commits-overlay](find-commits-overlay.md) — Find Commits overlay; supersedes the inline FilterBar — FR-257..270 — shipped
- [filter-bar-visual-redesign](filter-bar-visual-redesign.md) — FilterBar expanded-form restyle, date inputs; superseded by find-commits-overlay — FR-247..256 — shipped
- [compare-commits](compare-commits.md) — select two commits and compare them directly — FR-181..196 — shipped
- [drag-commit-menu](drag-commit-menu.md) — drag one commit onto another for a contextual action menu — FR-295..326 — shipped
- [branch-panel-drag-merge](branch-panel-drag-merge.md) — drag a Branches card or ref chip onto a branch to merge — FR-418..439 — shipped

## Staging, diff, commit
- [stage-unstage-diff](stage-unstage-diff.md) — Changes panel: stage/unstage, diff view, commit — FR-19..32 — shipped
- [detailpanel-auto-diff](detailpanel-auto-diff.md) — auto-diff on selection, two-region DetailPanel layout (addendum) — cites FR-27 — shipped
- [hunk-line-staging](hunk-line-staging.md) — hunk and line staging via checkbox model — FR-448..453, 477..485 — shipped
- [changes-panel-layout](changes-panel-layout.md) — Changes panel columns and commit-form placement — FR-486..491 — shipped
- [ignore-and-multiselect](ignore-and-multiselect.md) — ignore files, multi-select file actions in Changes — FR-494..526 — partly (follow-ups in ROADMAP)
- [amend-last-commit](amend-last-commit.md) — amend the last commit from the Changes panel — FR-148..161 — shipped
- [image-diff-preview](image-diff-preview.md) — image preview for binary image diffs — FR-139..147 — shipped
- [layout-and-view-polish](layout-and-view-polish.md) — filter-bar collapse, diff sizing, resizable persisted panels — no FRs (AC-based) — shipped

## Branches
- [branch-management](branch-management.md) — create, switch, delete branches — FR-33..57, 320, 321 — shipped
- [reset-to-here](reset-to-here.md) — reset current branch/HEAD to a chosen commit — FR-359..377 — shipped
- [worktrees](worktrees.md) — create/open/remove worktrees, tabs, left-panel list, post-create banners — FR-601..616, 632..641, 644 — built, not merged
- [external-programs](external-programs.md) — open a repo/worktree folder in an editor: accordion, detection, Programs dialog — FR-617..625, 642 — built, not merged
- [worktree-copy-ignored](worktree-copy-ignored.md) — copy ignored files into a new worktree with a per-repo memory — FR-626..631, 643 — built (feat/copy-ignored), not merged

## Merge, rebase, conflicts
- [merge-rebase-conflict-resolution](merge-rebase-conflict-resolution.md) — merge/rebase and conflict resolution UI — FR-58..80 — shipped
- [conflict-first-layout](conflict-first-layout.md) — Changes puts conflicted files first during an operation — FR-573..576 — shipped
- [mid-merge-landing](mid-merge-landing.md) — conflict banner, auto-open first conflict, resolved state — FR-577..583 — shipped

## Stash, cherry-pick
- [stash](stash.md) — save, list, apply, pop, drop stashes — FR-81..102 — shipped
- [cherry-pick](cherry-pick.md) — cherry-pick commits with conflict handling — FR-103..122 — shipped

## Blame, history
- [blame](blame.md) — blame view and per-file history — FR-123..138 — shipped

## Editing
- [edit-in-diff](edit-in-diff.md) — edit in the diff pane, conflict block editor; amends hunk-line-staging and live-refresh — FR-467..476, 527..540, 556..572, 584..600 — shipped (Find in editor not built)
- [edit-recovery-draft](edit-recovery-draft.md) — recovery drafts for unsaved editor buffers — FR-541..555 — shipped

## Live refresh, tabs, repo open
- [live-refresh](live-refresh.md) — working-tree and ref watchers refresh the UI automatically — FR-457..466, 492, 493 — shipped
- [self-write-refresh-suppression](self-write-refresh-suppression.md) — no external-change alert for the app's own checkout/branch writes — local FR-6a..c — shipped
- [multi-repo-tabs](multi-repo-tabs.md) — several repos open in tabs — no FRs (AC-based) — shipped
- [repo-list](repo-list.md) — landing screen and recent repositories list — no FRs (numbered rules) — shipped
- [instant-tab-revisit](instant-tab-revisit.md) — already-loaded tabs reopen instantly — FR-239..246 — shipped
- [restore-tabs-on-relaunch](restore-tabs-on-relaunch.md) — restore open tabs across app relaunch — FR-208..214 — shipped
- [remember-last-selected-file](remember-last-selected-file.md) — remember last selected file per tab — FR-215..220 — shipped
- [repo-open-feedback](repo-open-feedback.md) — elapsed-time indicator and cancel while opening a repo — FR-162..170 — shipped
- [repo-open-feedback-fixes](repo-open-feedback-fixes.md) — cancel, path and lock bug fixes for repo open — FR-197..207 — shipped

## Online sync (V2)
- [online-sync-fetch](online-sync-fetch.md) — phase 1: fetch, diverged indicator, credential-failure UX — FR-320..328 — shipped
- [git-identity-profiles](git-identity-profiles.md) — phase 2: identity and SSH key profiles — FR-329..337, 378, 379 — shipped
- [identity-profile-network-interlock](identity-profile-network-interlock.md) — block identity apply/remove during in-flight network ops — FR-380..386 — shipped
- [online-sync-pull](online-sync-pull.md) — phase 3: pull — FR-338..343 — shipped
- [online-sync-push](online-sync-push.md) — phase 4: push, the highest-risk phase — FR-344..350 — shipped
- [online-sync-clone](online-sync-clone.md) — phase 5: clone a repository — FR-351..358 — shipped
- [online-sync-security-flags](online-sync-security-flags.md) — standing security-review checklist for the five sync specs — no FRs (companion doc) — reference

## UI, shortcuts, messages
- [keyboard-shortcuts-command-palette](keyboard-shortcuts-command-palette.md) — Ctrl/Cmd+K palette and keybindings from one registry — FR-221..230 — shipped
- [keyboard-shortcuts-reference](keyboard-shortcuts-reference.md) — in-app keyboard shortcuts reference screen — FR-231..238 — shipped
- [keyboard-shortcuts-visual-redesign](keyboard-shortcuts-visual-redesign.md) — keycap visuals for shortcuts — FR-387..393 — shipped
- [keyboard-shortcut-rebinding](keyboard-shortcut-rebinding.md) — user-customizable shortcut rebinding — FR-394..405 — shipped
- [banner-uniform-look](banner-uniform-look.md) — one banner look app-wide: icon + tint + 1px border, no side stripe — FR-645..648 — built (feat/worktrees-ui), not merged
- [auto-dismiss-status-messages](auto-dismiss-status-messages.md) — plain success banners auto-dismiss — FR-440..447 — shipped

## Release, site
- [release-pipeline](release-pipeline.md) — tag-triggered installers and checksums via GitHub Actions — FR-171..180 — shipped (v0.1.0, unsigned)
- [landing-page-design-seo](landing-page-design-seo.md) — landing page design pass and on-page SEO — FR-271..294 — shipped (site lives on gh-pages)
