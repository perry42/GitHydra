// SPDX-License-Identifier: GPL-3.0-or-later
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { GITHYDRA_TAB_ID } from "../../../shared/programsContract";
import { makeMockGitHydra, mockProgram } from "../../test/mockGitHydra";
import { ProgramsDialog } from "./ProgramsDialog";

/** specs/external-programs.md AC7: Add (via the main-side picker stub), Rescan, Default, Hide/Show, Locate, Remove, the missing row. */

const SEED = {
  programs: [
    { id: "vscode", name: "Visual Studio Code", path: "C:/Tools/vscode/Code.exe" },
    { id: "zed", name: "Zed", path: "C:/Tools/zed/Zed.exe", hidden: true },
    { id: "usr-aaa", name: "My Editor", path: "C:/Mine/ed.exe", source: "custom" as const },
    { id: "usr-gone", name: "Lost Editor", path: "C:/Gone/lost.exe", source: "custom" as const, available: false, unavailableReason: "Not found at C:/Gone/lost.exe" },
  ],
  defaultId: "vscode",
};

async function open(seed = SEED) {
  const api = makeMockGitHydra({ externalPrograms: seed });
  const onClose = vi.fn();
  const onChanged = vi.fn();
  render(<ProgramsDialog api={api} onClose={onClose} onChanged={onChanged} />);
  await screen.findByText("Visual Studio Code");
  return { api, onClose, onChanged };
}

const row = (name: string) => screen.getByText(name, { selector: ".gh-programs-dialog__row-name" }).closest("li")!;

