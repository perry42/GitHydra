// SPDX-License-Identifier: GPL-3.0-or-later
import { beforeAll, describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import type { FileDiffResult } from "@githydra/git-core";
import { file, list, mountPanel } from "../../test/changesPanelHarness";
import { polyfillCodeMirrorDom, typeAtEnd } from "../../test/codemirrorDom";

// specs/edit-in-diff.md through the real ChangesPanel: entry (FR-467/468), row locks (FR-531), leave guard (FR-535).

beforeAll(polyfillCodeMirrorDom);

const H = (c: string) => c.repeat(64);
const fileDiff = {
  status: "ok",
  isBinary: false,
  hunks: [
    {
      header: "@@ -3,2 +3,2 @@",
      oldStart: 3,
      oldLines: 2,
      newStart: 3,
      newLines: 2,
      lines: [
        { type: "context", content: "keep", oldLineNumber: 3, newLineNumber: 3 },
        { type: "add", content: "fresh-text", oldLineNumber: null, newLineNumber: 4 },
      ],
    },
  ],
} as unknown as FileDiffResult;

const readOk = (content: string) => ({
  ok: true as const,
  data: {
    eligible: true as const, hasStagedContent: false, isNew: false, isUntracked: false, size: 1, mtimeMs: 1, mode: 0o644,
    content, eol: "lf" as const, hasBom: false, finalNewline: true, contentHash: H("a"),
  },
});

function mount(extra: Parameters<typeof mountPanel>[1] = {}) {
  const m = mountPanel(list({ unstaged: [file("a.txt", "unstaged"), file("b.txt", "unstaged")], staged: [file("c.txt", "staged")] }), extra, { fileDiff });
  (m.api.readEditableFile as ReturnType<typeof vi.fn>).mockImplementation((p: string) => Promise.resolve(readOk(`${p} body\n`)));
  return m;
}

const rowButton = (name: string, section: "Staged" | "Unstaged") =>
  document.querySelector<HTMLElement>(`[data-row-key="${section.toLowerCase()}:${name}"]`)!;
const editButton = () => screen.findByRole("button", { name: "Edit" });
const enter = async () => {
  fireEvent.click(await editButton());
  return screen.findByRole("textbox", { name: /Editing/ });
};

describe("ChangesPanel edit-in-diff", () => {
  it("probes the open file and opens the editor from the Edit button; Back to diff returns focus to it", async () => {
    const { api } = mount();
    fireEvent.click(rowButton("a.txt", "Unstaged"));
    await waitFor(() => expect(api.probeEditableFile).toHaveBeenCalledWith("a.txt"));
    await waitFor(() => expect(screen.getByRole("button", { name: "Edit" })).not.toHaveAttribute("aria-disabled"));
    await enter();
    expect(api.readEditableFile).toHaveBeenCalledWith("a.txt");
    fireEvent.click(screen.getByRole("button", { name: "Back to diff" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Edit" })).toHaveFocus());
  });

  it("an ineligible file shows Edit disabled with the probe's reason", async () => {
    const { api } = mount();
    (api.probeEditableFile as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      data: { eligible: false, reason: "too-large", message: "File too large to edit here" },
    });
    fireEvent.click(rowButton("a.txt", "Unstaged"));
    const btn = await screen.findByRole("button", { name: "Edit" });
    await waitFor(() => expect(btn).toHaveAttribute("aria-disabled", "true"));
    expect(btn).toHaveAccessibleDescription("Edit unavailable: File too large to edit here");
    fireEvent.click(btn);
    expect(screen.queryByRole("textbox", { name: /Editing/ })).toBeNull();
  });

  it("while dirty, Stage/Unstage/Discard on that file are aria-disabled with the reason and do nothing; other files are untouched", async () => {
    const { api, container } = mount();
    fireEvent.click(rowButton("a.txt", "Unstaged"));
    await waitFor(() => expect(screen.getByRole("button", { name: "Edit" })).not.toHaveAttribute("aria-disabled"));
    await enter();
    act(() => typeAtEnd(container, "x"));
    const aRow = rowButton("a.txt", "Unstaged").closest("li")!;
    expect(within(aRow).getByText("Unsaved changes")).toBeInTheDocument();
    const stage = within(aRow).getByRole("button", { name: "Stage. Save or discard your edits first" });
    expect(stage).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(stage);
    fireEvent.click(within(aRow).getByRole("button", { name: "Discard changes to a.txt. Save or discard your edits first" }));
    expect(api.stageFile).not.toHaveBeenCalled();
    expect(api.getDiscardFingerprint).not.toHaveBeenCalled();
    const bRow = rowButton("b.txt", "Unstaged").closest("li")!;
    expect(bRow.querySelector("[aria-disabled=true]")).toBeNull();
  });

  it("switching to another file asks first; Cancel keeps the editor, Discard moves on", async () => {
    mount();
    fireEvent.click(rowButton("a.txt", "Unstaged"));
    await waitFor(() => expect(screen.getByRole("button", { name: "Edit" })).not.toHaveAttribute("aria-disabled"));
    await enter();
    act(() => typeAtEnd(document.body, "x"));
    fireEvent.click(rowButton("b.txt", "Unstaged"));
    let dlg = await screen.findByRole("alertdialog");
    fireEvent.click(within(dlg).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(screen.getByRole("textbox", { name: "Editing a.txt" })).toBeInTheDocument();
    // The list highlight must agree with the editor: still a.txt, never b.txt after a Cancel.
    expect(rowButton("a.txt", "Unstaged").closest("li")).toHaveAttribute("aria-selected", "true");
    expect(rowButton("b.txt", "Unstaged").closest("li")).toHaveAttribute("aria-selected", "false");

    fireEvent.click(rowButton("b.txt", "Unstaged"));
    dlg = await screen.findByRole("alertdialog");
    expect(rowButton("b.txt", "Unstaged").closest("li")).toHaveAttribute("aria-selected", "false");
    fireEvent.click(within(dlg).getByRole("button", { name: "Discard" }));
    await waitFor(() => expect(screen.queryByRole("textbox", { name: /Editing/ })).toBeNull());
    expect(rowButton("b.txt", "Unstaged").closest("li")).toHaveAttribute("aria-selected", "true");
    expect(await screen.findByRole("heading", { name: "b.txt" })).toBeInTheDocument();
  });

  it("a clean editor lets another file open without a prompt, and Save refreshes the Changes data", async () => {
    const onWorkingDirChanged = vi.fn();
    const { api } = mount({ onWorkingDirChanged });
    fireEvent.click(rowButton("a.txt", "Unstaged"));
    await waitFor(() => expect(screen.getByRole("button", { name: "Edit" })).not.toHaveAttribute("aria-disabled"));
    await enter();
    act(() => typeAtEnd(document.body, "x"));
    (api.writeEditedFile as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      data: { status: "written", contentHash: H("b"), mtimeMs: 2, size: 5 },
    });
    fireEvent.keyDown(document.querySelector(".cm-content")!, { key: "s", code: "KeyS", ctrlKey: true });
    await waitFor(() => expect(onWorkingDirChanged).toHaveBeenCalled());
    await waitFor(() => expect(within(rowButton("a.txt", "Unstaged").closest("li")!).queryByText("Unsaved changes")).toBeNull());
    fireEvent.click(rowButton("b.txt", "Unstaged"));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(await screen.findByRole("heading", { name: "b.txt" })).toBeInTheDocument();
  });

  it("the panel close button asks before dropping a dirty buffer", async () => {
    const onClose = vi.fn();
    mount({ onClose });
    fireEvent.click(rowButton("a.txt", "Unstaged"));
    await waitFor(() => expect(screen.getByRole("button", { name: "Edit" })).not.toHaveAttribute("aria-disabled"));
    await enter();
    act(() => typeAtEnd(document.body, "x"));
    fireEvent.click(screen.getByRole("button", { name: "Close changes panel" }));
    const dlg = await screen.findByRole("alertdialog");
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(within(dlg).getByRole("button", { name: "Discard" }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  // specs/edit-recovery-draft.md FR-550: a confirmed Restore opens the editor with the draft as the dirty buffer.
  it("a restore request opens that file's editor dirty with the draft text, then reports it handled", async () => {
    const onRestoreRequestHandled = vi.fn();
    const draft = { content: "drafted\r\n", expectedHash: H("a"), eol: "mixed" as const, bom: false, finalNewline: true };
    mount({ restoreRequest: { id: 7, path: "b.txt", draft }, onRestoreRequestHandled, repoKey: "/repo" });
    const box = await screen.findByRole("textbox", { name: "Editing b.txt" }, { timeout: 8000 });
    expect(box.textContent).toContain("drafted");
    await waitFor(() => expect(onRestoreRequestHandled).toHaveBeenCalledWith(7), { timeout: 8000 });
    expect(onRestoreRequestHandled).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(within(rowButton("b.txt", "Unstaged").closest("li")!).getByText("Unsaved changes")).toBeInTheDocument(), { timeout: 8000 });
  });

  it("a restore request for a file that is in no Changes section still opens the editor", async () => {
    const draft = { content: "x\n", expectedHash: H("a"), eol: "lf" as const, bom: false, finalNewline: true };
    mount({ restoreRequest: { id: 1, path: "gone-from-list.txt", draft }, repoKey: "/repo" });
    expect(await screen.findByRole("textbox", { name: "Editing gone-from-list.txt" }, { timeout: 8000 })).toBeInTheDocument();
  });
});
