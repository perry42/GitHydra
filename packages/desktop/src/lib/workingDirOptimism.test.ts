// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from "vitest";
import type { WorkingDirectoryChanges, WorkingDirectoryFileChange } from "@githydra/git-core";
import {
  optimisticStage,
  optimisticStageAll,
  optimisticUnstage,
  optimisticUnstageAll,
  totalChangeCount,
} from "./workingDirOptimism";

function entry(
  path: string,
  category: WorkingDirectoryFileChange["category"],
  status: WorkingDirectoryFileChange["status"] = "modified",
  extra: Partial<WorkingDirectoryFileChange> = {},
): WorkingDirectoryFileChange {
  return { path, category, status, ...extra };
}

function empty(): WorkingDirectoryChanges {
  return { staged: [], unstaged: [], untracked: [], conflicted: [] };
}

describe("optimisticStage", () => {
  it("moves an unstaged file into staged", () => {
    const changes: WorkingDirectoryChanges = {
      ...empty(),
      unstaged: [entry("a.ts", "unstaged", "modified")],
    };
    const next = optimisticStage(changes, "a.ts", "unstaged");
    expect(next.unstaged).toEqual([]);
    expect(next.staged).toEqual([entry("a.ts", "staged", "modified")]);
  });

  it("moves an untracked file into staged as added", () => {
    const changes: WorkingDirectoryChanges = {
      ...empty(),
      untracked: [entry("new.ts", "untracked", "added")],
    };
    const next = optimisticStage(changes, "new.ts", "untracked");
    expect(next.untracked).toEqual([]);
    expect(next.staged).toEqual([entry("new.ts", "staged", "added")]);
  });

  it("is a no-op when the path isn't in the source category", () => {
    const changes = empty();
    expect(optimisticStage(changes, "missing.ts", "unstaged")).toBe(changes);
  });

  it("replaces any existing staged entry for the same path rather than duplicating it", () => {
    const changes: WorkingDirectoryChanges = {
      ...empty(),
      staged: [entry("a.ts", "staged", "modified")],
      unstaged: [entry("a.ts", "unstaged", "modified")],
    };
    const next = optimisticStage(changes, "a.ts", "unstaged");
    expect(next.staged).toHaveLength(1);
  });
});

describe("optimisticUnstage", () => {
  it("moves a staged modification back to unstaged", () => {
    const changes: WorkingDirectoryChanges = {
      ...empty(),
      staged: [entry("a.ts", "staged", "modified")],
    };
    const next = optimisticUnstage(changes, "a.ts");
    expect(next.staged).toEqual([]);
    expect(next.unstaged).toEqual([entry("a.ts", "unstaged", "modified")]);
  });

  it("moves a staged 'added' file back to untracked (git's real unstage-a-new-file behavior)", () => {
    const changes: WorkingDirectoryChanges = {
      ...empty(),
      staged: [entry("new.ts", "staged", "added")],
    };
    const next = optimisticUnstage(changes, "new.ts");
    expect(next.staged).toEqual([]);
    expect(next.untracked).toEqual([entry("new.ts", "untracked", "added")]);
  });

  it("drops a staged rename from Staged without guessing a destination", () => {
    const changes: WorkingDirectoryChanges = {
      ...empty(),
      staged: [entry("b.ts", "staged", "renamed", { oldPath: "a.ts" })],
    };
    const next = optimisticUnstage(changes, "b.ts");
    expect(next.staged).toEqual([]);
    expect(next.unstaged).toEqual([]);
    expect(next.untracked).toEqual([]);
  });

  it("is a no-op when the path isn't staged", () => {
    const changes = empty();
    expect(optimisticUnstage(changes, "missing.ts")).toBe(changes);
  });
});

describe("optimisticStageAll / optimisticUnstageAll", () => {
  it("stages every unstaged and untracked file, leaving conflicted untouched", () => {
    const changes: WorkingDirectoryChanges = {
      staged: [],
      unstaged: [entry("a.ts", "unstaged")],
      untracked: [entry("b.ts", "untracked", "added")],
      conflicted: [entry("c.ts", "conflicted", "unmerged")],
    };
    const next = optimisticStageAll(changes);
    expect(next.unstaged).toEqual([]);
    expect(next.untracked).toEqual([]);
    expect(next.staged.map((e) => e.path).sort()).toEqual(["a.ts", "b.ts"]);
    expect(next.conflicted).toEqual(changes.conflicted);
  });

  it("unstages every staged file back to its origin category", () => {
    const changes: WorkingDirectoryChanges = {
      staged: [entry("a.ts", "staged", "modified"), entry("new.ts", "staged", "added")],
      unstaged: [],
      untracked: [],
      conflicted: [],
    };
    const next = optimisticUnstageAll(changes);
    expect(next.staged).toEqual([]);
    expect(next.unstaged).toEqual([entry("a.ts", "unstaged", "modified")]);
    expect(next.untracked).toEqual([entry("new.ts", "untracked", "added")]);
  });
});

describe("totalChangeCount", () => {
  it("sums all four categories", () => {
    const changes: WorkingDirectoryChanges = {
      staged: [entry("a.ts", "staged")],
      unstaged: [entry("b.ts", "unstaged"), entry("c.ts", "unstaged")],
      untracked: [entry("d.ts", "untracked", "added")],
      conflicted: [],
    };
    expect(totalChangeCount(changes)).toBe(4);
  });
});
