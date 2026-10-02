// SPDX-License-Identifier: GPL-3.0-or-later
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { CombinedDiffHunk, FileDiffResult } from "@githydra/git-core";
import { DiffView, type CombinedDiffControls } from "./DiffView";

// specs/hunk-line-staging.md FR-453/FR-477/FR-478/FR-483/FR-453: the checkbox (combined) diff.
// Hunk 0: ctx, -old (unstaged), +new a (staged), +new b (unstaged), ctx  => mixed.
// Hunk 1: ctx, -gone (unstaged), ctx                                       => none.
type L = CombinedDiffHunk["lines"][number];
const line = (l: Partial<L> & Pick<L, "type" | "content">): L => ({
  oldLineNumber: null,
  newLineNumber: null,
  staged: false,
  discardable: false,
  ...l,
});

function hunks(): CombinedDiffHunk[] {
  return [
    {
      header: "@@ -1,3 +1,4 @@",
      oldStart: 1,
      oldLines: 3,
      newStart: 1,
      newLines: 4,
      stagedState: "some",
      lines: [
        line({ type: "context", content: "keep", oldLineNumber: 1, newLineNumber: 1 }),
        line({ type: "remove", content: "old", oldLineNumber: 2, discardable: true }),
        line({ type: "add", content: "new a", newLineNumber: 2, staged: true }),
        line({ type: "add", content: "new b", newLineNumber: 3, discardable: true }),
        line({ type: "context", content: "tail", oldLineNumber: 3, newLineNumber: 4 }),
      ],
    },
    {
      header: "@@ -20,3 +21,3 @@",
      oldStart: 20,
      oldLines: 3,
      newStart: 21,
      newLines: 3,
      stagedState: "none",
      lines: [
        line({ type: "context", content: "c", oldLineNumber: 20, newLineNumber: 21 }),
        line({ type: "remove", content: "gone", oldLineNumber: 21, discardable: true }),
        line({ type: "context", content: "d", oldLineNumber: 22, newLineNumber: 22 }),
      ],
    },
  ];
}

function controls(overrides: Partial<CombinedDiffControls> = {}): CombinedDiffControls {
  return {
    hunks: hunks(),
    busy: false,
    onToggleLines: vi.fn(),
    onToggleHunk: vi.fn(),
    onDiscardLines: vi.fn(),
    onDiscardHunk: vi.fn(),
    ...overrides,
  };
}

const props = { fileLabel: "a.ts", loading: false, errorMessage: null, result: null } as const;
const row = (name: string) => screen.getByRole("checkbox", { name: new RegExp(`^${name}(:|$)`) });
const diffGroup = () => screen.getByRole("group", { name: "Changed lines" });

