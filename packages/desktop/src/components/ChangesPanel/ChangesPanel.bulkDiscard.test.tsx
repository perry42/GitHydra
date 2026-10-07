// SPDX-License-Identifier: GPL-3.0-or-later
// specs/ignore-and-multiselect.md FR-508, FR-509, D6, D7, FR-465, FR-504 through the real ChangesPanel.
import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { BulkDiscardResult } from "@githydra/git-core";
import type { SelectionCommandReasons } from "../../lib/selectionCommands";
import { file, list, mountPanel } from "../../test/changesPanelHarness";

const rowBtn = (path: string): HTMLElement => document.querySelector<HTMLElement>(`[data-row-key$=":${path}"]`) as HTMLElement;

const basic = () =>
  list({
    staged: [file("s.ts", "staged")],
    unstaged: [file("a.ts", "unstaged"), file("b.ts", "unstaged"), file("c.ts", "unstaged")],
    untracked: [file("t.ts", "untracked", "added"), file("lib/", "untracked", "added")],
  });

const many = (n: number) => list({ unstaged: Array.from({ length: n }, (_, i) => file(`f${String(i).padStart(2, "0")}.ts`, "unstaged")) });

const result = (over: Partial<BulkDiscardResult> = {}): BulkDiscardResult => ({
  status: "complete",
  discarded: [],
  skipped: [],
  failed: null,
  notAttempted: [],
  backups: [],
  ...over,
});

const d = () => within(screen.getByRole("alertdialog"));

/** FR-518a: Discard all lives in the Unstaged header's overflow menu. */
async function openDiscardAllMenu(): Promise<HTMLElement> {
  await userEvent.click(screen.getByRole("button", { name: "Unstaged section actions" }));
  return within(await screen.findByRole("menu", { name: "Unstaged section actions" })).getByRole("menuitem", { name: "Discard all changes…" });
}

async function selectRows(...paths: string[]) {
  fireEvent.click(rowBtn(paths[0]!));
  for (const p of paths.slice(1)) fireEvent.click(rowBtn(p), { ctrlKey: true });
}

