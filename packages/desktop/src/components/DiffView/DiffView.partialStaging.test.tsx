// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import type { FileDiffResult, PartialStagingEligibility } from "@githydra/git-core";
import { DiffView, type PartialStagingControls } from "./DiffView";

// specs/hunk-line-staging.md FR-453. Hunk 0: ctx, -, +, +, ctx. Hunk 1: ctx, -, ctx.
type TextDiff = Extract<FileDiffResult, { status: "ok" }>;

function diff(partialStaging: PartialStagingEligibility = { eligible: true }): TextDiff {
  return {
    status: "ok",
    isBinary: false,
    fingerprint: "fp-1",
    partialStaging,
    hunks: [
      {
        header: "@@ -1,3 +1,4 @@",
        oldStart: 1,
        oldLines: 3,
        newStart: 1,
        newLines: 4,
        lines: [
          { type: "context", content: "keep", oldLineNumber: 1, newLineNumber: 1 },
          { type: "remove", content: "old", oldLineNumber: 2, newLineNumber: null },
          { type: "add", content: "new a", oldLineNumber: null, newLineNumber: 2 },
          { type: "add", content: "new b", oldLineNumber: null, newLineNumber: 3 },
          { type: "context", content: "tail", oldLineNumber: 3, newLineNumber: 4 },
        ],
      },
      {
        header: "@@ -20,3 +21,3 @@",
        oldStart: 20,
        oldLines: 3,
        newStart: 21,
        newLines: 3,
        lines: [
          { type: "context", content: "c", oldLineNumber: 20, newLineNumber: 21 },
          { type: "remove", content: "gone", oldLineNumber: 21, newLineNumber: null },
          { type: "context", content: "d", oldLineNumber: 22, newLineNumber: 22 },
        ],
      },
    ],
  };
}

function renderDiff(result: FileDiffResult, controls?: Partial<PartialStagingControls>) {
  const onAction = vi.fn();
  const utils = render(
    <DiffView
      fileLabel="a.ts"
      loading={false}
      errorMessage={null}
      result={result}
      partialStaging={controls === undefined ? undefined : { side: "unstaged", busy: false, onAction, ...controls }}
    />,
  );
  return { ...utils, onAction };
}

const gutter = (name: string) => screen.getByRole("button", { name });

