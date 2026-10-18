// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { WorktreeEntry, WorktreeList } from "@githydra/git-core";
import { getCommands, type CommandContext } from "../../lib/commands";
import { makeMockGitHydra, mockWorktreeEntry } from "../../test/mockGitHydra";
import { WorktreePickerHost } from "../WorktreePicker/WorktreePickerHost";

const main = mockWorktreeEntry({ id: null, isMain: true, path: "/w/acme", branch: "main" });
const login = mockWorktreeEntry({ id: "tl", path: "/w/acme.worktrees/tour-login", branch: "tour-login" });
const detached = mockWorktreeEntry({ id: "dt", path: "/w/acme.worktrees/hotfix", branch: null, head: "abc1234" + "0".repeat(33) });
const locked = mockWorktreeEntry({ id: "lk", path: "/w/acme.worktrees/old", branch: "old", locked: true, lockReason: "usb" });

const list = (entries: WorktreeEntry[]): WorktreeList => ({
  entries,
  untrusted: false,
  untrustedReason: null,
  commonDir: "/w/acme/.git",
  mainPath: "/w/acme",
  format: "nul",
  mainPathIsGitDir: false,
});

describe("palette entry (FR-656, AC 20)", () => {
  const ctx = (w: Partial<NonNullable<CommandContext["worktrees"]>>): CommandContext =>
    ({
      tabs: [],
      activeTabId: null,
      repoOpen: true,
      selectionCommands: {},
      editCommands: {},
      worktrees: { available: true, newBranchDisabledReason: null, createNew: vi.fn(), createFromBranch: vi.fn(), open: vi.fn(), remove: vi.fn(), ...w },
    }) as unknown as CommandContext;

  it("is registered with this label and no default keybinding", () => {
    const c = ctx({ copyInto: vi.fn(), copyIntoDisabledReason: null });
    const cmd = getCommands(c).find((x) => x.label === "Copy ignored files into worktree...")!;
    expect(cmd).toBeDefined();
    expect(cmd.keybindings ?? []).toEqual([]);
    expect(cmd.isAvailable(c)).toBe(true);
    expect(cmd.disabledReason?.(c)).toBeNull();
    cmd.run(c);
    expect(c.worktrees!.copyInto).toHaveBeenCalled();
  });

  it("carries the two disabled reasons through", () => {
    for (const reason of ["No other worktree to copy into", "This is a bare repository: there is nothing to copy."]) {
      const c = ctx({ copyInto: vi.fn(), copyIntoDisabledReason: reason });
      expect(getCommands(c).find((x) => x.label === "Copy ignored files into worktree...")!.disabledReason?.(c)).toBe(reason);
    }
  });

  it("is hidden when worktree info is unavailable", () => {
    const c = ctx({ available: false, copyInto: vi.fn() });
    expect(getCommands(c).find((x) => x.label === "Copy ignored files into worktree...")!.isAvailable(c)).toBe(false);
  });
});

describe("destination picker (FR-656, AC 20)", () => {
  function setup(entries: WorktreeEntry[], activePath = "/w/acme") {
    const onCopyInto = vi.fn();
    const onBack = vi.fn();
    const onClose = vi.fn();
    render(
      <WorktreePickerHost
        mode="copyInto"
        api={makeMockGitHydra({ repoPath: "/w/acme" })}
        list={list(entries)}
        activePath={activePath}
        onCreateForBranch={vi.fn()}
        onCreateForRemote={vi.fn()}
        onOpen={vi.fn()}
        onRemove={vi.fn()}
        onCopyInto={onCopyInto}
        onBack={onBack}
        onClose={onClose}
      />,
    );
    return { onCopyInto, onBack, onClose };
  }

  it("has the context line, placeholder and listbox name; the source is left out; the footer hints are the three keys", () => {
    setup([main, login, detached]);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText("Copy ignored files from acme into which worktree?")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Choose a worktree")).toBeInTheDocument();
    const box = screen.getByRole("listbox", { name: "Worktrees" });
    const options = within(box).getAllByRole("option");
    expect(options).toHaveLength(2);
    expect(options.map((o) => o.textContent)).toEqual([
      "tour-logintour-login · /w/acme.worktrees/tour-login",
      "detached abc1234detached at abc1234 · /w/acme.worktrees/hotfix",
    ]);
    expect(screen.getByText("Up Down move")).toBeInTheDocument();
    expect(screen.getByText("Enter choose")).toBeInTheDocument();
    expect(screen.getByText("Esc back")).toBeInTheDocument();
  });

  it("Enter chooses the highlighted eligible worktree", async () => {
    const { onCopyInto } = setup([main, login]);
    await userEvent.keyboard("{Enter}");
    expect(onCopyInto).toHaveBeenCalledWith(login);
  });

  it("a refused destination stays listed, aria-disabled, with its reason; Enter on it does nothing and keeps focus", async () => {
    const { onCopyInto } = setup([main, locked, login]);
    const lockedOption = screen.getByRole("option", { name: /old/ });
    expect(lockedOption).toHaveAttribute("aria-disabled", "true");
    expect(lockedOption).toHaveTextContent("Locked: unlock it first");
    const input = screen.getByRole("combobox");
    await userEvent.keyboard("{Enter}"); // highlighted: the locked one (list order)
    expect(onCopyInto).not.toHaveBeenCalled();
    expect(input).toHaveFocus();
    expect(screen.queryByText(/^old: /)).toBeNull(); // no extra notice: the reason is already on the row
  });

  it("filters on folder name, branch and path", async () => {
    setup([main, login, detached]);
    const names = () => screen.getAllByRole("option").map((o) => o.textContent);
    await userEvent.type(screen.getByRole("combobox"), "hotfix");
    expect(names()).toHaveLength(1);
    await userEvent.clear(screen.getByRole("combobox"));
    await userEvent.type(screen.getByRole("combobox"), "tour-login");
    expect(names()).toHaveLength(1);
    await userEvent.clear(screen.getByRole("combobox"));
    await userEvent.type(screen.getByRole("combobox"), "worktrees/");
    expect(names()).toHaveLength(2);
  });

  it("Esc steps back to the command list; the backdrop closes", () => {
    const { onBack, onClose } = setup([main, login]);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onBack).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.mouseDown(document.querySelector(".gh-command-palette__overlay")!);
    expect(onClose).toHaveBeenCalled();
  });
});
