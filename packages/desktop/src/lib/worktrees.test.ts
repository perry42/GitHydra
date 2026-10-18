// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from "vitest";
import type { RepoTab } from "../hooks/useRepoTabs";
import { mockWorktreeEntry } from "../test/mockGitHydra";
import {
  branchWorktreeMenuAction,
  buildTabLabels,
  commitWorktreeMenuAction,
  describeWorktree,
  findTabForPath,
  identitiesFromList,
  indexWorktrees,
  lockedRemoveReason,
  MISSING_OPEN_REASON,
  truncateMiddle,
  truncatePathMiddle,
  visibleText,
  worktreeName,
} from "./worktrees";

const tab = (id: string, repoPath: string): RepoTab => ({
  id,
  repoPath,
  remembered: { selectedSha: null, filter: {}, showAllRefs: false, rightPanel: "none", selectedFile: null },
});

describe("truncateMiddle (FR-612, AC14)", () => {
  it("leaves a short name alone and caps a long one at 24 characters", () => {
    expect(truncateMiddle("main")).toBe("main");
    const out = truncateMiddle("feature/PROJ-1234-add-debounce-to-the-search-box-v3");
    expect(Array.from(out)).toHaveLength(24);
    expect(out).toContain("...");
  });

  it("keeps the first and the last characters so a shared 20-character prefix stays distinguishable", () => {
    const prefix = "feature/PROJ-1234567";
    const a = truncateMiddle(`${prefix}-fix-search-debounce-v2`);
    const b = truncateMiddle(`${prefix}-fix-search-debounce-v3`);
    expect(a).not.toBe(b);
    expect(a.startsWith("feature/")).toBe(true);
    expect(a.endsWith("v2")).toBe(true);
    expect(b.endsWith("v3")).toBe(true);
  });

  it("counts code points, so an astral character is never split", () => {
    const out = truncateMiddle("😀".repeat(40));
    expect(Array.from(out)).toHaveLength(24);
    expect(out).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/);
  });
});

describe("visibleText (FR-612)", () => {
  it("shows control and bidi characters as visible escapes", () => {
    expect(visibleText("a\u202Eb")).toBe("a\\u{202e}b");
    expect(visibleText("tab\there")).toBe("tab\\u{9}here");
    expect(visibleText("plain-name")).toBe("plain-name");
    expect(visibleText("a￹b\u{1d173}c")).toBe("a\\u{fff9}b\\u{1d173}c");
  });
});

describe("worktreeName", () => {
  it("is the branch, or 'detached <short sha>'", () => {
    expect(worktreeName(mockWorktreeEntry({ branch: "feature/x" }))).toBe("feature/x");
    expect(worktreeName(mockWorktreeEntry({ branch: null, head: "abcdef1234567890" }))).toBe("detached abcdef1");
  });
});

describe("describeWorktree (FR-614/FR-615 reasons)", () => {
  it("allows a plain linked worktree", () => {
    const r = describeWorktree(mockWorktreeEntry(), false);
    expect(r.openReason).toBeNull();
    expect(r.removeReason).toBeNull();
    expect(r.canCleanUp).toBe(false);
    expect(r.canDeleteBranch).toBe(true);
  });

  it("disables Remove for a locked worktree with the exact sentence", () => {
    const r = describeWorktree(mockWorktreeEntry({ locked: true, lockReason: "on a usb stick" }), false);
    expect(r.removeReason).toBe("Locked: on a usb stick. Unlock it with git worktree unlock before removing.");
    expect(r.removeReason).toBe(lockedRemoveReason("on a usb stick"));
    expect(r.openReason).toBeNull();
  });

  it("a missing worktree cannot be opened, offers Clean up, and cannot be removed", () => {
    const r = describeWorktree(mockWorktreeEntry({ prunable: true, prunableReason: "gitdir file points to non-existent location" }), false);
    expect(r.openReason).toBe("Its folder is missing.");
    expect(r.openReason).toBe(MISSING_OPEN_REASON);
    expect(r.canCleanUp).toBe(true);
    expect(r.removeReason).not.toBeNull();
  });

  it("the main worktree can be opened (its own tab) but never removed", () => {
    const r = describeWorktree(mockWorktreeEntry({ id: null, isMain: true }), false);
    expect(r.openReason).toBeNull();
    expect(r.removeReason).toBe("The main worktree cannot be removed.");
  });

  it("an unsupported entry and an untrusted list disable Open and Remove with a reason", () => {
    const bad = describeWorktree(mockWorktreeEntry({ supported: false }), false);
    expect(bad.openReason).toMatch(/cannot be trusted/);
    expect(bad.removeReason).toMatch(/cannot be trusted/);
    const untrusted = describeWorktree(mockWorktreeEntry(), true);
    expect(untrusted.openReason).toMatch(/disagree/);
    expect(untrusted.removeReason).toMatch(/disagree/);
    expect(untrusted.canCleanUp).toBe(false);
  });

  it("a bare entry is not openable", () => {
    expect(describeWorktree(mockWorktreeEntry({ id: null, isMain: true, isBare: true, branch: null }), false).openReason).toMatch(/bare/);
  });
});

