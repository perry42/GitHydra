// SPDX-License-Identifier: GPL-3.0-or-later
// `npm run demo -- tick <repo> [action]`: external git activity against a demo repo while the app is open.
import * as fs from "node:fs";
import * as path from "node:path";
import { assertSafeDir, git, gitDirOf, isDemoRepo, tryGit } from "./lib.mjs";

const branches = (d) => git(d, "for-each-ref", "--format=%(refname:short)", "refs/heads").split("\n").filter(Boolean);
const current = (d) => tryGit(d, "symbolic-ref", "--short", "-q", "HEAD").out.trim();
const inProgress = (d) => ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply"].some((p) => fs.existsSync(path.join(gitDirOf(d), p)));
const stamp = () => String(Date.now()).slice(-6);

const mergeAbort = (d) => {
  const gd = gitDirOf(d);
  const has = (p) => fs.existsSync(path.join(gd, p));
  if (has("MERGE_HEAD")) return git(d, "merge", "--abort"), "merge --abort";
  if (has("rebase-merge") || has("rebase-apply")) return git(d, "rebase", "--abort"), "rebase --abort";
  if (has("CHERRY_PICK_HEAD")) return git(d, "cherry-pick", "--abort"), "cherry-pick --abort";
  return "nothing in progress";
};

export const actions = {
  branch: { help: "create a new branch at HEAD (demo-N)", run: (d) => { const n = `demo-${stamp()}`; git(d, "branch", n); return `created branch ${n}`; } },
  commit: { help: "add a file and commit it on the current branch", run: (d) => { const f = `tick-${stamp()}.txt`; fs.writeFileSync(path.join(d, f), `external commit ${new Date().toISOString()}\n`); git(d, "add", f); git(d, "commit", "-q", "-m", `external commit ${f}`); return `committed ${f}`; } },
  checkout: { help: "switch to the next local branch", run: (d) => { const all = branches(d); const next = all[(all.indexOf(current(d)) + 1) % all.length]; git(d, "checkout", "-q", next); return `checked out ${next}`; } },
  dirty: { help: "modify a tracked file and add an untracked one", run: (d) => { const tracked = git(d, "ls-files").split("\n").filter(Boolean)[0]; if (tracked) fs.appendFileSync(path.join(d, tracked), "\nexternal edit\n"); fs.writeFileSync(path.join(d, `untracked-${stamp()}.txt`), "external\n"); return `edited ${tracked}, added an untracked file`; } },
  stash: { help: "stash all changes including untracked", run: (d) => { const r = tryGit(d, "stash", "push", "-u", "-m", `external stash ${stamp()}`); return r.out.trim() || "nothing to stash"; } },
  tag: { help: "create a lightweight tag at HEAD", run: (d) => { const n = `tick-${stamp()}`; git(d, "tag", n); return `created tag ${n}`; } },
  "merge-start": { help: "merge branch `theirs` (or the first other branch); may leave a conflict", run: (d) => { if (inProgress(d)) return "an operation is already in progress"; const all = branches(d).filter((b) => b !== current(d)); const b = all.includes("theirs") ? "theirs" : all[0]; if (!b) return "no other branch"; const r = tryGit(d, "merge", "--no-edit", b); return `merge ${b}: ${r.ok ? "completed cleanly" : "stopped (conflicts)"}`; } },
  "merge-abort": { help: "abort an in-progress merge/rebase/cherry-pick", run: mergeAbort },
};
actions.auto = { help: "abort what is in progress, else merge-start if possible, else commit", run: (d) => (inProgress(d) ? mergeAbort(d) : branches(d).length > 1 ? actions["merge-start"].run(d) : actions.commit.run(d)) };

export function tick(repoArg, action = "auto") {
  if (!repoArg) throw new Error("usage: npm run demo -- tick <repo-path> [action]");
  const dir = assertSafeDir(repoArg);
  if (!isDemoRepo(dir)) throw new Error(`${dir} is not a repo built by this kit (no githydra-demo marker); refusing to touch it.`);
  const a = actions[action];
  if (!a) throw new Error(`unknown action "${action}". Actions: ${Object.keys(actions).join(", ")}`);
  return a.run(dir);
}
