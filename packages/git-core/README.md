# @githydra/git-core

Local git engine for GitHydra. Implements the "Data & git semantics" requirements from
`specs/commit-graph.md` (FR-1 through FR-9, commit history/refs/changed-file reading) and
`specs/stage-unstage-diff.md` (FR-19 through FR-27: per-file working-directory status, diff
content, stage/unstage/discard, and commit creation).

- Shells out to the system `git` CLI (`child_process.spawn`, argv arrays only, `shell: false`).
- Makes no network calls, ever. Every read comes from the local `.git` directory.
- Requires `git >= 2.24.0` on PATH (needed for `--end-of-options`, used to safely pass
  repo-controlled strings like branch names as revision arguments — see "Security notes" below).
  Checked at `Repository.open()` time; throws `UnsupportedGitVersionError` if not met.

## Usage

```ts
import { Repository } from "@githydra/git-core";

const repo = await Repository.open("/path/to/repo"); // or a bare repo, a worktree, etc.
const state = repo.getState(); // bare/shallow/empty/detached/in-progress-op flags (FR-4, FR-5)

const reader = await repo.createCommitLogReader({
  author: "jane",
  dateFrom: "2024-01-01",
});
const page = await reader.readPage(50); // FR-3: paged, never loads full history up front
console.log(page.commits, page.done);
reader.close(); // always close a reader when done with it

const commit = await repo.getCommit("a1b2c3d"); // full or abbreviated SHA (FR-7's SHA filter)
const files = await repo.getChangedFiles(commit!); // FR-13's data dependency

const wdStatus = await repo.getWorkingDirectoryStatus(); // FR-18; null for a bare repo
const upstream = await repo.getUpstreamBranch(); // FR-15's default heuristic; null if none

const watcher = repo.watchForRefChanges(() => {
  /* re-fetch state/refs/log — see caveats in src/watcher.ts */
});

// --- stage/unstage/diff (specs/stage-unstage-diff.md, FR-19 through FR-27) ---

// FR-19: per-file working-directory status, split staged/unstaged/untracked/conflicted.
// null for a bare repo, same convention as getWorkingDirectoryStatus().
const changes = await repo.getWorkingDirectoryChanges();

// FR-20/FR-21/FR-22: unified diff content, or a binary/too-large result instead of raw bytes.
const unstagedDiff = await repo.getUnstagedFileDiff("src/index.ts"); // worktree vs index
const stagedDiff = await repo.getStagedFileDiff("src/index.ts"); // index vs HEAD
const untrackedDiff = await repo.getUntrackedFileDiff("NEW_FILE.md"); // all-addition vs empty
const commitDiff = await repo.getCommitFileDiff(commit!, changedFileEntry); // a historical commit's file
if (commitDiff.status === "ok") {
  console.log(commitDiff.hunks); // DiffHunk[]: header, old/new start+len, per-line add/remove/context
} else if (commitDiff.status === "binary") {
  console.log("binary file — no patch content");
} else {
  console.log(`too large to display: ${commitDiff.reason}`);
}

// FR-23: stage/unstage.
await repo.stageFile("src/index.ts");
await repo.unstageFile("src/index.ts");
await repo.stageAllFiles(); // every eligible (non-conflicted) unstaged/untracked file
await repo.unstageAllFiles(); // every eligible (non-conflicted) staged file

// FR-24: discard (destructive/unrecoverable) — distinctly named, never reachable via unstage.
await repo.discardTrackedFileChanges("src/index.ts"); // git restore --
await repo.discardUntrackedFile("scratch.txt"); // git clean -f --, scoped to this one path

// FR-25: commit staged content. Message goes via stdin, never `-m` string concatenation.
try {
  const { sha } = await repo.createCommit({ subject: "Fix the thing", body: "Optional body." });
} catch (err) {
  // NothingStagedError | MissingCommitIdentityError | CommitHookRejectedError | GitCommandError
}
```

## Module layout

- `gitProcess.ts` — the only place that spawns `git`. Enforces argv-array execution (no shell
  string ever built), `--end-of-options` for revision-like user/repo-controlled input, disabled
  credential/pager prompts, the minimum git version check, `GIT_LITERAL_PATHSPECS=1` (every
  pathspec this module ever passes is interpreted literally, never as a glob), and
  `withFsmonitorNeutralized()` — the shared helper (see its doc comment) that every command
  touching working-tree/index state prepends to argv to neutralize the repo-local
  `core.fsmonitor` hook-execution vector.