describe("DiffView hunk/line controls", () => {
  it("shows Stage hunk (always) and Discard hunk on each hunk header of an unstaged, eligible diff", () => {
    renderDiff(diff(), {});
    expect(screen.getByRole("button", { name: "Stage hunk 1 of 2" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Stage hunk 2 of 2" })).toBeInTheDocument();
    const discard = screen.getByRole("button", { name: "Discard hunk 1 of 2" });
    // Hover/focus reveal is pure CSS; it must stay a real, focusable button (not display:none).
    expect(discard).toHaveClass("gh-diff-view__hunk-btn--discard");
    expect(discard).not.toBeDisabled();
    expect(screen.queryByRole("button", { name: /^unstage hunk/i })).not.toBeInTheDocument();
  });

  it("on the staged side shows Unstage hunk and never Discard", () => {
    renderDiff(diff(), { side: "staged" });
    expect(screen.getByRole("button", { name: "Unstage hunk 1 of 2" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /discard/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^stage hunk/i })).not.toBeInTheDocument();
  });

  it("renders no controls when the diff is ineligible, has no eligibility info, or no controls are wired", () => {
    const ineligible = renderDiff(diff({ eligible: false, reason: "renamed" }), {});
    expect(ineligible.container.querySelector(".gh-diff-view__hunk-btn")).toBeNull();
    expect(ineligible.container.querySelector("[data-gutter]")).toBeNull();
    ineligible.unmount();

    const unknown = renderDiff({ ...diff(), partialStaging: undefined }, {});
    expect(unknown.container.querySelector(".gh-diff-view__hunk-btn")).toBeNull();
    unknown.unmount();

    const readOnly = renderDiff(diff());
    expect(readOnly.container.querySelector(".gh-diff-view__hunk-btn")).toBeNull();
    // The pre-existing markup is untouched: the old header div carries the text directly.
    expect(screen.getByText("@@ -1,3 +1,4 @@")).toHaveClass("gh-diff-view__hunk-header");
  });

  it("Stage hunk reports the whole hunk (no lineIndexes) with its changed-line count", () => {
    const { onAction } = renderDiff(diff(), {});
    fireEvent.click(screen.getByRole("button", { name: "Stage hunk 1 of 2" }));
    expect(onAction).toHaveBeenCalledWith("stage", [{ hunkIndex: 0 }], { hunks: 1, lines: 3 });
  });

  it("Discard hunk and Unstage hunk report their own actions", () => {
    const first = renderDiff(diff(), {});
    fireEvent.click(screen.getByRole("button", { name: "Discard hunk 2 of 2" }));
    expect(first.onAction).toHaveBeenCalledWith("discard", [{ hunkIndex: 1 }], { hunks: 1, lines: 1 });
    first.unmount();

    const second = renderDiff(diff(), { side: "staged" });
    fireEvent.click(screen.getByRole("button", { name: "Unstage hunk 1 of 2" }));
    expect(second.onAction).toHaveBeenCalledWith("unstage", [{ hunkIndex: 0 }], { hunks: 1, lines: 3 });
  });

  it("ignores activation while busy but keeps the control focusable (aria-disabled)", () => {
    const { onAction } = renderDiff(diff(), { busy: true });
    const btn = screen.getByRole("button", { name: "Stage hunk 1 of 2" });
    expect(btn).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(btn);
    expect(onAction).not.toHaveBeenCalled();
  });

  it("only changed lines get a gutter control; context lines do not", () => {
    const { container } = renderDiff(diff(), {});
    expect(container.querySelectorAll("button[data-gutter]")).toHaveLength(4);
    expect(gutter("Select removed line 2")).toBeInTheDocument();
    expect(gutter("Select added line 3")).toBeInTheDocument();
  });

  it("clicking a gutter selects one line and shows a floating 'Stage 1 line' bar", () => {
    const { onAction } = renderDiff(diff(), {});
    fireEvent.mouseDown(gutter("Select added line 2"));
    expect(gutter("Select added line 2")).toHaveAttribute("aria-pressed", "true");
    const bar = screen.getByRole("toolbar", { name: /1 selected line/i });
    fireEvent.click(within(bar).getByRole("button", { name: "Stage 1 line" }));
    // Hunk 0 line indexes: 1 = '-' old, 2 = '+' new a, 3 = '+' new b.
    expect(onAction).toHaveBeenCalledWith("stage", [{ hunkIndex: 0, lineIndexes: [2] }], { hunks: 0, lines: 1 });
  });

  it("shift-click extends the selection and the bar counts lines, skipping context lines", () => {
    const { onAction } = renderDiff(diff(), {});
    fireEvent.mouseDown(gutter("Select removed line 2"));
    fireEvent.mouseUp(window);
    fireEvent.mouseDown(gutter("Select added line 3"), { shiftKey: true });
    const bar = screen.getByRole("toolbar", { name: /3 selected lines/i });
    fireEvent.click(within(bar).getByRole("button", { name: "Discard 3 lines" }));
    expect(onAction).toHaveBeenCalledWith("discard", [{ hunkIndex: 0, lineIndexes: [1, 2, 3] }], { hunks: 0, lines: 3 });
  });

  it("click-drag across lines selects the range; dragging over context lines does not select them", () => {
    const { container, onAction } = renderDiff(diff(), {});
    fireEvent.mouseDown(gutter("Select removed line 2"));
    const lines = container.querySelectorAll(".gh-diff-view__hunk")[0]!.querySelectorAll(".gh-diff-view__line");
    fireEvent.mouseEnter(lines[2]!);
    fireEvent.mouseEnter(lines[4]!); // trailing context line: in range, never selectable
    fireEvent.mouseUp(window);
    fireEvent.click(screen.getByRole("button", { name: "Stage 3 lines" }));
    expect(onAction).toHaveBeenCalledWith("stage", [{ hunkIndex: 0, lineIndexes: [1, 2, 3] }], { hunks: 0, lines: 3 });
  });

  it("a selection never spans hunks (dragging into another hunk is ignored)", () => {
    const { container } = renderDiff(diff(), {});
    fireEvent.mouseDown(gutter("Select added line 3"));
    const hunk2Lines = container.querySelectorAll(".gh-diff-view__hunk")[1]!.querySelectorAll(".gh-diff-view__line");
    fireEvent.mouseEnter(hunk2Lines[1]!);
    fireEvent.mouseUp(window);
    expect(screen.getByRole("button", { name: "Stage 1 line" })).toBeInTheDocument();
  });

  it("clicking the only selected line again clears it", () => {
    renderDiff(diff(), {});
    fireEvent.mouseDown(gutter("Select added line 2"));
    fireEvent.mouseUp(window);
    fireEvent.mouseDown(gutter("Select added line 2"));
    fireEvent.mouseUp(window);
    expect(screen.queryByRole("toolbar")).not.toBeInTheDocument();
  });

  it("on the staged side the bar offers Unstage only", () => {
    renderDiff(diff(), { side: "staged" });
    fireEvent.mouseDown(gutter("Select added line 2"));
    expect(screen.getByRole("button", { name: "Unstage 1 line" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /discard/i })).not.toBeInTheDocument();
  });

  it("keyboard: Enter toggles a line, Shift+ArrowDown extends, Escape clears", () => {
    renderDiff(diff(), {});
    const first = gutter("Select removed line 2");
    first.focus();
    // detail 0 is how a keyboard-initiated click reaches the handler.
    fireEvent.click(first, { detail: 0 });
    expect(first).toHaveAttribute("aria-pressed", "true");
    fireEvent.keyDown(first, { key: "ArrowDown", shiftKey: true });
    expect(screen.getByRole("toolbar", { name: /2 selected lines/i })).toBeInTheDocument();
    expect(gutter("Select added line 2")).toHaveFocus();
    fireEvent.keyDown(gutter("Select added line 2"), { key: "Escape" });
    expect(screen.queryByRole("toolbar")).not.toBeInTheDocument();
  });

  it("keyboard: exactly one gutter is a tab stop (roving tabindex)", () => {
    const { container } = renderDiff(diff(), {});
    const stops = Array.from(container.querySelectorAll<HTMLButtonElement>("button[data-gutter]")).filter(
      (b) => b.tabIndex === 0,
    );
    expect(stops).toHaveLength(1);
  });

  it("right-click opens a menu with the same actions, acting on the clicked line when nothing is selected", () => {
    const { onAction } = renderDiff(diff(), {});
    const line = gutter("Select added line 3").closest(".gh-diff-view__line")!;
    fireEvent.contextMenu(line, { clientX: 10, clientY: 10 });
    const menu = screen.getByRole("menu", { name: /1 selected line/i });
    expect(within(menu).getByRole("menuitem", { name: "Discard 1 line" })).toBeInTheDocument();
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Stage 1 line" }));
    expect(onAction).toHaveBeenCalledWith("stage", [{ hunkIndex: 0, lineIndexes: [3] }], { hunks: 0, lines: 1 });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("drops the line selection when the diff is reloaded with a new fingerprint", () => {
    const { rerender, onAction } = renderDiff(diff(), {});
    fireEvent.mouseDown(gutter("Select added line 2"));
    expect(screen.getByRole("toolbar")).toBeInTheDocument();
    rerender(
      <DiffView
        fileLabel="a.ts"
        loading={false}
        errorMessage={null}
        result={{ ...diff(), fingerprint: "fp-2" }}
        partialStaging={{ side: "unstaged", busy: false, onAction }}
      />,
    );
    expect(screen.queryByRole("toolbar")).not.toBeInTheDocument();
  });

  it("shows a status notice when given one", () => {
    render(
      <DiffView fileLabel="a.ts" loading={false} errorMessage={null} result={diff()} notice="File changed. Diff reloaded." />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("File changed. Diff reloaded.");
  });
});
