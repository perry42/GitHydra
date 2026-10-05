// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { buildRows } from "./fileSelection";
import { computeSelectionCommands } from "./selectionCommands";

const rows = buildRows(
  {
    staged: [{ path: "s", category: "staged", status: "modified" }],
    unstaged: [{ path: "u", category: "unstaged", status: "modified" }],
    untracked: [],
    conflicted: [{ path: "c", category: "conflicted", status: "unmerged" }],
  },
  new Set(),
);
const pick = (...paths: string[]) => rows.filter((r) => paths.includes(r.path));

describe("computeSelectionCommands (FR-504)", () => {
  it("disables every selection command with a reason when nothing is selected", () => {
    const r = computeSelectionCommands(rows, [], true);
    expect(r.stage).toMatch(/select files/i);
    expect(r.unstage).toMatch(/select files/i);
    expect(r.discard).toMatch(/select files/i);
    expect(r.ignore).toMatch(/select files/i);
    expect(r.selectAll).toBeNull();
    expect(r.discardAll).toBeNull();
  });

  it("enables what applies and explains what does not", () => {
    const r = computeSelectionCommands(rows, pick("u"), true);
    expect(r.stage).toBeNull();
    expect(r.unstage).toMatch(/not staged/i);
    expect(r.discard).toBeNull();
    expect(r.ignore).toBeNull();
  });

  it("a conflicted-only selection can do nothing", () => {
    const r = computeSelectionCommands(rows, pick("c"), true);
    expect(r.stage).toMatch(/conflict/i);
    expect(r.ignore).toMatch(/conflict/i);
  });

  it("explains a bare repository for every command", () => {
    const r = computeSelectionCommands([], [], false);
    expect(Object.values(r).every((v) => /no working directory/i.test(v ?? ""))).toBe(true);
  });

  it("Discard all changes needs something discardable", () => {
    expect(computeSelectionCommands(pick("s", "c"), [], true).discardAll).toMatch(/nothing|no unstaged/i);
  });
});
