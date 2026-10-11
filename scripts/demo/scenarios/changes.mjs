// SPDX-License-Identifier: GPL-3.0-or-later
// Working-tree / staging / stash scenarios. Same shape as conflicts.mjs; `expect` may be a function of build()'s `meta`.
import * as fs from "node:fs";
import * as path from "node:path";
import { lines, scaled, setLine } from "../lib.mjs";

const wide = (n) => Array.from({ length: n }, (_, i) => `${String(i + 1).padStart(5, "0")} ${"x".repeat(93)}\n`).join(""); // 100 bytes per line

export const changeScenarios = [
  {
    name: "partly-staged-edits",
    summary: "Files with staged AND unstaged edits: hunks to stage one by one, a file shown in both lists, a restaged line.",
    tryText:
      "partly.txt: line 3 is staged, line 50 is not (two hunks, one in each list). hunks.txt: three separate unstaged hunks to stage/unstage/discard individually. two-rows.txt: the staged copy says v2, the working copy says v3, so it appears in BOTH lists. " +
      "Try: stage a single hunk and watch the diff and list update at once; open the editor on the working copy of partly.txt, change a line, save, and check the STAGED copy is untouched; unstage and re-stage; discard one hunk and check only that hunk goes.",
    build(ctx) {
      const r = ctx.repo("partly-staged-edits");
      const hunks = lines(100, "h");
      r.commit("base", { "partly.txt": lines(60, "p"), "hunks.txt": hunks, "two-rows.txt": "v1\nsecond\n" });
      const p = setLine(lines(60, "p"), 3, "p3 STAGED CHANGE");
      r.write("partly.txt", p);
      r.write("two-rows.txt", "v2\nsecond\n");
      r.git("add", "partly.txt", "two-rows.txt");
      r.write("partly.txt", setLine(p, 50, "p50 UNSTAGED CHANGE"));
      r.write("two-rows.txt", "v3\nsecond\n");
      r.write("hunks.txt", [5, 40, 85].reduce((t, n) => setLine(t, n, `h${n} EDITED`), hunks));
      return { repo: r.dir };
    },
    expect: { operation: "none", staged: 2, unstaged: 3, untracked: 0 },
  },
  {
    name: "edit-misc",
    summary: "One of every file state: modified, staged, deleted, untracked, long line, 0.9/1.5/2.5MB files, non-UTF-8, binary, symlink (if allowed), non-ASCII names.",
    tryText:
      "Open each file in the Changes panel. Text files should diff and edit normally. size-0.9MB.txt is under the 1MB edit cap (editable); size-1.5MB.txt shows its diff but is NOT editable; size-2.5MB.txt is over the 2MB diff cap (a 'too large' notice, no freeze). " +
      "latin1.txt is not valid UTF-8 (editing must not corrupt the bytes or must refuse clearly), binary.dat is binary, long-line.txt has one 50KB line, the non-ASCII names must render and stage correctly. " +
      "A symlink 'link-to-modified' exists only when this OS allowed creating one (see the console line at launch).",
    build(ctx) {
      const r = ctx.repo("edit-misc");
      const latin1 = Buffer.from("caf\xe9 na\xefve\nsecond line\n", "latin1");
      r.commit("base", {
        "modified.txt": lines(20, "m"), "staged-mod.txt": lines(10, "s"), "deleted.txt": "to be deleted\n", "staged-deleted.txt": "staged deletion\n",
        "long-line.txt": "short\n" + "y".repeat(50000) + "\n", "size-0.9MB.txt": wide(9000), "size-1.5MB.txt": wide(15000), "size-2.5MB.txt": wide(25000),
        "latin1.txt": latin1, "binary.dat": Buffer.from([0, 1, 2, 3, 0, 0, 255]), "ünïcode-файл.txt": "héllo\n", "日本語.txt": "こんにちは\n",
      });
      r.write("modified.txt", setLine(lines(20, "m"), 4, "m4 changed"));
      r.write("staged-mod.txt", setLine(lines(10, "s"), 2, "s2 staged"));
      r.git("add", "staged-mod.txt");
      r.remove("deleted.txt");
      r.git("rm", "-q", "staged-deleted.txt");
      r.write("staged-new.txt", "new and staged\n");
      r.git("add", "staged-new.txt");
      r.write("untracked.txt", "i am untracked\n");
      r.write("long-line.txt", "short\n" + "z".repeat(50000) + "\n");
      r.write("size-0.9MB.txt", setLine(wide(9000), 5, "EDITED line five"));
      r.write("size-1.5MB.txt", setLine(wide(15000), 5, "EDITED line five"));
      r.write("size-2.5MB.txt", setLine(wide(25000), 5, "EDITED line five"));
      r.write("latin1.txt", Buffer.from("caf\xe9 na\xefve\nsecond line EDITED\n", "latin1"));
      r.write("binary.dat", Buffer.from([0, 1, 2, 4, 0, 0, 255]));
      r.write("ünïcode-файл.txt", "héllo wörld\n");
      r.write("日本語.txt", "こんにちは世界\n");
      r.write("новый-файл.txt", "untracked with a non-ASCII name\n");
      let symlink = false;
      try {
        fs.symlinkSync("modified.txt", path.join(r.dir, "link-to-modified"));
        symlink = true;
      } catch {
        console.log("note: edit-misc could not create a symlink on this OS/user (needs privilege); that case is skipped.");
      }
      return { repo: r.dir, meta: { symlink } };
    },
    expect: (meta) => ({ operation: "none", staged: 3, unstaged: 10, untracked: 2 + (meta.symlink ? 1 : 0) }),
  },
  {
    name: "many-files",
    summary: "About 2000 changed files (modified, deleted, untracked) across 40 folders, for list windowing/performance.",
    tryText:
      "Open the Changes panel: it should appear quickly and scroll smoothly (no multi-second freeze, no blank gaps while scrolling fast). Try Select all / Stage all / Unstage all, filtering if available, keyboard Up/Down across the list, and that the counters match what `git status` reports. Count scales with GITHYDRA_DEMO_SCALE.",
    build(ctx) {
      const r = ctx.repo("many-files");
      const n = scaled(2000, 60);
      const base = {};
      for (let i = 0; i < n; i++) base[`dir${i % 40}/file${i}.txt`] = `file ${i}\nsecond\n`;
      r.commit("base", base);
      let changed = 0;
      for (let i = 0; i < n; i++) {
        const f = `dir${i % 40}/file${i}.txt`;
        if (i % 50 === 0) { r.remove(f); changed++; }
        else if (i % 10 !== 0) { r.write(f, `file ${i}\nEDITED\n`); changed++; }
      }
      const untracked = Math.floor(n / 20);
      for (let i = 0; i < untracked; i++) r.write(`new/untracked${i}.txt`, `new ${i}\n`);
      return { repo: r.dir, meta: { changed: changed + untracked } };
    },
    expect: (meta) => ({ operation: "none", changed: meta.changed, staged: 0 }),
  },
  {
    name: "stash-heavy",
    summary: "25 stashes: named/unnamed, with untracked files, multi-file, and one that conflicts when applied.",
    tryText:
      "Open the Stashes list: it should handle 25 entries. Apply and Pop several (the working tree must match what the stash held), drop one, and check Pop of 'will conflict on apply' reports the conflict instead of losing the stash (it must stay in the list). Stashes that include untracked files must bring them back. (Count scales with GITHYDRA_DEMO_SCALE.)",
    build(ctx) {
      const r = ctx.repo("stash-heavy");
      const n = scaled(25, 6);
      r.commit("base", { "work.txt": lines(20, "w"), "other.txt": lines(10, "o"), "conflict-target.txt": "line1\nline2\n" });
      r.write("conflict-target.txt", "stashed line1\nline2\n");
      r.git("stash", "push", "-q", "-m", "will conflict on apply");
      r.commit("move conflict-target on", { "conflict-target.txt": "committed line1\nline2\n" });
      for (let i = 2; i <= n; i++) {
        r.write("work.txt", setLine(lines(20, "w"), (i % 18) + 1, `stash ${i} edit`));
        if (i % 4 === 0) r.write(`untracked-${i}.txt`, `untracked in stash ${i}\n`);
        if (i % 7 === 0) r.write("other.txt", setLine(lines(10, "o"), 3, `stash ${i} other`));
        const args = ["stash", "push", "-q"];
        if (i % 4 === 0) args.push("-u");
        if (i % 3 !== 0) args.push("-m", `stash ${i}: ${i % 2 ? "experiment" : "wip on parser"}`);
        r.git(...args);
      }
      r.write("work.txt", setLine(lines(20, "w"), 1, "current uncommitted edit"));
      return { repo: r.dir, meta: { n } };
    },
    expect: (meta) => ({ operation: "none", stashes: meta.n, unstaged: 1 }),
  },
];
