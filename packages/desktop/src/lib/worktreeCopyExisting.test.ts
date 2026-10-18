// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from "vitest";
import type { WorktreeList } from "@githydra/git-core";
import type { WorktreeExistingCopyResult } from "../../shared/ipcContract";
import { mockWorktreeEntry } from "../test/mockGitHydra";
import {
  copyIntoNotice,
  copyIntoReason,
  findSourceEntry,
  measureSelection,
  paletteCopyIntoReason,
  pickerSubLine,
  REASON_BARE,
  REASON_LOCKED,
  REASON_MISSING,
  REASON_NO_OTHER,
  REASON_SOURCE,
  REASON_UNSAFE_LIST,
  selectionReadout,
} from "./worktreeCopyExisting";

const main = mockWorktreeEntry({ id: null, isMain: true, path: "/w/acme", branch: "main" });
const linked = mockWorktreeEntry({ id: "tl", path: "/w/acme.worktrees/tour-login", branch: "tour-login" });
const list = (entries = [main, linked], over: Partial<WorktreeList> = {}): WorktreeList => ({
  entries,
  untrusted: false,
  untrustedReason: null,
  commonDir: "/w/acme/.git",
  mainPath: "/w/acme",
  format: "nul",
  mainPathIsGitDir: false,
  ...over,
});

describe("copyIntoReason (FR-650, exact strings)", () => {
  it("allows an ordinary other worktree, including the main worktree from a linked source", () => {
    expect(copyIntoReason(linked, { source: main, list: list() })).toBeNull();
    expect(copyIntoReason(main, { source: linked, list: list() })).toBeNull();
  });

  it.each([
    ["the source itself", mockWorktreeEntry({ id: "tl", path: "/w/acme.worktrees/tour-login" }), "This is the source worktree"],
    ["a locked worktree", mockWorktreeEntry({ id: "lk", locked: true, lockReason: "x" }), "Locked: unlock it first"],
    ["a missing (prunable) worktree", mockWorktreeEntry({ id: "ms", prunable: true }), "The folder is missing"],
    ["an unsupported entry", mockWorktreeEntry({ id: "un", supported: false }), "This worktree list could not be read safely"],
  ])("%s", (_n, entry, text) => {
    expect(copyIntoReason(entry, { source: linked, list: list([main, linked, entry]) })).toBe(text);
  });

  it("an untrusted list refuses every row; a bare repository refuses every row", () => {
    expect(copyIntoReason(main, { source: linked, list: list([main, linked], { untrusted: true }) })).toBe("This worktree list could not be read safely");
    const bare = mockWorktreeEntry({ id: null, isMain: true, isBare: true, path: "/w/acme.git" });
    expect(copyIntoReason(linked, { source: null, list: list([bare, linked]) })).toBe("This is a bare repository: there is nothing to copy.");
  });

  it("exports the same strings the spec names", () => {
    expect([REASON_SOURCE, REASON_LOCKED, REASON_MISSING, REASON_UNSAFE_LIST, REASON_BARE, REASON_NO_OTHER]).toEqual([
      "This is the source worktree",
      "Locked: unlock it first",
      "The folder is missing",
      "This worktree list could not be read safely",
      "This is a bare repository: there is nothing to copy.",
      "No other worktree to copy into",
    ]);
  });

  it("finds the source by the active tab's path", () => {
    expect(findSourceEntry(list(), "/w/acme.worktrees/tour-login")).toBe(linked);
    expect(findSourceEntry(list(), "/elsewhere")).toBeNull();
  });
});

describe("palette reasons and picker rows (FR-656)", () => {
  it("'No other worktree to copy into' when only the source exists; the bare sentence for a bare repo", () => {
    expect(paletteCopyIntoReason(list([main]), main)).toBe("No other worktree to copy into");
    expect(paletteCopyIntoReason(list([main, linked]), main)).toBeNull();
    expect(paletteCopyIntoReason(list([mockWorktreeEntry({ isBare: true, isMain: true, id: null }), linked]), null)).toBe("This is a bare repository: there is nothing to copy.");
  });

  it("the sub line is '<branch> · <path>' or 'detached at <short sha>' in place of the branch", () => {
    expect(pickerSubLine(linked)).toBe("tour-login · /w/acme.worktrees/tour-login");
    expect(pickerSubLine(mockWorktreeEntry({ branch: null, head: "abc1234" + "0".repeat(33), path: "/w/x" }))).toBe("detached at abc1234 · /w/x");
  });
});

describe("selection readout (FR-651)", () => {
  const r = (copyableCount: number, bytes: number) => ({ id: String(copyableCount), copyableCount, bytes, disabledReason: null }) as never;
  it("counts only enabled ticked files; 5,000 files / 200 MB are fine, one more is over", () => {
    expect(measureSelection([r(5000, 1)], new Set(["5000"])).overLimit).toBe(false);
    expect(measureSelection([r(5001, 1)], new Set(["5001"])).overLimit).toBe(true);
    expect(measureSelection([r(1, 200 * 1024 * 1024)], new Set(["1"])).overLimit).toBe(false);
    expect(measureSelection([r(1, 200 * 1024 * 1024 + 1)], new Set(["1"])).overLimit).toBe(true);
    expect(selectionReadout({ files: 1, bytes: 100, overLimit: false }, true)).toBe("1 file selected, 100 B");
    expect(selectionReadout({ files: 0, bytes: 0, overLimit: false }, false)).toBe("No ignored files will be copied.");
  });
});