describe("menu actions: exactly ONE worktree item (FR-607, AC12)", () => {
  const main = mockWorktreeEntry({ id: null, isMain: true, path: "/w/repo", branch: "main", head: "a".repeat(40) });
  const linked = mockWorktreeEntry({ id: "f", path: "/w/repo.worktrees/feature", branch: "feature", head: "b".repeat(40) });
  const detached = mockWorktreeEntry({ id: "d", path: "/w/repo.worktrees/d", branch: null, head: "c".repeat(40) });
  const index = indexWorktrees([main, linked, detached]);

  it("a free branch offers Create; a branch with a worktree, or checked out in main, offers Open with the path", () => {
    expect(branchWorktreeMenuAction("free", index)).toEqual({ kind: "create", label: "Create worktree…" });
    const open = branchWorktreeMenuAction("feature", index);
    expect(open).toMatchObject({ kind: "open", label: "Open worktree", description: "In worktree feature" });
    expect(branchWorktreeMenuAction("main", index)).toMatchObject({ kind: "open" });
  });

  it("a remote-only branch (no local entry) offers Create", () => {
    expect(branchWorktreeMenuAction("only-remote", index)).toMatchObject({ kind: "create" });
  });

  it("offers nothing when worktree info is unavailable", () => {
    expect(branchWorktreeMenuAction("free", index, false)).toBeNull();
    expect(commitWorktreeMenuAction("f".repeat(40), index, false)).toBeNull();
  });

  it("a commit with a worktree at it offers Open (also a detached one); otherwise 'Create worktree from commit <sha>'", () => {
    expect(commitWorktreeMenuAction("c".repeat(40), index)).toMatchObject({ kind: "open", entry: detached });
    expect(commitWorktreeMenuAction("1234567890abcdef".padEnd(40, "0"), index)).toEqual({
      kind: "create",
      label: "Create worktree from commit 1234567…",
    });
  });

  it("every action label matches /worktree/i exactly once per menu", () => {
    for (const b of ["free", "feature", "main"]) {
      const a = branchWorktreeMenuAction(b, index)!;
      expect(a.label.match(/worktree/gi)).toHaveLength(1);
    }
  });
});

