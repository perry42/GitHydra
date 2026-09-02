import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { RepositoryState } from "@githydra/git-core";
import type { GitHydraApi } from "../../../shared/ipcContract";
import { BranchesPanel } from "./BranchesPanel";
import { ConfirmDialog } from "../ConfirmDialog/ConfirmDialog";
import { useBranchActions } from "../../hooks/useBranchActions";
import { makeLocalBranch, makeRemoteBranch, makeRepoState } from "../../test/fixtures";
import { makeMockGitHydra } from "../../test/mockGitHydra";

/** Mirrors how `App` wires `useBranchActions` + `BranchesPanel` + the delete-escalation
 * `ConfirmDialog`s together, so these tests exercise the real hook logic (FR-51/52) rather than
 * a hand-rolled fake of it. */
function Harness({
  api,
  repoState = makeRepoState(),
  onChanged = () => {},
  onRequestNewBranch = () => {},
  collapsed = false,
  onToggleCollapsed = () => {},
  onLocateBranch = () => {},
}: {
  api: GitHydraApi;
  repoState?: RepositoryState;
  onChanged?: () => void;
  onRequestNewBranch?: () => void;
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
  onLocateBranch?: (sha: string) => void;
}) {
  const actions = useBranchActions({ api, onChanged });
  return (
    <>
      <BranchesPanel
        api={api}
        repoState={repoState}
        actions={actions}
        onRequestNewBranch={onRequestNewBranch}
        collapsed={collapsed}
        onToggleCollapsed={onToggleCollapsed}
        onLocateBranch={onLocateBranch}
      />
      {actions.pendingDelete && (
        <ConfirmDialog
          title="Delete branch?"
          message={`Delete branch "${actions.pendingDelete}"? This cannot be undone.`}
          confirmLabel="Delete"
          destructive
          onConfirm={actions.confirmDelete}
          onCancel={actions.cancelDelete}
        />
      )}
      {actions.pendingForceDelete && (
        <ConfirmDialog
          title="Branch has unmerged commits"
          message={`"${actions.pendingForceDelete}" has commits that are not merged anywhere else. Force-deleting it may make those commits unreachable and hard to recover.`}
          confirmLabel="Force delete"
          destructive
          onConfirm={actions.confirmForceDelete}
          onCancel={actions.cancelForceDelete}
        />
      )}
    </>
  );
}

