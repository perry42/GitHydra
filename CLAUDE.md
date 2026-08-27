# CLAUDE.md — GitHydra project context

Claude Code reads this automatically every session. It's the shared context for all five subagents (see AGENTS.md for the full team and workflow) — keep it updated as real decisions get made, so nobody has to re-explain them.

## What this is
GitHydra: a free, open-source, GitKraken-style visual git client.

## Product principles (non-negotiable — source of truth is `.claude/agents/product-manager.md`)
- Works with ANY git repo: local, GitHub, GitLab, Bitbucket, self-hosted, bare repos, submodules, worktrees. No host lock-in, no forced sign-in.
- No forced account creation, no telemetry by default, no feature paywalls. Runs entirely against the user's local git and their own remotes — no proprietary backend.
- v1 priority order: commit graph visualization, stage/unstage + diff, branch management, merge/rebase + conflict resolution UI, stash, cherry-pick, blame.

## Tech stack
- Desktop shell: **Electron** — decided. Rationale: `packages/git-core` already runs on Node.js `child_process.spawn`; Electron's main process is Node.js, so `git-core` plugs in directly with no bridging layer. Tauri's backend is Rust — using `git-core` from Tauri would mean either bundling a Node sidecar just to run it, or reimplementing the git-shelling logic in Rust, which throws away a decision already made.
- Frontend framework: **React** — decided. Rationale: matches the TypeScript-first stack already committed to; has the deepest ecosystem of virtualization/canvas libraries for rendering a 100k–1M-commit graph (FR-3/FR-12 in `specs/commit-graph.md`); and since GitHydra is meant to attract outside open-source contributors, React has the largest available contributor pool of any framework choice.
- Language: TypeScript on Node.js (>=18) — decided for the git-core logic (`packages/git-core`); now also decided for the rest of the app (Electron main/preload/renderer, React UI) for the same reason.
- Package manager: npm, using npm workspaces (`packages/*`) — decided, root `package.json` already set up this way.
- Git integration approach: shell out to the system `git` CLI via `child_process.spawn`, with argv arrays only (never a shell string) — decided. Rationale: libgit2 bindings (e.g. nodegit) are poorly maintained and lag git's own edge-case handling (grafts, shallow, worktrees); isomorphic-git doesn't cover the full plumbing surface (worktrees, shallow/graft nuances) and reimplements git's object/pack formats itself, which is more surface area to get subtly wrong. Shelling out to the user's real, already-installed git inherits git's own correctness for every edge case for free, at the cost of requiring git on PATH (git >= 2.24, for `--end-of-options`; see `packages/git-core/README.md`).

## Project structure
- `.claude/agents/` — the 5 subagents: product-manager, git-core-engineer, ui-graphics, security-reviewer, test-agent
- `.claude/skills/oss-licensing-guardrails/` — licensing/naming/trademark guardrails skill
- `AGENTS.md` — how to use the agent team, day-1 instructions, recommended tooling
- `packages/git-core` — commit-history-reading / git plumbing engine (git-core-engineer's domain). Shells out to system git only; no UI, no network calls. See its README for the module layout.
- other source folders — TBD once the rest of the tech stack above is decided

## Licensing
Not yet named for public release or licensed — read the oss-licensing-guardrails skill before making any naming, branding, or LICENSE decision.
