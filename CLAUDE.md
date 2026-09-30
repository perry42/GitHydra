# CLAUDE.md — GitHydra project context

Claude Code reads this automatically every session. It's the shared context for all five subagents (see AGENTS.md for the full team and workflow) — keep it updated as real decisions get made, so nobody has to re-explain them.

## What this is
GitHydra: a free, open-source, GitKraken-style visual git client.

## Status
- **v1 shipped in full**: commit graph visualization, stage/unstage + diff, branch management, merge/rebase + conflict resolution UI, stash, cherry-pick, blame & file history. Each feature's PRD, FR numbers, and acceptance criteria live in `specs/*.md` — that's the historical record; this file no longer narrates each one. See `ROADMAP.md` for what's queued next (Priority 0 bugs, a design pass, tech debt, V1.1/V1.5/V2).
- **Publicly released**: `v0.1.0` is a real GitHub Release (installers + `SHA256SUMS.txt`) via the tag-triggered `release.yml` pipeline. Unsigned for now (no SignPath application filed yet, despite an earlier stale claim that one had been) — full status in `ROADMAP.md`'s "Smaller open threads" entry.
- Run it with `npm install && npm run build && npm start` from the repo root.
- `PRODUCT.md` and `DESIGN.md` exist at the repo root (written via the `impeccable` skill, PM-reviewed) — read those for product truth and the visual system before touching UI work; don't re-derive either from scratch.

## Known pitfalls
- **Graph canvas must track scroll position like `CommitRow` does.** `packages/desktop/src/components/CommitGraph/GraphCanvas.tsx`'s `<canvas>` element draws its visible row slice at *local* y-offsets starting at 0, so the canvas element itself must be positioned at `top: startIndex * ROW_HEIGHT` — mirroring exactly how each absolutely-positioned `CommitRow` computes its own `top: index * ROW_HEIGHT`. Losing that sync (e.g. a refactor that CSS-pins the canvas at `top: 0` again) silently offsets everything the canvas draws — node dots, lane lines, the HEAD marker, and the selection ring — by `startIndex * ROW_HEIGHT` pixels from the real DOM rows once scrolled past the first screenful. This exact regression shipped once and was fixed; `GraphCanvas.test.tsx` guards it.
- **A fire-and-forget call into `useRepositoryGraph.ts` must use `refreshRefsAndRowsInBackground()`, never `refreshRefsAndRows()` directly.** `refreshRefsAndRows()` deliberately still throws on failure — `refresh()` depends on observing that throw to correctly restore `hasExternalChanges`/`operationStateAlert`. Any OTHER call site that invokes it as `() => void graph.refreshRefsAndRows()` without awaiting/catching (e.g. a mutation's `onSettled`/`onOperationChanged` callback) can leak a real unhandled promise rejection if the repo closes (tab close, "+ New tab") while that call is still mid-flight — a real, reachable user sequence, not just test-timing noise. `refreshRefsAndRowsInBackground()` wraps the same call and never rejects (a stale-generation failure is a silent no-op; a genuine failure logs a console diagnostic instead). This exact bug shipped once (found via `App.cherryPick.e2e.test.tsx` under full-suite load) and was fixed; `useRepositoryGraph.refreshRefsAndRowsInBackground.test.ts` guards it.
- **A `.claude/worktrees/agent-*` checkout has no `node_modules` of its own until you run `npm install` inside it.** Without that, Node/Vite's upward module resolution silently falls through to the *main checkout's* `node_modules/@githydra/*` symlinks — so a build or test run inside the worktree validates against `main`'s code, not the worktree's own changes, with no error to signal it. Found 2026-09-25 during test-agent's live-Electron verification of the `refs/original/*` graph-leak fix: the first run "failed" showing the pre-fix bug, purely because it was silently exercising `main`'s pre-fix `commitLog.ts` through the stale symlink. Fix is simply `npm install` (then rebuild) inside the worktree before trusting any build/test/launch result run there.
- **Always build from the repo root (`npm run build`), never `packages/desktop` alone, before a real Electron launch.** `main.js`'s `require("@githydra/git-core")` is deliberately `external` (`vite.config.electron.mts`), resolved at runtime via the `node_modules/@githydra/git-core` workspace symlink → that package's own `dist/index.js`. A `packages/desktop`-only build never runs `git-core`'s own `tsc`, so if `packages/git-core/dist` doesn't already exist, the built app throws `MODULE_NOT_FOUND` for `@githydra/git-core` at startup — confirmed reproducible 2026-09-28 during the ref-chip-gutter-legibility fix's verification. The root `npm run build` builds `git-core` first, avoiding this entirely.
- **Never render a drag/drop target inside a `disabled` `<button>`.** Chromium (Electron) doesn't hit-test a disabled button's contents, so `elementFromPoint` never returns the chip inside it and the drop silently does nothing — jsdom can't show this. Informational "+N" popover rows use `aria-disabled="true"` + `tabIndex=-1` + a no-op click instead. Found 2026-09-30 via a real user test; `e2e-playwright/electron/refChipDragMerge.spec.ts` guards it. Same lesson: a `:hover` rule can out-specify a state class like `.gh-refchip--drag-reject` and jsdom (class-name assertions) won't notice — check real screenshots for visual states.

## Conventions
- **New user-facing actions should get a Command Palette entry.** `packages/desktop/src/lib/commands.ts`'s `getCommands()` is the single registry behind both the `Ctrl/Cmd+K` Command Palette and every direct keybinding (`specs/keyboard-shortcuts-command-palette.md`, FR-223) — nothing else defines a command independently. When a new feature adds a discrete, repeatable action a user would trigger from anywhere (not a context-specific action needing a pre-selected target, like per-file operations — see that spec's Non-goals), add an entry to this array as part of building the feature, not as a later cleanup pass. There's no test or lint rule enforcing this yet — it relies on whoever builds the next feature (or reviews it) checking this section.
- **Code comments explain WHY, briefly.** About a third of non-test source lines were comments (measured 2026-09-30), and every agent that opens a file pays for them. Write a comment only for a race, a non-obvious ordering, a pitfall, or a spec constraint, in one or two lines. Cite the spec by file + FR number (`specs/foo.md`, FR-123) instead of retelling it. Never restate what the code does. Keep warning-style comments that map to "Known pitfalls" above. When you edit a file and find a stale comment, fix or delete it rather than adding next to it. Applies to new and touched code; existing files are trimmed separately.

