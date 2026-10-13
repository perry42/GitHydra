// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { makeLocalBranch, makeRemoteBranch } from "../../test/fixtures";
import { makeMockGitHydra, mockWorktreeEntry } from "../../test/mockGitHydra";
import { WorktreePicker } from "./WorktreePicker";
import { WorktreePickerHost } from "./WorktreePickerHost";

describe("WorktreePicker (FR-607)", () => {
  const items = [
    { key: "a", label: "alpha", secondary: "/w/a", disabledReason: null },
    { key: "m", label: "main", secondary: "/w/m", disabledReason: "The main worktree cannot be removed." },
  ];

  it("picks with Enter; a disabled row is reachable by keyboard, its reason is shown, and Enter on it does nothing", async () => {
    const onPick = vi.fn();
    render(<WorktreePicker title="Worktree: Remove" placeholder="p" emptyText="none" items={items} onPick={onPick} onClose={() => {}} />);
    const input = screen.getByRole("combobox", { name: "Worktree: Remove" });
    expect(input).toHaveFocus();
    await userEvent.keyboard("{ArrowDown}");
    expect(screen.getByRole("status")).toHaveTextContent("The main worktree cannot be removed.");
    expect(input).toHaveAttribute("aria-activedescendant", expect.stringMatching(/-1$/));
    await userEvent.keyboard("{Enter}");
    expect(onPick).not.toHaveBeenCalled();
    expect(screen.getByRole("status")).toHaveTextContent("main: The main worktree cannot be removed.");
    await userEvent.keyboard("{ArrowUp}{Enter}");
    expect(onPick).toHaveBeenCalledWith("a");
  });

  it("filters by typing and closes on Escape", async () => {
    const onClose = vi.fn();
    render(<WorktreePicker title="t" placeholder="p" emptyText="No worktrees match" items={items} onPick={() => {}} onClose={onClose} />);
    await userEvent.type(screen.getByRole("combobox"), "zzz");
    expect(screen.getByText("No worktrees match")).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalled();
  });
});

describe("WorktreePickerHost", () => {
  const list = {
    entries: [mockWorktreeEntry({ id: null, isMain: true, path: "/w/repo", branch: "main" }), mockWorktreeEntry({ id: "f", path: "/w/f", branch: "feature", locked: true, lockReason: "usb" })],
    untrusted: false,
    untrustedReason: null,
    commonDir: "/w/repo/.git",
    mainPath: "/w/repo",
    format: "nul" as const,
    mainPathIsGitDir: false,
  };

  it("Remove lists the main and locked entries disabled, with the exact reasons", () => {
    render(<WorktreePickerHost mode="remove" api={makeMockGitHydra()} list={list} onCreateForBranch={() => {}} onCreateForRemote={() => {}} onOpen={() => {}} onRemove={() => {}} onClose={() => {}} />);
    const options = screen.getAllByRole("option");
    expect(options).toHaveLength(2);
    expect(options[0]).toHaveAttribute("aria-disabled", "true");
    expect(options[0]).toHaveTextContent("The main worktree cannot be removed.");
    expect(options[1]).toHaveTextContent("Locked: usb. Unlock it with git worktree unlock before removing.");
  });

  it("Open picks an entry; Create from branch lists checked-out branches disabled and remote-only ones as creatable", async () => {
    const onOpen = vi.fn();
    const { unmount } = render(<WorktreePickerHost mode="open" api={makeMockGitHydra()} list={list} onCreateForBranch={() => {}} onCreateForRemote={() => {}} onOpen={onOpen} onRemove={() => {}} onClose={() => {}} />);
    await userEvent.keyboard("{ArrowDown}{Enter}");
    expect(onOpen).toHaveBeenCalledWith(list.entries[1]);
    unmount();

    const api = makeMockGitHydra({
      localBranches: [makeLocalBranch("main", { isCurrent: true }), makeLocalBranch("feature", { checkedOutInWorktree: "/w/f" }), makeLocalBranch("free")],
      remoteBranches: [makeRemoteBranch("origin", "release"), makeRemoteBranch("origin", "free")],
    });
    const onCreateForBranch = vi.fn();
    const onCreateForRemote = vi.fn();
    render(<WorktreePickerHost mode="createFromBranch" api={api} list={list} onCreateForBranch={onCreateForBranch} onCreateForRemote={onCreateForRemote} onOpen={() => {}} onRemove={() => {}} onClose={() => {}} />);
    await waitFor(() => expect(screen.getAllByRole("option").length).toBe(4));
    const byText = (t: string) => screen.getAllByRole("option").find((o) => o.textContent?.startsWith(t))!;
    expect(byText("main")).toHaveAttribute("aria-disabled", "true");
    expect(byText("main")).toHaveTextContent("current branch");
    expect(byText("feature")).toHaveTextContent("Checked out at /w/f");
    expect(screen.queryByText("origin/free")).toBeNull();
    await userEvent.click(byText("origin/release"));
    expect(onCreateForRemote).toHaveBeenCalledWith("origin", "release");
  });
});
