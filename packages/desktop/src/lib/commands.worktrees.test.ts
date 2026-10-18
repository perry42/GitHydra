// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it, vi } from "vitest";
import { getCommands, type CommandContext } from "./commands";

// Strings copied from specs/worktrees.md FR-607 (AC19).
const TITLES = [
  "Worktree: Create new branch in a new worktree",
  "Worktree: Create from branch...",
  "Worktree: Open...",
  "Worktree: Remove...",
];

function ctx(worktrees: CommandContext["worktrees"]): CommandContext {
  return { tabs: [], activeTabId: null, repoOpen: true, selectionCommands: {}, editCommands: {}, worktrees } as unknown as CommandContext;
}

describe("worktree palette commands (FR-607, AC19)", () => {
  const handlers = () => ({ createNew: vi.fn(), createFromBranch: vi.fn(), open: vi.fn(), remove: vi.fn() });

  it("registers exactly the four titles from the spec", () => {
    const labels = getCommands(ctx({ available: true, newBranchDisabledReason: null, ...handlers() })).map((c) => c.label);
    for (const t of TITLES) expect(labels).toContain(t);
    expect(labels.filter((l) => l.startsWith("Worktree:"))).toEqual(TITLES);
  });

  it("each command runs its own handler", () => {
    const h = handlers();
    const c = ctx({ available: true, newBranchDisabledReason: null, ...h });
    const run = (title: string) => getCommands(c).find((x) => x.label === title)!.run(c);
    run(TITLES[0]!);
    run(TITLES[1]!);
    run(TITLES[2]!);
    run(TITLES[3]!);
    expect([h.createNew, h.createFromBranch, h.open, h.remove].map((f) => f.mock.calls.length)).toEqual([1, 1, 1, 1]);
  });

  it("is hidden when worktrees are unavailable or the context predates the feature", () => {
    for (const w of [undefined, { available: false, newBranchDisabledReason: null, ...handlers() }]) {
      const c = ctx(w);
      expect(getCommands(c).filter((x) => x.label.startsWith("Worktree:") && x.isAvailable(c))).toHaveLength(0);
    }
  });

  it("'Create new branch in a new worktree' is listed with a reason when the repository has no commit to start from", () => {
    const c = ctx({ available: true, newBranchDisabledReason: "No commit.", ...handlers() });
    const cmd = getCommands(c).find((x) => x.label === TITLES[0])!;
    expect(cmd.isAvailable(c)).toBe(true);
    expect(cmd.disabledReason?.(c)).toBe("No commit.");
  });
});
