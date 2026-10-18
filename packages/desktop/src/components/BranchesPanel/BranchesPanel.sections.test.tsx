// SPDX-License-Identifier: GPL-3.0-or-later
import { createRef } from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { WorktreeEntry } from "@githydra/git-core";
import { BranchesPanel, type BranchesPanelWorktrees } from "./BranchesPanel";
import { useBranchActions } from "../../hooks/useBranchActions";
import { indexWorktrees } from "../../lib/worktrees";
import { makeLocalBranch, makeRemoteBranch, makeRepoState } from "../../test/fixtures";
import { makeMockGitHydra, mockWorktreeEntry } from "../../test/mockGitHydra";

/** Section headers share one anatomy and order: Local, Worktrees, then each remote (DESIGN.md "Branches panel sections"). */

const main = mockWorktreeEntry({ id: null, isMain: true, path: "/w/repo", branch: "main" });
const feature = mockWorktreeEntry({ id: "f", path: "/w/repo.worktrees/feature", branch: "feature" });

function wt(entries: WorktreeEntry[]): BranchesPanelWorktrees {
  return {
    state: {
      status: "ready",
      list: { entries, untrusted: false, untrustedReason: null, commonDir: "/w/repo/.git", mainPath: "/w/repo", format: "nul", mainPathIsGitDir: false },
      errorMessage: null,
      index: indexWorktrees(entries),
      reload: () => {},
    },
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
    headingRef: createRef<HTMLHeadingElement>(),
    onMenuOpenChange: vi.fn(),
  };
}

function Harness({ worktrees }: { worktrees: BranchesPanelWorktrees }) {
  const api = makeMockGitHydra({
    localBranches: [makeLocalBranch("main", { isCurrent: true }), makeLocalBranch("dev")],
    remoteBranches: [makeRemoteBranch("origin", "main"), makeRemoteBranch("upstream", "main")],
  });
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

const toggle = (name: RegExp) => screen.getByRole("button", { name });

describe("Branches panel section headers", () => {
  it("orders the sections Local, Worktrees, then each remote", async () => {
    window.localStorage.setItem("githydra:layout:worktreesCollapsed", "0");
    render(<Harness worktrees={wt([main, feature])} />);
    await screen.findByText("Local (2)");
    const order = screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent?.replace(/\s+/g, " ").trim());
    expect(order).toEqual(["Local (2)", "Worktrees (2)", "origin (1)", "upstream (1)"]);
  });

  it("every header has a real toggle button with aria-expanded and aria-controls, and a 14px aria-hidden icon", async () => {
    render(<Harness worktrees={wt([main, feature])} />);
    await screen.findByText("Local (2)");
    for (const name of [/^Local/, /^Worktrees/, /^origin/, /^upstream/]) {
      const b = toggle(name);
      expect(b).toHaveAttribute("aria-expanded");
      const controlled = document.getElementById(b.getAttribute("aria-controls")!);
      expect(controlled).not.toBeNull();
      const icon = b.querySelector(".gh-section-header__icon")!;
      expect(icon).toHaveAttribute("aria-hidden", "true");
      expect(icon.querySelector("svg")).toHaveAttribute("width", "14");
      expect(b.querySelector(".gh-section-header__chevron")).toHaveAttribute("aria-hidden", "true");
    }
  });

  it("defaults: Local and the remotes expanded; Worktrees collapsed with only the main worktree", async () => {
    render(<Harness worktrees={wt([main])} />);
    await screen.findByText("Local (2)");
    expect(toggle(/^Local/)).toHaveAttribute("aria-expanded", "true");
    expect(toggle(/^origin/)).toHaveAttribute("aria-expanded", "true");
    expect(toggle(/^Worktrees/)).toHaveAttribute("aria-expanded", "false");
  });

  it("collapses and expands Local and a remote independently, by mouse and by keyboard", async () => {
    render(<Harness worktrees={wt([main])} />);
    await screen.findByText("Local (2)");
    const local = toggle(/^Local/);
    const body = document.getElementById(local.getAttribute("aria-controls")!)!;
    expect(body).toBeVisible();
    await userEvent.click(local);
    expect(local).toHaveAttribute("aria-expanded", "false");
    expect(body).not.toBeVisible();
    // The remotes are untouched.
    expect(toggle(/^origin/)).toHaveAttribute("aria-expanded", "true");
    local.focus();
    await userEvent.keyboard("{Enter}");
    expect(local).toHaveAttribute("aria-expanded", "true");
    await userEvent.keyboard(" ");
    expect(local).toHaveAttribute("aria-expanded", "false");
    const origin = toggle(/^origin/);
    await userEvent.click(origin);
    expect(document.getElementById(origin.getAttribute("aria-controls")!)).not.toBeVisible();
    expect(toggle(/^upstream/)).toHaveAttribute("aria-expanded", "true");
    expect(within(document.getElementById(toggle(/^upstream/).getAttribute("aria-controls")!)!).getByRole("list")).toBeVisible();
  });

  it("the Worktrees header keeps its Create worktree action beside the toggle", async () => {
    window.localStorage.setItem("githydra:layout:worktreesCollapsed", "0");
    render(<Harness worktrees={wt([main, feature])} />);
    await screen.findByText("Local (2)");
    const heading = screen.getByRole("heading", { name: /^Worktrees/ });
    expect(within(heading).getByRole("button", { name: "New worktree" })).toBeInTheDocument();
  });

  it("the toggle target is at least 24px by stylesheet", async () => {
    const css = (await import("../SectionHeader/SectionHeader.css?raw")).default as string;
    expect(css).toMatch(/\.gh-section-header__toggle[^}]*min-height: 24px/s);
  });

  it("a long remote name wraps inside a narrow sidebar instead of widening it (stylesheet pin)", async () => {
    const css = (await import("../SectionHeader/SectionHeader.css?raw")).default as string;
    expect(css).toMatch(/\.gh-section-header__toggle[^}]*min-width: 0/s);
    expect(css).toMatch(/\.gh-section-header__toggle[^}]*overflow-wrap: anywhere/s);
  });
});
