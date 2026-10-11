// SPDX-License-Identifier: GPL-3.0-or-later
// History / repo-shape / multi-repo scenarios. Same shape as conflicts.mjs.
import * as fs from "node:fs";
import * as path from "node:path";
import { MARKER, fastImportHistory, git, gitDirOf, lines, scaled, setLine, twoSided } from "../lib.mjs";

/** Small realistic history: n commits on main, each touching one of a few files. */
function smallHistory(r, n, from = 1) {
  for (let i = from; i <= n; i++) r.commit(i === 1 ? "Initial commit" : `Change ${i}: ${["fix parser", "add tests", "refactor", "docs", "tweak ui"][i % 5]}`, { [`src/file${i % 4}.txt`]: `content ${i}\n`, "README.md": `# Demo\n\nrevision ${i}\n` });
}

export const repoScenarios = [
  {
    name: "big-history",
    summary: "2000 commits on main with side branches that merge back every 25 commits.",
    tryText:
      "Scroll the graph from top to bottom and back: rows must not blank out, lanes must line up with the rows, the HEAD marker and selection ring must stay on their row after scrolling far down (a past regression). Jump to a far commit, select, open details, search if available. Opening should be quick. (Size scales with GITHYDRA_DEMO_SCALE.)",
    build(ctx) {
      const r = ctx.repo("big-history");
      const total = scaled(2000, 60);
      const commits = [];
      let mark = 0, mainTip = null, i = 0;
      const add = (c) => { commits.push({ mark: ++mark, ...c }); return mark; };
      while (commits.length < total) {
        i++;
        if (i % 25 === 0 && commits.length + 4 <= total && mainTip) {
          const ref = `refs/heads/side-${i}`;
          let tip = add({ ref, from: mainTip, msg: `side ${i}.1`, files: { [`side/s${i % 7}.txt`]: `side ${i}.1\n` } });
          tip = add({ ref, msg: `side ${i}.2`, files: { [`side/s${i % 7}.txt`]: `side ${i}.2\n` } });
          tip = add({ ref, msg: `side ${i}.3`, files: { [`side/s${i % 7}.txt`]: `side ${i}.3\n` } });
          mainTip = add({ ref: "refs/heads/main", merge: [tip], msg: `Merge side-${i}` });
        } else {
          mainTip = add({ ref: "refs/heads/main", msg: `Commit ${i}: ${["fix", "feat", "docs", "refactor", "test"][i % 5]} #${i}`, files: { [`src/m${i % 40}.txt`]: `change ${i}\n` } });
        }
      }
      fastImportHistory(r, commits);
      r.git("reset", "-q", "--hard", "main");
      r.git("tag", "v1.0", `main~${Math.floor(total / 2)}`);
      r.git("tag", "-a", "-m", "annotated tip tag", "v2.0", "main");
      return { repo: r.dir, meta: { total } };
    },
    expect: (meta) => ({ operation: "none", commits: meta.total, merges: { min: 1 }, tags: 2, changed: 0 }),
  },
  {
    name: "detached-head",
    summary: "HEAD detached on tag v0.2 with one extra commit made while detached and one uncommitted edit.",
    tryText:
      "The header/branch area must say 'detached HEAD' (not blank or a hash dressed up as a branch name). The graph's HEAD marker sits on the detached commit (which is NOT on any branch). Check: Create branch here saves it; checking out main from here must warn or keep the detached commit reachable rather than silently abandoning it; the uncommitted edit shows in Changes.",
    build(ctx) {
      const r = ctx.repo("detached-head");
      smallHistory(r, 3);
      r.git("tag", "v0.2");
      smallHistory(r, 6, 4); // continues main past the tag
      r.git("checkout", "-q", "--detach", "v0.2");
      r.commit("work done while detached", { "detached-work.txt": "only reachable from HEAD\n" });
      r.write("README.md", "# Demo\n\nuncommitted edit on a detached HEAD\n");
      return { repo: r.dir };
    },
    expect: { operation: "none", detached: true, changed: 1 },
  },
  {
    name: "submodule-present",
    summary: "A repo with a submodule whose checkout has a new commit and an untracked file.",
    tryText:
      "libs/sub is a submodule: the parent reports it modified (new commits in the submodule) and it must show as a submodule entry, not a crash or a bogus text diff. Try staging it, committing, discarding it. Open libs/sub itself as a repo (it has its own history).",
    build(ctx) {
      const upstream = ctx.repo("submodule-upstream");
      upstream.commit("upstream 1", { "lib.txt": "lib v1\n" });
      upstream.commit("upstream 2", { "lib.txt": "lib v2\n" });
      const r = ctx.repo("submodule-present");
      smallHistory(r, 2);
      r.git("-c", "protocol.file.allow=always", "submodule", "add", "-q", upstream.dir, "libs/sub");
      r.git("commit", "-q", "-m", "add submodule");
      const sub = path.join(r.dir, "libs", "sub");
      git(sub, "config", "user.name", "Demo User");
      git(sub, "config", "user.email", "demo@example.com");
      fs.writeFileSync(path.join(sub, "lib.txt"), "lib v3 (new commit in submodule)\n");
      git(sub, "commit", "-q", "-am", "submodule commit not yet recorded in parent");
      fs.writeFileSync(path.join(sub, "scratch.txt"), "untracked inside submodule\n");
      return { repo: r.dir, extra: [sub] };
    },
    expect: { operation: "none", submodules: 1, unstaged: 1 },
  },
  {
    name: "empty-repo",
    summary: "A freshly `git init`ed repo with no commits at all.",
    tryText:
      "Opening must not error: the graph shows an empty state, branch shows main/unborn. Create a file, stage it and make the FIRST commit (including as the very first action; amend and 'undo' must be disabled or harmless); the graph then shows that one commit.",
    build(ctx) {
      const r = ctx.repo("empty-repo");
      return { repo: r.dir };
    },
    expect: { operation: "none", empty: true, commits: 0, changed: 0 },
  },
  {
    name: "worktree",
    summary: "A linked worktree opened as the main repo, with the primary checkout and a bare clone as extra paths.",
    tryText:
      "The repo opened here is a LINKED worktree (its .git is a file, not a directory) on branch `feature`. Everything should work as normal: graph, status, commit, stash. Then open the extra paths in tabs: the primary checkout (branch main, worktree list shows both) and bare.git (a bare repo: no working tree, so Changes should be absent or explain why, never crash). Branch `feature` is checked out in the worktree so deleting or checking it out from the primary must be refused by git with a readable message.",
    build(ctx) {
      const r = ctx.repo("worktree-primary");
      smallHistory(r, 4);
      r.git("branch", "feature");
      const wt = path.join(ctx.root, "worktree-linked");
      r.git("worktree", "add", "-q", wt, "feature");
      fs.writeFileSync(path.join(wt, "in-worktree.txt"), "untracked file in the linked worktree\n");
      const bare = path.join(ctx.root, "bare.git");
      git(ctx.root, "clone", "-q", "--bare", r.dir, bare);
      fs.writeFileSync(path.join(gitDirOf(bare), MARKER), "githydra manual-testing repo\n");
      return { repo: wt, extra: [r.dir, bare] };
    },
    expect: { operation: "none", worktrees: 2, untracked: 1 },
  },
  {
    name: "recovery-draft",
    summary: "A small clean repo for testing the crash-recovery prompt of unsaved editor text. Use with --same-profile.",
    tryText:
      "1) Run `npm run demo -- recovery-draft --same-profile`. 2) Edit notes.txt in the diff editor and type something WITHOUT saving. 3) Wait a few seconds, then end the process hard from Task Manager (End task on that GitHydra, NOT via X). 4) Run the same command again: the repo reopens on the same profile and offers to restore the unsaved text. Check Restore brings back exactly what you typed and Discard really discards. Also try the normal X close with unsaved text: it must ask first.",
    stable: true,
    build(ctx) {
      const r = ctx.repo("recovery-draft");
      r.commit("base", { "notes.txt": lines(15, "note"), "other.txt": lines(5, "o") });
      r.write("notes.txt", setLine(lines(15, "note"), 3, "note3 (modified, so it has a diff to edit)"));
      return { repo: r.dir };
    },
    expect: { operation: "none", unstaged: 1, commits: 1 },
  },
  {
    name: "clean-repo",
    summary: "A tidy small repo: 12 commits, 3 branches, 2 tags, nothing to commit.",
    tryText:
      "The baseline for general UI checks: graph with a branch that forked and is 2 commits ahead, tags on the graph, empty Changes panel with a sensible 'nothing to commit' state. Use it for theme (dark/light), narrow-window clipping, keyboard-only navigation and the Command Palette.",
    build(ctx) {
      const r = ctx.repo("clean-repo");
      smallHistory(r, 10);
      r.git("tag", "v0.1", "main~7");
      r.git("tag", "-a", "-m", "release 1.0", "v1.0", "main");
      r.git("branch", "bugfix", "main~3");
      r.git("checkout", "-q", "-b", "feature");
      r.commit("feature: first", { "feature.txt": "one\n" });
      r.commit("feature: second", { "feature.txt": "one\ntwo\n" });
      r.git("checkout", "-q", "main");
      return { repo: r.dir };
    },
    expect: { operation: "none", commits: 12, branches: 3, tags: 2, changed: 0 },
  },
  {
    name: "multi-tab",
    summary: "Three repos for tab switching: clean history (opened), dirty working tree, and one that will get a merge conflict started from outside.",
    tryText:
      "Only tab-a-clean opens automatically; the next two + clicks open tab-b-dirty and then tab-c-theirs from the stubbed picker. Switch between tabs: each keeps its own selection/scroll/Changes. Leave tab C open in the background; after ~60s a script starts a conflicting merge in it (or run `npm run demo -- tick <path-of-tab-c> merge-start` yourself): switching to the tab must show the conflict state without a manual refresh, and no other tab may change. Close tabs with unsaved editor text open: you must be asked.",
    build(ctx) {
      const a = ctx.repo("tab-a-clean");
      smallHistory(a, 6);
      const b = ctx.repo("tab-b-dirty");
      smallHistory(b, 3);
      b.write("README.md", "# Demo\n\ndirty edit\n");
      b.write("untracked.txt", "untracked\n");
      const c = ctx.repo("tab-c-theirs");
      twoSided(c, { base: { "c.txt": lines(30, "c") }, theirs: { "c.txt": setLine(lines(30, "c"), 10, "theirs-10") }, ours: { "c.txt": setLine(lines(30, "c"), 10, "ours-10") }, theirsBranch: "theirs" });
      return { repo: a.dir, extra: [b.dir, c.dir], autoTick: { afterSec: 60, repo: c.dir, action: "merge-start" } };
    },
    expect: { operation: "none", changed: 0, commits: 6 },
    expectExtra: [{ operation: "none", changed: 2 }, { operation: "none", branches: 2, changed: 0 }],
  },
  {
    name: "live-refresh",
    summary: "A clean repo with 3 branches to be changed behind the app's back with `tick` (external git activity).",
    tryText:
      "Leave the app open on this repo and, from another terminal in the repo root, run: `npm run demo -- tick <repo-path> branch`, `commit`, `checkout`, `dirty`, `stash`, `tag`, `merge-start`, `merge-abort` (run `tick <repo-path>` with no action to see them all; `auto` is the default). " +
      "After each, the graph, branch list, status and Changes panel should refresh by themselves (or via the refresh control) and show exactly what git did, with no stale rows, no duplicate entries and no flicker of the selection.",
    build(ctx) {
      const r = ctx.repo("live-refresh");
      smallHistory(r, 5);
      r.git("branch", "develop");
      r.git("checkout", "-q", "-b", "theirs");
      r.commit("theirs: edits README", { "README.md": "# Demo\n\nedited on the theirs branch\n" });
      r.git("checkout", "-q", "main");
      r.commit("main: edits README", { "README.md": "# Demo\n\nedited on main\n" });
      return { repo: r.dir };
    },
    expect: { operation: "none", branches: 3, changed: 0 },
  },
];
