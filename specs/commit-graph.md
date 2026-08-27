# PRD: Commit Graph Visualization

Status: v1 draft
Owner: product-manager
Priority: P0 — first feature in the v1 build order

## Problem

`git log` and its variants are the ground truth for a repo's history, but they're
line-oriented text — a working developer has to mentally reconstruct branch
topology, merge structure, and "where am I relative to everything else" from
scrolling text. That reconstruction gets harder exactly when it matters most:
mid-rebase, reviewing a merge-heavy release branch, or onboarding onto a repo
with unfamiliar history. GitHydra's first job is to make that structure visible
at a glance, for any repository, without requiring a hosted service to do it.

## Target user

A developer working in git day-to-day — solo or on a team, on a local-only
repo, a self-hosted GitLab/Gitea instance, GitHub, Bitbucket, or a bare repo
they're inspecting on a server. They already know git; they don't need it
explained, they need to *see* it. They may be working with repos ranging from
a few hundred commits to enterprise-scale monorepos with hundreds of thousands
of commits and hundreds of branches.

## User stories

- As a developer, I open a repo and immediately see a graph of commits with
  branch/tag/HEAD labels, so I know where I am without running `git log
  --graph` first.
- As a developer, I want to scroll back through years of history in a large
  repo without the app hanging or the UI dropping frames.
- As a developer reviewing a release branch, I want to visually trace which
  commits came in through which merge, including in histories with dozens of
  interleaved branches.
- As a developer in the middle of an interactive rebase or a detached-HEAD
  checkout, I want the graph to clearly show I'm not on a branch tip.
- As a developer, I want to filter the graph by branch, author, commit
  message/SHA, or file path, so I can find a specific commit in a large
  history quickly.
- As a developer working against a bare repo (e.g., inspecting a server-side
  mirror) or a shallow clone (CI checkout), I want the graph to render
  correctly instead of erroring out.
- As a developer, I want to click a commit and see its metadata and the list
  of files it touched, without leaving the graph view.
- As a developer, I want the graph to update when refs change underneath me
  (another terminal does a pull, a hook runs, a rebase completes), without
  having to close and reopen the repo.

## Must-have behavior

### Data & git semantics (primarily git-core-engineer)

- FR-1: Read commit history via the repo's actual ref graph (all local
  branches, all remote-tracking branches, tags, and HEAD) — not just the
  current branch. Must work identically regardless of remote host (GitHub,
  GitLab, Bitbucket, self-hosted, or no remote at all); the graph is built
  from local git data only.
- FR-2: Correctly compute and expose parent/child relationships for merge
  commits (2+ parents) and, if present, octopus merges (3+ parents).
- FR-3: Load history incrementally/on-demand (paged or batched by commit
  count, e.g., N commits per page) — never require the full history to be
  read into memory before the first paint.
- FR-4: Support the following without erroring: bare repositories, shallow
  clones (`--depth`), grafted/truncated history, orphan branches (no common
  ancestor with other refs), repos with zero commits (fresh `git init`),
  repos in an unborn-HEAD state, detached HEAD, worktrees, and repos
  containing submodules (submodule commits are not expanded inline — see
  Non-goals).
- FR-5: Detect and expose when a repo is in an in-progress state that affects
  HEAD's meaning: mid-merge, mid-rebase, mid-cherry-pick, mid-bisect. The
  graph must label this state rather than silently rendering HEAD as if
  nothing were happening (exact conflict-resolution UI is out of scope here —
  see the merge/rebase spec — but the graph must not lie about state).
- FR-6: Provide a way to detect upstream ref changes (e.g., filesystem watch
  on `.git/refs`, `.git/HEAD`, `.git/packed-refs`, or equivalent) so the graph
  can refresh without a full app restart. A manual refresh action must exist
  regardless of whether auto-detection is implemented for v1.
- FR-7: Support filtering the underlying commit query by: branch/ref, author
  (name or email), commit message substring, commit SHA (full or abbreviated
  prefix), date range, and file path (commits touching a given path).
- FR-8: Expose per-commit metadata: full SHA, abbreviated SHA, author
  name/email, author date, committer name/email, committer date, full commit
  message (subject + body), parent SHAs, and referencing tags/branches. GPG
  signature status is nice-to-have metadata (verified/unverified/none) but not
  blocking for v1.
- FR-9: No network calls of any kind are made to render the graph. All data
  comes from the local `.git` directory. No avatar/gravatar fetching, no
  "enrich this commit" calls to GitHub/GitLab/Bitbucket APIs, by default.

