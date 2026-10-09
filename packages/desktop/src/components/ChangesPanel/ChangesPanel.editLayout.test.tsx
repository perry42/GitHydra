// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { file, list, mountPanel } from "../../test/changesPanelHarness";
import { polyfillCodeMirrorDom, typeAtEnd } from "../../test/codemirrorDom";
import { CHANGES_PANEL_STORAGE_KEY } from "../../lib/layoutSizes";
import type { EditCommandReasons } from "../../lib/editFile";

// specs/edit-in-diff.md FR-532 (layout), FR-533 (palette state), FR-534 (context menu).

beforeAll(polyfillCodeMirrorDom);

const H = (c: string) => c.repeat(64);
const readOk = (content: string) => ({
  ok: true as const,
  data: {
    eligible: true as const, hasStagedContent: false, isNew: false, isUntracked: false, size: 1, mtimeMs: 1, mode: 0o644,
    content, eol: "lf" as const, hasBom: false, finalNewline: true, contentHash: H("a"),
  },
});

function setWindowWidth(width: number) {
  Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: width });
}
const originalWidth = window.innerWidth;

function mount(extra: Parameters<typeof mountPanel>[1] = {}) {
  const m = mountPanel(list({ unstaged: [file("a.txt", "unstaged"), file("b.txt", "unstaged")], staged: [file("c.txt", "staged")] }), extra);
  (m.api.readEditableFile as ReturnType<typeof vi.fn>).mockImplementation((p: string) => Promise.resolve(readOk(`${p} body\n`)));
  return m;
}

const rowButton = (name: string, section: "Staged" | "Unstaged" = "Unstaged") =>
  document.querySelector<HTMLElement>(`[data-row-key="${section.toLowerCase()}:${name}"]`)!;
const panelEl = () => screen.getByRole("complementary", { name: "Changes" });
async function openEditor(name = "a.txt") {
  fireEvent.click(rowButton(name));
  await waitFor(() => expect(screen.getByRole("button", { name: "Edit" })).not.toHaveAttribute("aria-disabled"));
  fireEvent.click(screen.getByRole("button", { name: "Edit" }));
  return screen.findByRole("textbox", { name: `Editing ${name}` });
}

beforeEach(() => {
  window.localStorage.clear();
  setWindowWidth(1400);
});
afterEach(() => setWindowWidth(originalWidth));

