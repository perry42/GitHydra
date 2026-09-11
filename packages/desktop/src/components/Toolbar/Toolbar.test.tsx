// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Toolbar } from "./Toolbar";

describe("Toolbar", () => {
  it("disables Refresh when no repo is open and enables it once one is", () => {
    const { rerender } = render(
      <Toolbar repoPath={null} onRefresh={() => {}} canRefresh={false} theme="dark" onToggleTheme={() => {}} />,
    );
    expect(screen.getByRole("button", { name: /refresh commit graph/i })).toBeDisabled();

    rerender(<Toolbar repoPath="/repo" onRefresh={() => {}} canRefresh theme="dark" onToggleTheme={() => {}} />);
    expect(screen.getByRole("button", { name: /refresh commit graph/i })).toBeEnabled();
  });

  it("calls onToggleTheme", async () => {
    const onToggleTheme = vi.fn();
    render(<Toolbar repoPath={null} onRefresh={() => {}} canRefresh={false} theme="dark" onToggleTheme={onToggleTheme} />);
    await userEvent.click(screen.getByRole("button", { name: /switch to light theme/i }));
    expect(onToggleTheme).toHaveBeenCalled();
  });

  it("specs/repo-list.md (revised IA): no 'Open repository…' control exists anywhere in the Toolbar", () => {
    render(<Toolbar repoPath="/repo" onRefresh={() => {}} canRefresh theme="dark" onToggleTheme={() => {}} />);
    expect(screen.queryByRole("button", { name: /open repository/i })).not.toBeInTheDocument();
  });

  it("hides the Changes toggle until a repo is open, then shows a badge with the pending count", () => {
    const { rerender } = render(
      <Toolbar repoPath={null} onRefresh={() => {}} canRefresh={false} theme="dark" onToggleTheme={() => {}} />,
    );
    expect(screen.queryByRole("button", { name: /^changes/i })).not.toBeInTheDocument();

    const onToggleChanges = vi.fn();
    rerender(
      <Toolbar
        repoPath="/repo"
        onRefresh={() => {}}
        canRefresh
        theme="dark"
        onToggleTheme={() => {}}
        showChangesToggle
        changesCount={3}
        onToggleChanges={onToggleChanges}
      />,
    );
    const toggle = screen.getByRole("button", { name: /changes, 3 pending/i });
    expect(toggle).toHaveTextContent("3");
  });

  it("shows the current-branch indicator and toggles the Branches sidebar's collapsed state on click (FR-56, design-pass relocation)", async () => {
    const onToggleBranches = vi.fn();
    render(
      <Toolbar
        repoPath="/repo"
        onRefresh={() => {}}
        canRefresh
        theme="dark"
        onToggleTheme={() => {}}
        showBranchesToggle
        currentBranchLabel="main"
        onToggleBranches={onToggleBranches}
      />,
    );
    const toggle = screen.getByRole("button", { name: /branches.*current branch main/i });
    expect(toggle).toHaveTextContent("main");
    await userEvent.click(toggle);
    expect(onToggleBranches).toHaveBeenCalledTimes(1);
  });

  it("specs/stash.md FR-93: shows the Stash toggle with a live count badge and toggles the panel on click", async () => {
    const onToggleStash = vi.fn();
    render(
      <Toolbar
        repoPath="/repo"
        onRefresh={() => {}}
        canRefresh
        theme="dark"
        onToggleTheme={() => {}}
        showStashToggle
        stashCount={2}
        onToggleStash={onToggleStash}
      />,
    );
    const toggle = screen.getByRole("button", { name: /stashes, 2/i });
    expect(toggle).toHaveTextContent("2");
    await userEvent.click(toggle);
    expect(onToggleStash).toHaveBeenCalledTimes(1);
  });

  it("specs/stash.md edge cases: disables the Stash toggle itself with a reason on a bare repository", () => {
    render(
      <Toolbar
        repoPath="/repo"
        onRefresh={() => {}}
        canRefresh
        theme="dark"
        onToggleTheme={() => {}}
        showStashToggle
        stashDisabledReason="This is a bare repository — it has no working directory, so there is nothing to stash."
      />,
    );
    const toggle = screen.getByRole("button", { name: "Stashes" });
    expect(toggle).toBeDisabled();
    expect(toggle).toHaveAttribute("title", expect.stringMatching(/bare repository/i));
  });

  it("design-pass fix #1: demotes Refresh/theme-toggle to icon-only ghost buttons with no visible label text", () => {
    render(<Toolbar repoPath="/repo" onRefresh={() => {}} canRefresh theme="dark" onToggleTheme={() => {}} />);
    const refresh = screen.getByRole("button", { name: /refresh commit graph/i });
    const themeToggle = screen.getByRole("button", { name: /switch to light theme/i });
    expect(refresh).toHaveClass("gh-toolbar__icon-button");
    expect(refresh).not.toHaveClass("gh-toolbar__button");
    expect(refresh.textContent).toBe("");
    expect(refresh.querySelector("svg")).not.toBeNull();
    expect(themeToggle).toHaveClass("gh-toolbar__icon-button");
    expect(themeToggle.textContent).toBe("");
    expect(themeToggle.querySelector("svg")).not.toBeNull();
  });

  it("design-pass fix #1: groups panel-toggle chips together with icons, separated from utility actions", () => {
    render(
      <Toolbar
        repoPath="/repo"
        onRefresh={() => {}}
        canRefresh
        theme="dark"
        onToggleTheme={() => {}}
        showBranchesToggle
        currentBranchLabel="main"
        showChangesToggle
        showStashToggle
      />,
    );
    const branchesToggle = screen.getByRole("button", { name: /branches.*current branch main/i });
    const changesToggle = screen.getByRole("button", { name: "Changes" });
    const stashesToggle = screen.getByRole("button", { name: "Stashes" });
    for (const toggle of [branchesToggle, changesToggle, stashesToggle]) {
      expect(toggle).toHaveClass("gh-toolbar__button");
      expect(toggle.querySelector("svg")).not.toBeNull();
      expect(toggle.closest(".gh-toolbar__group--toggles")).not.toBeNull();
    }
  });

  // specs/refresh-without-teardown.md AC4: a visible, testable loading affordance while
  // `isRefreshing` is true, independent of `canRefresh`/`status`.
  it("shows a busy Refresh button while isRefreshing is true, and a plain one once it clears", () => {
    const { rerender } = render(
      <Toolbar repoPath="/repo" onRefresh={() => {}} canRefresh theme="dark" onToggleTheme={() => {}} isRefreshing />,
    );
    const busyRefresh = screen.getByRole("button", { name: /refreshing commit graph/i });
    expect(busyRefresh).toHaveAttribute("aria-busy", "true");
    expect(busyRefresh).toBeDisabled();
    expect(busyRefresh.querySelector("svg")).toHaveClass("gh-toolbar__icon--spin");

    rerender(
      <Toolbar
        repoPath="/repo"
        onRefresh={() => {}}
        canRefresh
        theme="dark"
        onToggleTheme={() => {}}
        isRefreshing={false}
      />,
    );
    const idleRefresh = screen.getByRole("button", { name: /^refresh commit graph$/i });
    expect(idleRefresh).toHaveAttribute("aria-busy", "false");
    expect(idleRefresh).toBeEnabled();
    expect(idleRefresh.querySelector("svg")).not.toHaveClass("gh-toolbar__icon--spin");
  });

  describe("specs/find-commits-overlay.md FR-258", () => {
    it("hides the 'Find commits' button by default, shows it (28x28, Refresh's icon-button treatment, working title/aria-label) once showFindCommitsButton is true, and calls onFindCommits on click", async () => {
      const { rerender } = render(
        <Toolbar repoPath={null} onRefresh={() => {}} canRefresh={false} theme="dark" onToggleTheme={() => {}} />,
      );
      expect(screen.queryByRole("button", { name: "Find commits" })).not.toBeInTheDocument();

      const onFindCommits = vi.fn();
      rerender(
        <Toolbar
          repoPath="/repo"
          onRefresh={() => {}}
          canRefresh
          theme="dark"
          onToggleTheme={() => {}}
          showFindCommitsButton
          onFindCommits={onFindCommits}
        />,
      );
      const button = screen.getByRole("button", { name: "Find commits" });
      expect(button).toHaveClass("gh-toolbar__icon-button");
      expect(button).toHaveAttribute("title", expect.stringMatching(/find commits/i));
      expect(button.querySelector("svg")).not.toBeNull();
      await userEvent.click(button);
      expect(onFindCommits).toHaveBeenCalledTimes(1);
    });

    it("positions 'Find commits' before Refresh in the utility-actions cluster", () => {
      render(
        <Toolbar
          repoPath="/repo"
          onRefresh={() => {}}
          canRefresh
          theme="dark"
          onToggleTheme={() => {}}
          showFindCommitsButton
          onFindCommits={() => {}}
        />,
      );
      const utilityGroup = screen.getByRole("button", { name: "Find commits" }).closest(".gh-toolbar__group--utility")!;
      const buttons = within(utilityGroup).getAllByRole("button");
      expect(buttons[0]).toHaveAccessibleName("Find commits");
      expect(buttons[1]).toHaveAccessibleName(/refresh commit graph/i);
    });
  });

  it("falls back to a neutral 'Branches' label for detached HEAD / bare repos (no misleading branch name)", () => {
    render(
      <Toolbar
        repoPath="/repo"
        onRefresh={() => {}}
        canRefresh
        theme="dark"
        onToggleTheme={() => {}}
        showBranchesToggle
        currentBranchLabel={null}
      />,
    );
    expect(screen.getByRole("button", { name: "Branches" })).toBeInTheDocument();
  });
});