### Rendering & interaction (primarily ui-graphics)

- FR-10: Render commits as nodes in a vertical, scrollable graph with lanes
  representing concurrent branches; lines connect each commit to its
  parent(s). Standard git-graph visual conventions apply (distinct lane color
  per branch line, merge lines converging, curves rather than sharp elbow
  crossings where reasonable).
- FR-11: Label commits that are the tip of a ref: local branch names, remote-
  tracking branch names (visually distinguished from local), tags, and HEAD
  (visually distinguished when detached vs. attached to a branch).
- FR-12: The graph must be virtualized — only render DOM/GPU work for commits
  currently in or near the viewport. Scrolling must not require re-rendering
  the entire loaded history.
- FR-13: Selecting a commit opens a detail panel showing: full message,
  author/committer info with dates, parent SHA(s) (clickable to jump to
  parent), referencing branches/tags, and a list of changed files (add/
  modify/delete/rename) with counts. Showing the actual file diff content is
  out of scope for this spec (see stage/unstage + diff PRD) — the file list
  and change-type per file is in scope.
- FR-14: Provide a search/filter bar in the graph view backed by FR-7, with
  results that scroll/jump the graph to matches rather than replacing the
  graph with a flat list.
- FR-15: Provide a way to show/hide remote-tracking branches and tags as a
  toggle, since large repos can have hundreds of refs cluttering the label
  area. Default view should be legible without user configuration on a
  typical repo (roughly: show local branches, current branch's upstream, and
  tags reachable near HEAD; let the user expand to "show all").
  Exact default heuristic is left to ui-graphics to propose against this
  constraint — legibility on first open, no required configuration.
  FLAG: **needs a follow-up decision from ui-graphics** on the exact default
  filtering heuristic for ref-heavy repos.
- FR-16: A right-click context menu exists on a commit node as an extension
  point (checkout, create branch here, cherry-pick, revert, reset, etc.). The
  actual git behavior behind each action is defined in that action's own PRD
  (branch management, cherry-pick, merge/rebase) — this spec only requires
  that the graph expose the interaction surface; it does not define the
  actions' git semantics.
- FR-17: Visually distinguish the currently-checked-out commit/branch tip from
  the rest of the graph at all times (not just on selection).
- FR-18: Uncommitted working-directory changes, when present (i.e., not a
  bare repo), are represented as a distinguishable pseudo-node above HEAD
  (e.g., "Uncommitted changes") so the graph reflects what `git status` would
  show, without requiring the user to switch views. This pseudo-node is not
  a real commit and must not be selectable as a ref target for git operations
  that require a real SHA.

## Edge cases & constraints

These must be explicitly handled, not just "not crash":

- **Very large histories** (100k–1M+ commits, e.g., Linux-kernel scale):
  virtualized rendering + paged loading (FR-3, FR-12) are the mitigation.
  Initial paint must not depend on total history size.
- **Merge-heavy / high branch-count repos**: many concurrent lanes. The
  layout algorithm must handle lane reuse/crossing without lane count growing
  unbounded on screen; if lanes exceed a reasonable on-screen count, provide
  a way to collapse/simplify (e.g., collapse merged-in side branches into
  their merge commit) rather than rendering off-screen or overlapping lanes.
