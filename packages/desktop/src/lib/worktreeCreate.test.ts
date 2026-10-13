// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { addRefusalFailure, destinationFailure, isAbsolutePathLike, joinFolder, resolveWorktreeFolder } from "./worktreeCreate";

describe("resolveWorktreeFolder (FR-608)", () => {
  it("leaves an absolute path alone", () => {
    expect(resolveWorktreeFolder("/x/y", "/w/repo")).toBe("/x/y");
    expect(resolveWorktreeFolder("C:\\x\\y", "C:\\w\\repo")).toBe("C:\\x\\y");
  });

  it("resolves a relative path against the repo's PARENT, folding . and ..", () => {
    expect(resolveWorktreeFolder("repo.worktrees/feature", "/w/repo")).toBe("/w/repo.worktrees/feature");
    expect(resolveWorktreeFolder("../other/./x", "/w/repo")).toBe("/other/x");
    expect(resolveWorktreeFolder("sibling", "C:\\work\\repo")).toBe("C:\\work\\sibling");
  });

  it("never climbs above the root", () => {
    expect(resolveWorktreeFolder("../../../../x", "/w/repo")).toBe("/x");
  });

  it("isAbsolutePathLike knows drive letters, roots and UNC", () => {
    expect(["/a", "C:\\a", "c:/a", "\\\\srv\\share"].every(isAbsolutePathLike)).toBe(true);
    expect(isAbsolutePathLike("a/b")).toBe(false);
  });

  it("joinFolder keeps the separator style of the parent", () => {
    expect(joinFolder("C:\\picked\\", "feat")).toBe("C:\\picked\\feat");
    expect(joinFolder("/picked/", "feat")).toBe("/picked/feat");
  });
});

describe("destination refusals become in-field messages (FR-608)", () => {
  const refuse = (reason: string, extra: Record<string, unknown> = {}) =>
    destinationFailure({ ok: false, reason, message: `git-core: ${reason}`, ...extra } as never);

  it("folder not empty, inside the repo, containing the repo", () => {
    expect(refuse("notEmpty").message).toMatch(/not empty/);
    expect(refuse("insideRepo").message).toMatch(/inside the repository/);
    expect(refuse("insideWorktree").message).toMatch(/inside the repository or another worktree/);
    expect(refuse("ancestorOfRepo").message).toMatch(/contains the repository/);
    expect(refuse("notEmpty").field).toBe("folder");
  });

  it("a worktree already at that folder names its branch and links to Open", () => {
    const f = refuse("alreadyWorktree", { branch: "feature/x", worktreePath: "/w/wt" });
    expect(f.message).toBe("A worktree already exists in that folder with branch feature/x checked out.");
    expect(f.link).toEqual({ label: "Open", path: "/w/wt" });
  });

  it("any other reason falls back to git-core's own sentence", () => {
    expect(refuse("tooLong").message).toBe("git-core: tooLong");
  });
});

describe("add refusals (FR-602, FR-608)", () => {
  const refuse = (reason: string, extra: Record<string, unknown> = {}) =>
    addRefusalFailure({ ok: false, reason, message: `git-core: ${reason}`, ...extra } as never);

  it("branch already checked out names the path and links to that worktree", () => {
    const f = refuse("branchCheckedOut", { worktreePath: "/w/repo" });
    expect(f.field).toBe("branch");
    expect(f.message).toBe("That branch is already checked out at /w/repo.");
    expect(f.link).toEqual({ label: "Open that worktree", path: "/w/repo" });
  });

  it("a destination refusal is mapped like the live validation", () => {
    const f = refuse("destination", { destinationReason: "notEmpty" });
    expect(f.field).toBe("folder");
    expect(f.message).toMatch(/not empty/);
  });

  it("missing refs and an empty repository are general, plain sentences with no raw git text", () => {
    for (const r of ["branchNotFound", "startPointNotFound", "remoteNotFound", "remoteBranchNotFound"]) {
      expect(refuse(r).field).toBe("general");
      expect(refuse(r).message).not.toContain("git-core:");
    }
    expect(refuse("emptyRepository").message).toMatch(/no commits/);
  });
});
