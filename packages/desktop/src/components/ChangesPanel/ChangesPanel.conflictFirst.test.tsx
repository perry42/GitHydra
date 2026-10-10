// SPDX-License-Identifier: GPL-3.0-or-later
// specs/conflict-first-layout.md FR-573..FR-575: Conflicted first, the rest collapsed, first conflict opened.
import { describe, expect, it } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { file, list, mountPanel } from "../../test/changesPanelHarness";

const withConflict = () =>
  list({
    staged: [file("s.ts", "staged")],
    unstaged: [file("a.ts", "unstaged")],
    untracked: [file("t.ts", "untracked", "added")],
    conflicted: [file("x.ts", "conflicted", "unmerged")],
  });
const headings = () => Array.from(document.querySelectorAll(".gh-changes-panel__section-heading")).map((h) => h.textContent);

describe("conflict-first Changes layout", () => {
  it("renders Conflicted first and the other sections as collapsed toggles with counts (FR-573)", async () => {
    mountPanel(withConflict());
    await waitFor(() => expect(screen.getByText("Conflicted (1)")).toBeInTheDocument());
    expect(headings().map((h) => h?.replace(/^[▸▾]/, ""))).toEqual(["Conflicted (1)", "Staged (1)", "Unstaged (1)", "Untracked (1)"]);
    for (const name of [/^Staged \(1\)/, /^Unstaged \(1\)/, /^Untracked \(1\)/]) {
      expect(screen.getByRole("button", { name })).toHaveAttribute("aria-expanded", "false");
    }
    expect(screen.getAllByRole("grid").map((g) => g.getAttribute("aria-label"))).toEqual(["Conflicted files"]);
  });

  it("expands a collapsed section on click and collapses it again; keyboard Enter works (FR-574)", async () => {
    mountPanel(withConflict());
    const toggle = await screen.findByRole("button", { name: /^Unstaged \(1\)/ });
    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("grid", { name: "Unstaged files" })).toBeInTheDocument();
    toggle.focus();
    await userEvent.keyboard("{Enter}");
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("grid", { name: "Unstaged files" })).not.toBeInTheDocument();
  });

  it("keeps the normal order and expansion when there are no conflicts", async () => {
    mountPanel(list({ staged: [file("s.ts", "staged")], unstaged: [file("a.ts", "unstaged")] }));
    await waitFor(() => expect(screen.getByText("Staged (1)")).toBeInTheDocument());
    expect(headings()[0]).toBe("Staged (1)");
    expect(document.querySelector(".gh-changes-panel__section-toggle")).toBeNull();
    expect(screen.getAllByRole("grid")).toHaveLength(2);
  });

  it("restores normal order and expansion once the last conflict is resolved", async () => {
    const { ctl } = mountPanel(withConflict());
    await screen.findByRole("button", { name: /^Staged \(1\)/ });
    await userEvent.click(screen.getByRole("button", { name: /^Staged \(1\)/ }));
    ctl.current!.read(list({ staged: [file("s.ts", "staged")], unstaged: [file("a.ts", "unstaged")] }));
    await waitFor(() => expect(screen.queryByText(/Conflicted \(1\)/)).toBeNull());
    expect(document.querySelector(".gh-changes-panel__section-toggle")).toBeNull();
    expect(screen.getAllByRole("grid")).toHaveLength(2);
  });

  it("keyboard arrows skip rows hidden in collapsed sections", async () => {
    mountPanel(list({ staged: [file("s.ts", "staged")], conflicted: [file("x.ts", "conflicted", "unmerged"), file("y.ts", "conflicted", "unmerged")] }));
    await waitFor(() => expect(screen.getByText("Conflicted (2)")).toBeInTheDocument());
    const x = document.querySelector<HTMLElement>('[data-row-key="conflicted:x.ts"]')!;
    x.focus();
    fireEvent.keyDown(x, { key: "ArrowDown" });
    expect(document.activeElement).toBe(document.querySelector('[data-row-key="conflicted:y.ts"]'));
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    expect(document.activeElement).toBe(document.querySelector('[data-row-key="conflicted:y.ts"]'));
  });

  it("opens the first conflicted file when an operation is in progress (FR-575)", async () => {
    const { api } = mountPanel(withConflict(), { operationLabel: "merge" });
    await waitFor(() => expect(api.probeEditableFile).toHaveBeenCalledWith("x.ts"));
  });
});