describe("bulk discard of selected rows (FR-508)", () => {
  it("reads every fingerprint when the dialog opens, shows counts, a path sample and the skipped rows, and never focuses Discard", async () => {
    const { api } = mountPanel(basic());
    await waitFor(() => expect(screen.getByText("Unstaged (3)")).toBeInTheDocument());
    await selectRows("a.ts", "t.ts", "s.ts", "lib/");
    fireEvent.click(within(screen.getByRole("toolbar")).getByRole("button", { name: /^Discard 2/ }));

    await screen.findByRole("alertdialog", { name: "Discard changes to 1 file?" });
    // Read at open, before any confirm.
    expect(api.getBulkDiscardFingerprints).toHaveBeenCalledWith([
      { path: "a.ts", section: "unstaged" },
      { path: "t.ts", section: "untracked" },
    ]);
    expect(api.bulkDiscard).not.toHaveBeenCalled();
    // Untracked rows are an opt-in, unchecked box (D7); the tracked row is the whole list.
    expect(await d().findByText(/1 tracked file\. This cannot be undone\./)).toBeInTheDocument();
    expect(d().getByRole("list", { name: "Files to discard" })).toHaveTextContent("a.ts");
    expect(d().getByRole("checkbox", { name: "Also delete 1 untracked file" })).not.toBeChecked();
    expect(d().getByText(/2 skipped\./)).toBeInTheDocument();
    expect(d().getByRole("button", { name: "Cancel" })).toHaveFocus();
    expect(d().getByRole("button", { name: "Discard 1 file" })).not.toHaveFocus();
  });

  it("confirms with the fingerprints from open on every row (never a path alone) and reports the result", async () => {
    const { api } = mountPanel(basic());
    await waitFor(() => expect(screen.getByText("Unstaged (3)")).toBeInTheDocument());
    await selectRows("a.ts", "t.ts");
    fireEvent.click(within(screen.getByRole("toolbar")).getByRole("button", { name: /^Discard 2/ }));
    await screen.findByRole("alertdialog");
    await userEvent.click(await d().findByRole("checkbox", { name: "Also delete 1 untracked file" }));
    const confirm = await d().findByRole("button", { name: "Discard 2 files" });
    await waitFor(() => expect(confirm).toBeEnabled());
    await userEvent.click(confirm);
    await waitFor(() => expect(api.bulkDiscard).toHaveBeenCalledTimes(1));
    const rows = vi.mocked(api.bulkDiscard).mock.calls[0]![0];
    expect(rows).toEqual([
      { path: "a.ts", section: "unstaged", expectedFingerprint: "fp:a.ts" },
      { path: "t.ts", section: "untracked", expectedFingerprint: "fp:t.ts" },
    ]);
    expect(rows.every((r) => typeof r.expectedFingerprint === "string" && r.expectedFingerprint !== "")).toBe(true);
    expect(await screen.findByText("Discarded 2 files.")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
  });

  it("skips a row git-core could not fingerprint and says why", async () => {
    const { api } = mountPanel(basic());
    await waitFor(() => expect(screen.getByText("Unstaged (3)")).toBeInTheDocument());
    vi.mocked(api.getBulkDiscardFingerprints).mockResolvedValue({
      ok: true,
      data: [
        { path: "a.ts", section: "unstaged", expectedFingerprint: "fp:a.ts" },
        { path: "b.ts", section: "unstaged", error: "File is too large to verify." },
      ],
    } as never);
    await selectRows("a.ts", "b.ts");
    fireEvent.click(within(screen.getByRole("toolbar")).getByRole("button", { name: /^Discard 2/ }));
    await screen.findByRole("alertdialog");
    expect(await d().findByText(/1 skipped\. File is too large to verify\./)).toBeInTheDocument();
    await userEvent.click(await d().findByRole("button", { name: "Discard 1 file" }));
    await waitFor(() => expect(api.bulkDiscard).toHaveBeenCalledWith([{ path: "a.ts", section: "unstaged", expectedFingerprint: "fp:a.ts" }]));
  });

  it("refuses the whole batch on STALE_DIFF, names the paths, and keeps Discard disabled", async () => {
    const { api } = mountPanel(basic());
    await waitFor(() => expect(screen.getByText("Unstaged (3)")).toBeInTheDocument());
    vi.mocked(api.bulkDiscard).mockResolvedValue({
      ok: false,
      error: { name: "StaleBatchError", code: "STALE_DIFF", message: "changed", details: { paths: ["b.ts", "c.ts"] } },
    } as never);
    await selectRows("a.ts", "b.ts", "c.ts");
    fireEvent.click(within(screen.getByRole("toolbar")).getByRole("button", { name: /^Discard 3/ }));
    await screen.findByRole("alertdialog");
    await userEvent.click(await d().findByRole("button", { name: "Discard 3 files" }));
    expect(await d().findByText(/These files changed since you opened this: b\.ts, c\.ts\. Nothing was discarded\./)).toBeInTheDocument();
    expect(d().getByRole("button", { name: /^Discard/ })).toBeDisabled();
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
  });

  it("bounds a huge StaleBatchError path list to a short sample plus 'and N more'", async () => {
    const { api } = mountPanel(basic());
    await waitFor(() => expect(screen.getByText("Unstaged (3)")).toBeInTheDocument());
    const many = Array.from({ length: 400 }, (_, i) => `f${i}.ts`);
    vi.mocked(api.bulkDiscard).mockResolvedValue({
      ok: false,
      error: { name: "StaleBatchError", code: "STALE_DIFF", message: "changed", details: { paths: many, totalPaths: 4000 } },
    } as never);
    await selectRows("a.ts", "b.ts");
    fireEvent.click(within(screen.getByRole("toolbar")).getByRole("button", { name: /^Discard 2/ }));
    await userEvent.click(await screen.findByRole("button", { name: "Discard 2 files" }));
    const line = await d().findByText(/These files changed since you opened this/);
    expect(line.textContent).toContain("f0.ts, f1.ts, f2.ts, f3.ts, f4.ts and 3995 more.");
    expect(line.textContent).not.toContain("f6.ts");
  });

  it("shows the too-many-files refusal from the read step as-is and discards nothing", async () => {
    const { api } = mountPanel(basic());
    await waitFor(() => expect(screen.getByText("Unstaged (3)")).toBeInTheDocument());
    vi.mocked(api.getBulkDiscardFingerprints).mockResolvedValue({
      ok: false,
      error: { name: "InvalidArgumentError", message: "Too many files (3001; at most 3000 at once). Discard in chunks." },
    } as never);
    await selectRows("a.ts", "b.ts");
    fireEvent.click(within(screen.getByRole("toolbar")).getByRole("button", { name: /^Discard 2/ }));
    expect(await d().findByText(/Discard in chunks\./)).toBeInTheDocument();
    expect(d().getByText(/Nothing was discarded/)).toBeInTheDocument();
    expect(api.bulkDiscard).not.toHaveBeenCalled();
  });

  it("shows a progress line while the discard runs", async () => {
    const { api } = mountPanel(basic());
    await waitFor(() => expect(screen.getByText("Unstaged (3)")).toBeInTheDocument());
    let release: (v: unknown) => void = () => {};
    vi.mocked(api.bulkDiscard).mockReturnValue(new Promise((r) => (release = r)) as never);
    await selectRows("a.ts", "b.ts");
    fireEvent.click(within(screen.getByRole("toolbar")).getByRole("button", { name: /^Discard 2/ }));
    await userEvent.click(await screen.findByRole("button", { name: "Discard 2 files" }));
    expect(await d().findByRole("status")).toHaveTextContent(/Discarding 2 files… this can take a few seconds/);
    release({ ok: true, data: result({ status: "complete", discarded: ["a.ts", "b.ts"] }) });
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
  });

  it("reports a partial result: what was discarded and what was not, as an alert", async () => {
    const { api } = mountPanel(basic());
    await waitFor(() => expect(screen.getByText("Unstaged (3)")).toBeInTheDocument());
    vi.mocked(api.bulkDiscard).mockResolvedValue({
      ok: true,
      data: result({ status: "partial", discarded: ["a.ts"], failed: { path: "b.ts", code: "EPERM", message: "permission denied" }, notAttempted: ["c.ts"] }),
    } as never);
    await selectRows("a.ts", "b.ts", "c.ts");
    fireEvent.click(within(screen.getByRole("toolbar")).getByRole("button", { name: /^Discard 3/ }));
    await userEvent.click(await screen.findByRole("button", { name: "Discard 3 files" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Discarded 1 of 3 files, then stopped at b.ts (permission denied). Not discarded: b.ts, c.ts.");
  });

  it("Cancel and Escape change nothing", async () => {
    const { api } = mountPanel(basic());
    await waitFor(() => expect(screen.getByText("Unstaged (3)")).toBeInTheDocument());
    await selectRows("a.ts", "b.ts");
    fireEvent.click(within(screen.getByRole("toolbar")).getByRole("button", { name: /^Discard 2/ }));
    await userEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    fireEvent.click(within(screen.getByRole("toolbar")).getByRole("button", { name: /^Discard 2/ }));
    await screen.findByRole("alertdialog");
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(api.bulkDiscard).not.toHaveBeenCalled();
  });

  it("an open dialog is a modal for the idle gate; the snapshot is not retargeted by a live refresh", async () => {
    const onDialogOpenChange = vi.fn();
    const { api, ctl } = mountPanel(basic(), { onDialogOpenChange });
    await waitFor(() => expect(screen.getByText("Unstaged (3)")).toBeInTheDocument());
    await selectRows("a.ts", "b.ts");
    fireEvent.click(within(screen.getByRole("toolbar")).getByRole("button", { name: /^Discard 2/ }));
    const confirm = await screen.findByRole("button", { name: "Discard 2 files" });
    expect(onDialogOpenChange).toHaveBeenLastCalledWith(true);

    // An external edit removes b.ts and adds d.ts while the dialog is open: the pending rows stay exactly a.ts and b.ts.
    act(() => {
      ctl.current!.read(list({ unstaged: [file("a.ts", "unstaged"), file("d.ts", "unstaged")] }));
    });
    await waitFor(() => expect(confirm).toBeEnabled());
    await userEvent.click(confirm);
    await waitFor(() => expect(api.bulkDiscard).toHaveBeenCalled());
    expect(vi.mocked(api.bulkDiscard).mock.calls[0]![0].map((r) => r.path)).toEqual(["a.ts", "b.ts"]);
  });
});

describe("Discard all changes (FR-509, D6, D7)", () => {
  async function openAll(over: { tracked?: number; untracked?: number } = {}) {
    const view = mountPanel(
      list({
        unstaged: Array.from({ length: over.tracked ?? 3 }, (_, i) => file(`f${String(i).padStart(2, "0")}.ts`, "unstaged")),
        untracked: Array.from({ length: over.untracked ?? 2 }, (_, i) => file(`n${i}.txt`, "untracked", "added")),
      }),
    );
    const item = await openDiscardAllMenu();
    await waitFor(() => expect(item).toBeEnabled());
    await userEvent.click(item);
    await screen.findByRole("alertdialog", { name: "Discard all changes?" });
    return view;
  }

  it("shows counts, a path sample with 'and M more', and an unchecked 'Also delete N untracked files' (D7)", async () => {
    const { api } = await openAll({ tracked: 10, untracked: 2 });
    expect(api.planDiscardAll).toHaveBeenCalledTimes(1);
    expect(await d().findByText(/discards your uncommitted changes in 10 tracked files\. Staged content is not touched\. This cannot be undone\./)).toBeInTheDocument();
    expect(d().getByRole("list", { name: "Files to discard" }).querySelectorAll("li")).toHaveLength(10);
    const checkbox = d().getByRole("checkbox", { name: "Also delete 2 untracked files" });
    expect(checkbox).not.toBeChecked();
    expect(d().getByRole("button", { name: "Cancel" })).toHaveFocus();
  });

  it("without the checkbox only tracked rows are sent and includeUntracked is false (Discard all always asks for the count)", async () => {
    const { api } = await openAll();
    const confirm = await d().findByRole("button", { name: "Discard 3 files" });
    expect(confirm).toBeDisabled();
    await userEvent.type(d().getByRole("textbox", { name: /Type 3 to confirm/ }), "3");
    await userEvent.click(confirm);
    await waitFor(() => expect(api.discardAllChanges).toHaveBeenCalledTimes(1));
    const [rows, include] = vi.mocked(api.discardAllChanges).mock.calls[0]!;
    expect(include).toBe(false);
    expect(rows.map((r) => r.path)).toEqual(["f00.ts", "f01.ts", "f02.ts"]);
    expect(rows.every((r) => r.expectedFingerprint.startsWith("fp:"))).toBe(true);
    expect(await screen.findByText("Discarded 3 files.")).toBeInTheDocument();
  });

  it("ticking the checkbox includes the untracked rows and says they are deleted", async () => {
    const { api } = await openAll();
    await userEvent.click(await d().findByRole("checkbox", { name: "Also delete 2 untracked files" }));
    expect(d().getByText(/and permanently deletes 2 untracked files\./)).toBeInTheDocument();
    await userEvent.type(d().getByRole("textbox", { name: /Type 5 to confirm/ }), "5");
    await userEvent.click(d().getByRole("button", { name: "Discard 5 files" }));
    await waitFor(() => expect(api.discardAllChanges).toHaveBeenCalled());
    const [rows, include] = vi.mocked(api.discardAllChanges).mock.calls[0]!;
    expect(include).toBe(true);
    expect(rows.map((r) => r.path)).toEqual(["f00.ts", "f01.ts", "f02.ts", "n0.txt", "n1.txt"]);
  });

  it("Cancel keeps the focus (not the typing field), Enter never discards, and the count must match", async () => {
    const { api } = await openAll({ tracked: 25, untracked: 0 });
    const field = await d().findByRole("textbox", { name: /Type 25 to confirm/ });
    expect(d().getByRole("button", { name: "Cancel" })).toHaveFocus();
    const confirm = d().getByRole("button", { name: "Discard 25 files" });
    expect(confirm).toBeDisabled();
    await userEvent.type(field, "2");
    expect(confirm).toBeDisabled();
    await userEvent.type(field, "5{Enter}");
    expect(api.discardAllChanges).not.toHaveBeenCalled();
    expect(confirm).toBeEnabled();
    await userEvent.click(confirm);
    await waitFor(() => expect(api.discardAllChanges).toHaveBeenCalled());
  });

  it("the untracked checkbox changes the count the user has to type", async () => {
    await openAll({ tracked: 20, untracked: 1 });
    await userEvent.type(d().getByRole("textbox", { name: /Type 20 to confirm/ }), "20");
    await userEvent.click(d().getByRole("checkbox"));
    expect(d().getByRole("textbox", { name: /Type 21 to confirm/ })).toBeInTheDocument();
    expect(d().getByRole("button", { name: "Discard 21 files" })).toBeDisabled();
  });

  it("shows a loading state until the plan arrives, with Discard disabled", async () => {
    const view = mountPanel(many(3));
    const item = await openDiscardAllMenu();
    let release: (v: unknown) => void = () => {};
    vi.mocked(view.api.planDiscardAll).mockReturnValue(new Promise((res) => (release = res)) as never);
    await userEvent.click(item);
    await screen.findByRole("alertdialog");
    expect(d().getByText("Reading the current changes…")).toBeInTheDocument();
    expect(d().getByRole("button", { name: /^Discard/ })).toBeDisabled();
    release({ ok: true, data: { tracked: [], untracked: [], skipped: [], counts: { trackedReset: 0, untrackedDeleted: 0 } } });
    expect(await d().findByText("There is nothing to discard.")).toBeInTheDocument();
  });

  it("is disabled with the reason when there is nothing to discard", async () => {
    mountPanel(list({ staged: [file("s.ts", "staged")] }));
    const item = await openDiscardAllMenu();
    expect(item).toBeDisabled();
    expect(item).toHaveAttribute("title", expect.stringMatching(/no unstaged or untracked changes/i));
  });

  it("names skipped paths from the plan (nested repos, conflicted)", async () => {
    const view = mountPanel(many(2));
    vi.mocked(view.api.planDiscardAll).mockResolvedValue({
      ok: true,
      data: {
        tracked: [{ path: "f00.ts", section: "unstaged", expectedFingerprint: "fp:f00.ts" }],
        untracked: [],
        skipped: [{ path: "lib/", reason: "Nested repositories cannot be discarded." }],
        counts: { trackedReset: 1, untrackedDeleted: 0 },
      },
    } as never);
    await userEvent.click(await openDiscardAllMenu());
    expect(await screen.findByText(/1 skipped\. Nested repositories cannot be discarded\./)).toBeInTheDocument();
  });
});

describe("selection commands through the panel handle (FR-504)", () => {
  it("reports reasons that clear as the selection changes, and the handle runs the same actions as the bar", async () => {
    const reasons: SelectionCommandReasons[] = [];
    const { api, panelRef } = mountPanel(basic(), { onSelectionCommandsChange: (r) => reasons.push(r) });
    await waitFor(() => expect(screen.getByText("Unstaged (3)")).toBeInTheDocument());
    expect(reasons.at(-1)!.stage).toMatch(/select files/i);
    expect(reasons.at(-1)!.discardAll).toBeNull();

    await selectRows("a.ts", "b.ts");
    await waitFor(() => expect(reasons.at(-1)!.stage).toBeNull());
    expect(reasons.at(-1)!.unstage).toMatch(/not staged/i);

    act(() => panelRef.current!.stageSelected());
    await waitFor(() => expect(api.stagePaths).toHaveBeenCalledWith([
      { path: "a.ts", section: "unstaged" },
      { path: "b.ts", section: "unstaged" },
    ]));
  });

  it("selectAllInSection selects the open row's section; discardSelected and discardAll open the dialogs; ignoreSelected opens the scope menu", async () => {
    const { panelRef } = mountPanel(basic());
    await waitFor(() => expect(screen.getByText("Unstaged (3)")).toBeInTheDocument());
    fireEvent.click(rowBtn("b.ts"));
    act(() => panelRef.current!.selectAllInSection());
    await waitFor(() => expect(screen.getByText("3 selected")).toBeInTheDocument());

    act(() => panelRef.current!.discardSelected());
    expect(await screen.findByRole("alertdialog", { name: "Discard changes to 3 files?" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));

    act(() => panelRef.current!.discardAll());
    expect(await screen.findByRole("alertdialog", { name: "Discard all changes?" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));

    act(() => panelRef.current!.ignoreSelected());
    expect(await screen.findByRole("dialog", { name: /^Ignore 3 files/ })).toBeInTheDocument();
  });

  it("commands are no-ops when nothing applies (no dialog, no call)", async () => {
    const { api, panelRef } = mountPanel(basic());
    await waitFor(() => expect(screen.getByText("Unstaged (3)")).toBeInTheDocument());
    act(() => {
      panelRef.current!.stageSelected();
      panelRef.current!.discardSelected();
      panelRef.current!.ignoreSelected();
    });
    expect(api.stagePaths).not.toHaveBeenCalled();
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });
});

describe("previews scaled to risk, never blocking (FR-520, FR-522)", () => {
  async function openSelection(n: number) {
    const view = mountPanel(many(n));
    await waitFor(() => expect(screen.getByText(`Unstaged (${n})`)).toBeInTheDocument());
    fireEvent.click(rowBtn("f00.ts"));
    fireEvent.keyDown(rowBtn("f00.ts"), { key: "a", ctrlKey: true });
    fireEvent.click(within(screen.getByRole("toolbar")).getByRole("button", { name: new RegExp(`^Discard ${n}`) }));
    await screen.findByRole("alertdialog");
    return view;
  }

  it("1-5 files: one confirm listing names only, no counts requested", async () => {
    const { api } = await openSelection(3);
    await d().findByRole("button", { name: "Discard 3 files" });
    expect(d().getByRole("list", { name: "Files to discard" })).toHaveTextContent("f00.ts");
    expect(api.getDiscardPreview).not.toHaveBeenCalled();
    expect(d().queryByRole("textbox")).not.toBeInTheDocument();
    expect(d().queryByRole("checkbox")).not.toBeInTheDocument();
  });

  it("6-20 files: the list gets +/- counts from one bounded read, and no type-to-confirm", async () => {
    const { api } = await openSelection(12);
    await d().findByRole("button", { name: "Discard 12 files" });
    await waitFor(() => expect(api.getDiscardPreview).toHaveBeenCalledTimes(1));
    expect(vi.mocked(api.getDiscardPreview).mock.calls[0]![0]).toHaveLength(12);
    expect(await d().findAllByText("+3")).toHaveLength(12);
    expect(d().queryByRole("textbox")).not.toBeInTheDocument();
  });

  it("21 files needs the count typed; at most 50 rows are fetched and listed, the title keeps the true total", async () => {
    const { api } = await openSelection(60);
    await screen.findByRole("alertdialog", { name: "Discard changes to 60 files?" });
    await waitFor(() => expect(api.getDiscardPreview).toHaveBeenCalledTimes(1));
    expect(vi.mocked(api.getDiscardPreview).mock.calls[0]![0]).toHaveLength(50);
    expect(d().getByText("and 10 more")).toBeInTheDocument();
    expect(d().getByRole("textbox", { name: /Type 60 to confirm/ })).toBeInTheDocument();
    expect(d().getByRole("button", { name: "Cancel" })).toHaveFocus();
  });

  it("a failing or hanging preview leaves names without counts and the confirm fully usable (no banner)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const view = mountPanel(many(8));
      await waitFor(() => expect(screen.getByText("Unstaged (8)")).toBeInTheDocument());
      vi.mocked(view.api.getDiscardPreview).mockRejectedValue(new Error("boom") as never);
      fireEvent.click(rowBtn("f00.ts"));
      fireEvent.keyDown(rowBtn("f00.ts"), { key: "a", ctrlKey: true });
      fireEvent.click(within(screen.getByRole("toolbar")).getByRole("button", { name: /^Discard 8/ }));
      const go = await d().findByRole("button", { name: "Discard 8 files" });
      await waitFor(() => expect(warn).toHaveBeenCalled());
      expect(d().queryByText("+3")).not.toBeInTheDocument();
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      await waitFor(() => expect(go).toBeEnabled());
      await userEvent.click(go);
      await waitFor(() => expect(view.api.bulkDiscard).toHaveBeenCalled());
    } finally {
      warn.mockRestore();
    }
  });
});

describe("partly staged file (specs/hunk-line-staging.md FR-482)", () => {
  it("both rows selected is one file: only the unstaged part is a candidate, the Staged row is never one, and the dialog says staged content stays", async () => {
    const { api } = mountPanel(list({ staged: [file("p.ts", "staged"), file("q.ts", "staged")], unstaged: [file("p.ts", "unstaged"), file("a.ts", "unstaged")] }));
    await waitFor(() => expect(screen.getByText("Unstaged (2)")).toBeInTheDocument());
    fireEvent.click(document.querySelector<HTMLElement>('[data-row-key="staged:p.ts"]')!);
    fireEvent.click(document.querySelector<HTMLElement>('[data-row-key="unstaged:p.ts"]')!, { ctrlKey: true });
    fireEvent.click(rowBtn("a.ts"), { ctrlKey: true });
    fireEvent.click(within(screen.getByRole("toolbar")).getByRole("button", { name: /^Discard 2/ }));
    await screen.findByRole("alertdialog", { name: "Discard changes to 2 files?" });
    expect(api.getBulkDiscardFingerprints).toHaveBeenCalledWith([
      { path: "p.ts", section: "mixed" },
      { path: "a.ts", section: "unstaged" },
    ]);
    expect(await d().findByText(/1 partly staged file keep their staged changes/)).toBeInTheDocument();
    expect(d().getByText(/tracked files?\. This cannot be undone\./)).toBeInTheDocument();
  });
});
