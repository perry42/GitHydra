// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from "vitest";
import type { IgnoreReport, IgnoreRowReport } from "@githydra/git-core";
import { buildRows } from "./fileSelection";
import { directoryOf, extensionOf, scopeImpact, scopeOptions, summarizeIgnoreReport } from "./ignoreMessages";

const rowsOf = (...paths: string[]) =>
  buildRows(
    {
      staged: [],
      unstaged: [],
      untracked: paths.map((path) => ({ path, category: "untracked" as const, status: "added" as const })),
      conflicted: [],
    },
    new Set(),
  );

const report = (rows: Partial<IgnoreRowReport>[], extra: Partial<IgnoreReport> = {}): IgnoreReport => ({
  rows: rows.map((r) => ({ path: "x", tracked: false, outcome: "written", file: ".gitignore", ...r }) as IgnoreRowReport),
  files: [],
  stopTracking: null,
  applied: true,
  ...extra,
});

describe("extensionOf / directoryOf (FR-494)", () => {
  it("uses the last extension only and nothing for dotfiles or extensionless names", () => {
    const [a, b, c, d] = rowsOf("a.tar.gz", ".env", "Makefile", "dir/sub/x.log");
    expect(extensionOf(a!)).toBe(".gz");
    expect(extensionOf(b!)).toBeNull();
    expect(extensionOf(c!)).toBeNull();
    expect(directoryOf(d!)).toBe("dir/sub");
    expect(directoryOf(a!)).toBeNull();
  });

  it("a directory row is its own directory and has no extension", () => {
    const [d] = rowsOf("vendor/lib/");
    expect(directoryOf(d!)).toBe("vendor/lib");
    expect(extensionOf(d!)).toBeNull();
  });
});

describe("scopeOptions (D1)", () => {
  it("names the extension and the directory for one file", () => {
    const opts = scopeOptions(rowsOf("build/out.log"));
    expect(opts.map((o) => o.label)).toEqual(["This file", "All *.log files", "All files in build/"]);
    expect(opts.every((o) => o.disabledReason === null)).toBe(true);
  });

  it("disables, with a reason, what does not apply (FR-501)", () => {
    const opts = scopeOptions(rowsOf(".env"));
    expect(opts[1]!.disabledReason).toMatch(/no extension/i);
    expect(opts[2]!.disabledReason).toMatch(/repository root/i);
  });

  it("words a multi-selection by counts", () => {
    const opts = scopeOptions(rowsOf("a/x.log", "b/y.map", "b/z.map"));
    expect(opts[0]!.label).toBe("These 3 files");
    expect(opts[1]!.label).toBe("All *.log, *.map files");
    expect(opts[2]!.label).toBe("All files in these 2 folders");
  });
});

describe("summarizeIgnoreReport (FR-497, D9)", () => {
  it("names the rule and the file", () => {
    expect(summarizeIgnoreReport(report([{ outcome: "written", rule: "/x" }]))).toEqual({
      text: "Added /x to .gitignore.",
      tone: "ok",
    });
  });

  it("names each file when rules went to different ones", () => {
    const n = summarizeIgnoreReport(
      report([
        { outcome: "written", rule: "/a" },
        { outcome: "written", rule: "/b", file: ".git/info/exclude" },
      ]),
    );
    expect(n.text).toBe("Added /a to .gitignore and /b to .git/info/exclude.");
  });

  it("says already in, as a warning when nothing was written", () => {
    expect(summarizeIgnoreReport(report([{ outcome: "already-in", rule: "/x" }]))).toEqual({
      text: "/x is already in .gitignore.",
      tone: "warn",
    });
  });

  it("names the rule that already ignores the file", () => {
    const n = summarizeIgnoreReport(
      report([{ path: "a.log", outcome: "already-ignored", ignoredBy: { source: ".gitignore", line: 3, pattern: "*.log" } }]),
    );
    expect(n.text).toBe("a.log is already ignored by .gitignore:3; nothing was written.");
    expect(n.tone).toBe("warn");
  });

  it("is honest when a later negation leaves the path unignored", () => {
    const n = summarizeIgnoreReport(
      report([
        {
          path: "keep.log",
          outcome: "still-not-ignored",
          rule: "*.log",
          ignoredBy: { source: ".gitignore", line: 9, pattern: "!keep.log" },
        },
      ]),
    );
    expect(n.text).toBe("keep.log still not ignored. A later rule re-includes it: !keep.log (.gitignore:9).");
    expect(n.tone).toBe("warn");
  });

  it("states a refusal and its reason", () => {
    const n = summarizeIgnoreReport(
      report([{ path: "d.txt", outcome: "refused", reason: "Conflicted files cannot be ignored; resolve the conflict first." }]),
    );
    expect(n.text).toBe("d.txt was not ignored: Conflicted files cannot be ignored; resolve the conflict first.");
    expect(n.tone).toBe("warn");
  });

  it("adds the stop-tracking result", () => {
    const n = summarizeIgnoreReport(
      report([{ outcome: "written", rule: "/x" }], {
        stopTracking: {
          paths: ["x"],
          count: 1,
          otherMatchesStillTracked: 0,
          mixedRows: [],
          renamedRows: [],
          skippedSubmodules: [],
          skippedConflicted: [],
        },
      }),
    );
    expect(n.text).toBe("Added /x to .gitignore. Stopped tracking 1 file; they stay on disk and show as staged deletions.");
  });
});

describe("scopeImpact (FR-523: '+N files' from the in-memory list)", () => {
  const all = rowsOf("build/a.log", "build/b.log", "build/sub/c.txt", "root.log", "other/d.log");
  const pick = (...p: string[]) => all.filter((r) => p.includes(r.path));

  it("name: nothing else is touched", () => {
    expect(scopeImpact(all, pick("build/a.log"), "name")).toEqual({ others: 0, hidden: 1 });
  });

  it("extension: every other listed file with that extension, anywhere", () => {
    expect(scopeImpact(all, pick("build/a.log"), "extension")).toEqual({ others: 3, hidden: 4 });
  });

  it("directory: files under the parent folder, nested included, never siblings of it", () => {
    expect(scopeImpact(all, pick("build/a.log"), "directory")).toEqual({ others: 2, hidden: 3 });
  });

  it("counts a path once and does not count conflicted rows", () => {
    const withConflict = buildRows(
      { staged: [], unstaged: [], untracked: [{ path: "a.log", category: "untracked", status: "added" }], conflicted: [{ path: "c.log", category: "conflicted", status: "unmerged" }] },
      new Set(),
    );
    expect(scopeImpact(withConflict, withConflict.filter((r) => r.path === "a.log"), "extension")).toEqual({ others: 0, hidden: 1 });
  });
});
