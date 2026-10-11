# CLAUDE.md — GitHydra project context

Claude Code reads this automatically every session. It's the shared context for all five subagents (see AGENTS.md for the full team and workflow) — keep it updated as real decisions get made, so nobody has to re-explain them.

## What this is
GitHydra: a free, open-source, GitKraken-style visual git client.

## Status
- **v1 shipped in full** (graph, stage/diff, branches, merge/rebase + conflicts, stash, cherry-pick, blame) and since then: multi-repo tabs, online sync, Edit in diff (+ recovery drafts, own close dialog), the conflict block editor (FR-556..565, 584..592), conflicts-first Changes list (573..576), mid-merge landing (577..583), live refresh, and more. PRDs, FR numbers and acceptance criteria live in `specs/*.md` (the historical record, not narrated here); `ROADMAP.md` holds what is queued.
- **Released**: `v0.1.0` is a GitHub Release (installers + `SHA256SUMS.txt`) via the tag-triggered `release.yml`. Unsigned (no SignPath application filed) — see `ROADMAP.md` "Smaller open threads".
- Run: `npm install && npm run build && npm start` from the repo root. Read `PRODUCT.md` (product truth) and `DESIGN.md` (visual system) before UI work; don't re-derive either.

## Known pitfalls
- **Graph canvas must track scroll like `CommitRow`.** `CommitGraph/GraphCanvas.tsx` draws its row slice at local y from 0, so the `<canvas>` must sit at `top: startIndex * ROW_HEIGHT`. Pinning it at `top: 0` offsets dots, lanes, HEAD marker and selection ring once scrolled. Shipped once; `GraphCanvas.test.tsx` guards it.
- **Fire-and-forget calls into `useRepositoryGraph.ts` use `refreshRefsAndRowsInBackground()`, never `refreshRefsAndRows()`.** The latter deliberately throws (`refresh()` relies on it to restore `hasExternalChanges`/`operationStateAlert`); an un-awaited call from e.g. `onSettled` leaks an unhandled rejection if the repo closes mid-flight. The Background variant never rejects. Shipped once; `useRepositoryGraph.refreshRefsAndRowsInBackground.test.ts` guards it.
- **A `.claude/worktrees/agent-*` checkout needs its own `npm install`.** Without it, module resolution silently falls through to the main checkout's `node_modules/@githydra/*` symlinks, so builds/tests validate `main`'s code, not the worktree's. Run `npm install` (then rebuild) before trusting any result there.
- **Build from the repo root (`npm run build`) before a real Electron launch.** `main.js` requires `@githydra/git-core` as `external` (`vite.config.electron.mts`) via its `dist/index.js`; a `packages/desktop`-only build skips git-core's `tsc` and the app dies with `MODULE_NOT_FOUND`.
- **Never put a drag/drop target inside a `disabled` `<button>`.** Chromium doesn't hit-test its contents, so the drop silently fails (jsdom can't show it). Use `aria-disabled="true"` + `tabIndex=-1` + no-op click. Likewise a `:hover` rule can out-specify a state class like `.gh-refchip--drag-reject` unseen by class-name assertions; check real screenshots. Guard: `e2e-playwright/electron/refChipDragMerge.spec.ts`.
- **No module in `packages/git-core` may touch Node globals (`Buffer`, `process`, `__dirname`) at load time.** The renderer value-imports it and has none; a top-level `Buffer.from` blanked the built app while vitest (which has `Buffer`) stayed green. Guards: `tests/rendererSafeLoad.test.ts`, `e2e-playwright/electron/rendererBootsSmoke.spec.ts`.
- **Anything that unmounts `ChangesPanel` or drops a repo tab must go through the dirty-leave guard.** An open editor buffer (`specs/edit-in-diff.md`) is lost on unmount, so tab close/switch/new, open repo, drawer close, commit select and Stash/Blame/Compare call `registry.guard(fn)` (`useDirtyLeaveGuard.tsx`); app close uses `electron/closeGuard.ts`.
- **Real-Electron tests run the BUILT app.** Run `npm run build` from the root first (the launcher refuses a stale build; `GITHYDRA_SKIP_BUILD_CHECK=1` bypasses). Run one window at a time and leave none behind (`closeApp` + Playwright global teardown kill the tree; unsaved editor text vetoes a polite close by design, FR-535). Never kill Electron windows you did not launch — the owner may have a demo open.
- **FR numbers are unique across ALL specs.** Grep every `specs/*.md` for the number before assigning one (a collision happened and forced a renumber to 584..591).
- **Container-query blocks in `EditorPane.css` must stay at the END of the stylesheet**, or later base rules win. jsdom can't see it; `EditorPane.layout.test.ts` pins the stylesheet text.
- **A repo opened mid-conflict already has Changes open**, so e2e helpers must not blind-click the Changes toggle (it would close it); use the open-if-needed helper (`openChangesDrawer` in `e2e-playwright/electron/conflictEditor.spec.ts`).
- **Live-refresh's idle gate treats a conflicted or dirty editor as busy** (`specs/live-refresh.md`), so refreshes defer while one is open.
- **Only the active tab has a live repo connection**, so there is no per-tab conflict badge (queued in `ROADMAP.md`).

