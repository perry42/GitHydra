// SPDX-License-Identifier: GPL-3.0-or-later
// specs/ignore-and-multiselect.md FR-505..FR-507, FR-511, FR-513, D4, D5, D8 through the real ChangesPanel.
import { describe, expect, it } from "vitest";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { file, list, mountPanel } from "../../test/changesPanelHarness";

const rowBtn = (path: string): HTMLElement =>
  document.querySelector<HTMLElement>(`[data-row-key$=":${path}"]`) as HTMLElement;
const rowOf = (path: string): HTMLElement => rowBtn(path).closest<HTMLElement>(".gh-changes-panel__file")!;
const ctrlClick = (path: string) => fireEvent.click(rowBtn(path), { ctrlKey: true });
const shiftClick = (path: string) => fireEvent.click(rowBtn(path), { shiftKey: true });

const basic = () =>
  list({
    staged: [file("s.ts", "staged")],
    unstaged: [file("a.ts", "unstaged"), file("b.ts", "unstaged"), file("c.ts", "unstaged")],
    untracked: [file("t.ts", "untracked", "added")],
    conflicted: [file("x.ts", "conflicted", "unmerged")],
  });

async function ready() {
  await waitFor(() => expect(screen.getByText("Unstaged (3)")).toBeInTheDocument());
}

describe("selection model (FR-505) and a11y (FR-513)", () => {
  it("exposes each file list as a multiselectable grid of rows with aria-selected", async () => {
    mountPanel(basic());
    await ready();
    const grids = screen.getAllByRole("grid");
    expect(grids.map((g) => g.getAttribute("aria-label"))).toEqual(["Staged files", "Unstaged files", "Untracked files", "Conflicted files"]);
    for (const g of grids) expect(g).toHaveAttribute("aria-multiselectable", "true");
    for (const r of screen.getAllByRole("row")) expect(r).toHaveAttribute("aria-selected", "false");
  });

  it("plain click selects one row and opens its diff; Ctrl/Cmd-click toggles without opening a diff (D8)", async () => {
    const { api } = mountPanel(basic());
    await ready();
    fireEvent.click(rowBtn("b.ts"));
    expect(rowOf("b.ts")).toHaveAttribute("aria-selected", "true");
    await waitFor(() => expect(api.getCombinedFileDiff).toHaveBeenCalledWith("b.ts"));
    vi_clear(api);

    ctrlClick("c.ts");
    expect(rowOf("b.ts")).toHaveAttribute("aria-selected", "true");
    expect(rowOf("c.ts")).toHaveAttribute("aria-selected", "true");
    // The diff pane keeps the last plain-clicked row's diff.
    expect(api.getCombinedFileDiff).not.toHaveBeenCalledWith("c.ts");
    expect(within(document.querySelector(".gh-changes-panel__diff") as HTMLElement).getAllByText("b.ts").length).toBeGreaterThan(0);

    ctrlClick("c.ts");
    expect(rowOf("c.ts")).toHaveAttribute("aria-selected", "false");

    // Cmd-click (metaKey) is the same toggle.
    fireEvent.click(rowBtn("a.ts"), { metaKey: true });
    expect(rowOf("a.ts")).toHaveAttribute("aria-selected", "true");
  });

  it("Shift-click selects the range from the anchor across sections (D4)", async () => {
    mountPanel(basic());
    await ready();
    fireEvent.click(rowBtn("s.ts"));
    shiftClick("b.ts");
    for (const p of ["s.ts", "a.ts", "b.ts"]) expect(rowOf(p)).toHaveAttribute("aria-selected", "true");
    expect(rowOf("c.ts")).toHaveAttribute("aria-selected", "false");
  });

  it("selection is not colour-only: selected rows carry the --selected class (drawn check/bar) and aria-selected", async () => {
    mountPanel(basic());
    await ready();
    ctrlClick("a.ts");
    expect(rowOf("a.ts")).toHaveClass("gh-changes-panel__file--selected");
    expect(rowOf("b.ts")).not.toHaveClass("gh-changes-panel__file--selected");
  });

  it("announces the selection count in a polite live region", async () => {
    mountPanel(basic());
    await ready();
    fireEvent.click(rowBtn("a.ts"));
    ctrlClick("b.ts");
    ctrlClick("c.ts");
    const live = document.querySelector<HTMLElement>('p.gh-visually-hidden[role="status"]')!;
    expect(live).toHaveAttribute("aria-live", "polite");
    expect(live).toHaveTextContent("3 files selected");
  });

  it("clears the selection from the bulk bar's Clear button", async () => {
    mountPanel(basic());
    await ready();
    fireEvent.click(rowBtn("a.ts"));
    ctrlClick("b.ts");
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(screen.queryByRole("toolbar")).not.toBeInTheDocument();
    expect(rowOf("a.ts")).toHaveAttribute("aria-selected", "false");
  });
});