describe("BranchesPanel", () => {
  it("lists local branches (with a Current badge) and remote branches grouped by remote (FR-47/48)", async () => {
    const api = makeMockGitHydra({
      localBranches: [
        makeLocalBranch("main", { isCurrent: true }),
        makeLocalBranch("feature-x", { upstreamName: "origin/feature-x", ahead: 2, behind: 1 }),
      ],
      remoteBranches: [makeRemoteBranch("origin", "feature-y")],
    });
    render(<Harness api={api} />);

    await waitFor(() => expect(screen.getByText("Local (2)")).toBeInTheDocument());
    expect(screen.getByText("main")).toBeInTheDocument();
    expect(screen.getByText("Current")).toBeInTheDocument();
    expect(screen.getByText("origin (1)")).toBeInTheDocument();
    expect(screen.getByText("origin/feature-y")).toBeInTheDocument();

    // FR-57: ahead/behind + upstream name are captioned as last-known, not live.
    const upstream = screen.getByText("↑2 ↓1 origin/feature-x");
    expect(upstream).toHaveAttribute("title", expect.stringMatching(/last-known|last fetch/i));
  });

  it("FR-50: typing in the search box narrows the list by name substring", async () => {
    const api = makeMockGitHydra({
      localBranches: [makeLocalBranch("main", { isCurrent: true }), makeLocalBranch("feature-x")],
    });
    render(<Harness api={api} />);
    await waitFor(() => expect(screen.getByText("Local (2)")).toBeInTheDocument());

    await userEvent.type(screen.getByRole("searchbox", { name: /search branches/i }), "feat");
    await waitFor(() => expect(screen.getByText("Local (1)")).toBeInTheDocument());
    expect(screen.getByText("feature-x")).toBeInTheDocument();
    expect(screen.queryByText("main")).not.toBeInTheDocument();
  });

  it("Checkout switches HEAD to the clicked branch and disables the control for the current branch (FR-51/AC6)", async () => {
    const onChanged = vi.fn();
    const api = makeMockGitHydra({
      localBranches: [makeLocalBranch("main", { isCurrent: true }), makeLocalBranch("feature-x")],
    });
    render(<Harness api={api} onChanged={onChanged} />);
    await waitFor(() => expect(screen.getByText("Local (2)")).toBeInTheDocument());

    const mainRow = screen.getByText("main").closest("li")!;
    expect(within(mainRow).getByRole("button", { name: /checkout/i })).toBeDisabled();

    const featureRow = screen.getByText("feature-x").closest("li")!;
    await userEvent.click(within(featureRow).getByRole("button", { name: /checkout/i }));

    expect(vi.mocked(api.switchBranch)).toHaveBeenCalledWith("feature-x");
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
  });

  it("surfaces git's real refusal reason (not a generic message) when a switch is rejected (FR-51/AC7)", async () => {
    const api = makeMockGitHydra({
      localBranches: [makeLocalBranch("main", { isCurrent: true }), makeLocalBranch("feature-x")],
    });
    vi.mocked(api.switchBranch).mockResolvedValueOnce({
      ok: false,
      error: {
        name: "BranchSwitchConflictError",
        message: 'Cannot switch to "feature-x": uncommitted changes would be overwritten (src/app.ts).',
      },
    });
    render(<Harness api={api} />);
    await waitFor(() => expect(screen.getByText("Local (2)")).toBeInTheDocument());

    const featureRow = screen.getByText("feature-x").closest("li")!;
    await userEvent.click(within(featureRow).getByRole("button", { name: /checkout/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/uncommitted changes would be overwritten.*src\/app\.ts/i);
  });

  it("shows a disabled Checkout control with the reason for a branch checked out in another worktree (FR-48)", async () => {
    const api = makeMockGitHydra({
      localBranches: [
        makeLocalBranch("main", { isCurrent: true }),
        makeLocalBranch("wt-branch", { checkedOutInWorktree: "/other/worktree" }),
      ],
    });
    render(<Harness api={api} />);
    await waitFor(() => expect(screen.getByText("Local (2)")).toBeInTheDocument());

    expect(screen.getByText("Checked out elsewhere")).toBeInTheDocument();
    const row = screen.getByText("wt-branch").closest("li")!;
    const checkoutButton = within(row).getByRole("button", { name: /checkout/i });
    expect(checkoutButton).toBeDisabled();
    expect(within(row).getByRole("button", { name: /delete/i })).toBeDisabled();
  });

  it("Delete requires a single confirmation naming the branch, then removes it (FR-52/AC8)", async () => {
    const onChanged = vi.fn();
    const api = makeMockGitHydra({
      localBranches: [makeLocalBranch("main", { isCurrent: true }), makeLocalBranch("old-feature")],
    });
    render(<Harness api={api} onChanged={onChanged} />);
    await waitFor(() => expect(screen.getByText("Local (2)")).toBeInTheDocument());

    const row = screen.getByText("old-feature").closest("li")!;
    await userEvent.click(within(row).getByRole("button", { name: /delete/i }));

    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent(/"old-feature"/);

    // Cancel first: no delete call, branch untouched.
    await userEvent.click(within(dialog).getByRole("button", { name: /cancel/i }));
    expect(vi.mocked(api.deleteBranch)).not.toHaveBeenCalled();
    expect(screen.getByText("old-feature")).toBeInTheDocument();

    await userEvent.click(within(row).getByRole("button", { name: /delete/i }));
    const confirmDialog = await screen.findByRole("alertdialog");
    await userEvent.click(within(confirmDialog).getByRole("button", { name: /^delete$/i }));

    expect(vi.mocked(api.deleteBranch)).toHaveBeenCalledWith("old-feature");
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
  });

  it("escalates to a second, more severely-worded confirmation on BranchNotFullyMergedError, and only force-deletes after that (FR-52/AC9)", async () => {
    const onChanged = vi.fn();
    const api = makeMockGitHydra({
      localBranches: [makeLocalBranch("main", { isCurrent: true }), makeLocalBranch("unmerged-feature")],
    });
    // Every safe-delete attempt against this branch refuses the same way (git's real behavior
    // wouldn't change between the two escalation attempts this test exercises below).
    vi.mocked(api.deleteBranch).mockResolvedValue({
      ok: false,
      error: { name: "BranchNotFullyMergedError", message: 'Branch "unmerged-feature" is not fully merged.' },
    });
    render(<Harness api={api} onChanged={onChanged} />);
    await waitFor(() => expect(screen.getByText("Local (2)")).toBeInTheDocument());

    const row = screen.getByText("unmerged-feature").closest("li")!;
    await userEvent.click(within(row).getByRole("button", { name: /delete/i }));
    const firstDialog = await screen.findByRole("alertdialog");
    await userEvent.click(within(firstDialog).getByRole("button", { name: /^delete$/i }));

    // Safe delete was attempted and refused — no force call yet.
    await waitFor(() => expect(vi.mocked(api.deleteBranch)).toHaveBeenCalledWith("unmerged-feature"));
    expect(vi.mocked(api.forceDeleteBranch)).not.toHaveBeenCalled();

    // Second, more severe confirmation appears, naming the branch and warning about unreachable commits.
    const secondDialog = await screen.findByRole("alertdialog");
    expect(secondDialog).toHaveTextContent(/"unmerged-feature"/);
    expect(secondDialog).toHaveTextContent(/unreachable/i);

    // Canceling here leaves the branch untouched.
    await userEvent.click(within(secondDialog).getByRole("button", { name: /cancel/i }));
    expect(vi.mocked(api.forceDeleteBranch)).not.toHaveBeenCalled();
    expect(screen.getByText("unmerged-feature")).toBeInTheDocument();

    // Redo, this time confirming the second dialog: only now is force-delete called.
    await userEvent.click(within(row).getByRole("button", { name: /delete/i }));
    const firstDialogAgain = await screen.findByRole("alertdialog");
    await userEvent.click(within(firstDialogAgain).getByRole("button", { name: /^delete$/i }));
    const secondDialogAgain = await screen.findByRole("alertdialog");
    await userEvent.click(within(secondDialogAgain).getByRole("button", { name: /force delete/i }));

    expect(vi.mocked(api.forceDeleteBranch)).toHaveBeenCalledWith("unmerged-feature");
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it("a remote branch's Checkout creates a tracking local branch and switches to it (FR-37/53)", async () => {
    const onChanged = vi.fn();
    const api = makeMockGitHydra({
      localBranches: [makeLocalBranch("main", { isCurrent: true })],
      remoteBranches: [makeRemoteBranch("origin", "feature-y")],
    });
    render(<Harness api={api} onChanged={onChanged} />);
    await waitFor(() => expect(screen.getByText("origin/feature-y")).toBeInTheDocument());

    const row = screen.getByText("origin/feature-y").closest("li")!;
    await userEvent.click(within(row).getByRole("button", { name: /checkout/i }));

    expect(vi.mocked(api.createBranch)).toHaveBeenCalledWith({
      name: "feature-y",
      startPoint: "refs/remotes/origin/feature-y",
      switchToIt: true,
      track: true,
    });
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
  });

  it("disables every Checkout control with an explanation on a bare repository (AC11)", async () => {
    const api = makeMockGitHydra({
      localBranches: [makeLocalBranch("main", { isCurrent: true }), makeLocalBranch("feature-x")],
    });
    render(<Harness api={api} repoState={makeRepoState({ isBare: true, workdir: null })} />);
    await waitFor(() => expect(screen.getByText("feature-x")).toBeInTheDocument());

    const row = screen.getByText("feature-x").closest("li")!;
    const checkoutButton = within(row).getByRole("button", { name: /checkout/i });
    expect(checkoutButton).toBeDisabled();
    expect(checkoutButton).toHaveAttribute("title", expect.stringMatching(/bare repository/i));
  });

  it("the New Branch button invokes the caller's callback (dialog itself is a separate component)", async () => {
    const onRequestNewBranch = vi.fn();
    const api = makeMockGitHydra({ localBranches: [makeLocalBranch("main", { isCurrent: true })] });
    render(<Harness api={api} onRequestNewBranch={onRequestNewBranch} />);
    await waitFor(() => expect(screen.getByText("main")).toBeInTheDocument());

    await userEvent.click(screen.getByRole("button", { name: /new branch/i }));
    expect(onRequestNewBranch).toHaveBeenCalledTimes(1);
  });

  // design-pass "Branches panel relocation": FR-50 extended — a branch's name is now itself a
  // jump affordance, reusing App.tsx's `jumpToSha` (passed down as `onLocateBranch`) rather than
  // requiring Checkout (a git mutation) just to look at a branch's tip commit in the graph.
  it("clicking a branch's name jumps the graph to its tip commit, without checking it out (design-pass)", async () => {
    const onLocateBranch = vi.fn();
    const api = makeMockGitHydra({
      localBranches: [makeLocalBranch("main", { isCurrent: true, tipSha: "sha-main" })],
      remoteBranches: [makeRemoteBranch("origin", "feature-y", { tipSha: "sha-remote" })],
    });
    render(<Harness api={api} onLocateBranch={onLocateBranch} />);
    await waitFor(() => expect(screen.getByText("origin/feature-y")).toBeInTheDocument());

    await userEvent.click(screen.getByRole("button", { name: /jump to main in the commit graph/i }));
    expect(onLocateBranch).toHaveBeenCalledWith("sha-main");
    expect(vi.mocked(api.switchBranch)).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: /jump to origin\/feature-y in the commit graph/i }));
    expect(onLocateBranch).toHaveBeenCalledWith("sha-remote");
  });

  // design-pass "Branches panel relocation": ROADMAP.md's explicit ask — the search box itself
  // also jumps, not just each row's name button, so a search-then-Enter flow never requires an
  // extra click once the right branch is found.
  it("pressing Enter in the search box jumps to the top matching branch's tip commit (local branches take priority)", async () => {
    const onLocateBranch = vi.fn();
    const api = makeMockGitHydra({
      localBranches: [
        makeLocalBranch("main", { isCurrent: true, tipSha: "sha-main" }),
        makeLocalBranch("feature-x", { tipSha: "sha-feature-x" }),
      ],
      remoteBranches: [makeRemoteBranch("origin", "feature-y", { tipSha: "sha-remote" })],
    });
    render(<Harness api={api} onLocateBranch={onLocateBranch} />);
    await waitFor(() => expect(screen.getByText("Local (2)")).toBeInTheDocument());

    const search = screen.getByRole("searchbox", { name: /search branches/i });
    await userEvent.type(search, "feature{Enter}");

    // Both "feature-x" (local) and "origin/feature-y" (remote) match "feature" — local wins.
    expect(onLocateBranch).toHaveBeenCalledWith("sha-feature-x");
  });

  // design-pass "Branches panel relocation": the panel is now a persistent, collapsible left
  // sidebar rather than a closeable right-hand rail — collapse/expand replace the old ×/onClose.
  it("collapses to a slim rail and back via the header/rail toggle buttons", async () => {
    const onToggleCollapsed = vi.fn();
    const api = makeMockGitHydra({ localBranches: [makeLocalBranch("main", { isCurrent: true })] });
    const { rerender } = render(<Harness api={api} onToggleCollapsed={onToggleCollapsed} />);
    await waitFor(() => expect(screen.getByText("main")).toBeInTheDocument());

    await userEvent.click(screen.getByRole("button", { name: /collapse branches sidebar/i }));
    expect(onToggleCollapsed).toHaveBeenCalledTimes(1);

    rerender(<Harness api={api} onToggleCollapsed={onToggleCollapsed} collapsed />);
    expect(screen.queryByText("main")).not.toBeInTheDocument();
    const expandButton = screen.getByRole("button", { name: /expand branches sidebar/i });
    await userEvent.click(expandButton);
    expect(onToggleCollapsed).toHaveBeenCalledTimes(2);
  });
});
