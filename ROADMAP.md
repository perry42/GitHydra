# ROADMAP — post-v1

**Status:** v1, V1.1, the design-pass/Floaters backlog, and **V2** (all five online-sync phases
plus Reset to here) are fully shipped. Nothing is queued as the next milestone.

**Convention:** this file is intake, not spec detail. Shipped items get one line — outcome + spec
reference; the full problem/acceptance-criteria/FR/review history lives in `specs/*.md` and git
log. Only genuinely open items keep their context, since that's what someone needs to act on them.

## Open

### Find in editor (Ctrl+F) — V1.1, NOT built

PM FR scope: Ctrl/Cmd+F (physical KeyF) in the open editor opens a find bar at the same top-right position as the conflict navigator: text input, match count, prev/next (Enter/Shift+Enter), match case, Esc closes and returns focus; in a conflict file a Find | Conflicts segment (default Find); plain-text only; no regex/replace/multi-file; not persisted; optional palette entry enabled only while editor open.
Until then Ctrl/Cmd+F is swallowed in the editor (`specs/edit-in-diff.md` FR-591); before 2026-10-11 it fell through to the global "Focus branches search" and stole focus. The pill's `EditorFloat` slot (FR-585) is the mount point.

### Drag-to-merge: unverified corners (real-Electron pass 2026-09-30, branch test/drag-merge-corners)

Verified in a real Electron run by `e2e-playwright/electron/refChipDragMergeCorners.spec.ts` (real pointer events, screenshots
under git-ignored `.tmp-critique-screenshots/drag-merge-corners/`): lane-color legibility of the target ring + self-drop reject
(5 non-blue lanes, dark and light; reject also carries a `not-allowed` cursor and a ghost ring), drop menu (enabled and
disabled-with-reason) and palette picker in the light theme, dirty-tree checkout refusal (git's text shown verbatim, nothing
changed), a conflicting merge through a real drag (banner, conflict view, Abort restores HEAD/tree), a card with no rendered
chip (branch on an off-screen commit), and the Branches search filter.

**FR-430 fixed (2026-09-30, `feat/detached-head-orphan-guard`, see Shipped).** The finding: `switchBranch()`/`switchToCommit()` discarded
git's "you are leaving N commit(s) behind" warning, so leaving a detached HEAD with unreferenced commits was silent — it never
worked in GitHydra, and the Branches panel's plain Checkout was affected, not only drag. Real-Electron verification
(`detachedHeadOrphanGuard.spec.ts`, 12 criteria, dark and light) passes. Untested there: the guard's behavior for rebase,
cherry-pick and bare repos (in-progress merge only), and whether a 4 MB subject slows the graph itself (only dialog latency was asserted).
Confirmed 2026-09-30 (cosmetic, pending fix): a "History changed outside GitHydra." banner stays up after a drag-triggered
checkout+merge onto a non-current branch — `useDragCommitActions.ts` `ensureCheckedOut()` closes the checkout with a bare
`onSettled()`, so `selfWriteGate.ts`'s `hasUnexpectedRefChangeBeyondCurrentBranch` flags the currentBranch change (fix: pass the
known `{ sha, currentBranch }`; touches the AC5 self-write gate, needs security-reviewer). Red spec: `dragMergeExternalBanner.spec.ts`.
Drop-menu-clipped-near-bottom-edge: not reproducible 2026-09-30 (`dragMenuViewportEdge.spec.ts` guards it).
Known limits from the drag-banner security review (2026-09-30, accepted): a same-repo generation bump (`applyFilter`/`clearFilter`)
mid-refresh can leave a queued self-write gate entry unshifted (pre-existing; `refreshRefsAndRowsBody` bails before the shift), which
suppresses the watcher until the next gated settle; and an external advance of the *currently checked-out* branch's tip during the
checkout->merge wait can be absorbed (the merge gate deliberately exempts the current branch).
Still to check (unconfirmed, cosmetic): the orphan-guard banner briefly coexists with a stale "Detached HEAD" toolbar/graph
label and "Loading branches…" during the post-checkout refresh; the drag dialog names the source by short sha, not branch name.
Lower-severity leftovers from the security review, accepted: the IPC layer still accepts an unguarded switch (the guard is a UX
net, not a security boundary — a compromised renderer can already discard/force-delete); when the check says `none` the checkout
is not HEAD-bound; the no-direct-calls test misses aliased calls (`const a = api; a.switchBranch()`); whitespace lookalikes
(U+00A0, U+3000, U+2800) are not stripped from subjects; the desktop and git-core sanitizers are duplicated and could drift.

