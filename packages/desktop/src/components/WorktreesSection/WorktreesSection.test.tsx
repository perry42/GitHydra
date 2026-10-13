// SPDX-License-Identifier: GPL-3.0-or-later
import { createRef } from "react";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { WorktreeEntry, WorktreeList } from "@githydra/git-core";
import { mockWorktreeEntry } from "../../test/mockGitHydra";
import { WorktreesSection, type WorktreesSectionProps } from "./WorktreesSection";

function list(entries: WorktreeEntry[], over: Partial<WorktreeList> = {}): WorktreeList {
  return { entries, untrusted: false, untrustedReason: null, commonDir: "/w/repo/.git", mainPath: "/w/repo", format: "nul", mainPathIsGitDir: false, ...over };
}

const main = mockWorktreeEntry({ id: null, isMain: true, path: "/w/repo", branch: "main" });

function setup(entries: WorktreeEntry[], props: Partial<WorktreesSectionProps> = {}) {
  const handlers = {
    onOpen: vi.fn(),
    onRemove: vi.fn(),
    onCleanUp: vi.fn(),
    onCreate: vi.fn(),
  };
  const ui = render(
    <WorktreesSection
      status="ready"
      list={list(entries)}
      errorMessage={null}
      unavailable={false}
      isOpenAsTab={() => false}
      headingRef={createRef<HTMLHeadingElement>()}
      {...handlers}
      {...props}
    />,
  );
  return { ...handlers, ...ui };
}

