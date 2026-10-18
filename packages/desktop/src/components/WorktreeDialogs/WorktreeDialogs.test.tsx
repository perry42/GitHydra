// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { GitHydraApi } from "../../../shared/ipcContract";
import { makeMockGitHydra, mockWorktreeEntry } from "../../test/mockGitHydra";
import { CleanUpWorktreeDialog, RemoveWorktreeDialog, type RemoveOutcome } from "./WorktreeDialogs";

const entry = mockWorktreeEntry({ id: "wt1", path: "/w/repo.worktrees/feature", branch: "feature" });

function apiWith(count: number, over: { submodules?: string[]; dirty?: string[]; merge?: { merged: boolean; unmergedCommits: number | null; exists?: boolean } } = {}): GitHydraApi {
  const api = makeMockGitHydra();
  vi.mocked(api.getWorktreeRemovalState).mockResolvedValue({
    ok: true,
    data: { ok: true, count, submodules: over.submodules ?? [], dirtySubmodules: over.dirty ?? [] },
  });
  if (over.merge) {
    vi.mocked(api.getBranchMergeState).mockResolvedValue({
      ok: true,
      data: { exists: over.merge.exists ?? true, merged: over.merge.merged, unmergedCommits: over.merge.unmergedCommits, reference: "HEAD" },
    });
  }
  return api;
}

function setup(api: GitHydraApi, props: Partial<Parameters<typeof RemoveWorktreeDialog>[0]> = {}) {
  const onConfirm = vi.fn(async (): Promise<RemoveOutcome | null> => null);
  const onCancel = vi.fn();
  render(
    <RemoveWorktreeDialog
      api={api}
      entry={entry}
      wantsDeleteBranch={false}
      openAsTab={false}
      currentBranch="main"
      onConfirm={onConfirm}
      onCancel={onCancel}
      {...props}
    />,
  );
  return { onConfirm, onCancel };
}