Resolved by spec amendment: the palette entry being always listed (FR-437 deviation) is now the specified behavior. FR-437 was
amended to "the entry is always listed; opening the picker in a bare repo or during an in-progress operation shows every branch
disabled, or a single inline message, with the FR-308 reason (identical to the drag menu's); no silent empty state; keyboard-only
users can reach it". Observed behavior already matched; no code change needed beyond keeping a regression test.

Full-suite vitest flake: not a single identifiable test — it is load-induced timeouts in the real-git App e2e family. Ran the full suite 3 times: run 1 (concurrent with Electron/Playwright runs, ~15 min) failed only `App.restoreTabs.e2e.test.tsx` (30s timeout, 36.5s elapsed); run 2 (partly concurrent) failed `App.amend.e2e` AC7 (30s timeout), `App.pull.e2e` AC4/AC5 (`expected '' to match /merging/i`, banner never rendered in time) and `App.stash.e2e` AC18 (90s timeout, then 'No repository is open'); run 3 on an otherwise idle machine passed 1648/1648. Same family as the `App.repoOpenElapsed` note below: the 30s per-test default is too tight when the box is busy (the full suite itself takes ~14-20 min here). Not fixed here; candidates are a higher testTimeout for `*.e2e.test.tsx` or fewer parallel workers.

### Smaller open threads

- **Code signing.** Corrected 2026-09-25: the 2026-09-07 entry claiming a SignPath Foundation
  application had been "submitted" was wrong — user confirmed no application was ever actually
  filed. **Not applied yet.** Checked 2026-09-25 against `signpath.org/terms.html`: there's no formal
  user/download-count threshold, but eligibility is discretionary on "verifiable reputation" — their
  own wording is "we cannot sign binaries based on source code that nobody knows" — alongside active
  maintenance, OSI license, and an already-released signed(-ish) build. Practical implication is
  similar even without a hard number: promotion shouldn't wait on signing, since visible
  activity/adoption plausibly helps the application. Target technically-literate channels
  (HN/Reddit-r/opensource/dev communities) that will click through a SmartScreen warning rather than
  bounce off it. macOS has no free option, not pursued. Until resolved: ship unsigned, workaround
  documented in release notes. (No auto-update mechanism — explicit non-goal.)
- **Donate/support link** — approved in principle, not built, no urgency. Keep it a passive link,
  not a nag.
- **Repo-open cancel gap** — canceling a tab reactivation triggered by *closing* another tab has no
  well-defined "restore to" target; un-special-cased pending a product decision.
- **FR-245 resume-reader API** — finished and tested, but still not swapped in over the shipped
  fast-forward fix. That swap remains a separate future decision.
- **Stash visualization polish** — no concrete gap identified yet, not actionable.

### Follow-ups from the hunk/line staging + live refresh work (2026-10-05)

- **Edit in diff** (`specs/edit-in-diff.md`, FR-467..476) — specced, not built; it must hide the line/hunk
  checkboxes while editing (hunk-line-staging FR-484) and relies on live refresh's conflict rule.
- **Ignore / Ignore and stop tracking + multi-select file actions** — built on `feat/ignore-and-multiselect`
  (`specs/ignore-and-multiselect.md`, FR-494..526 incl. the 2026-10-05 UX amendment). Open follow-ups:
  discard residuals (a write or directory swap in
  the microseconds before `git restore`, files over 256 MB fingerprinted by size/mtime/inode only); the
  discard +/- counts are untested on CRLF repos; a wider default file column would stop the narrow-header
  wrap; `refChipGutterVisualCheck` (AC9/AC6 icon-scale cases and the "+N popover" case) is intermittently flaky on a screenshot bounding-box race (a different case fails each run; passes alone) — not yet checked whether main flakes the same.
- **Graph scroll resets to the top after A -> B -> A tab revisit** — reproduced on `main` too (900 -> 0), so
  not a live-refresh regression; contradicts `specs/graph-head-indicator-and-refresh-alerting.md` Addendum 3
  AC1. Guarded by a `test.fail()` in `liveRefreshAcceptance.spec.ts` that will flag when it is fixed.
- **Live refresh, unmeasured platforms** — the working-tree watcher was only measured on Windows 10; macOS
  (FSEvents) and Linux (documented degraded mode) and network/WSL/OneDrive folders are unverified. Changes to
  `.git/info/exclude` and global ignore files do not refresh the watcher's ignore list until reopen.
- **Silent apply while reading a selected commit** — external HEAD moves follow even when the idle user has a
  commit selected (decided with product-manager; revisit after real use: fallback is follow only when the
  selection was on the old HEAD).
- **Discard residuals (accepted):** a write in the few ms between the final in-queue read and git's own
  rewrite can still be lost; files over 256 MB are fingerprinted by size+mtime+inode only and files over 64 MB
  get no safety copy; the safety copy is a loose unreferenced object (`git fsck --lost-found`, pruned by gc
  after ~2 weeks) and the UI does not mention it.
- **Load-sensitive tests** — `App.stash.e2e` (AC7 / rapid second create), `ChangesPanel.layout` 500-files and
  `fetch` AC2 flake only under concurrent load; they pass alone. Same family as the testTimeout note above.

### Edit in diff — follow-ups (updated 2026-10-09)

- **Shipped** (`specs/edit-in-diff.md`, `specs/edit-recovery-draft.md`): git-core write path, typed IPC, CodeMirror editor, dirty-leave guard on every path that drops the buffer, app-close interception with GitHydra's own close-confirmation window (native box is only the last-resort fallback), widened drawer + rail, palette/context-menu entries, recovery drafts (private userData store, 7-day expiry, restore prompt), index.lock hardening, stale-build guard + leak-free teardown for e2e. Design notes + mockup: `docs/design/edit-in-diff/`.
- **Not built yet:** Expand (full-window editor), Compare view (mine vs on disk), gutter markers + peek, Shortcuts-screen entries for E / Ctrl+S / Ctrl+Shift+S, in-note 'Unstage this line' (needs a line-precise index write path + security review), encoding dropdown / Markdown preview / per-file tabs (v1.1).
- **Editable size cap:** measured 2026-10-08 on an i7-6700HQ: typing/scroll/open stay smooth to 20 MB of normal text; save crosses 1 s between 5 and 10 MB; one 5 MB minified line types at p95 ~66 ms (2 MB fine). Plan: raise `MAX_EDITABLE_FILE_BYTES` (git-core) and the IPC content cap to 5 MB together and add a longest-line rule (~2 MB -> 'Line too long to edit here'). The diff view is a separate 2 MB limit and Edit stays available above it.
- **Known small papercuts:** (a) press a row's Stage/Unstage then a hunk checkbox within a few hundred ms -> the stale open diff is refused safely ('The file changed on disk, so nothing was staged. Diff reloaded; try again.'); a fix was tried (optimistic ticks + 'tick gate') and dropped after review found HIGH risks — needs a keyed, bounded design; makes `hunkLineStaging` AC6 flaky (~15%). (b) a partly staged file OTHER than the open one that is edited externally while staying 'MM' keeps a stale marker until its status changes (FR-19 carries no content fingerprint). (c) the hover rail can cover the left edge of the editor header incl. 'Back to diff' for mouse users (keyboard fine).
- **Not verified on this machine:** git-core symlink/mode/FIFO/setuid tests (the Windows account cannot create symlinks) — run once on Linux/macOS CI; real IME composition for Esc-ignores-IME; Windows shutdown/session-end vs the close veto; drafts across moved/renamed repos (they expire).
- **Bundle:** CodeMirror added ~+99 KB gzipped, loaded eagerly; consider a dynamic import.
- **Test hygiene:** `liveRefreshStress` 'IGNORED directory' limit raised 5 -> 7 and counts only whole-repo status spawns.

### Conflict-first layout (2026-10-10, branch fix/conflict-first-layout)
- Done: Conflicted section first with other sections collapsed, first conflict auto-opened during an operation, comparison tabs/Take buttons no longer overlap (`specs/conflict-first-layout.md`).

### Conflict block editor — follow-ups (2026-10-09)

- **Candidates scoped 2026-10-11 (not built):**
  - *Auto-resolve trivial conflicts* (PM-scoped, size S–M, V1.1): an 'Auto-resolve trivial (N)' button in the editor, shown only when N > 0, never silent. Safe cases: sides equal after EOL normalisation; one side equals the diff3 base; sides differ only in trailing whitespace / line endings. Never touches leading or inner whitespace (Python/YAML/Makefile), binary, or anything not byte-identical to one side. Each block keeps its derived chip plus an 'Auto' tag, one-step 'Undo auto-resolve', 'Mark as resolved' still needs the click. Phase two (opt-in setting, off by default): merge-time `-Xignore-space-at-eol` / `-Xignore-cr-at-eol` / `-Xrenormalize`; later maybe 'auto-resolve on open' (off). GitKraken's only documented auto-resolve is the paid, account-bound 'Auto-resolve with AI' — not copyable; whether it silently fixes one-space conflicts is unverified (git's own 3-way merge already does for one-sided whitespace).
  - *Conflict badge on background tabs* (size M, needs PM spec + security review): only the active tab has a live repo connection today, so only it shows the badge/title. Needs a per-tab lightweight watcher (merge/rebase/cherry-pick markers + debounced `git ls-files --unmerged` count), read-only, via the existing read-only index helpers.
