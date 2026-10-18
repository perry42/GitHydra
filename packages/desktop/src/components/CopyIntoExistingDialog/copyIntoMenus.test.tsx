// SPDX-License-Identifier: GPL-3.0-or-later
import { createRef } from "react";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { WorktreeEntry, WorktreeList } from "@githydra/git-core";
import { makeMockGitHydra, mockWorktreeEntry } from "../../test/mockGitHydra";
import { makeLocalBranch, makeRepoState } from "../../test/fixtures";
import { indexWorktrees } from "../../lib/worktrees";
import { useBranchActions } from "../../hooks/useBranchActions";
import { BranchesPanel, type BranchesPanelWorktrees } from "../BranchesPanel/BranchesPanel";
import { WorktreesSection } from "../WorktreesSection/WorktreesSection";
import { buildCopyHereItem } from "./copyHereItem";

const main = mockWorktreeEntry({ id: null, isMain: true, path: "/w/acme", branch: "main" });
const login = mockWorktreeEntry({ id: "tl", path: "/w/acme.worktrees/tour-login", branch: "tour-login" });
const locked = mockWorktreeEntry({ id: "lk", path: "/w/acme.worktrees/locked", branch: "locked", locked: true, lockReason: "usb" });
const gone = mockWorktreeEntry({ id: "gn", path: "/w/acme.worktrees/gone", branch: "gone", prunable: true });
const odd = mockWorktreeEntry({ id: "od", path: "/w/acme.worktrees/odd", branch: "odd", supported: false });

const list = (entries: WorktreeEntry[], over: Partial<WorktreeList> = {}): WorktreeList => ({
  entries,
  untrusted: false,
  untrustedReason: null,
  commonDir: "/w/acme/.git",
  mainPath: "/w/acme",
  format: "nul",
  mainPathIsGitDir: false,
  ...over,
});

function section(entries: WorktreeEntry[], source: WorktreeEntry | null, over: Partial<WorktreeList> = {}) {
  window.localStorage.setItem("githydra:layout:worktreesCollapsed", "0");
  const onCopy = vi.fn();
  const l = list(entries, over);
  render(
    <WorktreesSection
      status="ready"
      list={l}
      errorMessage={null}
      unavailable={false}
      isOpenAsTab={() => false}
      headingRef={createRef<HTMLHeadingElement>()}
      onOpen={vi.fn()}
      onRemove={vi.fn()}
      onCleanUp={vi.fn()}
      onCreate={vi.fn()}
      copyHereItem={(entry, opts) => buildCopyHereItem(entry, l, source, onCopy, opts.wrap)}
    />,
  );
  return { onCopy };
}

async function openMenu(name: string) {
  await userEvent.click(screen.getByRole("button", { name: `Actions for worktree ${name}` }));
  return screen.getByRole("menu");
}

