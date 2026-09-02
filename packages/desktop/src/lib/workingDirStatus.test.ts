import { describe, expect, it } from "vitest";
import type { WorkingDirectoryChanges, WorkingDirectoryFileChange } from "@githydra/git-core";
import { deriveWorkingDirStatus } from "./workingDirStatus";

function entry(path: string): WorkingDirectoryFileChange {
  return { path, status: "modified", category: "staged" };
}

describe("deriveWorkingDirStatus", () => {
  it("returns null for a bare repository (null in, null out)", () => {
    expect(deriveWorkingDirStatus(null)).toBeNull();
  });

  it("returns hasChanges: false and all-zero counts for a clean working directory", () => {
    const changes: WorkingDirectoryChanges = { staged: [], unstaged: [], untracked: [], conflicted: [] };
    expect(deriveWorkingDirStatus(changes)).toEqual({
      hasChanges: false,
      staged: 0,
      unstaged: 0,
      untracked: 0,
      conflicted: 0,
    });
  });

  it("derives per-category counts as the .length of each array", () => {
    const changes: WorkingDirectoryChanges = {
      staged: [entry("a.ts"), entry("b.ts")],
      unstaged: [entry("c.ts")],
      untracked: [entry("d.ts"), entry("e.ts"), entry("f.ts")],
      conflicted: [],
    };
    expect(deriveWorkingDirStatus(changes)).toEqual({
      hasChanges: true,
      staged: 2,
      unstaged: 1,
      untracked: 3,
      conflicted: 0,
    });
  });

  it("sets hasChanges: true when only conflicted entries exist (no staged/unstaged/untracked)", () => {
    const changes: WorkingDirectoryChanges = { staged: [], unstaged: [], untracked: [], conflicted: [entry("x.ts")] };
    const result = deriveWorkingDirStatus(changes);
    expect(result?.hasChanges).toBe(true);
    expect(result?.conflicted).toBe(1);
  });
});
