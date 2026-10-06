// SPDX-License-Identifier: GPL-3.0-or-later
// ROADMAP.md "Changes list with thousands of files": the list mounts only the rows near the viewport, and every
// selection/keyboard behaviour keeps acting on the full file set (specs/ignore-and-multiselect.md FR-505).
import { describe, expect, it } from "vitest";
import { act, fireEvent, render } from "@testing-library/react";
import type { WorkingDirectoryChanges } from "@githydra/git-core";
import { ChangesPanel } from "./ChangesPanel";
import { makeMockGitHydra } from "../../test/mockGitHydra";

const N = 1000;
const changes: WorkingDirectoryChanges = {
  staged: [],
  unstaged: Array.from({ length: N }, (_, i) => ({ path: `d/file-${i}.ts`, status: "modified" as const, category: "unstaged" as const })),
  untracked: [],
  conflicted: [],
};

function renderPanel() {
  const api = makeMockGitHydra({ workingDirectoryChanges: changes });
  return render(
    <ChangesPanel api={api} changes={changes} onClose={() => {}} onWorkingDirChanged={() => {}} onCommitCreated={() => {}} />,
  );
}

const scroller = () => document.querySelector<HTMLElement>(".gh-changes-panel__scroll")!;
const rowKeys = () => [...document.querySelectorAll<HTMLElement>("[data-row-key]")].map((b) => b.dataset.rowKey!);
const btn = (i: number) => document.querySelector<HTMLElement>(`[data-row-key="unstaged:d/file-${i}.ts"]`);

// jsdom has no layout: keep scrollTop settable and make the list's rect slide up as the scroller scrolls, like a browser.
function emulateScrolling() {
  const el = scroller();
  let top = 0;
  Object.defineProperty(el, "scrollTop", { configurable: true, get: () => top, set: (v: number) => void (top = v) });
  for (const grid of document.querySelectorAll<HTMLElement>('[role="grid"]')) {
    grid.getBoundingClientRect = () => ({ top: -top, bottom: 0, left: 0, right: 0, width: 0, height: 0, x: 0, y: -top, toJSON: () => ({}) });
  }
}

function scrollTo(top: number) {
  emulateScrolling();
  scroller().scrollTop = top;
  act(() => void fireEvent.scroll(scroller()));
}

describe("Changes list windowing", () => {
  it("mounts a screenful, keeps the full height and the true count for assistive tech", () => {
    renderPanel();
    expect(rowKeys().length).toBeGreaterThan(0);
    expect(rowKeys().length).toBeLessThan(100);
    const grid = document.querySelector<HTMLElement>('[role="grid"]')!;
    expect(grid).toHaveAttribute("aria-rowcount", String(N));
    const first = grid.querySelector<HTMLElement>('[role="row"]')!;
    expect(first).toHaveAttribute("aria-rowindex", "1");
    // Padding stands in for the rows that are not mounted, so the scrollbar is the real length.
    const padded = parseFloat(grid.style.paddingTop || "0") + parseFloat(grid.style.paddingBottom || "0");
    expect(padded + rowKeys().length * 28).toBe(N * 28);
  });

  it("swaps in the rows at the new scroll position", () => {
    renderPanel();
    expect(btn(0)).not.toBeNull();
    scrollTo(500 * 28 + 100);
    expect(btn(0)).toBeNull();
    expect(btn(500)).not.toBeNull();
    const row = btn(500)!.closest('[role="row"]')!;
    expect(row).toHaveAttribute("aria-rowindex", "501");
  });

  it("Ctrl+A selects the whole section, not just the mounted rows", () => {
    renderPanel();
    fireEvent.keyDown(btn(0)!, { key: "a", ctrlKey: true });
    expect(document.body.textContent).toContain(`${N} selected`);
  });

  it("Shift+click selects a range that reaches rows that were never mounted together", () => {
    renderPanel();
    fireEvent.click(btn(0)!);
    scrollTo(900 * 28);
    fireEvent.click(btn(900)!, { shiftKey: true });
    expect(document.body.textContent).toContain("901 selected");
  });

  it("End focuses the last row even though it is not mounted", () => {
    renderPanel();
    emulateScrolling();
    fireEvent.keyDown(btn(0)!, { key: "End" });
    expect(btn(N - 1)).not.toBeNull();
    expect(document.activeElement).toBe(btn(N - 1));
  });

  it("ArrowDown from the last mounted row moves focus to the next one", () => {
    renderPanel();
    emulateScrolling();
    const last = Math.max(...rowKeys().map((k) => Number(/file-(\d+)/.exec(k)![1])));
    btn(last)!.focus();
    fireEvent.keyDown(btn(last)!, { key: "ArrowDown" });
    expect(document.activeElement).toBe(btn(last + 1));
  });
});
