// SPDX-License-Identifier: GPL-3.0-or-later
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { OpenInProgramModel } from "../../lib/openInProgram";
import { mockProgram } from "../../test/mockGitHydra";
import { OpenFolderSplitButton } from "./OpenFolderSplitButton";

/** specs/external-programs.md FR-624, AC8. */
function model(over: Partial<OpenInProgramModel> = {}): OpenInProgramModel {
  return {
    snapshot: { programs: [mockProgram({ id: "cursor", name: "Cursor" }), mockProgram({ id: "zed", name: "Zed" })], defaultId: "cursor", fallbackReason: null },
    refresh: vi.fn(),
    openInTab: vi.fn(),
    openInProgram: vi.fn(),
    managePrograms: vi.fn(),
    ...over,
  };
}

describe("OpenFolderSplitButton", () => {
  it("the main part runs the default program once and opens no menu", async () => {
    const m = model();
    render(<OpenFolderSplitButton model={m} disabledReason={null} />);
    await userEvent.click(screen.getByRole("button", { name: "Open folder in editor" }));
    expect(m.openInProgram).toHaveBeenCalledTimes(1);
    expect(m.openInProgram).toHaveBeenCalledWith("cursor");
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("the chevron opens the same list expanded (no GitHydra tab row), focus on the default, and Esc returns focus to the chevron", async () => {
    render(<OpenFolderSplitButton model={model()} disabledReason={null} />);
    const chevron = screen.getByRole("button", { name: "Choose a program to open the folder in" });
    expect(chevron).toHaveAttribute("aria-haspopup", "menu");
    expect(chevron).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(chevron);
    const menu = await screen.findByRole("menu", { name: "Open folder in editor" });
    expect(chevron).toHaveAttribute("aria-expanded", "true");
    expect(within(menu).queryByRole("menuitem", { name: "GitHydra tab" })).toBeNull();
    expect(within(menu).getByRole("menuitem", { name: /Cursor/ })).toHaveFocus();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).toBeNull();
    await Promise.resolve();
    expect(document.activeElement).toBe(chevron);
  });

  it("with no default the main part opens the list instead of launching", async () => {
    const m = model({ snapshot: { programs: [mockProgram({ id: "cursor", name: "Cursor" })], defaultId: null, fallbackReason: null } });
    render(<OpenFolderSplitButton model={m} disabledReason={null} />);
    await userEvent.click(screen.getByRole("button", { name: "Open folder in editor" }));
    expect(m.openInProgram).not.toHaveBeenCalled();
    expect(await screen.findByRole("menu", { name: "Open folder in editor" })).toBeInTheDocument();
  });

  it("a GitHydra-tab default cannot run anything here, so the list opens", async () => {
    const m = model({ snapshot: { programs: [mockProgram({ id: "cursor", name: "Cursor" })], defaultId: "githydra-tab", fallbackReason: null } });
    render(<OpenFolderSplitButton model={m} disabledReason={null} />);
    await userEvent.click(screen.getByRole("button", { name: "Open folder in editor" }));
    expect(m.openInProgram).not.toHaveBeenCalled();
    expect(screen.getByRole("menu", { name: "Open folder in editor" })).toBeInTheDocument();
  });

  it("is aria-disabled with its reason when no folder can be opened, and does nothing", async () => {
    const m = model();
    render(<OpenFolderSplitButton model={m} disabledReason="Open a repository with a working folder first." />);
    const main = screen.getByRole("button", { name: "Open folder in editor" });
    expect(main).toHaveAttribute("aria-disabled", "true");
    expect(main).toHaveAccessibleDescription("Open a repository with a working folder first.");
    await userEvent.click(main);
    await userEvent.click(screen.getByRole("button", { name: "Choose a program to open the folder in" }));
    expect(m.openInProgram).not.toHaveBeenCalled();
    expect(screen.queryByRole("menu")).toBeNull();
  });
});