- **Shipped** (`specs/edit-in-diff.md` FR-556..565, merged 1c6f9fa): chip row per conflict block (Yours / Incoming / Both + order / Neither / Custom, Reset, Edit) with the ✓ derived from the result text, Custom text kept per block, auto-advance + toast Undo, F3 / Alt+Up/Down navigation, gated "Mark as resolved" (saves, then stages from disk via `markConflictResolved`), rebase label inversion, reference strip, drafts as plain text, `merged` recovery for reopened half-resolved files. Entry: "Resolve in editor" button / "Edit file".
- **Not built (cut from the mockup):** overview ruler beside the text, "Remove stray markers" button, narrow-width tab mode for the reference strip, per-line checkboxes (GitKraken has them), direct chord shortcuts (Ctrl+Alt+1..3), ancestor column on by default.
- **Not covered by real-window tests:** recovery draft of a conflicted file (FR-565), stray-marker typing (FR-564), Both order for blocks restored from a draft, live-region announcement.
- **Consistency pass (feat/conflict-consistency, FR-566..572):** row click / Enter / menu / palette all open the editor; the file-level view only for ineligible files, with the reason and "Take <side> and mark resolved" (confirm only if the working file was edited); editing never decides (double-click, E); Enter on a chip activates; Esc steps up; post-resolve strip with Next conflicted file / Continue; "looks good" state; undo/redo in both modes; 15 s toast; palette + shortcuts entries; rebase side naming shared by chips and buttons. Known limit: `isConflictFileUntouched` compares against the index stage blobs only, so a text conflict that is not editor-eligible (marker-bearing working file) always asks before Take; core.autocrlf checkouts also count as "edited".
- **Read-only first (branch feat/read-only-first, FR-593..600, awaiting owner review):** conflicted files open read-only ("Resolving"); double-click, `E` or an Edit chip enters Editing. Owner answered Q1: text inside conflict blocks is editable in Resolving, only text outside is locked. Two owner answers are one-line constants in `packages/desktop/src/lib/resolvingMode.ts` (`LOCK_BLOCK_TEXT_IN_RESOLVING`, `ESC_STEPS_BACK_TO_RESOLVING`). Open point: the hint shares the FR-584 slot, so the blocking reason hides it until every block is decided; the footer keys line ("E edit") is the always-visible cue.
- **Known limits:** a legitimate line of exactly `=======` (Markdown setext underline) blocks Mark as resolved; `conflict-marker-size` attribute ignored; recovery is a line-diff heuristic (adjacent blocks / heavily edited buffers get no chip row); stale `githydra-merge-*` temp dirs after a hard kill are not swept; a restarted merge with a different incoming branch can still offer an old draft (no chips, markers still block staging).