- `pathSafety.ts` — `assertPathWithinWorkdir()`/`resolveWithinWorkdir()`: validates that a
  caller-supplied path is non-empty, repo-relative, and resolves to somewhere inside the given
  working directory, rejecting absolute paths and `..`-escapes. Required before `diff.ts`'s
  "untracked" source (a `--no-index` diff, which is not itself confined to the repository) ever
  touches the filesystem, and applied as defense-in-depth to every path-taking function in
  `staging.ts`.
- `repository.ts` — resolves repo/git-dir/common-dir paths (handles bare repos and linked
  worktrees correctly) and computes `RepositoryState`: bare/shallow/empty/detached-HEAD/
  unborn-HEAD flags and in-progress merge/rebase/am/cherry-pick/revert/bisect detection (FR-4, FR-5).
- `refs.ts` — lists local branches, remote-tracking branches, and tags via `for-each-ref`,
  dereferencing annotated tags to the commit they target.
- `commitLog.ts` — `CommitLogReader`: a paged, streaming reader backed by one long-lived
  `git log` process (FR-1, FR-2, FR-3, FR-7 except the SHA filter). Also `findCommitsBySha`,
  the direct SHA/prefix lookup path (see "Design notes" below).
- `changedFiles.ts` — per-commit changed-file list (add/modify/delete/rename/copy), diffing
  merges against their first parent and root commits against git's empty-tree object. Also
  exports `EMPTY_TREE_SHA`, `HEX_SHA_RE`, and `statusToChangeType` — shared with `diff.ts` and
  `workingDirStatus.ts` so all three modules agree on the same status-letter vocabulary and
  base-commit selection.
- `workingDirStatus.ts` — working-tree status via `git status`, at two granularities:
  `getWorkingDirectoryStatus()` (FR-18's uncommitted-changes pseudo-node — summary counts only,
  `git status --porcelain=v1`) and `getWorkingDirectoryChanges()` (FR-19/FR-27 — a per-file
  staged/unstaged/untracked/conflicted list, `git status --porcelain=v2 -z`, which also carries
  rename/copy detection and a distinct record type for conflicted paths). Both neutralize the
  repo-local `core.fsmonitor` hook (`-c core.fsmonitor=false`) — see "Security notes" below.
