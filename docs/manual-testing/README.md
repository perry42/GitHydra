# Manual testing kit

A dev-only kit for trying GitHydra by hand on ready-made scenario repos. It lives in `scripts/demo/` (not shipped: the packaged app only contains `packages/desktop/dist` and `dist-electron`, see the `files` list in `packages/desktop/electron-builder.yml`).

## Run it

From the repo root, after `npm run build` (the kit refuses to start on a missing or stale build and prints the exact command):

```
npm run demo -- --list                          # all scenarios
npm run demo -- merge-conflict-multi            # build the repo, open the BUILT app on it
npm run demo -- merge-conflict-multi --keep     # keep the repo and profile after you close the window
npm run demo -- --all-repos <folder-in-temp>    # only build every scenario's repos, no app
npm run demo -- tick <repo> [action]            # external git activity on a demo repo (see "Live changes")
```

- One window per run. **Close it with X.** The script then deletes the temp repo and profile and exits; nothing is left running. Ctrl+C in the terminal also closes only the window it started.
- Repos are created only under the OS temp dir (the path is printed) and never inside the GitHydra checkout. The app runs with its own throw-away `--user-data-dir`, so your real GitHydra profile (tabs, recovery drafts, window size) is not touched.
- `--same-profile`: use a stable repo + profile under `<tmp>/githydra-demo-stable/<scenario>` that survive between runs (needed for `recovery-draft`). `--rebuild` starts that scenario over.
- `--smoke`: launch, check the app reached the repo view, close it, exit 0/1 (for a quick "does the kit still work" check).
- `GITHYDRA_DEMO_SCALE=0.05` shrinks the big scenarios (history length, file counts, stash count, long-file lines) to 5%. The unit test sets it for speed; unset means full size.
- If the window shows `NOT-CONFIRMED` in the terminal, the toolbar did not appear in time; look at the window and report it if it is really broken.
- Multi-repo scenarios print extra repo paths. The first Open/"+" click in the app gets the first repo; later clicks get the extras in order, then the normal file picker returns.

## Live changes with `tick`

`npm run demo -- tick <repo-path> [action]` runs real git commands against a repo this kit built (it refuses any other repo). With no action it does `auto`. Actions: `branch`, `commit`, `checkout`, `dirty`, `stash`, `tag`, `merge-start` (merges `theirs`, usually leaving a conflict), `merge-abort`, `auto`. Run `tick` with no arguments to list them. `multi-tab` also runs `merge-start` on its third repo by itself after 60 s (`--tick-after <sec>`, `--no-tick`).

## Scenarios

| Scenario | What it builds | What to check |
|---|---|---|
| `merge-conflict-multi` | Mid-merge: 3 text conflicts (one with 2 blocks), 1 binary, plus modified/partly-staged/staged/deleted/untracked/long-line files | Conflict list separate from normal changes; resolve each side/both/edit; Continue blocked until all resolved; Abort restores everything |
| `rebase-conflict` | Mid-rebase of a 3-commit branch; steps 1 and 2 conflict, 3 is clean | Side labels inverted vs. a merge (ours = base branch); Continue goes to the next step; Skip; Abort restores the 3 commits |
| `cherry-pick-conflict` | Cherry-pick of 3 commits, first conflicts | Continue applies the rest; Abort leaves main untouched; Skip |
| `delete-modify-conflict` | Deleted-by-us and deleted-by-them conflicts | Keep-vs-delete choice offered, no empty text editor |
| `rename-add-conflict` | rename/rename (1 to 2) plus add/add | All 4 unmerged paths listed, no crash on missing base |
| `binary-only-conflict` | Only two binary files conflict | Pick-a-side per file; chosen bytes land in the commit |
| `crlf-conflict` | CRLF files and one mixed-ending file in conflict | Line endings preserved after resolving; no `^M` noise |
| `long-file-conflict` | One 5000-line file, 3 conflict blocks far apart | Block navigation, scrolling, keeps place after resolving |
| `many-conflicts` | 30 blocks across 10 files | File list/counters with many entries; counter hits zero exactly at the last block |
| `diff3-conflict` | `merge.conflictStyle=diff3` conflicts (`\|\|\|\|\|\|\|` base section) | Parsed correctly, no marker lines left after resolving |
| `conflict-with-big-line` | A 200KB conflicted line and a minified-JS conflict | No freeze, no clipping/overlap, nothing truncated |
| `partly-staged-edits` | Staged and unstaged hunks in one file, 3 separate hunks, a file in both lists | Stage/unstage/discard single hunks; editing the working copy leaves the staged copy alone |
| `edit-misc` | One of every state: modified/staged/deleted/untracked, 0.9/1.5/2.5MB files, non-UTF-8, binary, symlink (if the OS allows), non-ASCII names | Edit cap (1MB) and diff cap (2MB) behave; latin1 not corrupted; names render and stage |
| `many-files` | About 2000 changed files in 40 folders | List windowing/scroll, select-all, stage-all speed |
| `stash-heavy` | 25 stashes (named, unnamed, with untracked, one conflicting on apply) | Apply/pop/drop; a conflicting pop keeps the stash |
| `big-history` | 2000 commits, side branches merged every 25 | Graph scroll/alignment far down, HEAD marker and selection ring on their rows |
| `detached-head` | Detached at a tag, one commit made while detached, one uncommitted edit | "Detached HEAD" shown; commit not lost when switching away |
| `submodule-present` | Submodule with a new commit and an untracked file | Submodule entry shows sanely; stage/commit/discard it |
| `empty-repo` | `git init`, no commits | Empty state; first commit works |
| `worktree` | Opens a linked worktree; extras: the primary checkout and a bare clone | Worktree works like a normal repo; bare repo degrades gracefully; checked-out branch refused by git with a readable message |
| `recovery-draft` | Small repo with one modified file (run with `--same-profile`) | Edit without saving, kill the process (Task Manager, not X), run again: restore prompt, restore/discard both correct |
| `clean-repo` | 12 commits, 3 branches, 2 tags, clean tree | Baseline for theme, narrow width, keyboard-only, Command Palette |
| `multi-tab` | 3 repos: clean, dirty, one that gets a conflicting merge started from outside after 60 s | Per-tab state kept; background tab updates; closing tabs with unsaved edits asks first |
| `live-refresh` | Clean repo with 3 branches, meant for `tick` | Each external change appears without stale/duplicate rows |

