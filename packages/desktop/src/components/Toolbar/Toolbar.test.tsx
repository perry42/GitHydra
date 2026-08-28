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

  it("shows the current-branch indicator and toggles the Branches panel on click (FR-56)", async () => {
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