describe("result banners (FR-655, byte for byte)", () => {
  const base = { from: "acme", into: "tour-login" };
  const text = (r: Exclude<WorktreeExistingCopyResult, { status: "refused" }>, paths = {}) => copyIntoNotice(r, paths).text;
  const sk = (path: string, reason: string) => ({ path, reason: "x", text: reason });

  it("all copied is a success; 1 file reads '1 file'; sizes round like the Create dialog", () => {
    expect(copyIntoNotice({ status: "done", copied: 3, bytes: 4096, skipped: [], skippedTotal: 0, ...base })).toMatchObject({
      tone: "success",
      text: "Copied 3 files (4 KB) from acme into tour-login.",
    });
    expect(text({ status: "done", copied: 1, bytes: 12, skipped: [], skippedTotal: 0, ...base })).toBe("Copied 1 file (12 B) from acme into tour-login.");
    expect(text({ status: "done", copied: 2, bytes: 3 * 1024 * 1024, skipped: [], skippedTotal: 0, ...base })).toBe("Copied 2 files (3 MB) from acme into tour-login.");
  });

  it("some skipped is a warning that names them with their fixed reasons", () => {
    const n = copyIntoNotice({
      status: "done",
      copied: 2,
      bytes: 4096,
      skipped: [sk("config/local.json", "already exists"), sk("data/seed.sqlite", "changed since you reviewed")],
      skippedTotal: 2,
      ...base,
    });
    expect(n.tone).toBe("warning");
    expect(n.text).toBe("Copied 2 files (4 KB) from acme into tour-login. Not copied: config/local.json (already exists), data/seed.sqlite (changed since you reviewed).");
    // Names are <code> text.
    expect(n.parts.filter((p) => typeof p !== "string")).toEqual([{ code: "config/local.json" }, { code: "data/seed.sqlite" }]);
  });

  it("three skipped show all; four or more show three then 'and N more'", () => {
    const three = [sk("a", "already exists"), sk("b", "already exists"), sk("c", "symbolic link")];
    expect(text({ status: "done", copied: 1, bytes: 1024, skipped: three, skippedTotal: 3, ...base })).toBe(
      "Copied 1 file (1 KB) from acme into tour-login. Not copied: a (already exists), b (already exists), c (symbolic link).",
    );
    expect(text({ status: "done", copied: 1, bytes: 1024, skipped: [...three, sk("d", "already exists")], skippedTotal: 4, ...base })).toBe(
      "Copied 1 file (1 KB) from acme into tour-login. Not copied: a (already exists), b (already exists), c (symbolic link) and 1 more.",
    );
    // main lists at most 20; the real total decides the count.
    expect(text({ status: "done", copied: 1, bytes: 1024, skipped: Array.from({ length: 20 }, (_, i) => sk(`f${i}`, "already exists")), skippedTotal: 25, ...base })).toMatch(/\(already exists\) and 22 more\.$/);
  });

  it("nothing copied is a warning", () => {
    const n = copyIntoNotice({ status: "done", copied: 0, bytes: 0, skipped: [sk("a", "already exists")], skippedTotal: 1, ...base });
    expect(n.tone).toBe("warning");
    expect(n.text).toBe("Nothing was copied into tour-login: every selected file was skipped. Not copied: a (already exists).");
  });

  it("cancelled", () => {
    expect(text({ status: "cancelled", copied: 2, bytes: 3 * 1024, skipped: [], skippedTotal: 0, ...base })).toBe("Copy cancelled. Copied 2 files (3 KB) from acme into tour-login before it stopped.");
    expect(text({ status: "cancelled", copied: 0, bytes: 0, skipped: [], skippedTotal: 0, ...base })).toBe("Copy cancelled. Nothing was copied.");
  });

  it("limit hit while copying", () => {
    const n = copyIntoNotice({ status: "limit", copied: 5000, bytes: 10 * 1024, skipped: [], skippedTotal: 0, ...base });
    expect(n.tone).toBe("warning");
    expect(n.text).toBe("Stopped at the limit of 5,000 files, 200 MB or 60 s. Copied 5000 files (10 KB) from acme into tour-login.");
  });

  it("equal folder names fall back to the full paths", () => {
    expect(text({ status: "done", copied: 1, bytes: 1024, skipped: [], skippedTotal: 0, from: "app", into: "app" }, { fromPath: "/w/a/app", intoPath: "/w/b/app" })).toBe(
      "Copied 1 file (1 KB) from /w/a/app into /w/b/app.",
    );
  });

  it("never says 'remember' and only the fixed reason text reaches the banner (a sentinel in the code field does not)", () => {
    const n = copyIntoNotice({
      status: "done",
      copied: 1,
      bytes: 1,
      skipped: [{ path: "a", reason: "SENTINEL-CODE", text: "already exists" }],
      skippedTotal: 1,
      ...base,
    });
    expect(n.text).not.toMatch(/remember|SENTINEL/i);
  });
});