The exact "what to try / expected behaviour" paragraph is also printed when a scenario launches.

### Recovery-draft walkthrough

1. `npm run demo -- recovery-draft --same-profile`
2. Open `notes.txt` in the diff editor, type something, do not save.
3. Wait a few seconds, then End task on that GitHydra in Task Manager (not X).
4. Run the same command again. You should be offered the unsaved text back.

## Things to check in every scenario

- Same gesture, same behaviour: the same action from the list, the context menu, the keyboard and the Command Palette should do the same thing.
- No overlapping or clipped text, especially at the narrowest window width and with long names/lines.
- Dark and light theme both legible, including conflict markers and the disabled states.
- Keyboard only: reach and operate every control without the mouse; focus is always visible.
- Leave-guard prompts: closing a tab, opening another repo or closing the window with unsaved editor text asks first and loses nothing.
- Nothing is lost: after Abort/Continue/Discard/Pop, compare with `git status`/`git diff` in a terminal.
- The window closes cleanly: no stuck windows or leftover `electron.exe` (`tasklist | findstr electron`).
- Works offline (everything here is local).

## Bug report line

`[scenario] [action you did] -> [what you saw] vs [what you expected] | build <git short sha> | theme dark/light | window size | repo path (use --keep)`

## Known gaps

Not covered by this kit: remotes (push/pull/fetch against a real server), credentials, huge binaries, filesystem permission errors, network drives, repos on exotic filesystems. Open product bugs and queued work are tracked in [ROADMAP.md](../../ROADMAP.md). Symlinks need Developer Mode or admin on Windows.

## Adding a scenario

Append an object to an array in `scripts/demo/scenarios/*.mjs`:

```js
{ name: "my-case", summary: "one line for --list", tryText: "what to try / expected behaviour",
  build(ctx) { const r = ctx.repo("my-case"); r.commit("base", { "a.txt": "x\n" }); return { repo: r.dir }; },
  expect: { operation: "none", changed: 0 } }
```

`expect` keys (all optional, `{ min: n }` for at-least): `operation` (none/merge/rebase/cherry-pick), `unmerged`, `staged`, `unstaged`, `untracked`, `changed`, `commits`, `merges`, `branches`, `tags`, `stashes`, `worktrees`, `submodules`, `empty`, `detached`, `conflictStyle`. `expect` may be a function of `build()`'s returned `meta`. `packages/git-core/tests/demoKit.test.ts` builds every scenario and checks `expect`; add the new name to its list and a row to the table above.

## Play buttons in VS Code

`scripts/demo/package.json` lists one script per scenario. In VS Code open the Explorer sidebar, expand **NPM Scripts** (enable it with the `…` menu if hidden) and look under `scripts/demo`: hover a scenario and press the small play button. `00-build-app` builds the app first (run it after every code change or branch switch); `00-list` prints the scenarios. A test keeps this file in sync with the scenario list, so adding a scenario means adding its script line.