- `diff.ts` — FR-20/FR-21/FR-22: unified diff content for the four bases stage/unstage+diff
  needs (unstaged, staged, untracked, and a historical commit's file), with a binary-file guard
  and a size guard (changed-line count, then absolute byte size) checked *before* any full patch
  text is ever fetched — a guarded-out diff never touches the large content it's guarding
  against. `parseUnifiedDiffHunks()` (also exported) turns raw unified-diff text into
  structured hunks with per-line add/remove/context typing and old/new line numbers.
- `staging.ts` — FR-23/FR-24: stage/unstage/stage-all/unstage-all, plus the destructive discard
  operations (`discardTrackedFileChanges`, `discardUntrackedFile`), kept as distinctly-named
  exports so a caller can't reach a destructive path through a non-destructive one by accident.
- `commitChanges.ts` — FR-25: `createCommit()`, message piped via stdin (`git commit -F -`),
  with typed pre-flight errors for nothing-staged and missing-identity, and a best-effort
  post-hoc classification of a hook rejection (see its doc comment for the heuristic's caveat).
- `upstream.ts` — the current branch's configured upstream (`@{u}`), for FR-15's default
  branch-selection heuristic. Resolves to `null` (not an error) when there is none.
- `watcher.ts` — best-effort FR-6 change detection. **Deferred/stubbed, see doc comment in the
  file** — not a robust cross-platform implementation yet.
- `index.ts` — `Repository`, the facade most consumers should use.

## Design notes worth knowing before you touch this code

- **SHA filtering is not a log walk.** `git log <sha>` means "history starting from `<sha>`",
  which is a different operation from "find the commit matching this SHA/prefix". FR-7's SHA
  filter is implemented as a direct lookup (`findCommitsBySha`, via `rev-parse --disambiguate`
  for prefixes) that short-circuits `Repository.createCommitLogReader`, not as a `git log` arg.
- **Paging never re-walks history.** `CommitLogReader` keeps one `git log` child process alive
  across `readPage()` calls and buffers only what's already been written to its stdout pipe —
  no `--skip=N` (which is O(n) per page and gets worse as a scroll session goes on).
- **Shallow clones / grafts are marked, not silently rooted.** Commits listed in `.git/shallow`
  or `.git/info/grafts` are flagged `isHistoryBoundary: true` on the returned `CommitInfo` even
  though they have no parents in this repo's object database — the UI is expected to render
  that differently from a true root commit.
- **Merge-commit file lists diff against the first parent**, matching GitHub/GitLab/GitKraken
  convention for "what did this merge bring in." `getCommitFileDiff()` (FR-20d) follows the
  same base-selection rule.
- **Untracked-file diffs use `/dev/null` as the "empty" side**, via `git diff --no-index`. This
  is not an OS device-path lookup: git's own diff machinery special-cases the literal string
  `"/dev/null"` as "treat this side as empty," so it behaves identically on Windows (including
  Git for Windows) as on macOS/Linux — verified by `tests/diff.test.ts`'s untracked-file cases,
  which pass on this Windows dev environment. `--no-index` also has different exit-code
  semantics than every other diff invocation in this module (exits `1`, not `0`, when the two
  sides differ — the normal case here); `getFileDiff()` accounts for that via
  `runGitAllowingExitCodes()` rather than treating it as a failure.
- **`stageAllFiles()`/`unstageAllFiles()` enumerate paths rather than using a blanket
  `git add -A` / `git restore --staged :/`.** During an unresolved merge/rebase, a blanket
  `-A` would also silently stage (and thereby mark "resolved") any conflicted path it finds on
  disk — enumerating via `getWorkingDirectoryChanges()` first and passing an explicit path list
  means conflicted paths (which only ever appear in their own `conflicted` category, never in
  `staged`/`unstaged`) are structurally never touched by either "all" operation (FR-27).
- **`unstageFile()`/`unstageAllFiles()` unstage a renamed/copied entry as its old+new path
  pair, not just the new path (fixed post-QA — was a real silent-data-loss bug, not a scope
  call).** Git records a staged rename/copy internally as an old-path delete + new-path add.
  Restoring only the new path (`git restore --staged -- renamed.txt`) left the old path's
  delete still staged — invisible in the UI as anything other than a plain successful unstage,
  but a later commit would permanently delete the original file from history with no trace of
  the rename. `restorePathsFor()` in `staging.ts` looks up the staged entry first (via
  `getWorkingDirectoryChanges()`) and includes `oldPath` in the `git restore --staged --`
  pathspec whenever `status` is `"renamed"`/`"copied"` — the same old+new pairing approach
  `diff.ts`'s commit-mode source already uses for a historical rename's diff. Regression tests:
  `tests/changesFacadeIntegration.test.ts`'s "AC6" describe block.
- **`createCommit()`'s hook-rejection detection is a heuristic, not a certainty.** git gives no
  machine-readable signal distinguishing "a pre-commit/commit-msg hook rejected this commit"
  from any other `git commit` failure. After ruling out the two other named FR-25 failure modes
  (nothing staged, missing identity) before ever invoking `git commit`, a residual failure is
  classified as `CommitHookRejectedError` if an executable-looking pre-commit or commit-msg
  hook file is present in the repo's hooks directory, else as a plain `GitCommandError`. Either
  way the raw stderr is always preserved and surfaced to the caller, so no information is lost
  even on a misclassification. Flagging to product-manager as a known-imprecise edge, not a
  silent gap.

## Known limitations / explicitly deferred (not silently gapped)

- **FR-6 auto-refresh** (`watcher.ts`) is best-effort: `fs.watch(..., { recursive: true })`
  works on Windows/macOS but Node does not support recursive watching on Linux, so nested new
  refs may be missed there. Manual refresh (just re-calling the read methods — there is no
  cache to invalidate) always works regardless of platform and is the documented FR-6 fallback.
- **GPG signature status** (FR-8, "nice-to-have") is not exposed yet.
- **Combined (all-parents) diff for merge/octopus commits** is not implemented — only
  first-parent diff, for both `getChangedFiles()` (FR-13) and `getCommitFileDiff()` (FR-20d).
  Fine per FR-13 (which just requires *a* correctly-typed file list); `getCommitFileDiff()`
  follows the same convention for consistency with the file list it's diffing.
- **`getUpstreamBranch()` reports the tracking branch name only**, not ahead/behind commit
  counts relative to it — add that separately if/when a caller needs it.
- **`diff.ts`'s FR-22 file-size guard has a residual TOCTOU window (MEDIUM, security review).**
  A concurrent local process could swap a file — or replace it with a symlink — between the
  `statWorkdirFileSize()` size check and the actual `git diff` read moments later. Mitigated,
  not eliminated: `statWorkdirFileSize()` uses `fs.lstat` (not `fs.stat`), so a symlink is sized
  as itself (its short target-path string, which is also all git's own diff of a symlink ever
  shows) rather than silently followed to whatever it points at. Fully closing the remaining
  window would need an fd-based check-then-read, which git's CLI doesn't expose here; accepted
  as a residual, low-severity risk since it requires local code execution racing this process,
  which is already a bigger problem on its own. See the doc comment on `statWorkdirFileSize()`.
- **No hunk-/line-level partial staging.** `stageFile()`/`unstageFile()` (FR-23) are
  whole-file-only, matching `specs/stage-unstage-diff.md`'s explicit v1 non-goal
  ("Hunk- or line-level partial staging... deliberately deferred").
- **No amend-last-commit.** `createCommit()` (FR-25) always creates a new commit; amend is an
  explicit v1 non-goal per the spec.

## Security notes for security-reviewer

This module shells out to `git` with repo- and user-controlled input (repo paths, branch/tag
names from an untrusted repo, author/message search strings, file paths) but never touches
credentials, SSH keys, or tokens — FR-9 means it never invokes any git operation that could
reach the network (no `fetch`/`pull`/`push`/`clone`-with-remote), so there is no credential
surface here. The main risk class is argument injection (e.g. a repo with a branch literally
named `--upload-pack=/bin/sh`), which is mitigated by:

- Always using `spawn` with an argv array and `shell: false` — never a concatenated command
  string, so shell metacharacters are inert regardless of content.
- `withEndOfOptions()` in `gitProcess.ts`, prepending `--end-of-options` before any
  user/repo-controlled revision argument, so it can never be parsed as a flag.
- Value-bearing flags (`--author=`, `--grep=`, `--since=`, `--until=`) always built as a single
  argv token (`optionEquals()`), so a value starting with `-` can't be split into a separate,
  independently-parsed flag.
- Path filters always appended after a literal `--`, AND (as of the stage/unstage/diff work)
  `GIT_LITERAL_PATHSPECS=1` is set process-wide in `gitProcess.ts`'s `safeEnv()`, so a filename
  containing pathspec-magic characters (`*`, `?`, `[...]`, a leading `:`) is always matched
  literally rather than glob-interpreted — a real, not just theoretical, filename shape (e.g. a
  Next.js dynamic route `pages/[id].tsx`) could otherwise make `discardTrackedFileChanges()`/
  `discardUntrackedFile()` silently act on a *different* file than the one named. Confirmed via
  a repo-wide search that nothing in this codebase relies on glob pathspec behavior, so this is
  a safe blanket fix. Regression tests: `tests/gitProcess.test.ts`'s "GIT_LITERAL_PATHSPECS"
  describe block (including a positive-control proving plain, unguarded git glob-matches) and
  `tests/staging.test.ts`'s/`tests/diff.test.ts`'s "literal pathspec handling" blocks.
- SHA/prefix input validated against a strict hex regex before ever reaching a git argument.
- `GIT_TERMINAL_PROMPT=0` / blanked `GIT_ASKPASS` / `SSH_ASKPASS` — defense in depth so nothing
  in this module can ever hang on, or silently satisfy, a credential prompt.
- **Path containment for filesystem-touching operations** (`pathSafety.ts`'s
  `assertPathWithinWorkdir()`/`resolveWithinWorkdir()`): `diff.ts`'s "untracked" source builds a
  `git diff --no-index -- /dev/null <path>` call, and unlike a normal git pathspec — which git
  itself already refuses to resolve outside the working tree — `--no-index` compares two
  arbitrary *filesystem* paths and is not confined to the repository at all. Before this check
  existed, `getUntrackedFileDiff("../../../../.ssh/id_rsa")` (or an absolute path) would read
  and return that file's content as diff "add" lines: a real arbitrary-file-read primitive once
  wired to IPC from the renderer. The same check is also applied, as defense-in-depth, to every
  path-taking function in `staging.ts` (stage/unstage/discard), even though those already go
  through git's own pathspec confinement. It throws `InvalidArgumentError` rather than
  truncating/clamping, so a rejected path can never silently degrade into "unknown, don't
  block" the way it used to for the file-size guard (see next bullet). Regression tests:
  `tests/diff.test.ts`'s and `tests/staging.test.ts`'s "path containment" describe blocks.
- **`diff.ts`'s absolute-file-size guard (FR-22) previously had a silent bypass for exactly the
  escaping-path case above**: it resolved the size-check path via `path.join(cwd, relPath)`,
  which does NOT strip an absolute `relPath` — it just concatenates — so `fs.stat` on the
  resulting bogus path silently failed, and a failed stat was (deliberately, for the *legitimate*
  "file doesn't exist" case) treated as "size unknown, don't block." That meant the guard
  silently no-op'd in precisely the attack case it most needed to catch. Fixed by having
  `resolveWithinWorkdir()`'s containment check run and throw *before* the try/catch that treats
  a failed stat as "unknown" — a containment violation now always propagates as a real error,
  never gets swallowed into a pass-through `null`.
- `getWorkingDirectoryStatus()` and `getWorkingDirectoryChanges()` (`workingDirStatus.ts`)
  always pass `-c core.fsmonitor=false` ahead of `status` in argv — via the shared
  `withFsmonitorNeutralized()` helper in `gitProcess.ts`, not a locally-duplicated constant.
  Unlike most commands this module runs, `git status` consults the repo's *local* `.git/config`
  for `core.fsmonitor` and, if it's not a recognized boolean, executes it as an external hook —
  a real risk for a repo distributed as a pre-existing checkout/zip/tarball/bare-repo/worktree
  (all explicitly-supported per CLAUDE.md, not just a fresh `git clone`, which never copies this
  local config). The `-c` override always wins over `.git/config` for that one invocation.
  **This guard used to live only on the `status` call** — the stage/unstage/diff work added
  several more commands that refresh the same index/working-tree state against the same kind of
  untrusted repo without it (a real, shipped gap): `diff.ts`'s unstaged/staged numstat and patch
  calls, the staged-side `git cat-file -s :<path>` size check (reading the index), every command
  in `staging.ts` (`add`, `restore --staged`, `restore`, `clean -f`), and `commitChanges.ts`'s
  `git diff --cached --quiet` nothing-staged check and the `git commit` call itself. All of
  those now go through `withFsmonitorNeutralized()`. `core.hooksPath` was checked and does not
  need the same treatment for `status` specifically — verified empirically that plain
  `git status` invokes no hook at all (unrelated to `core.fsmonitor`). Regression tests: the
  original `tests/workingDirStatus.test.ts` "fsmonitor argument-injection guard" block, plus a
  matching block added to `tests/diff.test.ts`, `tests/staging.test.ts`, and
  `tests/commitChanges.test.ts` for each of the newly-guarded call sites, and a
  `tests/gitProcess.test.ts` "withFsmonitorNeutralized" block (including a positive control for
  `add`, proving plain/unguarded `git add` really does execute the hook in this environment).
- **`createCommit()` (`commitChanges.ts`) is a deliberate, single exception to this module's
  otherwise-universal "never execute repo-provided hook code" posture.** `git commit` runs
  `pre-commit`/`commit-msg`/`post-commit` hooks by git's own design, and FR-25 explicitly
  requires surfacing a hook rejection to the caller rather than suppressing it — so, unlike
  every other command in this module, hooks are intentionally **not** disabled (no
  `--no-verify`) here. This means opening an untrusted repo and calling `createCommit()` on it
  can execute an arbitrary script that repo shipped in `.git/hooks/` (or wherever
  `core.hooksPath` points). This is expected, user-initiated behavior — identical to running
  `git commit` from a terminal in the same repo — but it's the one place in `git-core` where
  repo-controlled code execution is in scope by design, worth a specific look.
- `createCommit()`'s commit message is always passed via stdin (`runGitWithInput`, `git commit
  -F -`), never appended to argv or built into a shell string, so no message content —
  including one crafted to look like a flag — can be misparsed as an option.
- `discardUntrackedFile()` (`staging.ts`, FR-24) always scopes `git clean -f --` to exactly the
  one caller-supplied path, never a bare `git clean -fd` (which would sweep the entire working
  tree) — a correctness/safety property worth re-checking if this function is ever touched.

See `tests/commitLog.test.ts` ("argument-injection guard") for a regression test against a
malicious ref name, and `tests/workingDirStatus.test.ts` ("fsmonitor argument-injection guard")
for a regression test against a malicious `core.fsmonitor` value — including a positive-control
test that proves the exploit actually fires against plain, un-neutralized `git status` in this
environment, so the "does not execute" assertion isn't just a no-op.