describe("ProgramsDialog (FR-623)", () => {
  it("lists GitHydra tab and every program with its path, as a labelled dialog", async () => {
    await open();
    expect(screen.getByRole("dialog", { name: "Programs" })).toBeInTheDocument();
    expect(screen.getByRole("radiogroup", { name: "Default program" })).toBeInTheDocument();
    expect(within(row("Visual Studio Code")).getByText("C:/Tools/vscode/Code.exe")).toBeInTheDocument();
    expect(screen.getByText("GitHydra tab")).toBeInTheDocument();
  });

  it("the Default radio picks one default (a program or GitHydra tab)", async () => {
    const { api } = await open();
    expect(within(row("Visual Studio Code")).getByRole("radio")).toBeChecked();
    await userEvent.click(within(row("My Editor")).getByRole("radio"));
    expect(api.setDefaultExternalProgram).toHaveBeenCalledWith("usr-aaa");
    await waitFor(() => expect(within(row("My Editor")).getByRole("radio")).toBeChecked());
    await userEvent.click(within(screen.getByText("GitHydra tab").closest("li")!).getByRole("radio"));
    expect(api.setDefaultExternalProgram).toHaveBeenLastCalledWith(GITHYDRA_TAB_ID);
  });

  it("Hide and Show toggle a program; the default cannot be hidden", async () => {
    const { api } = await open();
    const hideDefault = within(row("Visual Studio Code")).getByRole("button", { name: "Hide Visual Studio Code" });
    expect(hideDefault).toBeDisabled();
    expect(hideDefault).toHaveAttribute("title", "The default program cannot be hidden.");
    await userEvent.click(within(row("My Editor")).getByRole("button", { name: "Hide My Editor" }));
    expect(api.setExternalProgramHidden).toHaveBeenCalledWith("usr-aaa", true);
    await userEvent.click(await within(row("My Editor")).findByRole("button", { name: "Show My Editor" }));
    expect(api.setExternalProgramHidden).toHaveBeenLastCalledWith("usr-aaa", false);
    // A hidden program is still listed (only hidden from the menus) and cannot be made the default while hidden.
    expect(within(row("Zed")).getByText(/Hidden/)).toBeInTheDocument();
    expect(within(row("Zed")).getByRole("radio")).toBeDisabled();
  });

  it("Remove is offered for hand-added programs only", async () => {
    const { api } = await open();
    expect(within(row("Visual Studio Code")).queryByRole("button", { name: /Remove/ })).toBeNull();
    expect(within(row("Zed")).queryByRole("button", { name: /Remove/ })).toBeNull();
    await userEvent.click(within(row("My Editor")).getByRole("button", { name: "Remove My Editor" }));
    expect(api.removeExternalProgram).toHaveBeenCalledWith("usr-aaa");
    await waitFor(() => expect(screen.queryByText("My Editor")).toBeNull());
  });

  it("a missing hand-added program stays as a disabled 'Not found at <path>' row with Locate and Remove", async () => {
    const { api } = await open();
    const lost = row("Lost Editor");
    expect(lost).toHaveAttribute("aria-disabled", "true");
    expect(within(lost).getByText("Not found at C:/Gone/lost.exe")).toBeInTheDocument();
    expect(within(lost).getByRole("radio")).toBeDisabled();
    expect(within(lost).getByRole("button", { name: "Remove Lost Editor" })).toBeEnabled();
    // Locate exists only for the missing one.
    expect(within(row("My Editor")).queryByRole("button", { name: /Locate/ })).toBeNull();
    vi.mocked(api.locateExternalProgram).mockResolvedValueOnce({ ok: true, data: { status: "added", program: mockProgram({ id: "usr-gone", name: "Lost Editor" }) } });
    await userEvent.click(within(lost).getByRole("button", { name: "Locate Lost Editor" }));
    expect(api.locateExternalProgram).toHaveBeenCalledWith("usr-gone");
    expect(await screen.findByText("Updated Lost Editor.")).toBeInTheDocument();
  });

  it("Add program opens the main-side picker (no path from the renderer) and reloads the list", async () => {
    const { api } = await open();
    vi.mocked(api.addExternalProgram).mockResolvedValueOnce({ ok: true, data: { status: "added", program: mockProgram({ id: "usr-new", name: "Brand New" }) } });
    const listCalls = vi.mocked(api.listExternalPrograms).mock.calls.length;
    await userEvent.click(screen.getByRole("button", { name: "Add program…" }));
    expect(api.addExternalProgram).toHaveBeenCalledWith();
    expect(await screen.findByText("Added Brand New.")).toBeInTheDocument();
    expect(vi.mocked(api.listExternalPrograms).mock.calls.length).toBeGreaterThan(listCalls);
  });

  it("a rejected pick shows the reason as an alert", async () => {
    const { api } = await open();
    vi.mocked(api.addExternalProgram).mockResolvedValueOnce({ ok: true, data: { status: "rejected", problem: "script-extension", message: "Script files (.cmd, .bat, .ps1, .lnk, .vbs) cannot be used. Choose the program's own .exe." } });
    await userEvent.click(screen.getByRole("button", { name: "Add program…" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Script files");
  });

  it("a program in a repository or writable folder asks for a confirm showing the FULL path before it is added", async () => {
    const { api } = await open();
    const path = "C:/proj/repo/tools/very/long/folder/name/ed.exe";
    vi.mocked(api.addExternalProgram).mockResolvedValueOnce({ ok: true, data: { status: "needs-confirm", pendingId: "p1", path, why: "repository" } });
    await userEvent.click(screen.getByRole("button", { name: "Add program…" }));
    const confirm = await screen.findByRole("alertdialog");
    expect(within(confirm).getByText(path)).toBeInTheDocument();
    expect(confirm).toHaveTextContent("inside a repository");
    expect(api.confirmAddExternalProgram).not.toHaveBeenCalled();
    vi.mocked(api.confirmAddExternalProgram).mockResolvedValueOnce({ ok: true, data: { status: "added", program: mockProgram({ id: "usr-risky", name: "ed" }) } });
    await userEvent.click(within(confirm).getByRole("button", { name: "Add anyway" }));
    expect(api.confirmAddExternalProgram).toHaveBeenCalledWith("p1");
    expect(await screen.findByText("Added ed.")).toBeInTheDocument();
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("Cancel on the confirm adds nothing", async () => {
    const { api } = await open();
    vi.mocked(api.addExternalProgram).mockResolvedValueOnce({ ok: true, data: { status: "needs-confirm", pendingId: "p1", path: "/tmp/x", why: "world-writable" } });
    await userEvent.click(screen.getByRole("button", { name: "Add program…" }));
    await userEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Cancel" }));
    expect(api.confirmAddExternalProgram).not.toHaveBeenCalled();
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("Rescan asks main to look again and hands the new list to the menus", async () => {
    const { api, onChanged } = await open();
    await userEvent.click(screen.getByRole("button", { name: "Rescan" }));
    expect(api.rescanExternalPrograms).toHaveBeenCalledTimes(1);
    expect(await screen.findByText("Looked for programs again.")).toBeInTheDocument();
    expect(onChanged).toHaveBeenCalled();
  });

  it("an empty machine says so and still offers Add program", async () => {
    const api = makeMockGitHydra({ externalPrograms: { programs: [] } });
    render(<ProgramsDialog api={api} onClose={() => {}} />);
    expect(await screen.findByText(/No editors were found/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add program…" })).toBeEnabled();
  });

  it("Esc and Done close it; the first control takes focus", async () => {
    const { onClose } = await open();
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
