// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { GitHydraApi } from "../../../shared/ipcContract";
import { makeMockGitHydra } from "../../test/mockGitHydra";
import type { CreateFailure, WorktreeCreateRequest } from "../../lib/worktreeCreate";
import { CreateWorktreeDialog } from "./CreateWorktreeDialog";

function setup(request: WorktreeCreateRequest, api: GitHydraApi = makeMockGitHydra({ repoPath: "/w/acme" }), over: { submit?: ReturnType<typeof vi.fn> } = {}) {
  const onSubmit = over.submit ?? vi.fn(async (): Promise<CreateFailure | null> => null);
  const onCancel = vi.fn();
  const onOpenExisting = vi.fn();
  render(<CreateWorktreeDialog api={api} request={request} mainPath="/w/acme" onSubmit={onSubmit} onOpenExisting={onOpenExisting} onCancel={onCancel} />);
  return { api, onSubmit, onCancel, onOpenExisting };
}

describe("CreateWorktreeDialog (FR-608..610)", () => {
  it("shows the plain-words definition, a read-only source chip and a prefilled sibling folder; focus lands on Folder", async () => {
    setup({ kind: "branch", branch: "feature/search" });
    expect(screen.getByRole("dialog", { name: "Create worktree" })).toBeInTheDocument();
    expect(screen.getByText("A second folder with another branch checked out, sharing this repo's history. No second clone.")).toBeInTheDocument();
    expect(screen.getByText("feature/search")).toBeInTheDocument();
    expect(screen.queryByLabelText("New branch name")).toBeNull();
    const folder = screen.getByLabelText("Folder");
    await waitFor(() => expect(folder).toHaveValue("/w/acme.worktrees/feature-search"));
    expect(folder).toHaveFocus();
    // Prefilled and not edited: no "Will create:" preview.
    expect(screen.queryByText(/Will create:/)).toBeNull();
    expect(screen.getByLabelText("Open after create")).toBeChecked();
  });

  it("for a commit the branch-name input takes focus, and the primary button says 'Create worktree'", async () => {
    setup({ kind: "commit", sha: "abcdef1234567890".padEnd(40, "0"), label: "commit abcdef1" });
    expect(screen.getByLabelText("New branch name")).toHaveFocus();
    expect(screen.getByRole("button", { name: "Create worktree" })).toBeInTheDocument();
  });

  it("Enter creates, Esc cancels", async () => {
    const { onSubmit, onCancel } = setup({ kind: "branch", branch: "feature" });
    await waitFor(() => expect(screen.getByLabelText("Folder")).toHaveValue("/w/acme.worktrees/feature"));
    await userEvent.type(screen.getByLabelText("Folder"), "{Enter}");
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit).toHaveBeenCalledWith({
      destination: "/w/acme.worktrees/feature",
      source: { kind: "branch", branch: "feature" },
      openAfter: true,
    });
    await userEvent.keyboard("{Escape}");
    expect(onCancel).toHaveBeenCalled();
  });

  it("a remote-only branch creates a local tracking branch named after it", async () => {
    const { onSubmit } = setup({ kind: "remote", remote: "origin", branch: "feature/x" });
    expect(screen.getByText("origin/feature/x")).toBeInTheDocument();
    expect(screen.getByText(/tracking this remote branch/)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText("Folder")).toHaveValue("/w/acme.worktrees/feature-x"));
    await userEvent.click(screen.getByRole("button", { name: "Create worktree" }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(onSubmit.mock.calls[0]![0].source).toEqual({ kind: "remoteBranch", remote: "origin", branch: "feature/x" });
  });

  it("a new branch from a commit validates the name with the NewBranchDialog messages and passes the start point", async () => {
    const api = makeMockGitHydra({ repoPath: "/w/acme" });
    const sha = "a".repeat(40);
    const { onSubmit } = setup({ kind: "commit", sha, label: "commit aaaaaaa" }, api);
    await userEvent.type(screen.getByLabelText("New branch name"), "a b");
    await userEvent.click(screen.getByRole("button", { name: "Create worktree" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent('"a b" is not a valid branch name');
    expect(screen.getByLabelText("New branch name")).toHaveAccessibleDescription(/is not a valid branch name/);
    expect(onSubmit).not.toHaveBeenCalled();

    await userEvent.clear(screen.getByLabelText("New branch name"));
    await userEvent.type(screen.getByLabelText("New branch name"), "hotfix");
    await userEvent.click(screen.getByRole("button", { name: "Create worktree" }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(onSubmit.mock.calls[0]![0].source).toEqual({ kind: "newBranch", branch: "hotfix", startPoint: sha });
  });

  it("the folder follows the typed branch name until it is edited", async () => {
    setup({ kind: "newFromHead", headLabel: "main" });
    await userEvent.type(screen.getByLabelText("New branch name"), "fix/one");
    await waitFor(() => expect(screen.getByLabelText("Folder")).toHaveValue("/w/acme.worktrees/fix-one"));
    await userEvent.clear(screen.getByLabelText("Folder"));
    await userEvent.type(screen.getByLabelText("Folder"), "/elsewhere/mine");
    await userEvent.type(screen.getByLabelText("New branch name"), "2");
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.getByLabelText("Folder")).toHaveValue("/elsewhere/mine");
    // Edited: the absolute path is previewed.
    expect(screen.getByText(/Will create:/)).toBeInTheDocument();
  });

  it("a relative folder shows its resolved form against the repo parent", async () => {
    setup({ kind: "branch", branch: "feature" });
    await waitFor(() => expect(screen.getByLabelText("Folder")).toHaveValue("/w/acme.worktrees/feature"));
    await userEvent.clear(screen.getByLabelText("Folder"));
    await userEvent.type(screen.getByLabelText("Folder"), "side/by-side");
    expect(screen.getByText(/Will create:/).parentElement).toHaveTextContent("/w/side/by-side");
  });

  it("Detached HEAD sits under a collapsed Advanced with the lost-commits warning, and submits a detached source", async () => {
    const sha = "b".repeat(40);
    const { onSubmit } = setup({ kind: "commit", sha, label: "commit bbbbbbb" });
    const advanced = screen.getByRole("button", { name: /Advanced/ });
    expect(advanced).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(advanced);
    await userEvent.click(screen.getByLabelText("Detached HEAD (no branch)"));
    expect(screen.getByText(/can be lost unless you save them on a branch/)).toBeInTheDocument();
    expect(screen.queryByLabelText("New branch name")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Create worktree" }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(onSubmit.mock.calls[0]![0].source).toEqual({ kind: "detached", commit: sha });
  });

  it("maps destination refusals into the Folder field with aria-describedby and no toast", async () => {
    const api = makeMockGitHydra({ repoPath: "/w/acme" });
    vi.mocked(api.validateWorktreeDestination).mockResolvedValue({
      ok: true,
      data: { ok: false, reason: "alreadyWorktree", message: "x", branch: "other", worktreePath: "/w/wt" },
    });
    const { onSubmit, onOpenExisting } = setup({ kind: "branch", branch: "feature" }, api);
    await waitFor(() => expect(screen.getByLabelText("Folder")).toHaveValue("/w/acme.worktrees/feature"));
    await userEvent.click(screen.getByRole("button", { name: "Create worktree" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("A worktree already exists in that folder with branch other checked out.");
    expect(screen.getByLabelText("Folder")).toHaveAccessibleDescription(/already exists/);
    expect(onSubmit).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Open" }));
    expect(onOpenExisting).toHaveBeenCalledWith("/w/wt");
    expect(document.querySelector('[role="status"][class*="toast"]')).toBeNull();
  });

  it("a refusal returned by the create call lands in the branch field with an 'Open that worktree' link", async () => {
    const submit = vi.fn(async (): Promise<CreateFailure | null> => ({
      field: "branch",
      message: "That branch is already checked out at /w/acme.",
      link: { label: "Open that worktree", path: "/w/acme" },
    }));
    const { onOpenExisting } = setup({ kind: "commit", sha: "c".repeat(40), label: "commit ccccccc" }, undefined, { submit });
    await userEvent.type(screen.getByLabelText("New branch name"), "main");
    await userEvent.click(screen.getByRole("button", { name: "Create worktree" }));
    expect(await screen.findByText(/already checked out at \/w\/acme/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Open that worktree" }));
    expect(onOpenExisting).toHaveBeenCalledWith("/w/acme");
  });

  it("Browse picks a parent folder and appends the slug", async () => {
    const api = makeMockGitHydra({ repoPath: "/w/acme" });
    vi.mocked(api.pickWorktreeFolder).mockResolvedValueOnce({ ok: true, data: "/picked" });
    setup({ kind: "branch", branch: "feature" }, api);
    await waitFor(() => expect(screen.getByLabelText("Folder")).toHaveValue("/w/acme.worktrees/feature"));
    await userEvent.click(screen.getByRole("button", { name: "Browse…" }));
    await waitFor(() => expect(screen.getByLabelText("Folder")).toHaveValue("/picked/feature"));
    // Its own picker, never the "open a repository" one (LOW-4).
    expect(api.openRepoDialog).not.toHaveBeenCalled();
  });

  it("is 440 px wide with a sticky footer; only the body scrolls (stylesheet)", async () => {
    const css = (await import("./CreateWorktreeDialog.css?raw")).default as string;
    expect(css).toMatch(/\.gh-create-worktree \{[^}]*width: min\(440px, 90vw\)/s);
    expect(css).toMatch(/\.gh-create-worktree \{[^}]*max-height: calc\(100vh - 32px\)/s);
    expect(css).toMatch(/\.gh-create-worktree \{[^}]*overflow: hidden/s);
    expect(css).toMatch(/\.gh-create-worktree__body \{[^}]*overflow-y: auto/s);
    expect(css).toMatch(/\.gh-create-worktree__footer \{[^}]*flex: none/s);
    for (const m of css.matchAll(/font-size:\s*(\d+)px/g)) expect(Number(m[1])).toBeGreaterThanOrEqual(12);
  });
});
