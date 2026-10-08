// SPDX-License-Identifier: GPL-3.0-or-later
import { beforeAll, describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import type { FileDiffResult } from "@githydra/git-core";
import { file, list, mountPanel } from "../../test/changesPanelHarness";
import { polyfillCodeMirrorDom, typeAtEnd, viewOf } from "../../test/codemirrorDom";

// specs/edit-in-diff.md FR-532 (the editor stays open when its saved file drops out of the Changes list) and
// specs/hunk-line-staging.md AC20 (selection and open diff move to the surviving row), through the real ChangesPanel.

beforeAll(polyfillCodeMirrorDom);

const diff = {
  status: "ok",
  isBinary: false,
  hunks: [
    {
      header: "@@ -1,1 +1,1 @@",
      oldStart: 1,
      oldLines: 1,
      newStart: 1,
      newLines: 1,
      lines: [{ type: "add", content: "fresh", oldLineNumber: null, newLineNumber: 1 }],
    },
  ],
} as unknown as FileDiffResult;

const readOk = (content: string) => ({
  ok: true as const,
  data: {
    eligible: true as const, hasStagedContent: false, isNew: false, isUntracked: false, size: 1, mtimeMs: 1, mode: 0o644,
    content, eol: "lf" as const, hasBom: false, finalNewline: true, contentHash: "a".repeat(64),
  },
});

function mount(initial: Parameters<typeof list>[0], extra: Parameters<typeof mountPanel>[1] = {}) {
  const m = mountPanel(list(initial), extra, { fileDiff: diff });
  (m.api.readEditableFile as ReturnType<typeof vi.fn>).mockImplementation((p: string) => Promise.resolve(readOk(`${p} body\n`)));
  return m;
}

const row = (section: "staged" | "unstaged", name: string) => document.querySelector<HTMLElement>(`[data-row-key="${section}:${name}"]`);
const selectedKeys = () =>
  [...document.querySelectorAll<HTMLElement>('li[role="row"][aria-selected="true"]')].map((li) => li.querySelector<HTMLElement>("[data-row-key]")!.dataset.rowKey);
const openKeys = () =>
  [...document.querySelectorAll<HTMLElement>('.gh-changes-panel__file-label[aria-pressed="true"]')].map((b) => b.closest("li")!.querySelector<HTMLElement>("[data-row-key]")!.dataset.rowKey);
const editor = (name: string) => screen.queryByRole("textbox", { name: `Editing ${name}` });

async function openEditorOn(section: "staged" | "unstaged", name: string) {
  fireEvent.click(row(section, name)!);
  const btn = await screen.findByRole("button", { name: "Edit" });
  await waitFor(() => expect(btn).not.toHaveAttribute("aria-disabled"));
  fireEvent.click(btn);
  await screen.findByRole("textbox", { name: `Editing ${name}` });
}

describe("ChangesPanel: the edited file drops out of the Changes list", () => {
  it("a clean editor stays mounted with its text when its only row vanishes", async () => {
    const { ctl, container } = mount({ unstaged: [file("a.txt", "unstaged"), file("b.txt", "unstaged")] });
    await openEditorOn("unstaged", "a.txt");
    act(() => ctl.current!.read(list({ unstaged: [file("b.txt", "unstaged")] })));
    await waitFor(() => expect(row("unstaged", "a.txt")).toBeNull());
    expect(editor("a.txt")).toBeInTheDocument();
    expect(viewOf(container).state.doc.toString()).toBe("a.txt body\n");
  });

  it("a vanished edited row neither opens nor selects another file by itself", async () => {
    const { ctl } = mount({ unstaged: [file("a.txt", "unstaged"), file("b.txt", "unstaged")] });
    await openEditorOn("unstaged", "a.txt");
    act(() => ctl.current!.read(list({ unstaged: [file("b.txt", "unstaged")] })));
    await waitFor(() => expect(row("unstaged", "a.txt")).toBeNull());
    expect(selectedKeys()).toEqual([]);
    expect(openKeys()).toEqual([]);
  });

  it("a DIRTY editor keeps its unsaved text when the file vanishes, and the leave guard still protects it", async () => {
    const { ctl, container } = mount({ unstaged: [file("a.txt", "unstaged"), file("b.txt", "unstaged")] });
    await openEditorOn("unstaged", "a.txt");
    act(() => typeAtEnd(container, "mine"));
    act(() => ctl.current!.read(list({ unstaged: [file("b.txt", "unstaged")] })));
    await waitFor(() => expect(row("unstaged", "a.txt")).toBeNull());
    expect(viewOf(container).state.doc.toString()).toBe("a.txt body\nmine");
    fireEvent.click(row("unstaged", "b.txt")!);
    const dlg = await screen.findByRole("alertdialog");
    fireEvent.click(within(dlg).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(editor("a.txt")).toBeInTheDocument();
    expect(viewOf(container).state.doc.toString()).toBe("a.txt body\nmine");
  });

  it("a DIRTY editor on a vanished file still asks before the panel is closed", async () => {
    const onClose = vi.fn();
    const { ctl, container } = mount({ unstaged: [file("a.txt", "unstaged")] }, { onClose });
    await openEditorOn("unstaged", "a.txt");
    act(() => typeAtEnd(container, "mine"));
    act(() => ctl.current!.read(list()));
    await waitFor(() => expect(row("unstaged", "a.txt")).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: /^Close/ }));
    await screen.findByRole("alertdialog");
    expect(onClose).not.toHaveBeenCalled();
    expect(editor("a.txt")).toBeInTheDocument();
  });

  it("a different file vanishing leaves the editor, its buffer and the selection alone", async () => {
    const { ctl, container } = mount({ unstaged: [file("a.txt", "unstaged"), file("b.txt", "unstaged")] });
    await openEditorOn("unstaged", "b.txt");
    act(() => typeAtEnd(container, "mine"));
    act(() => ctl.current!.read(list({ unstaged: [file("b.txt", "unstaged")] })));
    await waitFor(() => expect(row("unstaged", "a.txt")).toBeNull());
    expect(viewOf(container).state.doc.toString()).toBe("b.txt body\nmine");
    expect(selectedKeys()).toEqual(["unstaged:b.txt"]);
    expect(openKeys()).toEqual(["unstaged:b.txt"]);
  });

  it("partly staged, editing the Unstaged row: when it vanishes the Staged row takes the selection and open diff, editor stays", async () => {
    const { ctl, container } = mount({ staged: [file("a.txt", "staged")], unstaged: [file("a.txt", "unstaged")] });
    await openEditorOn("unstaged", "a.txt");
    expect(openKeys()).toEqual(["unstaged:a.txt"]);
    act(() => ctl.current!.read(list({ staged: [file("a.txt", "staged")] })));
    await waitFor(() => expect(row("unstaged", "a.txt")).toBeNull());
    await waitFor(() => expect(openKeys()).toEqual(["staged:a.txt"]));
    expect(selectedKeys()).toEqual(["staged:a.txt"]);
    expect(editor("a.txt")).toBeInTheDocument();
    expect(viewOf(container).state.doc.toString()).toBe("a.txt body\n");
  });

  it("partly staged, editing the Staged row: when it vanishes the Unstaged row takes the selection and open diff, editor stays", async () => {
    const { ctl } = mount({ staged: [file("a.txt", "staged")], unstaged: [file("a.txt", "unstaged")] });
    await openEditorOn("staged", "a.txt");
    act(() => ctl.current!.read(list({ unstaged: [file("a.txt", "unstaged")] })));
    await waitFor(() => expect(row("staged", "a.txt")).toBeNull());
    await waitFor(() => expect(openKeys()).toEqual(["unstaged:a.txt"]));
    expect(selectedKeys()).toEqual(["unstaged:a.txt"]);
    expect(editor("a.txt")).toBeInTheDocument();
  });

  it("partly staged with a DIRTY buffer: the surviving row's actions stay locked and the buffer is kept", async () => {
    const { ctl, container } = mount({ staged: [file("a.txt", "staged")], unstaged: [file("a.txt", "unstaged")] });
    await openEditorOn("unstaged", "a.txt");
    act(() => typeAtEnd(container, "mine"));
    act(() => ctl.current!.read(list({ staged: [file("a.txt", "staged")] })));
    await waitFor(() => expect(row("unstaged", "a.txt")).toBeNull());
    const staged = row("staged", "a.txt")!.closest("li")!;
    for (const b of staged.querySelectorAll(".gh-changes-panel__file-actions button")) expect(b).toHaveAttribute("aria-disabled", "true");
    expect(viewOf(container).state.doc.toString()).toBe("a.txt body\nmine");
  });

  it("the file coming back into the list keeps the same editor instance (no remount)", async () => {
    const { ctl, container } = mount({ unstaged: [file("a.txt", "unstaged"), file("b.txt", "unstaged")] });
    await openEditorOn("unstaged", "a.txt");
    const dom = container.querySelector(".cm-editor");
    act(() => ctl.current!.read(list({ unstaged: [file("b.txt", "unstaged")] })));
    await waitFor(() => expect(row("unstaged", "a.txt")).toBeNull());
    act(() => ctl.current!.read(list({ unstaged: [file("a.txt", "unstaged"), file("b.txt", "unstaged")] })));
    await waitFor(() => expect(row("unstaged", "a.txt")).not.toBeNull());
    expect(container.querySelector(".cm-editor")).toBe(dom);
  });
});
