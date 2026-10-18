// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it, vi } from "vitest";
import { getCommands, type CommandContext } from "./commands";

/** specs/external-programs.md FR-625, AC8: exact titles, the CLAUDE.md palette convention. */
function ctx(over: Partial<CommandContext>): CommandContext {
  return { tabs: [], activeTabId: null, repoOpen: true, selectionCommands: {}, editCommands: {}, ...over } as unknown as CommandContext;
}

describe("external program palette commands (FR-625)", () => {
  const handlers = () => ({ manage: vi.fn(), openRepoDisabledReason: null as string | null, openRepo: vi.fn() });

  it("registers 'Manage external programs' and 'Open repository in external program' verbatim", () => {
    const labels = getCommands(ctx({ externalPrograms: handlers() })).map((c) => c.label);
    expect(labels).toContain("Manage external programs");
    expect(labels).toContain("Open repository in external program");
  });

  it("'Manage external programs' needs no repository; 'Open repository...' does", () => {
    const c = ctx({ repoOpen: false, externalPrograms: handlers() });
    const byTitle = (t: string) => getCommands(c).find((x) => x.label === t)!;
    expect(byTitle("Manage external programs").isAvailable(c)).toBe(true);
    expect(byTitle("Open repository in external program").isAvailable(c)).toBe(false);
  });

  it("each command runs its own handler, and a bare repository lists the open entry with its reason", () => {
    const h = handlers();
    const c = ctx({ externalPrograms: { ...h, openRepoDisabledReason: "Open a repository with a working folder first." } });
    getCommands(c).find((x) => x.label === "Manage external programs")!.run(c);
    getCommands(c).find((x) => x.label === "Open repository in external program")!.run(c);
    expect(h.manage).toHaveBeenCalledTimes(1);
    expect(h.openRepo).toHaveBeenCalledTimes(1);
    const open = getCommands(c).find((x) => x.label === "Open repository in external program")!;
    expect(open.disabledReason?.(c)).toBe("Open a repository with a working folder first.");
  });

  it("is hidden for a context that predates the feature", () => {
    const c = ctx({});
    for (const t of ["Manage external programs", "Open repository in external program"]) {
      expect(getCommands(c).find((x) => x.label === t)!.isAvailable(c)).toBe(false);
    }
  });
});
