# PRD: Blame & file history

Status: draft — seventh and final feature in the v1 build order (`PRODUCT.md`, `CLAUDE.md`), immediately after cherry-pick (shipped)
Owner: product-manager
Priority: P0 — completes the v1 feature set

Reuses several already-shipped patterns rather than re-deriving them: `diff.ts`'s guard-before-fetch discriminated result shape (binary/too-large before full content is ever materialized), `commitLog.ts`'s paged-reader (`CommitPager`) contract and its "SHA filtering is not a log walk" precedent (a dedicated read path instead of forcing everything through one generic multi-ref walker), `pathSafety.ts`'s containment checks, `DiffView`'s named non-content states, and `ContextMenu` (previously used only on graph rows and ref chips). **Sequencing:** git-core-engineer builds first (new `packages/git-core/src/blame.ts`: `getFileBlame`/`getFileHistory`); ui-graphics builds second, against those return shapes, adding a `BlamePanel` and wiring a new "Blame" context-menu entry onto `ChangesPanel`/`DetailPanel` file rows.

## Problem

A developer looking at any file constantly needs two questions answered without leaving GitHydra: "who wrote this line, and when/why" (blame) and "how has this file evolved" (file history) — today satisfiable only by dropping to a terminal for `git blame`/`git log --follow -- path`. This is the last item in the v1 priority order; every other shipped surface (`DetailPanel`'s changed-file list, `ChangesPanel`'s file rows) can already show a diff but none can show provenance.

## Target user

Same day-to-day developer as every prior spec, across local-only, GitHub/GitLab/Bitbucket/self-hosted, bare, worktree, and submodule repos, at scales from a few hundred commits to enterprise monorepos with hundreds of thousands of commits. Hits blame when reading unfamiliar code and wanting to know who/why, when investigating a bug via "when did this line change," or deciding whether to loop someone in before touching a line they authored. Hits file history when browsing how a file got to its current shape, or picking an earlier revision to blame against.

## Must-have behavior

### Data & git semantics (git-core-engineer) — new `packages/git-core/src/blame.ts`

