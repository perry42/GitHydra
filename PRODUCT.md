# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Developers working in git day-to-day — solo or on a team. They already know git; they don't need it explained, they need to *see* structure they'd otherwise reconstruct mentally from `git log` text. They work against local-only repos, GitHub, GitLab, Bitbucket, self-hosted (e.g. Gitea), or bare repos inspected on a server, with repo scale ranging from a few hundred commits up to enterprise monorepos with hundreds of thousands of commits and hundreds of branches.

## Product Purpose

GitHydra is a free, open-source, GitKraken-style visual git client. It makes a repository's commit graph, branch topology, and merge structure visible at a glance, and gives visual UI for the operations a working git user needs (staging/diff, branch management, merge/rebase with conflict resolution, stash, cherry-pick, blame) — without requiring a hosted service. Success means a developer can answer "where am I, and what happened" in any repo without falling back to `git log --graph` or mentally reconstructing topology from text.

## Positioning

Works identically against any git host or no host at all (GitHub, GitLab, Bitbucket, self-hosted, bare repos) with no sign-in and no proprietary backend: the graph and every git operation are built by shelling out to the user's own installed git binary against their local `.git` data. A commercial neighbor (e.g. GitKraken itself) cannot truthfully copy "free, no forced account, no telemetry by default, no feature paywalls, fully host-agnostic."

## Operating Context

Developers open GitHydra against repos in the full range of real-world git states: mid-rebase, mid-merge, mid-cherry-pick, mid-bisect, detached HEAD, shallow/grafted clones, orphan branches, worktrees, submodules, bare repos, and fresh zero-commit inits. Refs can change underneath an open session — another terminal, a git hook, or a teammate's push — and the app is expected to reflect that without a restart.

## Capabilities and Constraints

- Git integration: shells out to the system `git` CLI via `child_process.spawn` with argv arrays only (never a shell string); requires git ≥2.24 on PATH. No libgit2 bindings, no isomorphic-git.
- No network calls by default anywhere in the app. Any future host-specific overlay (PR/MR status, CI badges, etc.) would have to be opt-in, using the user's own credentials, and is not built yet.
- `packages/git-core` (commit-history reading / git plumbing) is implemented in TypeScript on Node.js ≥18; the rest of the app uses the same language for the same reason.
- Desktop shell: Electron. Frontend framework: React. Decided — see `CLAUDE.md` for rationale (Electron's main process is Node.js, so it plugs directly into `packages/git-core`'s `child_process.spawn`-based design without a bridging layer). GitHydra is a desktop application, not a browser-hosted product; `Platform: web` above records its *design language* (HTML/CSS/JS UI, not a native iOS/Android shell).
- Repo layout: npm workspaces monorepo (`packages/*`).
- v1 build priority order, highest first: commit graph visualization (shipped) → stage/unstage + diff (shipped) → branch create/switch/delete → merge/rebase + conflict resolution UI → stash → cherry-pick → blame/history. Everything else is v2+.

## Brand Commitments

Product name "GitHydra" is confirmed as the product/working name for design purposes (user-confirmed during init). This does not mean it's cleared for public release: no open-source license has been chosen yet (`package.json` still says `UNLICENSED`), and trademark/naming proximity to GitKraken has not been checked. Read the `oss-licensing-guardrails` skill before any public naming, branding, or LICENSE decision.

## Evidence on Hand

Two v1 features are built and runnable (`packages/desktop`, `npm start`): the commit graph visualization, and stage/unstage + diff (per-file working-directory status, diff content for unstaged/staged/untracked/historical files, stage/unstage/discard, commit creation) with its follow-up UX pass (auto-opening the first changed file's diff on commit/checkpoint selection, a two-region file-list/diff layout, a collapsible commit-metadata summary). Both were verified against real fixture repos (linear/branched/merge history, empty, bare, detached HEAD, mid-merge/conflicted) and passed a security review before merging (path-containment and git-hook-execution hardening on the new staging/diff code). No public screenshots, demos, testimonials, or case studies exist yet. `specs/commit-graph.md`, `specs/stage-unstage-diff.md`, and `specs/detailpanel-auto-diff.md` are the shipped PRDs; future PRDs follow the v1 priority order in Capabilities and Constraints above. Future design work must not fabricate testimonials, benchmarks, pricing, or customer references — none exist.

## Product Principles

1. Must work with ANY git repository — local, GitHub, GitLab, Bitbucket, self-hosted, bare, submodules, worktrees. Never design around a specific host or require sign-in to one.
2. No forced account creation, no telemetry by default, no feature paywalls.
3. No proprietary sync layer or backend — the app runs entirely against the user's local git and their own remotes.
4. Legibility of structure over configuration: default views (e.g. ref filtering on a large repo) must be usable without setup.
5. Correctness on git edge cases (shallow/grafted history, bare repos, orphan branches, detached HEAD, huge histories, in-progress rebase/merge/bisect) is a first-class requirement, not an afterthought.