- **Detached HEAD**: HEAD label rendered on its actual commit, clearly marked
  as detached (not implying it's a branch tip).
- **Bare repositories**: no working directory exists — FR-18's uncommitted-
  changes pseudo-node must not appear; graph renders from refs only.
- **Orphan branches** (`git checkout --orphan`, or genuinely disconnected
  history roots): rendered as a separate root/component in the same graph
  view, not merged visually with unrelated history, and must not cause a
  layout or data-fetch error.
- **Empty repo** (`git init`, zero commits, unborn HEAD): graph view shows an
  explicit empty state, not a blank/broken canvas.
- **Shallow clones / grafted history**: the boundary commit(s) where history
  is truncated must be visually marked (e.g., "history unavailable beyond
  this point") rather than silently appearing as a root commit.
- **Submodules**: the parent repo's graph renders normally; submodule commits
  are not expanded into the same graph (see Non-goals). A commit that changed
  a submodule pointer shows that as a changed "file" entry in FR-13's file
  list, same as any other path.
- **Worktrees**: v1 treats each open worktree as its own window/session
  showing that worktree's checked-out branch; this spec does not require a
  single graph view to simultaneously show multiple worktrees' HEADs.
- **External history rewrites** (another process force-pushes, rebases, or
  amends while GitHydra is open): graph must not silently show stale data
  indefinitely — refresh must be at minimum a one-click manual action (FR-6).
- **Malformed/unusual commit data**: non-UTF-8 commit messages, missing
  author email, extremely long commit message bodies, and octopus merges
  must render without crashing the view (truncate/escape display as needed
  rather than failing).
- **Ref clutter**: repos with hundreds of local/remote branches and tags —
  covered by FR-15's default-filtering requirement.

## Non-goals (v1)

- **Inline diff viewing.** Selecting a commit shows metadata and a changed-
  file list (FR-13), not diff content — that's the stage/unstage + diff view
  PRD (next priority).
- **Graph-driven history editing** (drag-and-drop interactive rebase, drag-
  to-reorder commits, drag-to-merge). The graph is view + selection + context-
  menu entry points only in v1; the underlying rebase/merge logic and any
  drag-based UI is scoped separately.
- **Host-specific overlays** (PR/MR status badges, CI check marks, review
  comments from GitHub/GitLab/Bitbucket). This would require API calls to a
  specific host and, per product principles, cannot be required or default-on
  for v1. If built later, it must be opt-in, use the user's own credentials/
  token, and degrade to nothing on a repo with no such remote — not built now.
- **Avatars from remote services** (Gravatar, GitHub avatar API, etc.). No
  default network calls (FR-9). A future opt-in local-only avatar cache (e.g.,
  from local git config or a user-provided image) is a v2+ idea, not v1.
- **Telemetry/analytics** on graph usage (which commits are clicked, how
  often filters are used, etc.). None, by default, per product principles.
- **Cross-repo / unified multi-repo graph** (e.g., a single graph spanning a
  submodule and its parent, or multiple unrelated repos in one view).
- **Multi-user/collaborative features** (shared cursors, live presence) —
  no backend exists or is planned for this.
- **Blame/line-history view** — separate, lower-priority spec.

## Acceptance criteria

1. Given a local repo with linear history only, opening the repo renders the
   commit graph with correct commit order, and HEAD/current-branch label on
   the correct commit, within 1 second for a 1,000-commit repo.
2. Given a repo with at least 3 branches and 2 merge commits, the graph
   correctly draws parent-child lines for every commit, including both
   parents of each merge commit, with no crossed/mislabeled lines.
3. Given a repo with 100,000+ commits, initial graph paint occurs without
   loading the full history up front (verified via paged/batched data
   fetching), and scrolling through loaded history does not drop below
   interactive frame rates on reference hardware.
4. Given a repo in detached HEAD state, the graph visually distinguishes HEAD
   from any branch tip label at the same or a different commit.
5. Given a bare repository, opening it renders the graph from refs with no
   uncommitted-changes pseudo-node and no error.
6. Given a repo with an orphan branch (no common ancestor with `main`), the
   graph renders both history components without error or forced merging of
   unrelated roots.
7. Given a freshly-initialized repo with zero commits, the graph view shows
   an explicit empty state, not a blank or errored canvas.
8. Given a shallow clone, the graph renders available commits and visually
   marks the truncation boundary rather than presenting it as a true root.
9. Selecting any commit opens a detail panel showing full message, author/
   committer info, parent SHA(s), and a correctly-typed (added/modified/
   deleted/renamed) list of changed files, with no diff content required.
10. Using the filter bar to search by author, message substring, SHA prefix,
    date range, or file path narrows/jumps the graph to matching commits, and
    clearing the filter returns to the full view without reloading from
    scratch.
11. After an external process changes refs (e.g., a `git pull` run in a
    separate terminal on the same repo), a manual refresh action in GitHydra
    updates the graph to reflect the new state without restarting the app.
12. None of the above requires network access; verified by confirming zero
    outbound requests are made during graph load, scroll, filter, or commit
    selection on a repo with a remote configured.
13. The same repo opened from a GitHub-hosted clone, a GitLab-hosted clone, a
    Bitbucket-hosted clone, a self-hosted remote, and a purely local repo
    with no remote at all all render identically (host has zero effect on
    graph behavior).

## Open items

- FR-15: exact default ref-filtering heuristic for ref-heavy repos is left
  for ui-graphics to propose against the stated constraint (legible by
  default, no required configuration).