- **Possible real-user latency (found 2026-10-12 by the flaky-test pass, unconfirmed):** staging 500 freshly written untracked files takes ~30 s on this Windows machine (git 2.31.1.windows.1; a raw `git add` of the same files: 31 s first time, 0.24 s once cached; batching into 50s does not help). Looks like a per-new-file first-read cost (likely antivirus scanning), but check on another machine/git version before dismissing; real-user 'Stage all' on a big untracked tree could feel hung (needs a progress/busy state at minimum).

- **Token savings, next steps (owner: park it here, 2026-10-13):** done already — lean `CLAUDE.md`, `specs/INDEX.md`, ROADMAP/archive split, DESIGN.md 'Where to look'. Left: (1) a read-only `npx ccusage@latest` baseline to see which agents/sessions burn tokens (MIT, local logs only; the researcher's savings percentages are unverified guesses); (2) small per-package `CLAUDE.md` files (`packages/desktop`, `packages/git-core`) that load only when working there — check the real nested-CLAUDE.md behaviour in the docs first; (3) skills for repeated recipes (real-Electron test, mockup-first, release checklist); (4) optionally a tiny self-written hook that shortens noisy command output (no third-party code; skip squeez/mcpkill; Magic Compact only after reading its source and only if ccusage shows long sessions are the problem). Do not apply the researcher's example settings snippet.

## Backlog — later ideas, not actively queued

Deprioritized by the user (2026-09-14); revisit only when explicitly picked back up.

- **Compare-commits' context-menu label doesn't name the two commits or their direction** — small,
  copy-only fast-follow to match the drag-menu's naming convention.
- **Remember last search/filter per repo.** An earlier draft spec (FR-197–207) was never saved; the
  user wants to redefine the shape before it's picked back up — don't reuse the old draft.
- **Auto-stash**, opt-in, default off. Only build if product-manager thinks it's needed.
- **Per-author identity marks** (commit-node avatars + right-panel chips). **Locally generated
  only** — deterministic initials/color-hash from author name+email, never a Gravatar/GitHub-avatar
  network fetch (hard product principle). Needs its own spec first.

## Standing constraints — apply to all future work

- **Online-sync scope boundaries:** force-push and delete-remote-branch are explicit non-goals, not
  deferred items. No credential storage, prompting, or management inside GitHydra ever — auth is
  delegated entirely to system git's credential helper and SSH agent. No remote add/edit/remove UI.
  PR/issue/host-API features stay V3. Anything touching `~/.ssh/config`, SSH agent key management,
  or our own token store is deferred indefinitely — it can break the user's git setup outside
  GitHydra and duplicates what credential managers already do.
- **Security review is required** for any work touching credentials or the network. The checklist
  is `specs/online-sync-security-flags.md`.
- **Credential redaction is structural**, living in `GitCommandError`/`GitCommandTimeoutError`/
  `OperationCancelledError`'s own constructors and covering `.message`/`.args`/`.stderr` uniformly.
  Don't reintroduce per-call-site redaction — that pattern already shipped one Critical leak.
- **`clone()` pins `-c core.sshCommand=ssh`** because its `cwd` is the destination's parent, which
  can sit inside an unrelated repo whose local config git would otherwise apply (a real RCE path).
  `fetchRemote()`/`push()` don't need it — their `cwd` is always the already-open target repo.
- **`git reset` rejects `--end-of-options`**, and a `--` separator is actively wrong there (git
  parses what follows as a pathspec) — hex-only `targetSha` validation is the compensating control.
  `blame.ts` has the same deviation documented.
- **Never put the user's real personal email in anything public-facing** (commit authorship,
  `package.json`) — use the GitHub no-reply address.


---
Shipped history (the former `## Shipped` section, incl. shipped tech-debt and licensing notes) moved to
`docs/roadmap-archive.md` on 2026-10-12. Specs index: `specs/INDEX.md`.
Older references to "ROADMAP.md" tech-debt/shipped entries now resolve there.