describe("keyboard (FR-505)", () => {
  it("arrows move focus without selecting; Shift+Arrow extends; Space toggles; Ctrl+A selects the section; Esc clears", async () => {
    mountPanel(basic());
    await ready();
    rowBtn("a.ts").focus();

    fireEvent.keyDown(rowBtn("a.ts"), { key: "ArrowDown" });
    expect(document.activeElement).toBe(rowBtn("b.ts"));
    expect(rowOf("b.ts")).toHaveAttribute("aria-selected", "false");

    fireEvent.keyDown(rowBtn("b.ts"), { key: "ArrowDown", shiftKey: true });
    expect(document.activeElement).toBe(rowBtn("c.ts"));
    expect(rowOf("b.ts")).toHaveAttribute("aria-selected", "true");
    expect(rowOf("c.ts")).toHaveAttribute("aria-selected", "true");

    fireEvent.keyDown(rowBtn("c.ts"), { key: "Escape" });
    expect(document.querySelectorAll('[role="row"][aria-selected="true"]')).toHaveLength(0);

    fireEvent.keyDown(rowBtn("c.ts"), { key: "a", ctrlKey: true });
    expect(document.querySelectorAll('[role="row"][aria-selected="true"]')).toHaveLength(3); // the Unstaged section only
    expect(rowOf("s.ts")).toHaveAttribute("aria-selected", "false");

    fireEvent.keyDown(rowBtn("c.ts"), { key: "ArrowUp", shiftKey: true });
    fireEvent.keyDown(rowBtn("b.ts"), { key: " " });
    expect(rowOf("b.ts")).toHaveAttribute("aria-selected", "false");
  });

  it("Space toggles the row without also opening its diff (the button's own click is suppressed)", async () => {
    const { api } = mountPanel(basic());
    await ready();
    await waitFor(() => expect(api.getCombinedFileDiff).toHaveBeenCalled());
    rowBtn("c.ts").focus();
    await userEvent.keyboard(" ");
    expect(rowOf("c.ts")).toHaveAttribute("aria-selected", "true");
    expect(api.getCombinedFileDiff).not.toHaveBeenCalledWith("c.ts");
  });

  it("Enter still activates a row like a click", async () => {
    const { api } = mountPanel(basic());
    await ready();
    rowBtn("c.ts").focus();
    await userEvent.keyboard("{Enter}");
    await waitFor(() => expect(api.getCombinedFileDiff).toHaveBeenCalledWith("c.ts"));
    expect(rowOf("c.ts")).toHaveAttribute("aria-selected", "true");
  });
});