describe("edit layout (FR-532)", () => {
  it("widens the drawer to 80vw only while editing and restores the stored width afterwards, never rewriting storage", async () => {
    window.localStorage.setItem(CHANGES_PANEL_STORAGE_KEY, "700");
    mount();
    expect(panelEl().style.width).toBe("700px");
    await openEditor();
    expect(panelEl().style.width).toBe("1120px");
    expect(panelEl()).toHaveClass("gh-changes-panel--editing");
    expect(window.localStorage.getItem(CHANGES_PANEL_STORAGE_KEY)).toBe("700");
    fireEvent.click(screen.getByRole("button", { name: "Back to diff" }));
    await waitFor(() => expect(panelEl().style.width).toBe("700px"));
    expect(panelEl()).not.toHaveClass("gh-changes-panel--editing");
    expect(window.localStorage.getItem(CHANGES_PANEL_STORAGE_KEY)).toBe("700");
  });

  it("an unset stored width is still unset after editing", async () => {
    mount();
    await openEditor();
    fireEvent.click(screen.getByRole("button", { name: "Back to diff" }));
    await waitFor(() => expect(panelEl().style.width).toBe("840px"));
    expect(window.localStorage.getItem(CHANGES_PANEL_STORAGE_KEY)).toBeNull();
  });

  it("the width handle is inert while editing", async () => {
    mount();
    await openEditor();
    fireEvent.keyDown(screen.getByRole("separator", { name: "Resize Changes panel" }), { key: "ArrowLeft" });
    expect(window.localStorage.getItem(CHANGES_PANEL_STORAGE_KEY)).toBeNull();
    expect(panelEl().style.width).toBe("1120px");
  });

  it("keeps the file column mounted as the labelled 'Changed files' rail, with every row still rendered and focusable", async () => {
    mount();
    await openEditor();
    const rail = screen.getByRole("region", { name: "Changed files" });
    expect(rail).toHaveClass("gh-changes-panel__files");
    expect(rail).not.toHaveAttribute("hidden");
    expect(rail.getAttribute("style") ?? "").not.toMatch(/display/);
    for (const [name, section] of [["a.txt", "Unstaged"], ["b.txt", "Unstaged"], ["c.txt", "Staged"]] as const) {
      const row = rowButton(name, section);
      expect(rail.contains(row)).toBe(true);
      row.focus();
      expect(row).toHaveFocus();
    }
    expect(screen.queryByRole("separator", { name: "Resize file list" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Back to diff" }));
    await waitFor(() => expect(screen.queryByRole("region", { name: "Changed files" })).toBeNull());
    expect(screen.getByRole("separator", { name: "Resize file list" })).toBeInTheDocument();
  });

  it("arrow keys still move row focus inside the rail (roving focus)", async () => {
    mount();
    await openEditor();
    rowButton("a.txt").focus();
    fireEvent.keyDown(rowButton("a.txt"), { key: "ArrowDown" });
    expect(rowButton("b.txt")).toHaveFocus();
  });

  it("does not remount or lose the dirty buffer when the window is resized while editing", async () => {
    mount();
    const box = await openEditor();
    act(() => typeAtEnd(document.body, "x"));
    const editorDom = document.querySelector(".cm-editor");
    setWindowWidth(1000);
    act(() => {
      window.dispatchEvent(new Event("resize"));
    });
    expect(panelEl().style.width).toBe("800px");
    expect(document.querySelector(".cm-editor")).toBe(editorDom);
    expect(box).toBeInTheDocument();
    expect(document.querySelector(".cm-content")!.textContent).toContain("bodyx");
  });

  it("keeps the commit message across entering and leaving the editor", async () => {
    mount();
    fireEvent.change(screen.getByLabelText("Subject"), { target: { value: "wip: half a sentence" } });
    await openEditor();
    expect(screen.getByLabelText("Subject")).toHaveValue("wip: half a sentence");
    fireEvent.click(screen.getByRole("button", { name: "Back to diff" }));
    await waitFor(() => expect(screen.queryByRole("textbox", { name: /Editing/ })).toBeNull());
    expect(screen.getByLabelText("Subject")).toHaveValue("wip: half a sentence");
  });
});

describe("file-row context menu (FR-534)", () => {
  const openMenu = (name: string, section: "Staged" | "Unstaged" = "Unstaged") => fireEvent.contextMenu(rowButton(name, section));

  it("offers Edit file on a single eligible row and opens the editor on that file, even if another row is open", async () => {
    const { api } = mount();
    fireEvent.click(rowButton("a.txt"));
    openMenu("b.txt");
    const item = await screen.findByRole("menuitem", { name: "Edit file" });
    await waitFor(() => expect(item).not.toBeDisabled());
    expect(api.probeEditableFile).toHaveBeenCalledWith("b.txt");
    fireEvent.click(item);
    expect(await screen.findByRole("textbox", { name: "Editing b.txt" })).toBeInTheDocument();
  });

  it("is disabled with the probe's reason on an ineligible file", async () => {
    const { api } = mount();
    (api.probeEditableFile as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      data: { eligible: false, reason: "binary", message: "Binary file, edit externally" },
    });
    openMenu("a.txt");
    const item = await screen.findByRole("menuitem", { name: "Edit file" });
    await waitFor(() => expect(item).toHaveAttribute("title", "Binary file, edit externally"));
    expect(item).toBeDisabled();
  });

  it("is disabled while the check runs, and on the file already being edited", async () => {
    let release: (v: unknown) => void = () => {};
    const { api } = mount();
    (api.probeEditableFile as ReturnType<typeof vi.fn>).mockImplementationOnce(() => new Promise((r) => (release = r)));
    openMenu("a.txt");
    const item = await screen.findByRole("menuitem", { name: "Edit file" });
    expect(item).toBeDisabled();
    expect(item).toHaveAttribute("title", "Checking whether this file can be edited…");
    await act(async () => {
      release({ ok: true, data: { eligible: true, hasStagedContent: false, isNew: false, isUntracked: false, size: 0, mtimeMs: 0, mode: 0o644 } });
    });
    await waitFor(() => expect(screen.getByRole("menuitem", { name: "Edit file" })).not.toBeDisabled());
  });

  it("is not offered on a multi-selection", async () => {
    mount();
    fireEvent.click(rowButton("a.txt"));
    fireEvent.click(rowButton("b.txt"), { ctrlKey: true });
    fireEvent.contextMenu(rowButton("b.txt"));
    const menu = await screen.findByRole("menu");
    expect(within(menu).queryByRole("menuitem", { name: "Edit file" })).toBeNull();
    expect(within(menu).getByRole("menuitem", { name: /^Stage 2 files/ })).toBeInTheDocument();
  });

  it("on a conflicted row Edit file follows the probe: enabled when the editor can open it, else the probe's reason (FR-556)", async () => {
    const m = mountPanel(list({ conflicted: [file("x.txt", "conflicted", "conflicted")] }));
    fireEvent.contextMenu(rowButton("x.txt", "Conflicted" as "Staged"));
    const item = await screen.findByRole("menuitem", { name: "Edit file" });
    await waitFor(() => expect(item).not.toBeDisabled());
    fireEvent.keyDown(document.body, { key: "Escape" });
    (m.api.probeEditableFile as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, data: { eligible: false, reason: "binary", message: "Binary file" } });
    fireEvent.contextMenu(rowButton("x.txt", "Conflicted" as "Staged"));
    await waitFor(() => expect(screen.getByRole("menuitem", { name: "Edit file" })).toBeDisabled());
    expect(screen.getByRole("menuitem", { name: "Edit file" }).getAttribute("title")).toBe("Binary file");
  });

  it("asks before switching away from a dirty buffer (Cancel keeps the first file)", async () => {
    mount();
    await openEditor("a.txt");
    act(() => typeAtEnd(document.body, "x"));
    openMenu("b.txt");
    const item = await screen.findByRole("menuitem", { name: "Edit file" });
    await waitFor(() => expect(item).not.toBeDisabled());
    fireEvent.click(item);
    fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(screen.getByRole("textbox", { name: "Editing a.txt" })).toBeInTheDocument();
  });
});

describe("palette state (FR-533)", () => {
  const latest = (spy: ReturnType<typeof vi.fn>) => spy.mock.calls.at(-1)![0] as EditCommandReasons;

  it("reports why Edit / Save / Save and stage cannot run, and clears the reasons as the editor opens and gets dirty", async () => {
    const spy = vi.fn();
    mount({ onEditCommandsChange: spy });
    await waitFor(() => expect(spy).toHaveBeenCalled());
    // The panel auto-selects the first file, so the first answer is "checking" and then "can edit".
    expect(latest(spy).save).toBe("Open a file for editing first.");
    await waitFor(() => expect(latest(spy).edit).toBeNull());

    await openEditor();
    await waitFor(() => expect(latest(spy).edit).toBe("Already editing this file."));
    await waitFor(() => expect(latest(spy).save).toBe("No unsaved edits"));
    // An unstaged file can still be staged as it is (the index differs from the working copy), so only Save is blocked.
    expect(latest(spy).saveAndStage).toBeNull();

    act(() => typeAtEnd(document.body, "x"));
    await waitFor(() => expect(latest(spy).save).toBeNull());
    expect(latest(spy).saveAndStage).toBeNull();
  });

  it("reports an ineligible file's reason for Edit file", async () => {
    const spy = vi.fn();
    const { api } = mount({ onEditCommandsChange: spy });
    (api.probeEditableFile as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      data: { eligible: false, reason: "too-large", message: "File too large to edit here" },
    });
    fireEvent.click(rowButton("a.txt"));
    await waitFor(() => expect(latest(spy).edit).toBe("File too large to edit here"));
  });

  it("the handle opens the editor, saves and saves-and-stages the open file", async () => {
    const spy = vi.fn();
    const { api, panelRef } = mount({ onEditCommandsChange: spy });
    fireEvent.click(rowButton("a.txt"));
    await waitFor(() => expect(latest(spy).edit).toBeNull());
    act(() => panelRef.current!.editFile());
    await screen.findByRole("textbox", { name: "Editing a.txt" });
    act(() => typeAtEnd(document.body, "x"));
    await waitFor(() => expect(latest(spy).save).toBeNull());
    act(() => panelRef.current!.saveEdit());
    await waitFor(() => expect(api.writeEditedFile).toHaveBeenCalledTimes(1));
    expect(api.stageFile).not.toHaveBeenCalled();
    act(() => typeAtEnd(document.body, "y"));
    await waitFor(() => expect(latest(spy).saveAndStage).toBeNull());
    act(() => panelRef.current!.saveAndStageEdit());
    await waitFor(() => expect(api.stageFile).toHaveBeenCalledWith("a.txt"));
  });

  it("Save and stage reads 'whole file' state when the file has staged content", async () => {
    const spy = vi.fn();
    const { api } = mount({ onEditCommandsChange: spy });
    (api.probeEditableFile as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      data: { eligible: true, hasStagedContent: true, isNew: false, isUntracked: false, size: 1, mtimeMs: 1, mode: 0o644 },
    });
    (api.readEditableFile as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      data: { ...readOk("x\n").data, hasStagedContent: true },
    });
    await openEditor();
    await waitFor(() => expect(latest(spy).stagedContent).toBe(true));
  });
});

// Bulk actions are allowed with a dirty buffer: they act on the index and the saved disk file, never on the editor's text.
describe("bulk Stage all / Unstage all with a dirty buffer", () => {
  it("leaves the editor open, dirty and untouched, and stages what is on disk", async () => {
    const { api } = mount();
    await openEditor();
    act(() => typeAtEnd(document.body, "x"));
    const editorDom = document.querySelector(".cm-editor");
    fireEvent.click(screen.getByRole("button", { name: "Stage all" }));
    await waitFor(() => expect(api.stageAllFiles).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(document.querySelector('[data-row-key="staged:a.txt"]')).not.toBeNull());
    expect(document.querySelector(".cm-editor")).toBe(editorDom);
    expect(document.querySelector(".cm-content")!.textContent).toContain("bodyx");
    expect(screen.getByText("Unsaved")).toBeInTheDocument();
    expect(api.writeEditedFile).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Unstage all" }));
    await waitFor(() => expect(api.unstageAllFiles).toHaveBeenCalledTimes(1));
    expect(document.querySelector(".cm-content")!.textContent).toContain("bodyx");
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });
});
