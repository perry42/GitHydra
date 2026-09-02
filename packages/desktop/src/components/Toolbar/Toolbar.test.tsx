import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Toolbar } from "./Toolbar";

describe("Toolbar", () => {
  it("disables Refresh when no repo is open and enables it once one is", () => {
    const { rerender } = render(
      <Toolbar repoPath={null} onOpenRepo={() => {}} onRefresh={() => {}} canRefresh={false} theme="dark" onToggleTheme={() => {}} />,
    );
    expect(screen.getByRole("button", { name: /refresh commit graph/i })).toBeDisabled();

    rerender(
      <Toolbar repoPath="/repo" onOpenRepo={() => {}} onRefresh={() => {}} canRefresh theme="dark" onToggleTheme={() => {}} />,
    );
    expect(screen.getByRole("button", { name: /refresh commit graph/i })).toBeEnabled();
  });

  it("calls onOpenRepo and onToggleTheme", async () => {
    const onOpenRepo = vi.fn();
    const onToggleTheme = vi.fn();
    render(
      <Toolbar
        repoPath={null}
        onOpenRepo={onOpenRepo}
        onRefresh={() => {}}
        canRefresh={false}
        theme="dark"
        onToggleTheme={onToggleTheme}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /open repository/i }));
    expect(onOpenRepo).toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: /switch to light theme/i }));
    expect(onToggleTheme).toHaveBeenCalled();
  });

  it("hides the Changes toggle until a repo is open, then shows a badge with the pending count", () => {
    const { rerender } = render(
      <Toolbar
        repoPath={null}
        onOpenRepo={() => {}}
        onRefresh={() => {}}
        canRefresh={false}
        theme="dark"
        onToggleTheme={() => {}}
      />,
    );
    expect(screen.queryByRole("button", { name: /^changes/i })).not.toBeInTheDocument();

    const onToggleChanges = vi.fn();
    rerender(
      <Toolbar
        repoPath="/repo"
        onOpenRepo={() => {}}
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
        onOpenRepo={() => {}}
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
        onOpenRepo={() => {}}
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
        onOpenRepo={() => {}}
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
    render(
      <Toolbar repoPath="/repo" onOpenRepo={() => {}} onRefresh={() => {}} canRefresh theme="dark" onToggleTheme={() => {}} />,
    );
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

  it("design-pass fix #1/#2: the Open repository launcher stays bordered and gains an icon", () => {
    render(
      <Toolbar repoPath="/repo" onOpenRepo={() => {}} onRefresh={() => {}} canRefresh theme="dark" onToggleTheme={() => {}} />,
    );
    const launcher = screen.getByRole("button", { name: /open repository/i });
    expect(launcher).toHaveClass("gh-toolbar__button");
    expect(launcher.querySelector("svg")).not.toBeNull();
  });

  it("design-pass fix #1: groups panel-toggle chips together with icons, separated from utility actions", () => {
    render(
      <Toolbar
        repoPath="/repo"
        onOpenRepo={() => {}}
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

  it("falls back to a neutral 'Branches' label for detached HEAD / bare repos (no misleading branch name)", () => {
    render(
      <Toolbar
        repoPath="/repo"
        onOpenRepo={() => {}}
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
