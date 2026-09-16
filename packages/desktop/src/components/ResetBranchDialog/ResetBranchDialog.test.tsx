// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ResetBranchDialog } from "./ResetBranchDialog";
import { makeMockGitHydra } from "../../test/mockGitHydra";

const target = { sha: "abc1234abc1234abc1234abc1234abc1234abc1", abbrevSha: "abc1234", subject: "A good commit" };

function renderDialog(overrides: Partial<React.ComponentProps<typeof ResetBranchDialog>> = {}) {
  const api = overrides.api ?? makeMockGitHydra();
  const onConfirm = vi.fn();
  const onClose = vi.fn();
  const utils = render(
    <ResetBranchDialog
      api={api}
      target={target}
      branchLabel="main"
      headSha="head0000head0000head0000head0000head0000"
      workingDirStatus={null}
      busy={false}
      onConfirm={onConfirm}
      onClose={onClose}
      {...overrides}
    />,
  );
  return { ...utils, api, onConfirm, onClose };
}

describe("ResetBranchDialog (specs/reset-to-here.md FR-367 through FR-371)", () => {
  it("FR-367/AC3: shows the target's abbreviated SHA and subject, all three modes simultaneously (each with its own description), Soft pre-selected — Hard never default, never hidden", () => {
    renderDialog();
    expect(screen.getByText("abc1234")).toBeInTheDocument();
    expect(screen.getByText("A good commit")).toBeInTheDocument();

    const soft = screen.getByRole("radio", { name: /soft/i });
    const mixed = screen.getByRole("radio", { name: /mixed/i });
    const hard = screen.getByRole("radio", { name: /hard/i });
    expect(soft).toBeChecked();
    expect(mixed).not.toBeChecked();
    expect(hard).not.toBeChecked();

    expect(screen.getByText(/keep all changes from the undone commits staged, ready to re-commit/i)).toBeInTheDocument();
    expect(screen.getByText(/keep all changes from the undone commits, but unstaged/i)).toBeInTheDocument();
    expect(
      screen.getByText(/permanently discard all changes from the undone commits.*untracked files are not touched/i),
    ).toBeInTheDocument();
  });

  it("FR-371: Soft confirms immediately via onConfirm — no second dialog involved at this layer", async () => {
    const { onConfirm } = renderDialog();
    await userEvent.click(screen.getByRole("button", { name: /^reset$/i }));
    expect(onConfirm).toHaveBeenCalledWith("soft");
  });

  it("FR-371: choosing Hard and confirming calls onConfirm with 'hard' — the dialog itself doesn't gate on working-tree state, that's useResetActions' job", async () => {
    const { onConfirm } = renderDialog();
    await userEvent.click(screen.getByRole("radio", { name: /hard/i }));
    await userEvent.click(screen.getByRole("button", { name: /^reset$/i }));
    expect(onConfirm).toHaveBeenCalledWith("hard");
  });

  it("FR-369: the danger callout appears only when Hard is selected AND the working tree is dirty — never for Soft/Mixed", async () => {
    renderDialog({ workingDirStatus: { hasChanges: true, staged: 3, unstaged: 2, conflicted: 0, untracked: 0 } });
    // Soft is the pre-selected default — no danger callout yet, even with a dirty working tree.
    expect(screen.queryByText(/permanently discarded/i)).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("radio", { name: /hard/i }));
    expect(screen.getByText("3 staged and 2 unstaged changes will be permanently discarded.")).toBeInTheDocument();
    expect(screen.getByText("Untracked files are not affected.")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("radio", { name: /mixed/i }));
    expect(screen.queryByText(/permanently discarded/i)).not.toBeInTheDocument();
  });

  it("FR-369: never appears for Hard when the working tree is clean", async () => {
    renderDialog({ workingDirStatus: { hasChanges: false, staged: 0, unstaged: 0, conflicted: 0, untracked: 0 } });
    await userEvent.click(screen.getByRole("radio", { name: /hard/i }));
    expect(screen.queryByText(/permanently discarded/i)).not.toBeInTheDocument();
  });

  it("FR-370/AC9: Soft and Mixed are disabled with the 'already at this commit' reason when the target is exactly HEAD; Hard stays enabled and becomes the default selection", () => {
    renderDialog({ headSha: target.sha });
    const soft = screen.getByRole("radio", { name: /soft/i });
    const mixed = screen.getByRole("radio", { name: /mixed/i });
    const hard = screen.getByRole("radio", { name: /hard/i });
    expect(soft).toBeDisabled();
    expect(mixed).toBeDisabled();
    expect(hard).not.toBeDisabled();
    expect(hard).toBeChecked();
    expect(soft.closest("label")).toHaveAttribute("title", "Already at this commit — nothing to reset.");
  });

  it("FR-368: the impact line reads 'already here' when the target is exactly HEAD, with no ancestry read performed", () => {
    const api = makeMockGitHydra();
    renderDialog({ headSha: target.sha, api });
    expect(screen.getByText("No commits are being undone — main is already here.")).toBeInTheDocument();
    expect(api.computeCommitPairRelationship).not.toHaveBeenCalled();
  });

  it("FR-368/AC10: computes and renders the impact line for an ancestor target, with the correct count", async () => {
    const api = makeMockGitHydra({ commitPairRelationship: "a-ancestor-of-b", resetImpactCount: 4 });
    renderDialog({ api });
    await waitFor(() => expect(screen.getByText("4 commits will no longer be on main.")).toBeInTheDocument());
    expect(api.computeCommitPairRelationship).toHaveBeenCalledWith(target.sha, "head0000head0000head0000head0000head0000");
  });

  it("FR-368/AC10: falls back to non-numeric wording without crashing when the count read is forced to fail (null)", async () => {
    const api = makeMockGitHydra({ commitPairRelationship: "a-ancestor-of-b", resetImpactCount: null });
    renderDialog({ api });
    await waitFor(() => expect(screen.getByText("Some commits will no longer be on main.")).toBeInTheDocument());
  });

  it("FR-368/AC15: renders the fourth (no-common-ancestor) variant with critical emphasis for a target on an unrelated line of history", async () => {
    const api = makeMockGitHydra({ commitPairRelationship: "no-common-ancestor", resetImpactCount: 9 });
    renderDialog({ api });
    const impact = await screen.findByText(/shares no history with main/i);
    expect(impact).toHaveClass("gh-reset-dialog__impact--critical");
  });

  it("Cancel and Escape both call onClose without calling onConfirm", async () => {
    const { onConfirm, onClose } = renderDialog();
    await userEvent.click(screen.getByRole("button", { name: /cancel/i }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();

    const { onClose: onClose2 } = renderDialog();
    await userEvent.keyboard("{Escape}");
    expect(onClose2).toHaveBeenCalledTimes(1);
  });

  it("shows a busy label and disables the primary action while a reset is in flight", () => {
    renderDialog({ busy: true });
    const button = screen.getByRole("button", { name: /resetting…/i });
    expect(button).toBeDisabled();
  });
});