describe("worktree row menu (FR-649, AC 13)", () => {
  it("orders Open worktree, Copy path | Copy ignored files here... | Remove...", async () => {
    section([main, login], main);
    const menu = await openMenu("tour-login");
    const kids = Array.from(menu.children).map((el) => (el.getAttribute("role") === "separator" ? "---" : (el.getAttribute("aria-label") ?? el.textContent)));
    expect(kids.slice(0, 5)).toEqual(["Open worktree", "Copy path", "---", "Copy ignored files here...", "---"]);
    expect(kids[5]).toBe("Remove this worktree");
    const item = within(menu).getByRole("menuitem", { name: "Copy ignored files here..." });
    expect(item.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
    expect(item).not.toHaveAttribute("aria-disabled");
  });

  it("choosing it hands the entry over (enabled: zero candidates is not a reason, the listing is not run to decide)", async () => {
    const { onCopy } = section([main, login], main);
    const menu = await openMenu("tour-login");
    await userEvent.click(within(menu).getByRole("menuitem", { name: "Copy ignored files here..." }));
    expect(onCopy).toHaveBeenCalledWith(login);
  });

  it.each([
    ["the source row", "tour-login", [main, login], login, "This is the source worktree"],
    ["a locked worktree", "locked", [main, login, locked], main, "Locked: unlock it first"],
    ["a missing worktree", "gone", [main, login, gone], main, "The folder is missing"],
    ["a supported:false entry", "odd", [main, login, odd], main, "This worktree list could not be read safely"],
  ])("%s is aria-disabled, focusable and describes its reason", async (_n, name, entries, source, reason) => {
    const { onCopy } = section(entries as WorktreeEntry[], source as WorktreeEntry);
    const menu = await openMenu(name as string);
    const item = within(menu).getByRole("menuitem", { name: "Copy ignored files here..." });
    expect(item).toHaveAttribute("aria-disabled", "true");
    expect(item).not.toBeDisabled();
    expect(item).toHaveAccessibleDescription(reason as string);
    expect(item.getAttribute("aria-describedby")).toBeTruthy();
    item.focus();
    expect(item).toHaveFocus();
    fireEvent.click(item);
    expect(onCopy).not.toHaveBeenCalled();
    expect(screen.getByRole("menu")).toBeInTheDocument(); // stays open: the reason is the answer
  });

  it("an untrusted list gives its reason", async () => {
    section([main, login], main, { untrusted: true });
    const item = within(await openMenu("tour-login")).getByRole("menuitem", { name: "Copy ignored files here..." });
    expect(item).toHaveAccessibleDescription("This worktree list could not be read safely");
  });

  it("a bare repository disables the item with the bare sentence", async () => {
    const bare = mockWorktreeEntry({ id: null, isMain: true, isBare: true, path: "/w/acme.git", branch: null });
    section([bare, login], null);
    const item = within(await openMenu("tour-login")).getByRole("menuitem", { name: "Copy ignored files here..." });
    expect(item).toHaveAccessibleDescription("This is a bare repository: there is nothing to copy.");
  });

  it("the arrow keys reach the focusable disabled item", async () => {
    section([main, login], login);
    const menu = await openMenu("tour-login");
    const copy = within(menu).getByRole("menuitem", { name: "Copy ignored files here..." });
    for (let i = 0; i < 4 && document.activeElement !== copy; i++) fireEvent.keyDown(document, { key: "ArrowDown" });
    expect(copy).toHaveFocus();
  });
});

function Harness({ api, worktrees }: { api: ReturnType<typeof makeMockGitHydra>; worktrees: BranchesPanelWorktrees }) {
  const actions = useBranchActions({ api, onChanged: () => {} });
  return (
    <BranchesPanel
      api={api}
      repoState={makeRepoState()}
      actions={actions}
      onRequestNewBranch={() => {}}
      collapsed={false}
      onToggleCollapsed={() => {}}
      onLocateBranch={() => {}}
      lastFetchedAt={null}
      worktrees={worktrees}
    />
  );
}

function panelWt(entries: WorktreeEntry[], source: WorktreeEntry, onCopy = vi.fn()): BranchesPanelWorktrees {
  const l = list(entries);
  return {
    state: { status: "ready", list: l, errorMessage: null, index: indexWorktrees(entries), reload: () => {} },
    isOpenAsTab: () => false,
    notices: [],
    onDismissNotice: vi.fn(),
    onOpenBranches: vi.fn(),
    onOpen: vi.fn(),
    onRemove: vi.fn(),
    onCleanUp: vi.fn(),
    onCreateNew: vi.fn(),
    onCreateForBranch: vi.fn(),
    onCreateForRemote: vi.fn(),
    copyHereItem: (entry, opts) => buildCopyHereItem(entry, l, source, onCopy, opts.wrap),
    headingRef: createRef<HTMLHeadingElement>(),
    onMenuOpenChange: vi.fn(),
  };
}

describe("branch menu (FR-649, AC 13)", () => {
  const api = () =>
    makeMockGitHydra({
      localBranches: [makeLocalBranch("main", { isCurrent: true }), makeLocalBranch("tour-login", { checkedOutInWorktree: "/w/acme.worktrees/tour-login" }), makeLocalBranch("plain")],
    });
  const openBranchMenu = async (name: string) => {
    await screen.findByText("Local (3)");
    const card = screen.getAllByRole("listitem").find((li) => li.closest(".gh-branches-panel__list") && li.textContent?.includes(name) && !li.closest(".gh-worktrees"));
    fireEvent.contextMenu(card!);
    return screen.getByRole("menu");
  };

  it("has the item directly after Open worktree for a branch that has a worktree", async () => {
    const onCopy = vi.fn();
    render(<Harness api={api()} worktrees={panelWt([main, login], main, onCopy)} />);
    const menu = await openBranchMenu("tour-login");
    const labels = within(menu).getAllByRole("menuitem").map((i) => i.getAttribute("aria-label") ?? i.textContent);
    const open = labels.findIndex((l) => l === "Open worktree");
    expect(open).toBeGreaterThanOrEqual(0);
    expect(labels[open + 1]).toBe("Copy ignored files here...");
    await userEvent.click(within(menu).getByRole("menuitem", { name: "Copy ignored files here..." }));
    expect(onCopy).toHaveBeenCalledWith(login);
  });

  it("a branch without a worktree gets Create worktree... and never the copy item (never both)", async () => {
    render(<Harness api={api()} worktrees={panelWt([main, login], main)} />);
    const menu = await openBranchMenu("plain");
    expect(within(menu).queryByRole("menuitem", { name: "Copy ignored files here..." })).toBeNull();
    expect(within(menu).getByRole("menuitem", { name: /Create worktree/ })).toBeInTheDocument();
  });

  it("the source worktree's branch shows the item disabled with 'This is the source worktree'", async () => {
    render(<Harness api={api()} worktrees={panelWt([main, login], login)} />);
    const menu = await openBranchMenu("tour-login");
    const item = within(menu).getByRole("menuitem", { name: "Copy ignored files here..." });
    expect(item).toHaveAttribute("aria-disabled", "true");
    expect(item).toHaveAccessibleDescription("This is the source worktree");
  });
});
