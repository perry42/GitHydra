// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { DISCARD_TYPE_TO_CONFIRM_ABOVE } from "./fileSelection";
import { mockWorktreeEntry } from "../test/mockGitHydra";
import { keptBranchLine, planRemoval, removalRefusalMessage, TYPE_CONFIRM_ABOVE } from "./worktreeRemove";

const entry = mockWorktreeEntry({ path: "/w/repo.worktrees/feature", branch: "feature" });
const state = (count: number, submodules: string[] = [], dirtySubmodules: string[] = []) => ({ ok: true as const, count, submodules, dirtySubmodules });
const merge = (merged: boolean, unmergedCommits: number | null = 0) => ({ exists: true, merged, unmergedCommits, reference: "HEAD" as const });
const plan = (over: Partial<Parameters<typeof planRemoval>[0]> = {}) =>
  planRemoval({ entry, state: state(0), merge: null, wantsDeleteBranch: false, openAsTab: false, currentBranch: "main", ...over });

describe("planRemoval (FR-615)", () => {
  it("a clean worktree says ignored files go too and shows the path exactly once", () => {
    const p = plan();
    expect(p.message).toBe("This also deletes ignored files such as node_modules and build output in /w/repo.worktrees/feature.");
    expect(p.message.split("/w/repo.worktrees/feature")).toHaveLength(2);
    expect(p.force).toBe(false);
    expect(p.needsTyping).toBe(false);
  });

  it("a dirty worktree states the count and needs the explicit force", () => {
    const p = plan({ state: state(3) });
    expect(p.message).toContain("3 uncommitted files");
    expect(p.force).toBe(true);
  });

  it("reuses the shared threshold: exactly 20 needs no typing, 21 does", () => {
    expect(TYPE_CONFIRM_ABOVE).toBe(DISCARD_TYPE_TO_CONFIRM_ABOVE);
    expect(plan({ state: state(20) }).needsTyping).toBe(false);
    expect(plan({ state: state(21) }).needsTyping).toBe(true);
  });

  it("submodules are carried through and need force even when nothing else is dirty", () => {
    const p = plan({ state: state(0, ["libs/a", "libs/b"], ["libs/b"]) });
    expect(p.submodules).toEqual(["libs/a", "libs/b"]);
    expect(p.dirtySubmodules).toEqual(["libs/b"]);
    expect(p.force).toBe(true);
  });

  it("a merged branch keeps 'Remove worktree and delete branch'", () => {
    const p = plan({ wantsDeleteBranch: true, merge: merge(true) });
    expect(p.title).toBe("Remove worktree and delete branch?");
    expect(p.confirmLabel).toBe("Remove and delete branch");
    expect(p.deleteBranch).toBe(true);
    expect(p.keptBranchLine).toBeNull();
  });

  it("an unmerged branch downgrades to 'Remove worktree' with the real count and the kept-branch line", () => {
    const p = plan({ wantsDeleteBranch: true, merge: merge(false, 4) });
    expect(p.title).toBe("Remove worktree?");
    expect(p.confirmLabel).toBe("Remove worktree");
    expect(p.deleteBranch).toBe(false);
    expect(p.keptUnmerged).toBe(true);
    expect(p.keptBranchLine).toBe("Branch feature has 4 commits that are not merged into main or its upstream, so it will be kept.");
  });

  it("says 'some commits' when the count could not be computed, and treats an unreadable state as unmerged", () => {
    expect(plan({ wantsDeleteBranch: true, merge: merge(false, null) }).keptBranchLine).toContain("some commits that are not merged");
    const unknown = plan({ wantsDeleteBranch: true, merge: null });
    expect(unknown.deleteBranch).toBe(false);
    expect(unknown.keptBranchLine).toContain("some commits");
  });

  it("singular count reads naturally", () => {
    expect(keptBranchLine("b", 1, "main")).toBe("Branch b has 1 commit that is not merged into main or its upstream, so it will be kept.");
  });

  it("tells the user the open tab is closed first", () => {
    expect(plan({ openAsTab: true }).tabLine).toBe("Its open tab will be closed first.");
    expect(plan().tabLine).toBeNull();
  });
});

describe("removalRefusalMessage", () => {
  it("never returns raw git text and covers the reasons the spec names", () => {
    expect(removalRefusalMessage({ ok: false, reason: "locked", lockReason: "why", message: "x" })).toBe("Locked: why. Unlock it with git worktree unlock before removing.");
    expect(removalRefusalMessage({ ok: false, reason: "inUse", message: "x" })).toBe("Close programs using this folder and try again.");
    for (const reason of ["unsafeTarget", "walkFailed", "unsupported", "main", "symlinkTarget", "notAWorktree", "missing", "notFound", "pathChanged"] as const) {
      expect(removalRefusalMessage({ ok: false, reason, message: "RAW" } as never)).not.toContain("RAW");
    }
  });
});
