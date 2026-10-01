// SPDX-License-Identifier: GPL-3.0-or-later
import { beforeEach, describe, expect, it, vi } from "vitest";
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

// Gutter labels carry the line text: "Select added line 2: new a".
const gutter = (name: string) => screen.getByRole("button", { name: new RegExp(`^${name}(:|$)`) });

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
    expect(onAction).toHaveBeenCalledWith("stage", [{ hunkIndex: 0 }], { hunks: 1, lines: 3, range: "1–4" });
  });

  it("Discard hunk and Unstage hunk report their own actions", () => {
    const first = renderDiff(diff(), {});
    fireEvent.click(screen.getByRole("button", { name: "Discard hunk 2 of 2" }));
    expect(first.onAction).toHaveBeenCalledWith("discard", [{ hunkIndex: 1 }], { hunks: 1, lines: 1, range: "21–23" });
    first.unmount();

    const second = renderDiff(diff(), { side: "staged" });
    fireEvent.click(screen.getByRole("button", { name: "Unstage hunk 1 of 2" }));
    expect(second.onAction).toHaveBeenCalledWith("unstage", [{ hunkIndex: 0 }], { hunks: 1, lines: 3, range: "1–4" });
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

  it("clicking a gutter selects one line and shows 'Stage 1 line' in that hunk's sticky header", () => {
    const { onAction } = renderDiff(diff(), {});
    fireEvent.mouseDown(gutter("Select added line 2"));
    fireEvent.mouseUp(window); // header actions appear once the drag ends
    expect(gutter("Select added line 2")).toHaveAttribute("aria-pressed", "true");
    const bar = screen.getByRole("group", { name: /1 selected line/i });
    expect(bar.closest(".gh-diff-view__hunk-header")).not.toBeNull();
    expect(screen.queryByRole("toolbar")).not.toBeInTheDocument();
    expect(within(bar).getByText("1 selected")).toBeInTheDocument();
    fireEvent.click(within(bar).getByRole("button", { name: "Stage 1 line" }));
    // Hunk 0 line indexes: 1 = '-' old, 2 = '+' new a, 3 = '+' new b.
    expect(onAction).toHaveBeenCalledWith("stage", [{ hunkIndex: 0, lineIndexes: [2] }], { hunks: 0, lines: 1 });
  });

  it("shift-click extends the selection and the header actions count lines, skipping context lines", () => {
    const { onAction } = renderDiff(diff(), {});
    fireEvent.mouseDown(gutter("Select removed line 2"));
    fireEvent.mouseUp(window);
    fireEvent.mouseDown(gutter("Select added line 3"), { shiftKey: true });
    const bar = screen.getByRole("group", { name: /3 selected lines/i });
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
    expect(screen.queryByRole("group", { name: /selected line/i })).not.toBeInTheDocument();
  });

  it("on the staged side the header actions offer Unstage only", () => {
    renderDiff(diff(), { side: "staged" });
    fireEvent.mouseDown(gutter("Select added line 2"));
    fireEvent.mouseUp(window); // header actions appear once the drag ends
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
    expect(screen.getByRole("group", { name: /2 selected lines/i })).toBeInTheDocument();
    expect(gutter("Select added line 2")).toHaveFocus();
    fireEvent.keyDown(gutter("Select added line 2"), { key: "Escape" });
    expect(screen.queryByRole("group", { name: /selected line/i })).not.toBeInTheDocument();
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
    fireEvent.mouseUp(window); // header actions appear once the drag ends
    expect(screen.getByRole("group", { name: /selected line/i })).toBeInTheDocument();
    rerender(
      <DiffView
        fileLabel="a.ts"
        loading={false}
        errorMessage={null}
        result={{ ...diff(), fingerprint: "fp-2" }}
        partialStaging={{ side: "unstaged", busy: false, onAction }}
      />,
    );
    expect(screen.queryByRole("group", { name: /selected line/i })).not.toBeInTheDocument();
  });

  it("shows a stale-diff notice as one collapsed line with details on demand (changes-panel-layout FR-490)", () => {
    render(
      <DiffView
        fileLabel="a.ts"
        loading={false}
        errorMessage={null}
        result={diff()}
        notice={{ summary: "File changed.", details: "Diff reloaded; select again." }}
      />,
    );
    const notice = screen.getByRole("status");
    expect(notice).toHaveTextContent("File changed.");
    expect(notice).not.toHaveTextContent("select again");
    fireEvent.click(within(notice).getByRole("button", { name: "Show details" }));
    expect(notice).toHaveTextContent("Diff reloaded; select again.");
    fireEvent.click(within(notice).getByRole("button", { name: "Hide details" }));
    expect(notice).not.toHaveTextContent("select again");
  });

  describe("sticky-header selection actions, focus, announcements, errors", () => {
    beforeEach(() => window.localStorage.clear());

    it("shows 'N selected', Stage, destructive Discard and clear in that order, before the hunk buttons", () => {
      renderDiff(diff(), {});
      fireEvent.mouseDown(gutter("Select removed line 2"));
      fireEvent.mouseUp(window);
      fireEvent.mouseDown(gutter("Select added line 3"), { shiftKey: true });
      const header = screen.getByRole("group", { name: "Actions for 3 selected lines" }).closest(".gh-diff-view__hunk-header")!;
      const labels = Array.from(header.querySelectorAll("button")).map((b) => b.getAttribute("aria-label") ?? b.textContent);
      expect(labels).toEqual(["Stage 3 lines", "Discard 3 lines", "Clear selection", "Stage hunk 1 of 2", "Discard hunk 1 of 2"]);
      expect(within(header as HTMLElement).getByText("3 selected")).toBeInTheDocument();
      expect(within(header as HTMLElement).getByRole("button", { name: "Discard 3 lines" })).toHaveClass("gh-diff-view__hunk-btn--danger");
    });

    it("the header only exists inside the selected hunk, and is sticky-styled via the hunk header class", () => {
      const { container } = renderDiff(diff(), {});
      fireEvent.mouseDown(gutter("Select added line 2"));
    fireEvent.mouseUp(window); // header actions appear once the drag ends
      const headers = container.querySelectorAll(".gh-diff-view__hunk-header--actions");
      expect(headers[0]!.querySelector(".gh-diff-view__sel-actions")).not.toBeNull();
      expect(headers[1]!.querySelector(".gh-diff-view__sel-actions")).toBeNull();
    });

    it("the clear button restores focus to a changed-line gutter button instead of dropping to body", () => {
      renderDiff(diff(), {});
      fireEvent.mouseDown(gutter("Select added line 2"));
      fireEvent.mouseUp(window);
      const clear = screen.getByRole("button", { name: "Clear selection" });
      clear.focus();
      fireEvent.click(clear);
      expect(screen.queryByRole("button", { name: "Clear selection" })).not.toBeInTheDocument();
      expect(document.activeElement).toBe(gutter("Select added line 2"));
    });

    it("Escape from the header actions clears the selection and restores focus", () => {
      renderDiff(diff(), {});
      fireEvent.mouseDown(gutter("Select added line 2"));
      fireEvent.mouseUp(window);
      const stage = screen.getByRole("button", { name: "Stage 1 line" });
      stage.focus();
      fireEvent.keyDown(stage, { key: "Escape" });
      expect(screen.queryByRole("group", { name: /selected line/i })).not.toBeInTheDocument();
      expect(document.activeElement).toBe(gutter("Select added line 2"));
    });

    it("after an action the diff remounts under a new fingerprint and focus lands on the nearest gutter button", () => {
      const onAction = vi.fn();
      const props = { fileLabel: "a.ts", loading: false, errorMessage: null as string | null };
      const { rerender } = render(<DiffView {...props} result={diff()} partialStaging={{ side: "unstaged", busy: false, onAction }} />);
      fireEvent.mouseDown(gutter("Select added line 2"));
      fireEvent.mouseUp(window);
      const stage = screen.getByRole("button", { name: "Stage 1 line" });
      stage.focus();
      fireEvent.click(stage);
      rerender(<DiffView {...props} result={{ ...diff(), fingerprint: "fp-2" }} partialStaging={{ side: "unstaged", busy: false, onAction }} />);
      expect(document.activeElement).toBe(gutter("Select added line 2"));
    });

    it("gutter buttons carry the line text and a how-to title", () => {
      renderDiff(diff(), {});
      const b = screen.getByRole("button", { name: "Select added line 2: new a" });
      expect(b).toHaveAttribute("title", "Click or drag to select lines. Shift-click to extend.");
    });

    it("truncates a long line in the gutter label", () => {
      const d = diff();
      d.hunks[0]!.lines[2]!.content = "x".repeat(200);
      renderDiff(d, {});
      const label = screen.getByRole("button", { name: /^Select added line 2: x+…$/ }).getAttribute("aria-label")!;
      expect(label.length).toBeLessThan(80);
    });

    it("announces selection counts in a polite live region", () => {
      renderDiff(diff(), {});
      const live = screen.getByRole("status");
      expect(live).toHaveAttribute("aria-live", "polite");
      fireEvent.mouseDown(gutter("Select removed line 2"));
      fireEvent.mouseUp(window);
      expect(live).toHaveTextContent("1 line selected");
      fireEvent.mouseDown(gutter("Select added line 3"), { shiftKey: true });
      expect(live).toHaveTextContent("3 lines selected");
    });

    it("announces the announcement prop (action outcome / failure)", () => {
      const { rerender } = render(
        <DiffView fileLabel="a.ts" loading={false} errorMessage={null} result={diff()} partialStaging={{ side: "unstaged", busy: false, onAction: vi.fn() }} announcement={null} />,
      );
      rerender(
        <DiffView fileLabel="a.ts" loading={false} errorMessage={null} result={diff()} partialStaging={{ side: "unstaged", busy: false, onAction: vi.fn() }} announcement="Staged 3 lines" />,
      );
      expect(screen.getByRole("status")).toHaveTextContent("Staged 3 lines");
    });

    it("no longer shows the gutter hint line (the checkbox model replaces it)", () => {
      renderDiff(diff(), {});
      expect(screen.queryByText(/select lines in the gutter/i)).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Dismiss hint" })).not.toBeInTheDocument();
    });

    it("renders an error as role=alert with details behind a disclosure", () => {
      const onDismissError = vi.fn();
      render(
        <DiffView
          fileLabel="a.ts"
          loading={false}
          errorMessage={null}
          result={diff()}
          error={{ summary: "Couldn't stage: another git process holds index.lock", details: "fatal: full stderr" }}
          onDismissError={onDismissError}
        />,
      );
      const alert = screen.getByRole("alert");
      expect(alert).toHaveTextContent("Couldn't stage: another git process holds index.lock");
      expect(alert).not.toHaveTextContent("full stderr");
      const toggle = within(alert).getByRole("button", { name: "Show details" });
      expect(toggle).toHaveAttribute("aria-expanded", "false");
      fireEvent.click(toggle);
      expect(alert).toHaveTextContent("fatal: full stderr");
      fireEvent.click(within(alert).getByRole("button", { name: "Dismiss" }));
      expect(onDismissError).toHaveBeenCalled();
    });
  });
});