describe("bulk bar (D5, FR-506, FR-507)", () => {
  it("appears at two selected rows with count and per-action eligibility, naming skipped rows before anything runs", async () => {
    mountPanel(basic());
    await ready();
    fireEvent.click(rowBtn("a.ts"));
    expect(screen.queryByRole("toolbar")).not.toBeInTheDocument();
    ctrlClick("s.ts");
    ctrlClick("x.ts"); // conflicted: never eligible
    const bar = screen.getByRole("toolbar", { name: /3 selected files/i });
    expect(within(bar).getByText("3 selected")).toBeInTheDocument();
    expect(within(bar).getByRole("button", { name: /^Stage 1\s*·\s*2 skipped/ })).toBeEnabled();
    expect(within(bar).getByRole("button", { name: /^Unstage 1\s*·\s*2 skipped/ })).toBeEnabled();
    expect(within(bar).getByRole("button", { name: /^Discard 1…\s*·\s*2 skipped/ })).toBeEnabled();
    // Conflicted rows never receive Ignore (FR-506/AC15).
    expect(within(bar).getByRole("button", { name: /^Ignore 2…\s*·\s*1 skipped/ })).toBeEnabled();
  });

  it("an action with nothing eligible is disabled with its reason", async () => {
    mountPanel(basic());
    await ready();
    fireEvent.click(rowBtn("a.ts"));
    ctrlClick("b.ts");
    const unstage = within(screen.getByRole("toolbar")).getByRole("button", { name: /^Unstage 0/ });
    expect(unstage).toBeDisabled();
    expect(unstage).toHaveAttribute("title", "Not staged.");
  });

  it("Stage sends only the eligible rows as one call, moves them to Staged, keeps them selected, and reports skipped", async () => {
    const { api } = mountPanel(basic());
    await ready();
    fireEvent.click(rowBtn("a.ts"));
    ctrlClick("t.ts");
    ctrlClick("s.ts");
    fireEvent.click(within(screen.getByRole("toolbar")).getByRole("button", { name: /^Stage 2/ }));
    await waitFor(() => expect(api.stagePaths).toHaveBeenCalledTimes(1));
    expect(api.stagePaths).toHaveBeenCalledWith([
      { path: "a.ts", section: "unstaged" },
      { path: "t.ts", section: "untracked" },
    ]);
    await waitFor(() => expect(screen.getByText("Staged (3)")).toBeInTheDocument());
    // FR-511: the staged rows keep their selection in their new section.
    expect(rowOf("a.ts")).toHaveAttribute("aria-selected", "true");
    expect(rowOf("t.ts")).toHaveAttribute("aria-selected", "true");
    expect(await screen.findByText("Staged 2 files, 1 skipped.")).toBeInTheDocument();
  });

  it("Unstage sends Staged rows to unstagePaths", async () => {
    const { api } = mountPanel(list({ staged: [file("s1.ts", "staged"), file("s2.ts", "staged")], unstaged: [file("u.ts", "unstaged")] }));
    await waitFor(() => expect(screen.getByText("Staged (2)")).toBeInTheDocument());
    fireEvent.click(rowBtn("s1.ts"));
    ctrlClick("s2.ts");
    fireEvent.click(within(screen.getByRole("toolbar")).getByRole("button", { name: /^Unstage 2/ }));
    await waitFor(() =>
      expect(api.unstagePaths).toHaveBeenCalledWith([
        { path: "s1.ts", section: "staged" },
        { path: "s2.ts", section: "staged" },
      ]),
    );
    await waitFor(() => expect(screen.getByText("Unstaged (3)")).toBeInTheDocument());
  });

  it("a failed bulk stage reverts the optimistic move and names the paths that did not change (FR-507)", async () => {
    const { api } = mountPanel(basic());
    await ready();
    api.stagePaths = ((() =>
      Promise.resolve({
        ok: false,
        error: {
          name: "BulkStagingError",
          code: "BULK_STAGING_FAILED",
          message: "Bulk operation failed",
          details: { changed: [], unchanged: ["a.ts", "b.ts"], gitMessage: "index.lock exists" },
        },
      })) as unknown) as typeof api.stagePaths;
    fireEvent.click(rowBtn("a.ts"));
    ctrlClick("b.ts");
    fireEvent.click(within(screen.getByRole("toolbar")).getByRole("button", { name: /^Stage 2/ }));
    const alert = await screen.findByText(/Couldn't stage 2 files: index\.lock exists\. Not changed: a\.ts, b\.ts\./);
    expect(alert).toBeInTheDocument();
    expect(screen.getByText("Unstaged (3)")).toBeInTheDocument();
    expect(screen.queryByText("Staged (2)")).not.toBeInTheDocument();
  });
});

describe("live refresh (FR-511)", () => {
  it("keeps a path selected when it moves section, drops a vanished one silently, and updates the count", async () => {
    const { ctl } = mountPanel(basic());
    await ready();
    fireEvent.click(rowBtn("a.ts"));
    ctrlClick("b.ts");
    ctrlClick("c.ts");
    expect(screen.getByText("3 selected")).toBeInTheDocument();

    // a.ts was staged elsewhere, b.ts reverted, c.ts untouched.
    act(() => {
      ctl.current!.read(
        list({
          staged: [file("s.ts", "staged"), file("a.ts", "staged")],
          unstaged: [file("c.ts", "unstaged")],
          untracked: [file("t.ts", "untracked", "added")],
          conflicted: [file("x.ts", "conflicted", "unmerged")],
        }),
      );
    });
    await waitFor(() => expect(screen.getByText("2 selected")).toBeInTheDocument());
    expect(rowOf("a.ts")).toHaveAttribute("aria-selected", "true");
    expect(rowOf("a.ts").closest("section")).toHaveTextContent(/Staged/);
    expect(rowOf("c.ts")).toHaveAttribute("aria-selected", "true");
    expect(document.querySelector('[data-row-key$=":b.ts"]')).toBeNull();
  });

  it("drops the bar when the selection falls below two rows", async () => {
    const { ctl } = mountPanel(basic());
    await ready();
    fireEvent.click(rowBtn("a.ts"));
    ctrlClick("b.ts");
    act(() => {
      ctl.current!.read(list({ unstaged: [file("a.ts", "unstaged")] }));
    });
    await waitFor(() => expect(screen.queryByRole("toolbar")).not.toBeInTheDocument());
    expect(rowOf("a.ts")).toHaveAttribute("aria-selected", "true");
  });

  it("focus falls to the nearest surviving row after a bulk action (never body)", async () => {
    mountPanel(list({ unstaged: [file("a.ts", "unstaged"), file("b.ts", "unstaged"), file("c.ts", "unstaged")] }));
    await waitFor(() => expect(screen.getByText("Unstaged (3)")).toBeInTheDocument());
    fireEvent.click(rowBtn("a.ts"));
    ctrlClick("b.ts");
    rowBtn("b.ts").focus();
    fireEvent.click(within(screen.getByRole("toolbar")).getByRole("button", { name: /^Stage 2/ }));
    await waitFor(() => expect(screen.getByText("Staged (2)")).toBeInTheDocument());
    await waitFor(() => expect(document.activeElement).not.toBe(document.body));
    expect(document.activeElement).toBe(rowBtn("b.ts"));
  });
});

describe("context menu on selected rows (D5)", () => {
  it("right-clicking a selected row in a multi-selection offers the bulk actions on the whole selection", async () => {
    const { api } = mountPanel(basic());
    await ready();
    fireEvent.click(rowBtn("a.ts"));
    ctrlClick("b.ts");
    fireEvent.contextMenu(rowOf("a.ts"), { clientX: 10, clientY: 10 });
    const menu = await screen.findByRole("menu", { name: "Actions for 2 selected files" });
    expect(within(menu).getByRole("menuitem", { name: "Unstage 0 files" })).toBeDisabled();
    expect(within(menu).getByRole("menuitem", { name: "Discard 2 files…" })).toBeEnabled();
    expect(within(menu).getByRole("menuitem", { name: "Ignore 2 files…" })).toBeEnabled();
    await userEvent.click(within(menu).getByRole("menuitem", { name: "Stage 2 files" }));
    await waitFor(() => expect(api.stagePaths).toHaveBeenCalledWith([
      { path: "a.ts", section: "unstaged" },
      { path: "b.ts", section: "unstaged" },
    ]));
  });

  it("right-clicking an unselected row selects just that row (without opening its diff) and offers the per-file menu", async () => {
    const { api } = mountPanel(basic());
    await ready();
    fireEvent.click(rowBtn("a.ts"));
    ctrlClick("b.ts");
    fireEvent.contextMenu(rowOf("c.ts"), { clientX: 10, clientY: 10 });
    const menu = await screen.findByRole("menu", { name: "Actions for c.ts" });
    expect(within(menu).getByRole("menuitem", { name: "Blame" })).toBeInTheDocument();
    expect(within(menu).getByRole("menuitem", { name: "Ignore…" })).toBeEnabled();
    expect(rowOf("c.ts")).toHaveAttribute("aria-selected", "true");
    expect(rowOf("a.ts")).toHaveAttribute("aria-selected", "false");
    expect(api.getCombinedFileDiff).not.toHaveBeenCalledWith("c.ts");
  });

  it("a conflicted row's menu disables Ignore with the reason (FR-501)", async () => {
    mountPanel(basic());
    await ready();
    fireEvent.contextMenu(rowOf("x.ts"), { clientX: 10, clientY: 10 });
    const menu = await screen.findByRole("menu");
    const item = within(menu).getByRole("menuitem", { name: "Ignore…" });
    expect(item).toBeDisabled();
    expect(item).toHaveAttribute("title", expect.stringMatching(/conflict/i));
  });
});

/** Forget calls so an assertion only sees what a later interaction triggered. */
function vi_clear(api: ReturnType<typeof mountPanel>["api"]) {
  (api.getCombinedFileDiff as unknown as { mockClear: () => void }).mockClear();
}
