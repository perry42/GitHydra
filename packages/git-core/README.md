# @githydra/git-core

Local git history-reading engine for GitHydra's commit graph. Implements the "Data & git
semantics" requirements (FR-1 through FR-9) from `specs/commit-graph.md`.

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

const watcher = repo.watchForRefChanges(() => {
  /* re-fetch state/refs/log — see caveats in src/watcher.ts */
});
```

## Module layout

- `gitProcess.ts` — the only place that spawns `git`. Enforces argv-array execution (no shell
  string ever built), `--end-of-options` for revision-like user/repo-controlled input, disabled
  credential/pager prompts, and the minimum git version check.
- `repository.ts` — resolves repo/git-dir/common-dir paths (handles bare repos and linked
  worktrees correctly) and computes `RepositoryState`: bare/shallow/empty/detached-HEAD/
  unborn-HEAD flags and in-progress merge/rebase/am/cherry-pick/revert/bisect detection (FR-4, FR-5).
- `refs.ts` — lists local branches, remote-tracking branches, and tags via `for-each-ref`,
  dereferencing annotated tags to the commit they target.
- `commitLog.ts` — `CommitLogReader`: a paged, streaming reader backed by one long-lived
  `git log` process (FR-1, FR-2, FR-3, FR-7 except the SHA filter). Also `findCommitsBySha`,
  the direct SHA/prefix lookup path (see "Design notes" below).
- `changedFiles.ts` — per-commit changed-file list (add/modify/delete/rename/copy), diffing
  merges against their first parent and root commits against git's empty-tree object.
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
  convention for "what did this merge bring in."

## Known limitations / explicitly deferred (not silently gapped)

- **FR-6 auto-refresh** (`watcher.ts`) is best-effort: `fs.watch(..., { recursive: true })`
  works on Windows/macOS but Node does not support recursive watching on Linux, so nested new
  refs may be missed there. Manual refresh (just re-calling the read methods — there is no
  cache to invalidate) always works regardless of platform and is the documented FR-6 fallback.
- **GPG signature status** (FR-8, "nice-to-have") is not exposed yet.
- **Combined (all-parents) diff for merge/octopus commits** is not implemented — only
  first-parent diff. Fine per FR-13 (which just requires *a* correctly-typed file list).

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
- Path filters always appended after a literal `--`.
- SHA/prefix input validated against a strict hex regex before ever reaching a git argument.
- `GIT_TERMINAL_PROMPT=0` / blanked `GIT_ASKPASS` / `SSH_ASKPASS` — defense in depth so nothing
  in this module can ever hang on, or silently satisfy, a credential prompt.

See `tests/commitLog.test.ts` ("argument-injection guard") for a regression test against a
malicious ref name.