## Conventions
- **New user-facing actions get a Command Palette entry.** `packages/desktop/src/lib/commands.ts`'s `getCommands()` is the single registry behind the `Ctrl/Cmd+K` palette and every direct keybinding (`specs/keyboard-shortcuts-command-palette.md`, FR-223). A discrete, repeatable, anywhere-triggerable action (not one needing a pre-selected target, like per-file operations) adds an entry as part of the feature. Nothing enforces this; reviewers check it.
- **Code comments explain WHY, briefly.** Comment only a race, non-obvious ordering, pitfall or spec constraint, in 1-2 lines; cite `specs/foo.md`, FR-123 instead of retelling it; never restate the code. Keep comments that map to the pitfalls above. Fix or delete stale comments you touch.

## Product principles (non-negotiable — source of truth is `.claude/agents/product-manager.md`)
- Works with ANY git repo: local, GitHub, GitLab, Bitbucket, self-hosted, bare repos, submodules, worktrees. No host lock-in, no forced sign-in.
- No forced account creation, no telemetry by default, no feature paywalls. Runs entirely against the user's local git and their own remotes — no proprietary backend.
- v1 priority order (all done): commit graph, stage/diff, branches, merge/rebase + conflicts, stash, cherry-pick, blame.

## Tech stack
All decided — do not re-litigate; see `docs/tech-decisions.md`.
- Desktop shell: **Electron** (not Tauri — `git-core` needs a Node runtime). Frontend: **React**.
- TypeScript on Node.js (>=18) across `git-core` and the app; npm workspaces (`packages/*`).
- Git integration: system `git` CLI via `child_process.spawn`, argv arrays only, never a shell string (not libgit2/isomorphic-git). Requires git >= 2.24 on PATH.

## Project structure
- `.claude/agents/` — the 5 subagents: product-manager, git-core-engineer, ui-graphics, security-reviewer, test-agent; `.claude/skills/oss-licensing-guardrails/` — licensing/naming/trademark skill
- `AGENTS.md` — agent team and build/review workflow; `PRODUCT.md` — product truth; `DESIGN.md` — visual system to extend, not re-decide
- `packages/git-core` — git plumbing engine (git-core-engineer): history, status/diff, staging, commits, etc. Shells out to system git only; no UI, no network calls. See its README.
- `packages/desktop` — Electron + React app (ui-graphics): main/preload, IPC bridge to `git-core`, graph, DetailPanel, Changes panel, editor.

## Licensing
**GPL-3.0-or-later** — settled: root `LICENSE`, `"license"` in all three `package.json`s, SPDX headers on every source file. Rationale, dependency-license check and open README-disclaimer/donate-link follow-ups: `ROADMAP.md` "Licensing decision". Read the oss-licensing-guardrails skill before any *new* naming, branding or licensing decision.