- FR-123: `getFileBlame(cwd, path, revision)` — `revision: string | null`. `null` blames the current working-tree content (`git blame` with no revision — includes uncommitted lines, attributed per FR-126); a commit SHA blames the file as of that historical commit (`git blame <sha> -- path`). Runs `git blame --porcelain`, argv arrays only, `--end-of-options` guarding the caller-supplied `revision` exactly as `diff.ts`'s commit source does, and `assertPathWithinWorkdir()` for the no-revision (working-tree) case.
- FR-124: Returns a discriminated result matching `FileDiffResult`'s convention: `{status:"ok", lines: BlameLine[]}` | `{status:"binary"}` | `{status:"too-large", reason, ...}` | `{status:"not-found"}` (file doesn't exist at this revision) | `{status:"empty"}` (zero-length file — a valid state, not an error). Each `BlameLine`: `content`, `lineNumber`, `commit: {sha, abbrevSha, authorName, authorEmail, authorDate, summary, isBoundary, isUncommitted}`.
- FR-125: Binary/size guards run before full blame output is materialized, mirroring `diff.ts`'s guard-before-fetch order: binary detection first, then a file-size guard reusing `DEFAULT_MAX_FILE_SIZE_BYTES`'s value, before `git blame`'s full run is ever invoked. A file over threshold returns `too-large` with no blame call made.
- FR-126: Uncommitted local edits (no-revision blame on a file with unstaged/staged changes) are never fabricated into a synthetic `CommitInfo` — parsed from porcelain's real all-zero boundary SHA into `isUncommitted: true` with `authorName` set to git's own literal "Not Committed Yet" string (passed through, not reworded), no committer/date fields treated as real metadata.
- FR-127: Shallow/grafted boundary commits (porcelain's boundary marker) are flagged `isBoundary: true`, mirroring `commitLog.ts`'s `isHistoryBoundary` convention — never silently shown as a true root commit.
- FR-128: A no-revision blame path that resolves outside the working directory is rejected via the same containment check `diff.ts`'s untracked source and `staging.ts` already require — never a raw filesystem read.
- FR-129: `getFileHistory(cwd, revision, path, count)` — a paged reader (same `readPage(count)`/`close()` contract as `CommitPager`) over `git log --follow --format=<...> <revision> -- <path>`, never fully materializing a long-lived file's (e.g. `README.md`, `package.json`) full history up front in a huge monorepo. `--follow` requires a single revision + single path, so this is a dedicated read path, not routed through `CommitLogReader`'s `--all`-based multi-ref walk — same reasoning `commitLog.ts`'s existing SHA-lookup precedent already established. Pre-rename history is included by default.
- FR-130: No network calls anywhere in this module — identical behavior regardless of remote host or absence of one.

### Rendering & interaction (ui-graphics) — `packages/desktop`

- FR-131: A new "Blame" action, reusing the existing `ContextMenu` component (its first use on a file row rather than a graph row or ref chip), reachable via right-click on: `ChangesPanel`'s Staged/Unstaged rows (blames `revision=null`, the working-tree file) and `DetailPanel`'s changed-file list rows (blames `revision=<that commit's sha>`). Untracked and Conflicted rows show Blame disabled with an explicit reason ("never committed" / "resolve conflicts first") — the established disabled+reason policy, never hidden outright.
- FR-132: New `BlamePanel` — a right-edge panel following the established two-region resizable-panel pattern. Primary region renders the blamed file per FR-124/126/127: contiguous lines from the same commit are visually banded as one block, with commit metadata (abbreviated SHA, author, relative date, subject) shown once per block, not repeated per line — tabular-nums line numbers and monospace content, matching `DiffView`'s existing conventions. FR-124's binary/too-large/not-found/empty results each render as an explicit named state, matching `DiffView`'s non-diff-state convention (never a blank pane).
- FR-133: A collapsible "File history" region within `BlamePanel` (reusing the collapsed-disclosure pattern `DetailPanel`'s metadata block and `FilterBar` already established), listing FR-129's paged commits (subject/author/relative date/short SHA — `DetailPanel`'s existing row convention) for the blamed path. Selecting a row re-blames the same panel in place against that commit, rather than opening a second view.
- FR-134: Clicking a blamed block's commit metadata selects that commit via the graph's existing selection mechanism (same as a normal row click) and opens its `DetailPanel`. If the commit isn't currently visible under the graph's active filter, the existing SHA-based filter (`commit-graph.md` FR-7) is applied to reveal it — no new jump/scroll mechanism is built.
- FR-135: The uncommitted-lines block (FR-126) renders visually distinct from a real commit block with no clickable jump-to-commit affordance (there is no commit to jump to), labeled with git's literal "Not Committed Yet" text, never color-only.
- FR-136: Every disabled/non-content state this spec introduces (FR-131's disabled reasons, FR-132's non-content states) carries a text label, never a color-only signal.
- FR-137: Zero outbound network requests across every blame/file-history flow, verified on repos configured against GitHub, GitLab, Bitbucket, a self-hosted remote, and a purely local repo with no remote.
- FR-138: No refresh-contract entry is needed here (unlike every mutating spec before this one) — blame/file-history are pure reads; opening/using `BlamePanel` never alters `HEAD`, the index, or any working-tree file.

### Edge cases & constraints

Bare repo: `DetailPanel`-driven blame (a real commit SHA) works normally, matching `diff.ts`'s commit-mode source; `ChangesPanel`-driven blame is unreachable since `ChangesPanel` shows no file rows there. Unborn HEAD: no committed file has ever existed, so Blame never appears. Worktrees: blame reads are per-worktree working-tree content, exactly like `diff.ts`'s unstaged/staged sources. Submodules: a gitlink row is not diffable today (`merge-rebase-conflict-resolution.md` FR-77) and gets the same non-diffable treatment for Blame. A renamed file: FR-129's `--follow` surfaces pre-rename history by default, and blame at any revision follows the file's own rename lineage automatically (git's default behavior, no extra flag) — the non-goal below is only about cross-file copy/move detection, not a file's own renames.

## Non-goals (v1)

- **Move/copy detection across other files** (`git blame -C`/`-M`). Expensive on large repos and not a daily-driver need the way plain per-line/per-file blame is; a file's own rename lineage is still followed by default. Fast-follow candidate.
- **Ignore-whitespace blame** (`git blame -w`). Useful after a reformat-only commit but adds a settings surface for a preference most users won't touch per-file. Fast-follow candidate, matching this codebase's precedent of not exposing rarely-changed per-operation toggles by default (e.g. cherry-pick's `-x`).
- **One-click "blame the parent of this line" chain-jump.** FR-133's file-history list already lets a user manually pick an earlier revision and re-blame against it — a slower, two-step version of the same outcome — so the dedicated one-click affordance is deferred, not blocking v1.
- **Partial/viewport-only blame** for huge files. FR-125's size guard is the v1 answer; true incremental/streaming blame is a performance optimization to revisit only if the guard proves too coarse in practice.
- **Blame on an untracked file.** Nothing to blame — stays disabled with a reason (FR-131), never a fabricated/empty response.
- **Combined (all-parents) blame for a merge commit.** Matches `git-core`'s existing first-parent-only convention for merge diffs (`getCommitFileDiff()`) — blame at a merge commit blames its first-parent tree.
- **Any network call, and telemetry on blame/file-history usage.** None, per product principles.

## Acceptance criteria

1. Right-clicking an Unstaged or Staged row in `ChangesPanel` and choosing Blame opens `BlamePanel` showing every line of the file's current working-tree content, each attributed to a real commit or, for a locally-modified line, "Not Committed Yet".
2. Right-clicking a changed-file row in `DetailPanel` for a historical commit and choosing Blame shows that file's content exactly as of that commit — never the working tree's current content — verified against a file modified since.
3. Blame on a file untouched since its initial commit shows every line attributed to that one commit, with no "Not Committed Yet" block.
4. Blame on a binary file returns the FR-124 binary state and `BlamePanel` renders the named binary state, never raw/garbled content and never a blank pane.
5. Blame on a file exceeding the FR-125 size guard renders the named too-large state with the reason inlined, and no full `git blame` content is ever fetched.
6. Blame on a file renamed at some point in its history correctly attributes pre-rename lines to their original commits with no extra configuration, and FR-133's file-history list includes pre-rename commits.
7. Clicking a blamed block's commit metadata selects that commit in the graph and opens its `DetailPanel`, including when that commit isn't currently visible under the graph's active filter (the SHA filter is applied and the commit becomes visible/selected).
8. Selecting an earlier commit from FR-133's file-history list re-blames the same open `BlamePanel` against that commit's version of the file, without closing/reopening the panel.
9. Blame is shown disabled with an explicit reason on Untracked and Conflicted rows in `ChangesPanel`; no git call is made if clicked regardless.
10. Opening `BlamePanel`, browsing file history, and re-blaming never changes `HEAD`, the index, or any working-tree file — verified via `git status --porcelain` before/after showing zero diff.
11. Zero outbound network requests across blame and file-history flows, on repos configured against GitHub, GitLab, Bitbucket, a self-hosted remote, and a purely local repo with no remote.
12. On a bare repository, Blame from a `DetailPanel` changed-file row works normally; `ChangesPanel` offers no file rows (and thus no Blame entry point), matching its existing bare-repo state.
13. File history for a file touched by thousands of commits pages incrementally (FR-129) rather than blocking `BlamePanel`'s open on a full history fetch.

## References

- `packages/git-core/src/diff.ts` (`getFileDiff`, commit-mode `planDiffArgs`, `DEFAULT_MAX_FILE_SIZE_BYTES`) — the guard-before-fetch/binary/too-large pattern FR-124/125 extend.
- `packages/git-core/src/commitLog.ts` (`CommitLogReader`, `CommitPager`, `findCommitsBySha`) — the paged-reader contract FR-129 matches, and the precedent for a dedicated read path instead of the shared multi-ref walker.
- `packages/git-core/src/pathSafety.ts` (`assertPathWithinWorkdir`) — required for FR-128.
- `packages/desktop/src/components/DiffView/` — the non-diff-state convention FR-132 extends to blame.
- `packages/desktop/src/components/ContextMenu/ContextMenu.tsx` — reused for FR-131, its first use on a file row.
- `specs/commit-graph.md` FR-7 — the existing SHA-filter mechanism FR-134 reuses.
- `packages/git-core/README.md` ("Design notes": merge-commit first-parent convention, shallow/graft boundary marking) — both extended to blame here.
