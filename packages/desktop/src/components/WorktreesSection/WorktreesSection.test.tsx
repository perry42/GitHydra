// SPDX-License-Identifier: GPL-3.0-or-later
import { createRef } from "react";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { WorktreeEntry, WorktreeList } from "@githydra/git-core";
import { buildOpenInProgramItem } from "../../lib/openInProgram";
import { mockProgram, mockWorktreeEntry } from "../../test/mockGitHydra";
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
      "Copy path",
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
    // Its sibling items have a second line, so the enabled Open has one too.
    expect(within(menu).getByRole("menuitem", { name: "Open worktree" })).toBeEnabled();
    expect(menu).toHaveTextContent("Opens it in a new tab.");
  });

  it("Missing: Open is disabled and spells the reason out ONCE; 'Forget missing worktree' says no files are deleted", async () => {
    window.localStorage.setItem("githydra:layout:worktreesCollapsed", "0");
    const missing = mockWorktreeEntry({ id: "m", path: "/gone", branch: "gone", prunable: true });
    const { onCleanUp } = setup([main, missing]);
    await userEvent.click(screen.getByRole("button", { name: "Actions for worktree gone" }));
    const menu = screen.getByRole("menu");
    expect(within(menu).getByRole("menuitem", { name: "Open worktree" })).toBeDisabled();
    expect(menu.textContent!.match(/Its folder is missing\./g)).toHaveLength(1);
    expect(menu).toHaveTextContent("Removes the leftover Git record. No files are deleted.");
    await userEvent.click(within(menu).getByRole("menuitem", { name: "Forget missing worktree" }));
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
    const header = (await import("../SectionHeader/SectionHeader.css?raw")).default as string;
    expect(header).toMatch(/\.gh-section-header__toggle[^}]*min-height: 24px/s);
    for (const m of css.matchAll(/font-size:\s*(\d+)px/g)) expect(Number(m[1])).toBeGreaterThanOrEqual(12);
  });

  it("shows the path on ONE line, cut in the middle with the leaf kept; the full path is the tooltip and the accessible name", () => {
    window.localStorage.setItem("githydra:layout:worktreesCollapsed", "0");
    const long = "D:\\projects\\clients\\acme-platform\\services\\acme.worktrees\\hotfix";
    const e = mockWorktreeEntry({ id: "h", path: long, branch: "hotfix" });
    setup([main, e]);
    const row = screen.getByRole("listitem", { name: /Worktree hotfix/ });
    const shown = row.querySelector(".gh-worktrees__path")!;
    expect(shown.textContent).toBe("...\\services\\acme.worktrees\\hotfix");
    expect(shown).toHaveAttribute("title", long);
    expect(row).toHaveAccessibleName(expect.stringContaining(long));
  });

  it("Copy path copies the FULL path", async () => {
    window.localStorage.setItem("githydra:layout:worktreesCollapsed", "0");
    const long = "/very/long/parent/folder/structure/that/does/not/fit/acme.worktrees/hotfix";
    const e = mockWorktreeEntry({ id: "h", path: long, branch: "hotfix" });
    const write = vi.fn(async (_t: string) => {});
    setup([main, e], { writeClipboard: write });
    await userEvent.click(screen.getByRole("button", { name: "Actions for worktree hotfix" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Copy path" }));
    expect(write).toHaveBeenCalledWith(long);
  });

  it("the list is ONE tab stop; Up/Down/Home/End move between rows and Space opens like Enter", async () => {
    window.localStorage.setItem("githydra:layout:worktreesCollapsed", "0");
    const a = mockWorktreeEntry({ id: "a", path: "/w/a", branch: "aa" });
    const b = mockWorktreeEntry({ id: "b", path: "/w/b", branch: "bb" });
    const { onOpen } = setup([main, a, b]);
    const rows = screen.getAllByRole("listitem");
    expect(rows.map((r) => r.getAttribute("tabindex"))).toEqual(["0", "-1", "-1"]);
    rows[0]!.focus();
    await userEvent.keyboard("{ArrowDown}");
    expect(rows[1]).toHaveFocus();
    expect(rows.map((r) => r.getAttribute("tabindex"))).toEqual(["-1", "0", "-1"]);
    await userEvent.keyboard("{End}");
    expect(rows[2]).toHaveFocus();
    await userEvent.keyboard("{ArrowUp}{Home}");
    expect(rows[0]).toHaveFocus();
    await userEvent.keyboard("{ArrowDown}{ }");
    expect(onOpen).toHaveBeenCalledWith(a);
  });

  it("the ... button reports aria-expanded while its menu is open", async () => {
    window.localStorage.setItem("githydra:layout:worktreesCollapsed", "0");
    setup([main, mockWorktreeEntry({ id: "a", path: "/w/a", branch: "aa" })]);
    const btn = screen.getByRole("button", { name: "Actions for worktree aa" });
    expect(btn).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(btn);
    expect(btn).toHaveAttribute("aria-expanded", "true");
  });

  it("Main and tab are quiet labels (no pill), Locked and Missing have distinct treatments, each icon + word", () => {
    window.localStorage.setItem("githydra:layout:worktreesCollapsed", "0");
    const l = mockWorktreeEntry({ id: "l", path: "/w/l", branch: "lk", locked: true });
    const m = mockWorktreeEntry({ id: "m", path: "/w/m", branch: "gone", prunable: true });
    setup([main, l, m], { isOpenAsTab: (e) => e.id === null });
    const mainRow = screen.getByRole("listitem", { name: /Worktree main/ });
    expect(within(mainRow).getByText("Main").className).toContain("flag--quiet");
    expect(within(mainRow).getByText("tab").className).toContain("flag--quiet");
    expect(within(mainRow).getByText("tab").querySelector("svg")).toHaveAttribute("aria-hidden", "true");
    const lock = within(screen.getByRole("listitem", { name: /Worktree lk/ })).getByText("Locked");
    const miss = within(screen.getByRole("listitem", { name: /Worktree gone/ })).getByText("Missing");
    expect(lock.className).toContain("flag--locked");
    expect(miss.className).toContain("flag--missing");
    expect(lock.querySelector("svg")).not.toBeNull();
    expect(miss.querySelector("svg")).not.toBeNull();
  });

  it("caps the list at about five rows with its own scroll, no card border, and never wraps the path mid-word (stylesheet)", async () => {
    const css = (await import("./WorktreesSection.css?raw")).default as string;
    expect(css).toMatch(/\.gh-worktrees__list \{[^}]*max-height: 270px[^}]*overflow-y: auto/s);
    expect(css).toMatch(/\.gh-worktrees__row \{[^}]*border-bottom: 1px solid/s);
    expect(css).not.toMatch(/\.gh-worktrees__row \{[^}]*border: 1px/s);
    expect(css).not.toContain("overflow-wrap: anywhere");
    expect(css).toMatch(/\.gh-worktrees__path \{[^}]*white-space: nowrap/s);
  });

  it("explains the section in one muted line when it is collapsed or holds only the main worktree", async () => {
    window.localStorage.removeItem("githydra:layout:worktreesCollapsed");
    setup([main]);
    expect(screen.getByText("Other folders with a branch checked out. Right-click a branch to create one.")).toBeInTheDocument();
  });
});