describe("DiffView combined (checkbox) mode", () => {
  it("gives every changed line a checkbox, context lines none, and ticks exactly the staged lines (FR-453)", () => {
    render(<DiffView {...props} combined={controls()} />);
    expect(row("Removed line 2")).toHaveAttribute("aria-checked", "false");
    expect(row("Added line 2")).toHaveAttribute("aria-checked", "true");
    expect(row("Added line 3")).toHaveAttribute("aria-checked", "false");
    // 3 + 1 line checkboxes plus 2 hunk checkboxes; no checkbox on context rows.
    expect(screen.getAllByRole("checkbox")).toHaveLength(4 + 2);
    expect(document.querySelectorAll(".gh-diff-view__line--context [role=checkbox]")).toHaveLength(0);
  });

  it("dims unticked changed lines with a class (not only color) and ticks via a drawn box", () => {
    render(<DiffView {...props} combined={controls()} />);
    expect(row("Added line 2").className).not.toContain("--unstaged");
    expect(row("Added line 3").className).toContain("gh-diff-view__line--unstaged");
    expect(row("Added line 2").querySelector(".gh-diff-view__cb--on")).not.toBeNull();
    expect(row("Added line 3").querySelector(".gh-diff-view__cb--on")).toBeNull();
  });

  it("hunk checkbox reports aria-checked mixed / false / true from the lines (FR-477, AC15)", () => {
    const h = hunks();
    h[1]!.lines[1] = { ...h[1]!.lines[1]!, staged: true, discardable: false };
    render(<DiffView {...props} combined={controls({ hunks: h })} />);
    expect(screen.getByRole("checkbox", { name: "Hunk 1 of 2" })).toHaveAttribute("aria-checked", "mixed");
    expect(screen.getByRole("checkbox", { name: "Hunk 2 of 2" })).toHaveAttribute("aria-checked", "true");
    const none = hunks();
    render(<DiffView {...props} fileLabel="b.ts" combined={controls({ hunks: none })} />);
    expect(screen.getAllByRole("checkbox", { name: "Hunk 2 of 2" })[1]).toHaveAttribute("aria-checked", "false");
  });

  it("clicking a line's checkbox toggles just that line to the opposite state, immediately (FR-453)", () => {
    const c = controls();
    render(<DiffView {...props} combined={c} />);
    fireEvent.click(row("Added line 3").querySelector(".gh-diff-view__gutter")!);
    expect(c.onToggleLines).toHaveBeenLastCalledWith([{ hunkIndex: 0, lineIndex: 3 }], "stage", "line 3");
    fireEvent.click(row("Added line 2").querySelector(".gh-diff-view__gutter")!);
    expect(c.onToggleLines).toHaveBeenLastCalledWith([{ hunkIndex: 0, lineIndex: 2 }], "unstage", "line 2");
  });

  it("Shift-click toggles the range from the last-clicked line as ONE call, skipping context, to the opposite of the clicked row (AC5)", () => {
    const c = controls();
    render(<DiffView {...props} combined={c} />);
    fireEvent.click(row("Removed line 2").querySelector(".gh-diff-view__gutter")!);
    fireEvent.click(row("Removed line 21").querySelector(".gh-diff-view__gutter")!, { shiftKey: true });
    // changed rows from hunk 0 line 1 .. hunk 1 line 1: -old, +new a, +new b, -gone (context rows skipped)
    expect(c.onToggleLines).toHaveBeenLastCalledWith(
      [
        { hunkIndex: 0, lineIndex: 1 },
        { hunkIndex: 0, lineIndex: 2 },
        { hunkIndex: 0, lineIndex: 3 },
        { hunkIndex: 1, lineIndex: 1 },
      ],
      "stage",
      "4 lines",
    );
    expect(c.onToggleLines).toHaveBeenCalledTimes(2);
  });

  it("hunk checkbox toggles its hunk; Discard sits on the header's right side, not on the checkbox (FR-477/478)", () => {
    const c = controls();
    render(<DiffView {...props} combined={c} />);
    const box = screen.getByRole("checkbox", { name: "Hunk 1 of 2" });
    fireEvent.click(box);
    expect(c.onToggleHunk).toHaveBeenCalledWith(0);
    expect(within(box).queryByText(/discard/i)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Discard hunk 2 of 2" }));
    expect(c.onDiscardHunk).toHaveBeenCalledWith(1);
  });

  it("hunk checkbox is a tab stop toggled with Space (FR-483)", async () => {
    const user = userEvent.setup();
    const c = controls();
    render(<DiffView {...props} combined={c} />);
    await user.tab(); // the diff itself
    expect(diffGroup()).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("checkbox", { name: "Hunk 1 of 2" })).toHaveFocus();
    await user.keyboard(" ");
    expect(c.onToggleHunk).toHaveBeenCalledWith(0);
  });

  it("offers no Discard on a fully staged hunk (nothing discardable)", () => {
    const h = hunks();
    h[1]!.lines[1] = { ...h[1]!.lines[1]!, staged: true, discardable: false };
    render(<DiffView {...props} combined={controls({ hunks: h })} />);
    expect(screen.queryByRole("button", { name: "Discard hunk 2 of 2" })).toBeNull();
    expect(screen.getByRole("button", { name: "Discard hunk 1 of 2" })).toBeInTheDocument();
  });

  it("removes the old select-then-act UI: no gutter buttons, selection bar, Stage-N-lines or hint", () => {
    render(<DiffView {...props} combined={controls()} />);
    expect(document.querySelector("button[data-gutter]")).toBeNull();
    expect(screen.queryByRole("button", { name: /^Stage \d+ lines?$/ })).toBeNull();
    expect(screen.queryByText(/selected$/)).toBeNull();
    expect(screen.queryByRole("button", { name: /^Stage hunk/ })).toBeNull();
  });

  describe("keyboard (FR-483)", () => {
    it("Up/Down moves the cursor over changed rows only, skipping context, via aria-activedescendant", async () => {
      const user = userEvent.setup();
      render(<DiffView {...props} combined={controls()} />);
      diffGroup().focus();
      await user.keyboard("{ArrowDown}");
      expect(diffGroup().getAttribute("aria-activedescendant")).toBe(row("Removed line 2").id);
      await user.keyboard("{ArrowDown}{ArrowDown}{ArrowDown}");
      expect(diffGroup().getAttribute("aria-activedescendant")).toBe(row("Removed line 21").id); // jumped the context rows
      expect(row("Removed line 21").className).toContain("gh-diff-view__line--cursor");
      await user.keyboard("{ArrowDown}"); // already last
      expect(diffGroup().getAttribute("aria-activedescendant")).toBe(row("Removed line 21").id);
      await user.keyboard("{ArrowUp}");
      expect(diffGroup().getAttribute("aria-activedescendant")).toBe(row("Added line 3").id);
    });

    it("Space toggles the cursor row", async () => {
      const user = userEvent.setup();
      const c = controls();
      render(<DiffView {...props} combined={c} />);
      diffGroup().focus();
      await user.keyboard("{ArrowDown}{ArrowDown} ");
      expect(c.onToggleLines).toHaveBeenCalledWith([{ hunkIndex: 0, lineIndex: 2 }], "unstage", "line 2");
    });

    it("Shift+Down extends a range; Space toggles it as one operation to the opposite of the anchor row; Esc clears the anchor", async () => {
      const user = userEvent.setup();
      const c = controls();
      render(<DiffView {...props} combined={c} />);
      diffGroup().focus();
      await user.keyboard("{ArrowDown}{Shift>}{ArrowDown}{ArrowDown}{/Shift}");
      expect(row("Removed line 2").className).toContain("gh-diff-view__line--in-range");
      expect(row("Added line 2").className).toContain("gh-diff-view__line--in-range");
      await user.keyboard(" ");
      // anchor = -old (unstaged) => stage all three, a single call
      expect(c.onToggleLines).toHaveBeenCalledTimes(1);
      expect(c.onToggleLines).toHaveBeenCalledWith(
        [
          { hunkIndex: 0, lineIndex: 1 },
          { hunkIndex: 0, lineIndex: 2 },
          { hunkIndex: 0, lineIndex: 3 },
        ],
        "stage",
        "3 lines",
      );
      await user.keyboard("{Escape}");
      expect(document.querySelector(".gh-diff-view__line--in-range")).toBeNull();
      await user.keyboard(" "); // back to a single-row toggle on the cursor
      expect(c.onToggleLines).toHaveBeenLastCalledWith([{ hunkIndex: 0, lineIndex: 3 }], "stage", "line 3");
    });

    it("marks the cursor with more than color (outline + bar class) and keeps it across an in-place reload", async () => {
      const user = userEvent.setup();
      const c = controls();
      const { rerender } = render(<DiffView {...props} combined={c} />);
      diffGroup().focus();
      await user.keyboard("{ArrowDown}{ArrowDown}");
      const reloaded = hunks();
      reloaded[0]!.lines[1] = { ...reloaded[0]!.lines[1]!, staged: true };
      rerender(<DiffView {...props} combined={{ ...c, hunks: reloaded }} />);
      expect(row("Added line 2").className).toContain("gh-diff-view__line--cursor");
      expect(row("Removed line 2")).toHaveAttribute("aria-checked", "true");
    });
  });

  describe("context menu (FR-478)", () => {
    it("on an unstaged line offers Stage and Discard; Discard routes to onDiscardLines with discardable refs only", () => {
      const c = controls();
      render(<DiffView {...props} combined={c} />);
      fireEvent.contextMenu(row("Added line 3"));
      const menu = screen.getByRole("menu");
      fireEvent.click(within(menu).getByRole("menuitem", { name: "Stage 1 line" }));
      expect(c.onToggleLines).toHaveBeenCalledWith([{ hunkIndex: 0, lineIndex: 3 }], "stage", "1 line");
      fireEvent.contextMenu(row("Added line 3"));
      fireEvent.click(within(screen.getByRole("menu")).getByRole("menuitem", { name: "Discard 1 line" }));
      expect(c.onDiscardLines).toHaveBeenCalledWith([{ hunkIndex: 0, lineIndex: 3 }]);
    });

    it("on a staged line offers Unstage and NO Discard", () => {
      render(<DiffView {...props} combined={controls()} />);
      fireEvent.contextMenu(row("Added line 2"));
      const menu = screen.getByRole("menu");
      expect(within(menu).getByRole("menuitem", { name: "Unstage 1 line" })).toBeInTheDocument();
      expect(within(menu).queryByRole("menuitem", { name: /discard/i })).toBeNull();
    });

    it("on a hunk header offers Stage hunk / Discard hunk", () => {
      const c = controls();
      render(<DiffView {...props} combined={c} />);
      fireEvent.contextMenu(document.querySelector("[data-hunk-header='1']")!);
      fireEvent.click(within(screen.getByRole("menu")).getByRole("menuitem", { name: "Stage hunk" }));
      expect(c.onToggleHunk).toHaveBeenCalledWith(1);
      fireEvent.contextMenu(document.querySelector("[data-hunk-header='1']")!);
      fireEvent.click(within(screen.getByRole("menu")).getByRole("menuitem", { name: "Discard hunk" }));
      expect(c.onDiscardHunk).toHaveBeenCalledWith(1);
    });

    it("right-click inside a Shift range acts on the whole range", async () => {
      const user = userEvent.setup();
      const c = controls();
      render(<DiffView {...props} combined={c} />);
      diffGroup().focus();
      await user.keyboard("{ArrowDown}{Shift>}{ArrowDown}{/Shift}");
      fireEvent.contextMenu(row("Added line 2"));
      expect(within(screen.getByRole("menu")).getByRole("menuitem", { name: "Stage 2 lines" })).toBeInTheDocument();
    });

    it("reports the menu open/closed so global keybindings can defer (FR-221)", () => {
      const onContextMenuOpenChange = vi.fn();
      render(<DiffView {...props} combined={controls({ onContextMenuOpenChange })} />);
      fireEvent.contextMenu(row("Added line 3"));
      expect(onContextMenuOpenChange).toHaveBeenLastCalledWith(true);
      fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
      expect(onContextMenuOpenChange).toHaveBeenLastCalledWith(false);
    });
  });

  it("reports the hunk under the cursor / focused checkbox for the Command Palette (FR-483)", async () => {
    const user = userEvent.setup();
    const onActiveHunkChange = vi.fn();
    render(<DiffView {...props} combined={controls({ onActiveHunkChange })} />);
    diffGroup().focus();
    await user.keyboard("{ArrowDown}");
    expect(onActiveHunkChange).toHaveBeenLastCalledWith(0);
    fireEvent.focus(screen.getByRole("checkbox", { name: "Hunk 2 of 2" }));
    expect(onActiveHunkChange).toHaveBeenLastCalledWith(1);
  });

  it("sticky hunk header: each header is a direct, class-addressable child of its own hunk", () => {
    render(<DiffView {...props} combined={controls()} />);
    const headers = document.querySelectorAll(".gh-diff-view__hunk > .gh-diff-view__hunk-header");
    expect(headers).toHaveLength(2);
  });

  describe("announcements and notes", () => {
    it("announces results in a polite live region, and re-announces an identical message", () => {
      function Host() {
        const [msg, setMsg] = useState<string | null>("Staged 1 line");
        return (
          <>
            <button onClick={() => setMsg(null)}>reset</button>
            <button onClick={() => setMsg("Staged 1 line")}>again</button>
            <DiffView {...props} combined={controls()} announcement={msg} />
          </>
        );
      }
      render(<Host />);
      const region = screen.getByRole("status");
      expect(region).toHaveAttribute("aria-live", "polite");
      expect(region).toHaveTextContent("Staged 1 line");
      const first = region.textContent;
      act(() => screen.getByText("again").click());
      expect(region.textContent).toBe(first); // unchanged prop: nothing new to say
      act(() => screen.getByText("reset").click());
      expect(region).toHaveTextContent("");
      act(() => screen.getByText("again").click());
      expect(region).toHaveTextContent("Staged 1 line");
    });

    it("separate mode with a note shows one neutral line beside the plain diff and no checkboxes (FR-481)", () => {
      const result: FileDiffResult = {
        status: "ok",
        isBinary: false,
        hunks: [
          {
            header: "@@ -1 +1 @@",
            oldStart: 1,
            oldLines: 1,
            newStart: 1,
            newLines: 1,
            lines: [{ type: "add", content: "x", oldLineNumber: null, newLineNumber: 1 }],
          },
        ],
      };
      render(<DiffView {...props} result={result} separateNote="Line-level staging unavailable for this file." />);
      expect(screen.getByRole("status")).toHaveTextContent("Line-level staging unavailable for this file.");
      expect(screen.queryAllByRole("checkbox")).toHaveLength(0);
      expect(screen.queryByRole("button", { name: /show details/i })).toBeNull();
    });
  });
});

