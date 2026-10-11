// SPDX-License-Identifier: GPL-3.0-or-later
// Conflict scenarios. Shape: { name, summary, tryText, build(ctx) -> { repo, extra?, autoTick? }, expect }.
import { lines, scaled, setLine, twoSided } from "../lib.mjs";

const bin = (...b) => Buffer.from(b);
const merge = (r, branch = "feature") => r.tryGit("merge", branch);

/** Working-tree changes of every kind, to sit next to a conflict (the prototype's "mixed changes"). */
function addMixedChanges(r) {
  r.write("notes.md", "# Notes\n\nfirst\nsecond (edited)\nthird\nfourth\n");
  r.write("app.js", setLine(lines(60, "app"), 10, "app10 CHANGED"));
  r.write("config.json", '{\n  "a": 1,\n  "b": 3,\n  "c": 4\n}\n');
  const p3 = setLine(lines(40, "p"), 3, "p3 STAGED CHANGE");
  r.write("partly.txt", p3);
  r.git("add", "partly.txt");
  r.write("partly.txt", setLine(p3, 35, "p35 UNSTAGED CHANGE"));
  r.write("staged.txt", setLine(lines(10, "s"), 2, "s2 staged"));
  r.git("add", "staged.txt");
  r.remove("gone.txt");
  r.write("brand-new.txt", "a new untracked file\nwith two lines\n");
  r.write("minified.js", "var x=" + "1+".repeat(20000) + "2;\n");
}

const mixedBase = () => ({
  "notes.md": "# Notes\n\nfirst\nsecond\nthird\n",
  "app.js": lines(60, "app"),
  "config.json": '{\n  "a": 1,\n  "b": 2\n}\n',
  "partly.txt": lines(40, "p"),
  "staged.txt": lines(10, "s"),
  "gone.txt": "delete me\n",
  "minified.js": "var x=" + "1+".repeat(20000) + "1;\n",
});