describe("WorktreesSection row menu: the Open worktree accordion (specs/external-programs.md FR-617)", () => {
  it("shows the accordion in place of the plain item when openItem is supplied, and Esc returns focus to the ... button", async () => {
    window.localStorage.setItem("githydra:layout:worktreesCollapsed", "0");
    const model = {
      snapshot: { programs: [mockProgram({ id: "cursor", name: "Cursor" })], defaultId: "cursor", fallbackReason: null },
      refresh: vi.fn(),
      openInTab: vi.fn(),
      openInProgram: vi.fn(),
      managePrograms: vi.fn(),
    };
    const linked = mockWorktreeEntry({ id: "f", path: "/w/repo.worktrees/feature", branch: "feature" });
    setup([main, linked], {
      openItem: (_e, opts) => buildOpenInProgramItem({ ...model, openInProgram: (id) => opts.wrap(() => model.openInProgram(id))() }, { label: "Open worktree" }),
    });
    const invoker = screen.getByRole("button", { name: "Actions for worktree feature" });
    await userEvent.click(invoker);
    const item = await screen.findByRole("menuitem", { name: "Open worktree" });
    expect(item).toHaveAttribute("aria-haspopup", "menu");
    expect(screen.getByText("Opens in Cursor")).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    await Promise.resolve();
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(invoker);
  });
});
