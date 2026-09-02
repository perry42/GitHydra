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
- v1 build priority order, highest first: commit graph visualization (shipped) → stage/unstage + diff (shipped) → branch create/switch/delete (shipped) → merge/rebase + conflict resolution UI (shipped) → stash (shipped) → cherry-pick (shipped) → blame/history (shipped). v1 complete; everything else is v2+ (see `ROADMAP.md`).

## Brand Commitments

Product name "GitHydra" is confirmed as the product/working name for design purposes (user-confirmed during init). This does not mean it's cleared for public release: no open-source license has been chosen yet (`package.json` still says `UNLICENSED`), and trademark/naming proximity to GitKraken has not been checked. Read the `oss-licensing-guardrails` skill before any public naming, branding, or LICENSE decision.

## Evidence on Hand

All seven v1 features are built and runnable (`packages/desktop`, `npm start`): the commit graph visualization; stage/unstage + diff (per-file working-directory status, diff content for unstaged/staged/untracked/historical files, stage/unstage/discard, commit creation) with its follow-up UX pass (auto-opening the first changed file's diff on commit/checkpoint selection, a two-region file-list/diff layout, a collapsible commit-metadata summary); branch management (local create/create-and-switch/switch/delete, remote-tracking-aware create with no network calls, locally-computed ahead/behind, two-tier unmerged-branch delete safety); merge/rebase + conflict resolution (rich in-progress-operation detail, per-file conflict classification/diff/resolution across text/rename/delete-modify/add-only/binary/submodule shapes, abort/continue); stash (list/preview/create/apply/pop/drop, worktree-shared visibility, conflict-on-apply reusing the existing conflict-resolution UI with no synthesized abort affordance since git itself has none there); cherry-pick (single and multi-commit selection with graph-order application regardless of click order, git's native sequencer for correct multi-commit abort/continue, empty-result skip/commit-empty handling, conflict resolution reusing the existing UI); and blame & file history (per-line authorship and file evolution, reusing `diff.ts`'s guard-before-fetch shape and `commitLog.ts`'s paged-reader contract). All seven were verified against real fixture repos (linear/branched/merge history, empty, bare, detached HEAD, mid-merge/conflicted, unborn HEAD, worktrees — including two real linked worktrees for stash's sharing behavior, 300+ branches, repos configured against five different remote-host shapes, and a ~1500-commit history for blame/file-history scale) and passed security review before merging — path-containment and git-hook-execution hardening on the staging/diff code, an argv-ordering/injection fix on the branch-management git plumbing, and (on stash) a pre-existing-conflict misattribution fix caught before merge. No public screenshots, demos, testimonials, or case studies exist yet. `specs/commit-graph.md`, `specs/stage-unstage-diff.md`, `specs/detailpanel-auto-diff.md`, `specs/branch-management.md`, `specs/merge-rebase-conflict-resolution.md`, `specs/stash.md`, `specs/cherry-pick.md`, and `specs/blame.md` are the shipped PRDs; v1 is complete, future PRDs follow `ROADMAP.md`. Future design work must not fabricate testimonials, benchmarks, pricing, or customer references — none exist.

## Product Principles

1. Must work with ANY git repository — local, GitHub, GitLab, Bitbucket, self-hosted, bare, submodules, worktrees. Never design around a specific host or require sign-in to one.
2. No forced account creation, no telemetry by default, no feature paywalls.
3. No proprietary sync layer or backend — the app runs entirely against the user's local git and their own remotes.
4. Legibility of structure over configuration: default views (e.g. ref filtering on a large repo) must be usable without setup.
5. Correctness on git edge cases (shallow/grafted history, bare repos, orphan branches, detached HEAD, huge histories, in-progress rebase/merge/bisect) is a first-class requirement, not an afterthought.