describe("tab labels (FR-611, FR-612, AC14)", () => {
  const list = (names: { id: string | null; path: string; branch: string | null }[], commonDir = "/w/repo/.git") => ({
    entries: names.map((n) => mockWorktreeEntry({ ...n, isMain: n.id === null })),
    untrusted: false,
    untrustedReason: null,
    commonDir,
    mainPath: "/w/repo",
    format: "nul" as const,
    mainPathIsGitDir: false,
  });

  it("a single-worktree repo keeps the folder-name label (no model at all)", () => {
    const ids = identitiesFromList(list([{ id: null, path: "/w/repo", branch: "main" }]));
    expect(buildTabLabels([tab("t1", "/w/repo")], ids)).toEqual({});
  });

  it("with two worktrees the main tab gets the house glyph and each linked tab the tree glyph, branch first", () => {
    const ids = identitiesFromList(
      list([
        { id: null, path: "/w/repo", branch: "main" },
        { id: "f", path: "/w/repo.worktrees/feature", branch: "feature/search" },
      ]),
    );
    const labels = buildTabLabels([tab("t1", "/w/repo"), tab("t2", "/w/repo.worktrees/feature")], ids);
    expect(labels.t1).toMatchObject({ label: "main", glyph: "main", suffix: null, title: "/w/repo" });
    expect(labels.t2).toMatchObject({ label: "feature/search", glyph: "linked", suffix: null, title: "/w/repo.worktrees/feature" });
    expect(labels.t2!.ariaLabel).toContain("/w/repo.worktrees/feature");
  });

  it("the repo-name suffix appears only when more than one REPOSITORY is open, and a second tab of the same repo changes nothing", () => {
    const ids = identitiesFromList(
      list([
        { id: null, path: "/w/repo", branch: "main" },
        { id: "f", path: "/w/repo.worktrees/feature", branch: "feature" },
      ]),
    );
    const sameRepo = buildTabLabels([tab("t1", "/w/repo"), tab("t2", "/w/repo.worktrees/feature")], ids);
    expect(sameRepo.t1!.suffix).toBeNull();
    expect(sameRepo.t2!.suffix).toBeNull();
    const withOther = buildTabLabels([tab("t1", "/w/repo"), tab("t2", "/w/repo.worktrees/feature"), tab("t3", "/w/other")], ids);
    expect(withOther.t1!.suffix).toBe("repo");
    expect(withOther.t2!.suffix).toBe("repo");
    expect(withOther.t3).toBeUndefined();
    // The meaning (label + glyph) of the existing tabs did not change.
    expect({ ...withOther.t1, suffix: null, ariaLabel: "" }).toEqual({ ...sameRepo.t1, suffix: null, ariaLabel: "" });
  });

  it("a detached worktree reads 'detached <short sha>'; long names truncate in the middle", () => {
    const ids = identitiesFromList(
      list([
        { id: null, path: "/w/repo", branch: "main" },
        { id: "d", path: "/w/repo.worktrees/d", branch: null },
        { id: "l", path: "/w/repo.worktrees/l", branch: "feature/PROJ-1-implement-the-debounce-of-search-v3" },
      ]),
    );
    const labels = buildTabLabels([tab("a", "/w/repo.worktrees/d"), tab("b", "/w/repo.worktrees/l")], ids);
    expect(labels.a!.label).toBe("detached def5678");
    expect(Array.from(labels.b!.label)).toHaveLength(24);
  });

  it("escapes bidi and control characters in the accessible name (LOW-3)", () => {
    const evil = "re\u202Epo";
    const ids = identitiesFromList({
      ...list([{ id: null, path: "/w/repo", branch: "main" }, { id: "f", path: "/w/f\u202Ex", branch: "b" }]),
      mainPath: "/w/" + evil,
    });
    const labels = buildTabLabels([tab("a", "/w/f\u202Ex"), tab("b", "/w/other")], ids);
    expect(labels.a!.ariaLabel).not.toMatch(/[\u202E]/);
    expect(labels.a!.ariaLabel).toContain("\\u{202e}");
  });

  it("matches tabs by path spelling (backslashes, trailing separator) like the rest of the tab code", () => {
    expect(findTabForPath([tab("t", "C:\\Work\\repo\\")], "C:/work/repo")?.id).toBe("t");
  });
});

describe("truncatePathMiddle", () => {
  it("keeps a short path whole", () => {
    expect(truncatePathMiddle("/w/repo", 38)).toBe("/w/repo");
  });
  it("keeps the leaf and as many parents as fit, in the path's own separator style", () => {
    expect(truncatePathMiddle("D:\\projects\\clients\\acme-platform\\services\\acme.worktrees\\hotfix", 26)).toBe("...\\acme.worktrees\\hotfix");
    expect(truncatePathMiddle("/home/me/projects/clients/acme.worktrees/hotfix", 30)).toBe(".../acme.worktrees/hotfix");
  });
  it("cuts a leaf that alone is too long in its middle", () => {
    const out = truncatePathMiddle("/w/" + "x".repeat(20) + "-end", 12);
    expect(Array.from(out)).toHaveLength(12);
    expect(out.endsWith("end")).toBe(true);
  });
});
