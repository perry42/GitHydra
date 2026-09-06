// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StatusBanner } from "./StatusBanner";
import { makeRepoState } from "../../test/fixtures";
import { makeMockGitHydra } from "../../test/mockGitHydra";

describe("StatusBanner", () => {
  it("renders nothing for a plain, up-to-date repo", () => {
    const { container } = render(
      <StatusBanner repoState={makeRepoState()} hasExternalChanges={false} onRefresh={() => {}} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("labels an in-progress rebase rather than silently rendering HEAD as normal (FR-5)", () => {
    render(
      <StatusBanner
        repoState={makeRepoState({ inProgressOperation: "rebase" })}
        hasExternalChanges={false}
        onRefresh={() => {}}
      />,
    );
    expect(screen.getByText(/rebase in progress/i)).toBeInTheDocument();
  });

  it("flags detached HEAD (AC4 supporting text)", () => {
    render(
      <StatusBanner
        repoState={makeRepoState({ isDetachedHead: true, currentBranch: null })}
        hasExternalChanges={false}
        onRefresh={() => {}}
      />,
    );
    expect(screen.getByText(/detached head/i)).toBeInTheDocument();
  });

  it("offers a manual refresh action when history changed externally (FR-6/AC11)", async () => {
    const onRefresh = vi.fn();
    render(<StatusBanner repoState={makeRepoState()} hasExternalChanges onRefresh={onRefresh} />);
    await userEvent.click(screen.getByRole("button", { name: /refresh/i }));
    expect(onRefresh).toHaveBeenCalled();
  });

  it("shows rich per-operation copy (rebase, with step count) once detail is available (FR-58/AC2)", () => {
    render(
      <StatusBanner
        repoState={makeRepoState({
          inProgressOperation: "rebase",
          currentBranch: "feature-x",
          inProgressOperationDetail: {
            kind: "rebase",
            originalBranch: "feature-x",
            ontoSha: null,
            ontoSubject: null,
            ontoRef: "main",
            currentCommitSha: null,
            currentCommitSubject: null,
            currentStep: 2,
            totalSteps: 5,
          },
        })}
        hasExternalChanges={false}
        onRefresh={() => {}}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("Rebasing feature-x onto main — step 2 of 5");
  });

  it("Continue is disabled while conflicts remain and enabled once none remain (FR-71/AC6)", async () => {
    const api = makeMockGitHydra({ conflictedFiles: [] });
    const onOperationChanged = vi.fn();
    const { rerender } = render(
      <StatusBanner
        repoState={makeRepoState({ inProgressOperation: "merge" })}
        hasExternalChanges={false}
        onRefresh={() => {}}
        api={api}
        workingDirStatus={{ hasChanges: true, staged: 0, unstaged: 0, untracked: 0, conflicted: 1 }}
        onOperationChanged={onOperationChanged}
      />,
    );
    expect(screen.getByRole("button", { name: /^continue$/i })).toBeDisabled();

    rerender(
      <StatusBanner
        repoState={makeRepoState({ inProgressOperation: "merge" })}
        hasExternalChanges={false}
        onRefresh={() => {}}
        api={api}
        workingDirStatus={{ hasChanges: false, staged: 0, unstaged: 0, untracked: 0, conflicted: 0 }}
        onOperationChanged={onOperationChanged}
      />,
    );
    const continueButton = screen.getByRole("button", { name: /^continue$/i });
    expect(continueButton).toBeEnabled();
    await userEvent.click(continueButton);
    expect(vi.mocked(api.continueInProgressOperation)).toHaveBeenCalled();
    await waitFor(() => expect(onOperationChanged).toHaveBeenCalled());
  });

  it("Abort requires confirming a dialog, then calls abortInProgressOperation (FR-68)", async () => {
    const api = makeMockGitHydra();
    const onOperationChanged = vi.fn();
    render(
      <StatusBanner
        repoState={makeRepoState({ inProgressOperation: "rebase" })}
        hasExternalChanges={false}
        onRefresh={() => {}}
        api={api}
        workingDirStatus={{ hasChanges: false, staged: 0, unstaged: 0, untracked: 0, conflicted: 0 }}
        onOperationChanged={onOperationChanged}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /^abort$/i }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent(/restores the pre-operation branch tip/i);

    await userEvent.click(within(dialog).getByRole("button", { name: /^abort$/i }));
    expect(vi.mocked(api.abortInProgressOperation)).toHaveBeenCalled();
    await waitFor(() => expect(onOperationChanged).toHaveBeenCalled());
  });

  it("surfaces git's own abort refusal verbatim rather than swallowing it (FR-68)", async () => {
    const api = makeMockGitHydra();
    vi.mocked(api.abortInProgressOperation).mockResolvedValueOnce({
      ok: false,
      error: { name: "GitCommandError", message: "fatal: There is no merge to abort" },
    });
    render(
      <StatusBanner
        repoState={makeRepoState({ inProgressOperation: "merge" })}
        hasExternalChanges={false}
        onRefresh={() => {}}
        api={api}
        workingDirStatus={{ hasChanges: false, staged: 0, unstaged: 0, untracked: 0, conflicted: 0 }}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /^abort$/i }));
    const dialog = await screen.findByRole("alertdialog");
    await userEvent.click(within(dialog).getByRole("button", { name: /^abort$/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/there is no merge to abort/i);
  });

  /**
   * specs/graph-head-indicator-and-refresh-alerting.md Problem 2 — revises FR-59/AC11's original
   * silent-auto-refresh plan: an externally-detected operation-state change must surface a
   * distinct alert (not the ordinary "History changed outside GitHydra" copy) and block
   * Continue/Abort until the user clicks that alert's own Refresh.
   */
  it("shows a distinct alert naming the operation when operationStateAlert is set, separate from the ordinary ref-churn banner (AC3)", () => {
    render(
      <StatusBanner
        repoState={makeRepoState({ inProgressOperation: "rebase" })}
        hasExternalChanges={false}
        onRefresh={() => {}}
        operationStateAlert={{ operation: "rebase" }}
      />,
    );
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent(/in-progress rebase changed outside githydra/i);
    expect(alert).toHaveTextContent(/refresh/i);
    // Distinct from the ordinary ref-churn copy — never conflated with it.
    expect(screen.queryByText(/history changed outside githydra/i)).not.toBeInTheDocument();
  });

  it("disables Continue and Abort while operationStateAlert is unacknowledged, and re-enables them once it clears (AC4)", () => {
    const api = makeMockGitHydra();
    const { rerender } = render(
      <StatusBanner
        repoState={makeRepoState({ inProgressOperation: "merge" })}
        hasExternalChanges={false}
        onRefresh={() => {}}
        api={api}
        workingDirStatus={{ hasChanges: false, staged: 0, unstaged: 0, untracked: 0, conflicted: 0 }}
        operationStateAlert={{ operation: "merge" }}
      />,
    );
    expect(screen.getByRole("button", { name: /^continue$/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /^abort$/i })).toBeDisabled();

    rerender(
      <StatusBanner
        repoState={makeRepoState({ inProgressOperation: "merge" })}
        hasExternalChanges={false}
        onRefresh={() => {}}
        api={api}
        workingDirStatus={{ hasChanges: false, staged: 0, unstaged: 0, untracked: 0, conflicted: 0 }}
        operationStateAlert={null}
      />,
    );
    expect(screen.getByRole("button", { name: /^continue$/i })).toBeEnabled();
    expect(screen.getByRole("button", { name: /^abort$/i })).toBeEnabled();
  });

  it("clicking the operation-state alert's own Refresh calls onRefresh, same as the ordinary banner's (AC5)", async () => {
    const onRefresh = vi.fn();
    render(
      <StatusBanner
        repoState={makeRepoState({ inProgressOperation: "rebase" })}
        hasExternalChanges={false}
        onRefresh={onRefresh}
        operationStateAlert={{ operation: "rebase" }}
      />,
    );
    await userEvent.click(within(screen.getByRole("alert")).getByRole("button", { name: /refresh/i }));
    expect(onRefresh).toHaveBeenCalled();
  });

  it("does not block Continue/Abort for the ordinary ref-churn banner (operationStateAlert absent)", () => {
    const api = makeMockGitHydra();
    render(
      <StatusBanner
        repoState={makeRepoState({ inProgressOperation: "merge" })}
        hasExternalChanges
        onRefresh={() => {}}
        api={api}
        workingDirStatus={{ hasChanges: false, staged: 0, unstaged: 0, untracked: 0, conflicted: 0 }}
      />,
    );
    expect(screen.getByRole("button", { name: /^continue$/i })).toBeEnabled();
    expect(screen.getByRole("button", { name: /^abort$/i })).toBeEnabled();
  });

  it("shows a live 'N of M conflicts resolved' readout that is never a separate client-tracked flag (FR-67)", () => {
    const { rerender } = render(
      <StatusBanner
        repoState={makeRepoState({ inProgressOperation: "merge" })}
        hasExternalChanges={false}
        onRefresh={() => {}}
        workingDirStatus={{ hasChanges: true, staged: 0, unstaged: 0, untracked: 0, conflicted: 3 }}
      />,
    );
    expect(screen.getByText(/0 of 3 conflicts resolved/i)).toBeInTheDocument();

    rerender(
      <StatusBanner
        repoState={makeRepoState({ inProgressOperation: "merge" })}
        hasExternalChanges={false}
        onRefresh={() => {}}
        workingDirStatus={{ hasChanges: true, staged: 0, unstaged: 0, untracked: 0, conflicted: 1 }}
      />,
    );
    expect(screen.getByText(/2 of 3 conflicts resolved/i)).toBeInTheDocument();
  });
});
