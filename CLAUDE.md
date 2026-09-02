# CLAUDE.md — GitHydra project context

Claude Code reads this automatically every session. It's the shared context for all five subagents (see AGENTS.md for the full team and workflow) — keep it updated as real decisions get made, so nobody has to re-explain them.

## What this is
GitHydra: a free, open-source, GitKraken-style visual git client.

## Status
- **v1 shipped in full**: commit graph visualization, stage/unstage + diff, branch management, merge/rebase + conflict resolution UI, stash, cherry-pick, blame & file history. Each feature's PRD, FR numbers, and acceptance criteria live in `specs/*.md` — that's the historical record; this file no longer narrates each one. See `ROADMAP.md` for what's queued next (Priority 0 bugs, a design pass, tech debt, V1.1/V1.5/V2).
- Run it with `npm install && npm run build && npm start` from the repo root.
- `PRODUCT.md` and `DESIGN.md` exist at the repo root (written via the `impeccable` skill, PM-reviewed) — read those for product truth and the visual system before touching UI work; don't re-derive either from scratch.

## Known pitfalls
- **Graph canvas must track scroll position like `CommitRow` does.** `packages/desktop/src/components/CommitGraph/GraphCanvas.tsx`'s `<canvas>` element draws its visible row slice at *local* y-offsets starting at 0, so the canvas element itself must be positioned at `top: startIndex * ROW_HEIGHT` — mirroring exactly how each absolutely-positioned `CommitRow` computes its own `top: index * ROW_HEIGHT`. Losing that sync (e.g. a refactor that CSS-pins the canvas at `top: 0` again) silently offsets everything the canvas draws — node dots, lane lines, the HEAD marker, and the selection ring — by `startIndex * ROW_HEIGHT` pixels from the real DOM rows once scrolled past the first screenful. This exact regression shipped once and was fixed; `GraphCanvas.test.tsx` guards it.

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
Not yet named for public release or licensed — read the oss-licensing-guardrails skill before making any naming, branding, or LICENSE decision.