## Product principles (non-negotiable — source of truth is `.claude/agents/product-manager.md`)
- Works with ANY git repo: local, GitHub, GitLab, Bitbucket, self-hosted, bare repos, submodules, worktrees. No host lock-in, no forced sign-in.
- No forced account creation, no telemetry by default, no feature paywalls. Runs entirely against the user's local git and their own remotes — no proprietary backend.
- v1 priority order: commit graph visualization ✅, stage/unstage + diff ✅, branch management ✅, merge/rebase + conflict resolution UI ✅, stash ✅, cherry-pick ✅, blame ✅. v1 complete.

## Tech stack
All decided — do not re-litigate; see `docs/tech-decisions.md` for the why behind each.
- Desktop shell: **Electron** (not Tauri — `git-core` needs a Node runtime).
- Frontend framework: **React**.
- Language: TypeScript on Node.js (>=18), across `git-core` and the app.
- Package manager: npm, npm workspaces (`packages/*`).
- Git integration: shell out to system `git` CLI via `child_process.spawn`, argv arrays only, never a shell string (not libgit2/isomorphic-git — see doc for why). Requires git >= 2.24 on PATH.

## Project structure
- `.claude/agents/` — the 5 subagents: product-manager, git-core-engineer, ui-graphics, security-reviewer, test-agent
- `.claude/skills/oss-licensing-guardrails/` — licensing/naming/trademark guardrails skill
- `AGENTS.md` — how to use the agent team and the build/review workflow
- `PRODUCT.md` — product truth (users, positioning, constraints); `DESIGN.md` — the visual system (tokens, component language) new UI work should extend, not re-decide
- `packages/git-core` — git plumbing engine (git-core-engineer's domain): commit-history reading, working-directory status/diff, staging/discard, commit creation. Shells out to system git only; no UI, no network calls. See its README for the module layout.
- `packages/desktop` — the Electron + React app (ui-graphics's domain): main/preload process, IPC bridge to `git-core`, the commit graph, the commit DetailPanel, and the Changes panel (staging/diff/commit UI). See its own doc comments; no separate README yet.

## Licensing
**GPL-3.0-or-later** — decided and landed: root `LICENSE` file, `"license"` field in all three `package.json`s, SPDX headers on every source file. Full rationale, the dependency-license check, and the still-open README-disclaimer/donate-link follow-ups live in `ROADMAP.md`'s "Licensing decision" entry. Read the oss-licensing-guardrails skill before making any *new* naming, branding, or licensing decision — this section just records what's already settled.
