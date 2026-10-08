// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { CombinedDiffHunk, FileDiffResult } from "@githydra/git-core";
import { DiffView, type DiffEditControls } from "./DiffView";

// specs/edit-in-diff.md FR-467, FR-468, FR-527, FR-539: how the diff asks for an edit.

const L = (type: "context" | "add" | "remove", content: string, o: number | null, n: number | null) => ({
  type,
  content,
  oldLineNumber: o,
  newLineNumber: n,
});
const result: FileDiffResult = {
  status: "ok",
  isBinary: false,
  hunks: [
    { header: "@@ -9,3 +9,3 @@", oldStart: 9, oldLines: 3, newStart: 9, newLines: 3, lines: [L("context", "ctx", 9, 9), L("remove", "gone", 10, null), L("add", "fresh", null, 10), L("context", "tail", 11, 11)] },
    { header: "@@ -40,2 +40,1 @@", oldStart: 40, oldLines: 2, newStart: 40, newLines: 1, lines: [L("remove", "only-removed", 40, null), L("context", "after", 41, 40)] },
  ],
} as unknown as FileDiffResult;

function controls(over: Partial<DiffEditControls> = {}): DiffEditControls {
  return { disabledReason: null, hint: "Edit this file.", workingLinesValid: true, onEdit: vi.fn(), ...over };
}
const view = (edit: DiffEditControls) =>
  render(<DiffView fileLabel="f.txt" loading={false} errorMessage={null} result={result} edit={edit} />);

describe("DiffView edit entry", () => {
  it("shows no Edit control and no extra tab stop when `edit` is omitted", () => {
    render(<DiffView fileLabel="f.txt" loading={false} errorMessage={null} result={result} />);
    expect(screen.queryByRole("button", { name: /edit/i })).toBeNull();
  });

  it("the Edit button opens at the first hunk's first working-file line", () => {
    const edit = controls();
    view(edit);
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect(edit.onEdit).toHaveBeenCalledWith({ line: 9 });
  });

  it("from a Staged diff (index line numbers) it opens at the top instead", () => {
    const edit = controls({ workingLinesValid: false });
    view(edit);
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect(edit.onEdit).toHaveBeenCalledWith({});
  });

  it("the diff's cursor hunk is the one opened (FR-539)", () => {
    const edit = controls({ activeHunkIndex: 1 });
    view(edit);
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect(edit.onEdit).toHaveBeenCalledWith({ line: 40 });
  });

  it("an ineligible file: aria-disabled button, reason as text and description, no editor, a click only flashes the reason", () => {
    const edit = controls({ disabledReason: "Binary file" });
    view(edit);
    const btn = screen.getByRole("button", { name: "Edit" });
    expect(btn).toHaveAttribute("aria-disabled", "true");
    expect(btn).toHaveAccessibleDescription("Edit unavailable: Binary file");
    fireEvent.click(btn);
    expect(edit.onEdit).not.toHaveBeenCalled();
    expect(document.querySelector(".gh-diff-view__edit-reason")).toHaveClass("gh-diff-view__edit-reason--flash");
    expect(screen.getByRole("status")).toHaveTextContent("Edit unavailable: Binary file");
  });

  it("double-click on a line's text opens at that line; a removed line maps to the line after it", () => {
    const edit = controls();
    view(edit);
    fireEvent.doubleClick(screen.getByText("fresh"));
    expect(edit.onEdit).toHaveBeenLastCalledWith({ line: 10, column: 0 });
    fireEvent.doubleClick(screen.getByText("gone"));
    expect(edit.onEdit).toHaveBeenLastCalledWith({ line: 10, column: 0 });
    fireEvent.doubleClick(screen.getByText("only-removed"));
    expect(edit.onEdit).toHaveBeenLastCalledWith({ line: 40, column: 0 });
  });

  it("double-click on a line number, a hunk header or the Edit button itself does nothing", () => {
    const edit = controls();
    const { container } = view(edit);
    fireEvent.doubleClick(container.querySelector(".gh-diff-view__line-no")!);
    fireEvent.doubleClick(screen.getByText("@@ -9,3 +9,3 @@"));
    fireEvent.doubleClick(screen.getByRole("button", { name: "Edit" }));
    expect(edit.onEdit).not.toHaveBeenCalled();
  });

  it("double-click on an ineligible file flashes the reason instead of editing", () => {
    const edit = controls({ disabledReason: "Not UTF-8, edit externally" });
    view(edit);
    fireEvent.doubleClick(screen.getByText("fresh"));
    expect(edit.onEdit).not.toHaveBeenCalled();
    expect(document.querySelector(".gh-diff-view__edit-reason")).toHaveClass("gh-diff-view__edit-reason--flash");
  });

  it("E opens by physical key (Hebrew layout), but not with a modifier, from a text input, or while composing", () => {
    const edit = controls();
    const { container } = view(edit);
    const region = container.querySelector<HTMLElement>(".gh-diff-view__hunks")!;
    expect(region).toHaveAttribute("tabindex", "0");
    fireEvent.keyDown(region, { key: "ק", code: "KeyE" });
    expect(edit.onEdit).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(region, { key: "e", code: "KeyE", ctrlKey: true });
    fireEvent.keyDown(region, { key: "e", code: "KeyE", isComposing: true });
    const input = document.createElement("input");
    region.append(input);
    fireEvent.keyDown(input, { key: "e", code: "KeyE" });
    expect(edit.onEdit).toHaveBeenCalledTimes(1);
  });
});

describe("DiffView edit entry on the checkbox (combined) diff", () => {
  const C = (type: "context" | "add" | "remove", content: string, o: number | null, n: number | null) => ({
    ...L(type, content, o, n),
    staged: false,
    discardable: type !== "context",
  });
  const hunks: CombinedDiffHunk[] = [
    { header: "@@ -1,2 +1,2 @@", oldStart: 1, oldLines: 2, newStart: 1, newLines: 2, lines: [C("context", "keep", 1, 1), C("add", "added-line", null, 2)], stagedState: "none" },
  ];
  const combined = () => ({
    hunks,
    busy: false,
    onToggleLines: vi.fn(),
    onToggleHunk: vi.fn(),
    onDiscardLines: vi.fn(),
    onDiscardHunk: vi.fn(),
  });

  it("double-click on the text opens the editor and never toggles a line; on the gutter it does not open", () => {
    const edit = controls();
    const c = combined();
    const { container } = render(<DiffView fileLabel="f.txt" loading={false} errorMessage={null} result={null} combined={c} edit={edit} />);
    fireEvent.doubleClick(screen.getByText("added-line"));
    expect(edit.onEdit).toHaveBeenCalledWith({ line: 2, column: 0 });
    expect(c.onToggleLines).not.toHaveBeenCalled();
    fireEvent.doubleClick(container.querySelector(".gh-diff-view__gutter--check")!);
    fireEvent.doubleClick(screen.getByRole("checkbox", { name: "Hunk 1 of 1" }));
    expect(edit.onEdit).toHaveBeenCalledTimes(1);
  });

  it("E with the hunk checkbox focused uses that hunk", () => {
    const edit = controls();
    render(<DiffView fileLabel="f.txt" loading={false} errorMessage={null} result={null} combined={combined()} edit={edit} />);
    const box = screen.getByRole("checkbox", { name: "Hunk 1 of 1" });
    box.focus();
    fireEvent.keyDown(box, { key: "e", code: "KeyE" });
    expect(edit.onEdit).toHaveBeenCalledWith({ line: 1 });
  });
});