export const conflictScenarios = [
  {
    name: "merge-conflict-multi",
    summary: "Mid-merge: 3 text conflicts (one with 2 blocks) + 1 binary, plus every other kind of change.",
    tryText:
      "Open the conflicted files one by one: merge1.txt has TWO blocks, merge2.txt and merge3.txt one each, logo.bin is binary (pick a side only). " +
      "Resolve some blocks with each side/both/edit, stage, and watch the conflict count fall; Abort merge must restore everything; Continue must be blocked while any file is unresolved. " +
      "Alongside, notes.md/app.js/config.json are modified, partly.txt is partly staged, staged.txt staged, gone.txt deleted, brand-new.txt untracked, minified.js has a 40KB line. " +
      "Expected: conflict files list separately from normal changes and nothing is lost on abort/continue.",
    build(ctx) {
      const r = ctx.repo("merge-conflict-multi");
      const m1 = lines(80, "m"), m2 = lines(30, "n"), m3 = lines(25, "k");
      twoSided(r, {
        base: { ...mixedBase(), "merge1.txt": m1, "merge2.txt": m2, "merge3.txt": m3, "logo.bin": bin(0, 1, 2, 3, 4, 5, 0, 0) },
        theirs: { "merge1.txt": setLine(setLine(m1, 5, "feature-5"), 70, "feature-70"), "merge2.txt": setLine(m2, 3, "feature-3"), "merge3.txt": setLine(m3, 12, "feature-12"), "logo.bin": bin(0, 1, 2, 9, 9, 9, 0, 0) },
        ours: { "merge1.txt": setLine(setLine(m1, 5, "main-5"), 70, "main-70"), "merge2.txt": setLine(m2, 3, "main-3"), "merge3.txt": setLine(m3, 12, "main-12"), "logo.bin": bin(0, 1, 2, 7, 7, 7, 0, 0) },
      });
      merge(r);
      addMixedChanges(r);
      return { repo: r.dir };
    },
    expect: { operation: "merge", unmerged: 4, staged: 2, unstaged: 6, untracked: 1 },
  },
  {
    name: "rebase-conflict",
    summary: "Mid-rebase (feature onto main), 3 commits: step 1 and 2 conflict, step 3 is clean.",
    tryText:
      "A rebase stops at step 1 of 3 with a conflict in alpha.txt. Check the side labels: during a rebase 'ours' is the branch you rebase ONTO (main) and 'theirs' is your own commit, the reverse of a merge; the editor should say so. " +
      "Resolve, Continue: it must stop again at step 2 (beta.txt), then Continue to finish with 3 rebased commits. Also try Skip on a step, and Abort, which must return feature to its original 3 commits.",
    build(ctx) {
      const r = ctx.repo("rebase-conflict");
      const a = lines(30, "a"), b = lines(30, "b"), c = lines(20, "c");
      r.commit("base", { "alpha.txt": a, "beta.txt": b, "gamma.txt": c });
      r.git("checkout", "-q", "-b", "feature");
      r.commit("feature: edit alpha", { "alpha.txt": setLine(a, 10, "feature-alpha-10") });
      r.commit("feature: edit beta", { "beta.txt": setLine(b, 10, "feature-beta-10") });
      r.commit("feature: edit gamma (clean)", { "gamma.txt": setLine(c, 5, "feature-gamma-5") });
      r.git("checkout", "-q", "main");
      r.commit("main: edit alpha", { "alpha.txt": setLine(a, 10, "main-alpha-10") });
      r.commit("main: edit beta", { "beta.txt": setLine(b, 10, "main-beta-10") });
      r.git("checkout", "-q", "feature");
      r.tryGit("rebase", "main");
      return { repo: r.dir };
    },
    expect: { operation: "rebase", unmerged: 1 },
  },
  {
    name: "cherry-pick-conflict",
    summary: "Mid cherry-pick of 3 commits from `topic` onto main; the first conflicts.",
    tryText:
      "Cherry-pick of a 3-commit range stopped on the first commit (conflict in shared.txt). Resolve and Continue: the other two commits should then apply (the third touches only other.txt). Also try Abort (main must be exactly as before) and Skip.",
    build(ctx) {
      const r = ctx.repo("cherry-pick-conflict");
      const s = lines(40, "s");
      r.commit("base", { "shared.txt": s, "other.txt": lines(10, "o") });
      r.git("checkout", "-q", "-b", "topic");
      r.commit("topic 1: edit shared", { "shared.txt": setLine(s, 8, "topic-8") });
      r.commit("topic 2: edit shared again", { "shared.txt": setLine(setLine(s, 8, "topic-8"), 30, "topic-30") });
      r.commit("topic 3: edit other", { "other.txt": setLine(lines(10, "o"), 2, "topic-o2") });
      r.git("checkout", "-q", "main");
      r.commit("main: edit shared", { "shared.txt": setLine(s, 8, "main-8") });
      r.tryGit("cherry-pick", "main..topic");
      return { repo: r.dir };
    },
    expect: { operation: "cherry-pick", unmerged: 1 },
  },
  {
    name: "delete-modify-conflict",
    summary: "Mid-merge with two delete/modify conflicts (deleted by us, deleted by them).",
    tryText:
      "removed-on-main.txt was deleted on main but edited on feature; removed-on-feature.txt is the opposite. The UI must offer keep-the-file vs. accept-the-deletion for each and not show a text editor with empty sides. Resolve both and commit; abort must bring both files back.",
    build(ctx) {
      const r = ctx.repo("delete-modify-conflict");
      const a = lines(20, "x"), b = lines(20, "y");
      twoSided(r, {
        base: { "removed-on-main.txt": a, "removed-on-feature.txt": b, "keep.txt": "keep\n" },
        theirs: { "removed-on-main.txt": setLine(a, 5, "feature edit"), "removed-on-feature.txt": null },
        ours: { "removed-on-main.txt": null, "removed-on-feature.txt": setLine(b, 5, "main edit") },
      });
      merge(r);
      return { repo: r.dir };
    },
    expect: { operation: "merge", unmerged: 2 },
  },
  {
    name: "rename-add-conflict",
    summary: "Mid-merge: a file renamed two different ways (rename/rename) plus an add/add conflict.",
    tryText:
      "shared.txt became alpha.txt on main and beta.txt on feature (git reports it as 3 unmerged paths), and both branches added both-added.txt with different content (add/add). The UI should list every unmerged path sensibly, not crash on the missing base file, and let you finish or abort.",
    build(ctx) {
      const r = ctx.repo("rename-add-conflict");
      const s = lines(40, "r");
      twoSided(r, {
        base: { "shared.txt": s },
        theirs: { "shared.txt": null, "beta.txt": s, "both-added.txt": "from feature\nfeature line 2\n" },
        ours: { "shared.txt": null, "alpha.txt": s, "both-added.txt": "from main\nmain line 2\n" },
      });
      merge(r);
      return { repo: r.dir };
    },
    expect: { operation: "merge", unmerged: 4 },
  },
  {
    name: "binary-only-conflict",
    summary: "Mid-merge where the ONLY conflicts are two binary files.",
    tryText:
      "Both conflicted files are binary (a.bin, b.bin). There are no text blocks: the UI should show a pick-a-side choice per file, not an empty text editor, and Continue becomes available once both are chosen. Check the chosen side's bytes really end up in the commit (the files differ in bytes 3-5).",
    build(ctx) {
      const r = ctx.repo("binary-only-conflict");
      twoSided(r, {
        base: { "a.bin": bin(0, 1, 2, 3, 4, 5, 0, 0), "b.bin": bin(0, 9, 9, 3, 4, 5, 0, 0), "readme.txt": "text\n" },
        theirs: { "a.bin": bin(0, 1, 2, 9, 9, 9, 0, 0), "b.bin": bin(0, 9, 9, 8, 8, 8, 0, 0) },
        ours: { "a.bin": bin(0, 1, 2, 7, 7, 7, 0, 0), "b.bin": bin(0, 9, 9, 6, 6, 6, 0, 0) },
      });
      merge(r);
      return { repo: r.dir };
    },
    expect: { operation: "merge", unmerged: 2 },
  },
  {
    name: "crlf-conflict",
    summary: "Mid-merge conflicts in CRLF files (plus one mixed-ending file).",
    tryText:
      "windows.txt and windows2.txt use CRLF line endings, mixed.txt has both. Resolve blocks and save: line endings of untouched lines must stay CRLF (no whole-file diff, no silent conversion to LF), and the diff view must not show a ^M noise on every line.",
    build(ctx) {
      const r = ctx.repo("crlf-conflict");
      const crlf = (n, p) => lines(n, p).replace(/\n/g, "\r\n");
      const w1 = crlf(30, "w"), w2 = crlf(20, "v");
      const mixed = "one\r\ntwo\nthree\r\nfour\nfive\r\n";
      twoSided(r, {
        base: { "windows.txt": w1, "windows2.txt": w2, "mixed.txt": mixed },
        theirs: { "windows.txt": setLine(w1, 5, "feature-5"), "windows2.txt": setLine(w2, 7, "feature-7"), "mixed.txt": mixed.replace("three", "feature three") },
        ours: { "windows.txt": setLine(w1, 5, "main-5"), "windows2.txt": setLine(w2, 7, "main-7"), "mixed.txt": mixed.replace("three", "main three") },
      });
      merge(r);
      return { repo: r.dir };
    },
    expect: { operation: "merge", unmerged: 3 },
  },
  {
    name: "long-file-conflict",
    summary: "Mid-merge, one 5000-line file with 3 conflict blocks far apart (near the top, middle, bottom).",
    tryText:
      "long.txt has conflicts near lines 10, 2500 and 4990. Check jumping between blocks (next/previous), scroll performance, that the editor keeps your place after resolving a block, and that resolving the far block does not shift the others. (Line count scales down with GITHYDRA_DEMO_SCALE.)",
    build(ctx) {
      const r = ctx.repo("long-file-conflict");
      const n = scaled(5000, 300);
      const mid = Math.floor(n / 2), end = n - 10;
      const base = lines(n, "row");
      const edit = (t, who) => setLine(setLine(setLine(t, 10, `${who}-10`), mid, `${who}-${mid}`), end, `${who}-${end}`);
      twoSided(r, { base: { "long.txt": base }, theirs: { "long.txt": edit(base, "feature") }, ours: { "long.txt": edit(base, "main") } });
      merge(r);
      return { repo: r.dir };
    },
    expect: { operation: "merge", unmerged: 1 },
  },
  {
    name: "many-conflicts",
    summary: "Mid-merge, 30 conflict blocks spread over 10 files (3 per file).",
    tryText:
      "ten files f01.txt..f10.txt each have 3 conflict blocks. Check the conflicted-file list and counters with many entries, keyboard navigation between files, resolving everything with 'take theirs' in bulk if offered, and that the counter reaches zero exactly when the last block is resolved.",
    build(ctx) {
      const r = ctx.repo("many-conflicts");
      const base = {}, ours = {}, theirs = {};
      for (let i = 1; i <= 10; i++) {
        const f = `f${String(i).padStart(2, "0")}.txt`;
        const t = lines(60, `f${i}-`);
        base[f] = t;
        ours[f] = [5, 30, 55].reduce((acc, ln) => setLine(acc, ln, `main-${i}-${ln}`), t);
        theirs[f] = [5, 30, 55].reduce((acc, ln) => setLine(acc, ln, `feature-${i}-${ln}`), t);
      }
      twoSided(r, { base, ours, theirs });
      merge(r);
      return { repo: r.dir };
    },
    expect: { operation: "merge", unmerged: 10 },
  },
  {
    name: "diff3-conflict",
    summary: "Mid-merge with merge.conflictStyle=diff3 (markers include a ||||||| base section).",
    tryText:
      "The raw file contains <<<<<<<, |||||||, =======, >>>>>>> markers. The conflict editor must still parse it into ours/theirs (and show the base if it supports it) rather than treating the base section as content; resolving must leave no marker lines behind.",
    build(ctx) {
      const r = ctx.repo("diff3-conflict");
      r.git("config", "merge.conflictStyle", "diff3");
      const t = lines(40, "d");
      twoSided(r, { base: { "d.txt": t, "e.txt": lines(20, "e") }, theirs: { "d.txt": setLine(t, 10, "feature-10"), "e.txt": setLine(lines(20, "e"), 4, "feature-e4") }, ours: { "d.txt": setLine(t, 10, "main-10"), "e.txt": setLine(lines(20, "e"), 4, "main-e4") } });
      merge(r);
      return { repo: r.dir };
    },
    expect: { operation: "merge", unmerged: 2, conflictStyle: "diff3" },
  },
  {
    name: "conflict-with-big-line",
    summary: "Mid-merge where a conflicted line is ~200KB long, plus a minified-JS conflict.",
    tryText:
      "huge-line.txt has a single 200KB line on each side of a conflict, and bundle.min.js is one long line that conflicts. The UI must stay responsive (no multi-second freeze, no clipped or overlapping text, horizontal scroll works) and resolving must not truncate the line.",
    build(ctx) {
      const r = ctx.repo("conflict-with-big-line");
      const big = (who) => `${who}:` + "abcdefghij".repeat(20000);
      const base = lines(10, "h");
      twoSided(r, {
        base: { "huge-line.txt": setLine(base, 5, "base:" + "abcdefghij".repeat(20000)), "bundle.min.js": "var a=" + "1+".repeat(15000) + "1;\n" },
        theirs: { "huge-line.txt": setLine(base, 5, big("feature")), "bundle.min.js": "var a=" + "1+".repeat(15000) + "2;\n" },
        ours: { "huge-line.txt": setLine(base, 5, big("main")), "bundle.min.js": "var a=" + "1+".repeat(15000) + "3;\n" },
      });
      merge(r);
      return { repo: r.dir };
    },
    expect: { operation: "merge", unmerged: 2 },
  },
];