describe("RemoveWorktreeDialog (FR-615)", () => {
  it("clean: Cancel has initial focus and the ignored-files sentence names the path once", async () => {
    setup(apiWith(0));
    const confirm = await screen.findByRole("button", { name: "Remove worktree" });
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
    await waitFor(() => expect(confirm).toBeEnabled());
    const text = document.querySelector(".gh-confirm-dialog")!.textContent ?? "";
    expect(text).toContain("This also deletes ignored files such as node_modules and build output in /w/repo.worktrees/feature.");
    expect(text.split("/w/repo.worktrees/feature")).toHaveLength(2);
  });

  it("dirty: states the count; exactly 20 needs no typing", async () => {
    const { onConfirm } = setup(apiWith(20));
    expect(await screen.findByText(/has 20 uncommitted files/)).toBeInTheDocument();
    expect(screen.queryByLabelText(/Type 20 to confirm/)).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Remove worktree" }));
    await waitFor(() => expect(onConfirm).toHaveBeenCalled());
    expect(onConfirm.mock.calls[0]![0]).toMatchObject({ count: 20, force: true });
  });

  it("21 files need the typed count, and Enter in the field never confirms", async () => {
    const { onConfirm } = setup(apiWith(21));
    const typed = await screen.findByLabelText(/Type 21 to confirm \(more than 20 files\)/);
    const confirm = screen.getByRole("button", { name: "Remove worktree" });
    expect(confirm).toBeDisabled();
    await userEvent.type(typed, "21");
    expect(confirm).toBeEnabled();
    await userEvent.type(typed, "{Enter}");
    expect(onConfirm).not.toHaveBeenCalled();
    await userEvent.click(confirm);
    await waitFor(() => expect(onConfirm).toHaveBeenCalled());
  });

  it("lists submodules (with the dirty ones marked) before force is offered", async () => {
    const { onConfirm } = setup(apiWith(0, { submodules: ["libs/a", "libs/b"], dirty: ["libs/b"] }));
    const list = await screen.findByRole("list", { name: "Submodules" });
    expect(list).toHaveTextContent("libs/a");
    expect(list).toHaveTextContent("libs/b");
    expect(list).toHaveTextContent("uncommitted changes");
    await userEvent.click(screen.getByRole("button", { name: "Remove worktree" }));
    await waitFor(() => expect(onConfirm.mock.calls[0]![0]).toMatchObject({ force: true }));
  });

  it("merged branch: 'Remove worktree and delete branch'", async () => {
    const { onConfirm } = setup(apiWith(0, { merge: { merged: true, unmergedCommits: 0 } }), { wantsDeleteBranch: true });
    expect(await screen.findByRole("heading", { name: "Remove worktree and delete branch?" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Remove and delete branch" }));
    await waitFor(() => expect(onConfirm.mock.calls[0]![0]).toMatchObject({ deleteBranch: true }));
  });

  it("unmerged branch downgrades to 'Remove worktree' with the real commit count", async () => {
    const { onConfirm } = setup(apiWith(0, { merge: { merged: false, unmergedCommits: 3 } }), { wantsDeleteBranch: true });
    expect(await screen.findByRole("heading", { name: "Remove worktree?" })).toBeInTheDocument();
    const kept = await screen.findByText("Branch feature has 3 commits that are not merged into main or its upstream, so it will be kept.");
    // The downgrade is the first thing read, above the generic sentence.
    const generic = screen.getByText(/This also deletes ignored files such as node_modules/);
    expect(kept.compareDocumentPosition(generic) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Remove worktree" }));
    await waitFor(() => expect(onConfirm.mock.calls[0]![0]).toMatchObject({ deleteBranch: false, keptUnmerged: true }));
  });

  it("says the open tab is closed first", async () => {
    setup(apiWith(0), { openAsTab: true });
    expect(await screen.findByText("Its open tab will be closed first.")).toBeInTheDocument();
  });

  it("a refusal from the flow is shown in the dialog and, for a changed worktree, the state is read again", async () => {
    const api = apiWith(0);
    const onConfirm = vi.fn(async (): Promise<RemoveOutcome | null> => ({ notice: "This worktree changed since you opened this. Review it again.", reload: true }));
    setup(api, { onConfirm });
    await userEvent.click(await screen.findByRole("button", { name: "Remove worktree" }));
    expect(await screen.findByText(/changed since you opened this/)).toBeInTheDocument();
    await waitFor(() => expect(api.getWorktreeRemovalState).toHaveBeenCalledTimes(2));
  });

  it("an untrusted worktree cannot be confirmed and says why", async () => {
    const api = makeMockGitHydra();
    vi.mocked(api.getWorktreeRemovalState).mockResolvedValue({ ok: true, data: { ok: false, reason: "backlink-mismatch" } });
    setup(api);
    expect(await screen.findByText("Not a worktree of this repository.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove worktree" })).toBeDisabled();
  });

  it("Cancel and Escape cancel", async () => {
    const { onCancel } = setup(apiWith(0));
    await screen.findByRole("button", { name: "Remove worktree" });
    await userEvent.keyboard("{Escape}");
    expect(onCancel).toHaveBeenCalled();
  });
});

describe("CleanUpWorktreeDialog (FR-604, FR-614)", () => {
  const missing = mockWorktreeEntry({ id: "m", path: "/gone", branch: "gone", prunable: true });

  it("says no files are deleted and Cancel has initial focus", () => {
    render(<CleanUpWorktreeDialog entry={missing} alsoForgotten={[]} busy={false} notice={null} onConfirm={() => {}} onCancel={() => {}} />);
    expect(screen.getByText("Its folder is missing. Forgetting it removes the leftover Git record. No files are deleted.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
  });

  it("lists every other entry git would also forget, with the unplugged-drive hint", () => {
    render(
      <CleanUpWorktreeDialog
        entry={missing}
        alsoForgotten={[{ id: "other", reason: "gitdir file points to non-existent location", path: "/usb/other" }]}
        busy={false}
        notice={null}
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(screen.getByRole("list", { name: "Also forgotten" })).toHaveTextContent("/usb/other");
    expect(screen.getByText(/reconnect it instead/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Forget all" })).toBeInTheDocument();
  });
});
