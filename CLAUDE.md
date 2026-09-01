# CLAUDE.md — GitHydra project context

Claude Code reads this automatically every session. It's the shared context for all five subagents (see AGENTS.md for the full team and workflow) — keep it updated as real decisions get made, so nobody has to re-explain them.

## What this is
GitHydra: a free, open-source, GitKraken-style visual git client.

## Status
- **Shipped:** commit graph visualization (`specs/commit-graph.md`), stage/unstage + diff (`specs/stage-unstage-diff.md` + `specs/detailpanel-auto-diff.md`), branch management (`specs/branch-management.md`), layout & view polish (`specs/layout-and-view-polish.md`) — collapsible filter bar, diff-sizing fix, resizable/persisted panels — multi-repo tabs (`specs/multi-repo-tabs.md`) — always-visible tab bar, one live `RepoSession` shared across tabs per the spec's option-B architecture decision, per-tab selection/filter/panel state — merge/rebase + conflict resolution (`specs/merge-rebase-conflict-resolution.md`, FR-58 through FR-80): git-core layer (rich in-progress-operation detail, FR-59's watcher gap closed, per-file conflict classification/diff, FR-61's per-operation-type labeling, FR-66's marker safety check, abort/continue) plus its UI — a persistent, non-dismissible operation banner with rich per-operation copy and a live "N of M resolved" readout (`StatusBanner`), Continue/Abort controls (Abort behind `ConfirmDialog`), and a `ConflictResolutionView` (opened by clicking a Conflicted row in the Changes panel, FR-72) covering all of FR-63/76-80's classifications — text (tabbed three-way diff), rename, delete/modify, add-only, binary, and submodule gitlink. See `DESIGN.md`'s "merge/rebase conflict resolution" component-language entry. — stash (`specs/stash.md`, FR-81 through FR-102): git-core layer (`stash.ts`'s list/preview/create/apply/pop/drop, FR-82's common-gitDir worktree-sharing, FR-91's watcher coverage, FR-86's reuse of existing conflict primitives with no synthesized in-progress-operation state, and a `PreExistingConflictError` pre-flight guard added post-security-review so an unrelated pre-existing conflict is never misattributed to the stash op) plus its UI — a `StashPanel` (two-region list+diff, reusing the resizable-panel pattern), `CreateStashDialog` (message/file-checklist/include-untracked), separately-labeled Apply/Pop buttons with no confirmation (nothing is lost even on conflict), Drop behind `ConfirmDialog`, and stash-apply/pop conflicts opening the existing `ConflictResolutionView` with no operation banner or Continue/Abort (there is no `git stash apply --abort`). `git stash branch` deferred as a fast-follow, not v1. Run it with `npm install && npm run build && npm start` from the repo root.
- **Not yet built:** none queued beyond the v1 priority order below.
- **Next up (v1 priority order below):** cherry-pick.
- `PRODUCT.md` and `DESIGN.md` exist at the repo root (written via the `impeccable` skill, PM-reviewed) — read those for product truth and the visual system before touching UI work; don't re-derive either from scratch.

## Product principles (non-negotiable — source of truth is `.claude/agents/product-manager.md`)
- Works with ANY git repo: local, GitHub, GitLab, Bitbucket, self-hosted, bare repos, submodules, worktrees. No host lock-in, no forced sign-in.
- No forced account creation, no telemetry by default, no feature paywalls. Runs entirely against the user's local git and their own remotes — no proprietary backend.
- v1 priority order: commit graph visualization ✅, stage/unstage + diff ✅, branch management ✅, merge/rebase + conflict resolution UI ✅, stash, cherry-pick, blame.

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
