# Tech stack decisions — rationale

Referenced from `CLAUDE.md`'s Tech stack section. Read this when you need the *why* behind
a stack choice (e.g. reconsidering it, or explaining it to a contributor) — CLAUDE.md itself
only keeps the *what*, since the reasoning doesn't need to be in every session's context.

## Desktop shell: Electron
`packages/git-core` already runs on Node.js `child_process.spawn`; Electron's main process is
Node.js, so `git-core` plugs in directly with no bridging layer. Tauri's backend is Rust — using
`git-core` from Tauri would mean either bundling a Node sidecar just to run it, or reimplementing
the git-shelling logic in Rust, which throws away a decision already made.

## Frontend framework: React
Matches the TypeScript-first stack already committed to; has the deepest ecosystem of
virtualization/canvas libraries for rendering a 100k–1M-commit graph (FR-3/FR-12 in
`specs/commit-graph.md`); and since GitHydra is meant to attract outside open-source
contributors, React has the largest available contributor pool of any framework choice.

## Language: TypeScript on Node.js (>=18)
Decided for the git-core logic (`packages/git-core`); also decided for the rest of the app
(Electron main/preload/renderer, React UI) for the same reason — one language across the stack.

## Package manager: npm, npm workspaces (`packages/*`)
Root `package.json` already set up this way.

## Git integration approach: shell out to system `git` CLI
Via `child_process.spawn`, argv arrays only (never a shell string). libgit2 bindings (e.g.
nodegit) are poorly maintained and lag git's own edge-case handling (grafts, shallow,
worktrees); isomorphic-git doesn't cover the full plumbing surface (worktrees, shallow/graft
nuances) and reimplements git's object/pack formats itself, which is more surface area to get
subtly wrong. Shelling out to the user's real, already-installed git inherits git's own
correctness for every edge case for free, at the cost of requiring git on PATH (git >= 2.24,
for `--end-of-options`; see `packages/git-core/README.md`).