describe("WorktreesSection (FR-613)", () => {
  it("lists one row per worktree: glyph, name, full path as selectable text and as a tooltip", () => {
    window.localStorage.setItem("githydra:layout:worktreesCollapsed", "0");
    const linked = mockWorktreeEntry({ id: "f", path: "/w/repo.worktrees/feature", branch: "feature" });
    setup([main, linked]);
    const row = screen.getByRole("listitem", { name: /Worktree feature, linked/ });
    const path = within(row).getByText("/w/repo.worktrees/feature");
    expect(path).toHaveAttribute("title", "/w/repo.worktrees/feature");
    expect(path.className).toContain("gh-worktrees__path");
    expect(within(row).getByRole("button", { name: "Actions for worktree feature" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /Worktrees \(2\)/ })).toBeInTheDocument();
    // Icons are decorative.
    expect(row.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
  });

  it("shows 'detached <short sha>' for a detached worktree and the tab / Locked / Missing flags", () => {
    window.localStorage.setItem("githydra:layout:worktreesCollapsed", "0");
    const d = mockWorktreeEntry({ id: "d", path: "/w/d", branch: null, head: "abcdef1234567890" });
    const l = mockWorktreeEntry({ id: "l", path: "/w/l", branch: "locked-one", locked: true, lockReason: "usb" });
    const m = mockWorktreeEntry({ id: "m", path: "/w/m", branch: "gone", prunable: true });
    setup([main, d, l, m], { isOpenAsTab: (e) => e.id === "l" });
    expect(screen.getByText("detached abcdef1")).toBeInTheDocument();
    const lockedRow = screen.getByRole("listitem", { name: /Worktree locked-one/ });
    expect(within(lockedRow).getByText("Locked")).toBeInTheDocument();
    expect(within(lockedRow).getByText("tab")).toBeInTheDocument();
    expect(within(screen.getByRole("listitem", { name: /Worktree gone/ })).getByText("Missing")).toBeInTheDocument();
    expect(within(screen.getByRole("listitem", { name: /Worktree main/ })).getByText("Main")).toBeInTheDocument();
  });

  it("Enter and double-click open a worktree; Shift+F10 and the menu key open the row menu", async () => {
    window.localStorage.setItem("githydra:layout:worktreesCollapsed", "0");
    const linked = mockWorktreeEntry({ id: "f", path: "/w/f", branch: "feature" });
    const { onOpen } = setup([main, linked]);
    const row = screen.getByRole("listitem", { name: /Worktree feature/ });
    row.focus();
    await userEvent.keyboard("{Enter}");
    expect(onOpen).toHaveBeenCalledWith(linked);
    onOpen.mockClear();
    fireEvent.doubleClick(row);
    expect(onOpen).toHaveBeenCalledWith(linked);

    row.focus();
    await userEvent.keyboard("{Shift>}{F10}{/Shift}");
    expect(screen.getByRole("menu", { name: "Actions for worktree feature" })).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).toBeNull();
    // FR-635: focus returns to the invoking control.
    expect(row).toHaveFocus();

    await userEvent.keyboard("{ContextMenu}");
    expect(screen.getByRole("menu")).toBeInTheDocument();
  });

  it("right-click and the ... button open the menu with Open, Remove and a SEPARATE 'Remove worktree and delete branch'", async () => {
    window.localStorage.setItem("githydra:layout:worktreesCollapsed", "0");
    const linked = mockWorktreeEntry({ id: "f", path: "/w/f", branch: "feature" });
    const { onOpen, onRemove } = setup([main, linked]);
    fireEvent.contextMenu(screen.getByRole("listitem", { name: /Worktree feature/ }), { clientX: 40, clientY: 40 });
    const menu = screen.getByRole("menu");
    expect(within(menu).getAllByRole("menuitem").map((i) => i.getAttribute("aria-label") ?? i.textContent)).toEqual([
      "Open worktree",
      "Remove this worktree",
      "Remove worktree and delete branch",
    ]);
    await userEvent.click(within(menu).getByRole("menuitem", { name: "Remove worktree and delete branch" }));
    expect(onRemove).toHaveBeenCalledWith(linked, true);

    await userEvent.click(screen.getByRole("button", { name: "Actions for worktree feature" }));
    await userEvent.click(within(screen.getByRole("menu")).getByRole("menuitem", { name: "Open worktree" }));
    expect(onOpen).toHaveBeenCalledWith(linked);
  });

  it("Locked: Remove is disabled with the exact reason, visible as text", async () => {
    window.localStorage.setItem("githydra:layout:worktreesCollapsed", "0");
    const locked = mockWorktreeEntry({ id: "l", path: "/w/l", branch: "lk", locked: true, lockReason: "on a stick" });
    setup([main, locked]);
    await userEvent.click(screen.getByRole("button", { name: "Actions for worktree lk" }));
    const menu = screen.getByRole("menu");
    const remove = within(menu).getByRole("menuitem", { name: "Remove this worktree" });
    expect(remove).toBeDisabled();
    expect(menu).toHaveTextContent("Locked: on a stick. Unlock it with git worktree unlock before removing.");
    expect(within(menu).getByRole("menuitem", { name: "Open worktree" })).toBeEnabled();
  });

  it("Missing: Open is disabled with 'Its folder is missing.' and Clean up is offered with the no-files-deleted sentence", async () => {
    window.localStorage.setItem("githydra:layout:worktreesCollapsed", "0");
    const missing = mockWorktreeEntry({ id: "m", path: "/gone", branch: "gone", prunable: true });
    const { onCleanUp } = setup([main, missing]);
    await userEvent.click(screen.getByRole("button", { name: "Actions for worktree gone" }));
    const menu = screen.getByRole("menu");
    expect(within(menu).getByRole("menuitem", { name: "Open worktree" })).toBeDisabled();
    expect(menu).toHaveTextContent("Its folder is missing.");
    expect(menu).toHaveTextContent("Its folder is missing. Clean up removes the leftover Git record. No files are deleted.");
    await userEvent.click(within(menu).getByRole("menuitem", { name: "Clean up" }));
    expect(onCleanUp).toHaveBeenCalledWith(missing);
  });

  it("an unsupported entry and the main worktree get disabled actions with a reason", async () => {
    window.localStorage.setItem("githydra:layout:worktreesCollapsed", "0");
    const bad = mockWorktreeEntry({ id: "b", path: "/w/b", branch: "bad", supported: false });
    setup([main, bad]);
    await userEvent.click(screen.getByRole("button", { name: "Actions for worktree bad" }));
    let menu = screen.getByRole("menu");
    expect(within(menu).getByRole("menuitem", { name: "Open worktree" })).toBeDisabled();
    expect(menu).toHaveTextContent("cannot be trusted");
    await userEvent.keyboard("{Escape}");
    await userEvent.click(screen.getByRole("button", { name: "Actions for worktree main" }));
    menu = screen.getByRole("menu");
    expect(menu).toHaveTextContent("The main worktree cannot be removed.");
  });

  it("collapses with the toggle (FR-613) and remembers the choice", async () => {
    window.localStorage.removeItem("githydra:layout:worktreesCollapsed");
    const linked = mockWorktreeEntry({ id: "f", path: "/w/f", branch: "feature" });
    setup([main, linked]);
    const toggle = screen.getByRole("button", { name: /Worktrees \(2\)/ });
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(window.localStorage.getItem("githydra:layout:worktreesCollapsed")).toBe("1");
  });

  it("when worktree info is unavailable it shows one line saying why and no worktree actions", () => {
    window.localStorage.setItem("githydra:layout:worktreesCollapsed", "0");
    setup([main], { unavailable: true });
    expect(screen.getByText(/Worktree actions are unavailable/)).toBeInTheDocument();
    expect(screen.queryByRole("listitem")).toBeNull();
    expect(screen.queryByRole("button", { name: "Create worktree" })).toBeNull();
  });

  it("an untrusted list says so and keeps linked entries unopenable", async () => {
    window.localStorage.setItem("githydra:layout:worktreesCollapsed", "0");
    const linked = mockWorktreeEntry({ id: "f", path: "/w/f", branch: "feature" });
    setup([main, linked], { list: list([main, linked], { untrusted: true, untrustedReason: "count-mismatch" }) });
    expect(screen.getByText(/records disagree/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Actions for worktree feature" }));
    expect(within(screen.getByRole("menu")).getByRole("menuitem", { name: "Open worktree" })).toBeDisabled();
  });

  it("interactive targets are at least 24x24 by stylesheet and meaningful text is at least 12px", async () => {
    const css = (await import("./WorktreesSection.css?raw")).default as string;
    expect(css).toMatch(/\.gh-worktrees__more[^}]*width: 24px/s);
    expect(css).toMatch(/\.gh-worktrees__toggle[^}]*min-height: 24px/s);
    for (const m of css.matchAll(/font-size:\s*(\d+)px/g)) expect(Number(m[1])).toBeGreaterThanOrEqual(12);
  });
});