// FR-453/FR-483 (revised): one Shift-range rule for mouse and keyboard - tick all unless all already ticked.
describe("uniform Shift-range rule", () => {
  function sixLines(staged: boolean[]): CombinedDiffHunk[] {
    return [
      {
        header: "@@ -1,0 +1,6 @@",
        oldStart: 1,
        oldLines: 0,
        newStart: 1,
        newLines: 6,
        stagedState: "none",
        lines: staged.map((s, i) => line({ type: "add", content: `l${i + 1}`, newLineNumber: i + 1, staged: s, discardable: !s })),
      },
    ];
  }
  // Applies toggles to its own state, like the optimistic update in useChangesPanel.
  function Harness({ initial }: { initial: boolean[] }) {
    const [st, setSt] = useState(initial);
    const c = controls({
      hunks: sixLines(st),
      onToggleLines: (lines, target) =>
        setSt((prev) => prev.map((v, i) => (lines.some((l) => l.lineIndex === i) ? target === "stage" : v))),
    });
    return <DiffView {...props} combined={c} />;
  }
  const ticked = () => [1, 2, 3, 4, 5, 6].map((n) => row(`Added line ${n}`).getAttribute("aria-checked"));
  const gutter = (n: number) => row(`Added line ${n}`).querySelector(".gh-diff-view__gutter")!;

  it("tick row 2 then Shift-click row 6 leaves rows 2-6 ticked", () => {
    render(<Harness initial={[false, false, false, false, false, false]} />);
    fireEvent.click(gutter(2));
    fireEvent.click(gutter(6), { shiftKey: true });
    expect(ticked()).toEqual(["false", "true", "true", "true", "true", "true"]);
  });

  it("keyboard: tick a row, Shift+Down x4, Space leaves them all ticked", async () => {
    const user = userEvent.setup();
    render(<Harness initial={[false, false, false, false, false, false]} />);
    diffGroup().focus();
    await user.keyboard("{ArrowDown}{ArrowDown} "); // row 2 ticked
    await user.keyboard("{Shift>}{ArrowDown}{ArrowDown}{ArrowDown}{ArrowDown}{/Shift} ");
    expect(ticked()).toEqual(["false", "true", "true", "true", "true", "true"]);
  });

  it("a range whose lines are all already ticked unticks them all", () => {
    render(<Harness initial={[true, true, true, true, true, true]} />);
    fireEvent.click(gutter(2)); // single click unticks 2 and anchors
    fireEvent.click(gutter(2)); // ticks again, anchor 2
    fireEvent.click(gutter(5), { shiftKey: true });
    expect(ticked()).toEqual(["true", "false", "false", "false", "false", "true"]);
  });

  it("a mixed range ticks every line in it", () => {
    render(<Harness initial={[false, true, false, true, false, false]} />);
    fireEvent.click(gutter(1));
    fireEvent.click(gutter(4), { shiftKey: true }); // range 1-4: [ticked-by-click, t, f, t] -> mixed
    expect(ticked().slice(0, 4)).toEqual(["true", "true", "true", "true"]);
  });
});
