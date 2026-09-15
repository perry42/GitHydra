// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useDragCommitActions } from "./useDragCommitActions";
import { makeCommit, makeRepoState } from "../test/fixtures";
import { makeMockGitHydra } from "../test/mockGitHydra";

describe("useDragCommitActions (specs/drag-commit-menu.md FR-309/311/312/313/314)", () => {
  it("FR-309: when {B} is already HEAD, Merge skips the checkout entirely and calls mergeCommit(A) directly", async () => {
    const onSettled = vi.fn();
    const cherryPick = vi.fn();
    const api = makeMockGitHydra({ repoState: { headSha: "b1" } });
    const { result } = renderHook(() =>
      useDragCommitActions({ api, repoState: makeRepoState({ headSha: "b1" }), cherryPick, onSettled }),
    );

    await act(async () => {
      result.current.runMerge("a1", "b1");
    });
    await waitFor(() => expect(vi.mocked(api.mergeCommit)).toHaveBeenCalledWith("a1"));
    expect(api.switchBranch).not.toHaveBeenCalled();
    expect(api.switchToCommit).not.toHaveBeenCalled();
    expect(result.current.error).toBeNull();
  });

  it("FR-309: when {B} isn't HEAD and is a local branch tip, switches via switchBranch before merging", async () => {
    const onSettled = vi.fn();
    const cherryPick = vi.fn();
    const api = makeMockGitHydra({
      commits: [makeCommit("b1", [], { refs: [{ name: "feature", fullName: "refs/heads/feature", type: "local-branch" }] })],
    });
    const { result } = renderHook(() =>
      useDragCommitActions({ api, repoState: makeRepoState({ headSha: "other" }), cherryPick, onSettled }),
    );

    await act(async () => {
      result.current.runMerge("a1", "b1");
    });
    await waitFor(() => expect(vi.mocked(api.switchBranch)).toHaveBeenCalledWith("feature"));
    await waitFor(() => expect(vi.mocked(api.mergeCommit)).toHaveBeenCalledWith("a1"));
    expect(api.switchToCommit).not.toHaveBeenCalled();
    // FR-314: the checkout half refreshes too, not only the merge itself.
    expect(onSettled.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("FR-309: when {B} isn't HEAD and carries no local branch, detaches via switchToCommit before rebasing", async () => {
    const cherryPick = vi.fn();
    const onSettled = vi.fn();
    const api = makeMockGitHydra({ commits: [makeCommit("b1", [], { refs: [] })] });
    const { result } = renderHook(() =>
      useDragCommitActions({ api, repoState: makeRepoState({ headSha: "other" }), cherryPick, onSettled }),
    );

    await act(async () => {
      result.current.runRebase("a1", "b1");
    });
    await waitFor(() => expect(vi.mocked(api.switchToCommit)).toHaveBeenCalledWith("b1"));
    await waitFor(() => expect(vi.mocked(api.rebaseCommitOnto)).toHaveBeenCalledWith("a1"));
    expect(api.switchBranch).not.toHaveBeenCalled();
  });

  it("FR-9: a refused checkout (e.g. uncommitted changes) surfaces verbatim and never attempts the merge/rebase/cherry-pick call", async () => {
    const cherryPick = vi.fn();
    const onSettled = vi.fn();
    const api = makeMockGitHydra({ commits: [makeCommit("b1", [], { refs: [] })] });
    const refusal = {
      ok: false as const,
      error: { name: "BranchSwitchConflictError", message: "Your local changes would be overwritten." },
    };
    vi.mocked(api.switchToCommit).mockResolvedValueOnce(refusal).mockResolvedValueOnce(refusal);
    const { result } = renderHook(() =>
      useDragCommitActions({ api, repoState: makeRepoState({ headSha: "other" }), cherryPick, onSettled }),
    );

    await act(async () => {
      result.current.runMerge("a1", "b1");
    });
    await waitFor(() => expect(result.current.error).toMatch(/overwritten/i));
    expect(api.mergeCommit).not.toHaveBeenCalled();

    await act(async () => {
      result.current.runCherryPick("a1", "b1");
    });
    expect(cherryPick).not.toHaveBeenCalled();
  });

  it("a conflicting merge rejects but is recognized as an expected pause (fresh getState shows merge in progress) — onSettled runs, no inline error", async () => {
    const cherryPick = vi.fn();
    const onSettled = vi.fn();
    const api = makeMockGitHydra({ repoState: { headSha: "b1" } });
    vi.mocked(api.mergeCommit).mockResolvedValueOnce({
      ok: false,
      error: { name: "GitCommandError", message: "fatal: conflict" },
    });
    vi.mocked(api.getState).mockResolvedValueOnce({
      ok: true,
      data: makeRepoState({ headSha: "b1", inProgressOperation: "merge" }),
    });
    const { result } = renderHook(() =>
      useDragCommitActions({ api, repoState: makeRepoState({ headSha: "b1" }), cherryPick, onSettled }),
    );

    await act(async () => {
      result.current.runMerge("a1", "b1");
    });
    await waitFor(() => expect(onSettled).toHaveBeenCalled());
    expect(result.current.error).toBeNull();
  });

  it("a genuine rebase failure (fresh getState shows no in-progress rebase) surfaces verbatim", async () => {
    const cherryPick = vi.fn();
    const onSettled = vi.fn();
    const api = makeMockGitHydra({ repoState: { headSha: "b1" } });
    vi.mocked(api.rebaseCommitOnto).mockResolvedValueOnce({
      ok: false,
      error: { name: "OperationAlreadyInProgressError", message: "A cherry-pick is already in progress." },
    });
    vi.mocked(api.getState).mockResolvedValueOnce({
      ok: true,
      data: makeRepoState({ headSha: "b1", inProgressOperation: "cherry-pick" }),
    });
    const { result } = renderHook(() =>
      useDragCommitActions({ api, repoState: makeRepoState({ headSha: "b1" }), cherryPick, onSettled }),
    );

    await act(async () => {
      result.current.runRebase("a1", "b1");
    });
    await waitFor(() => expect(result.current.error).toMatch(/already in progress/i));
  });

  it("FR-311: Cherry-pick delegates to the caller-supplied cherryPick callback with [aSha] after a successful checkout", async () => {
    const cherryPick = vi.fn();
    const onSettled = vi.fn();
    const api = makeMockGitHydra({
      commits: [makeCommit("b1", [], { refs: [{ name: "feature", fullName: "refs/heads/feature", type: "local-branch" }] })],
    });
    const { result } = renderHook(() =>
      useDragCommitActions({ api, repoState: makeRepoState({ headSha: "other" }), cherryPick, onSettled }),
    );

    await act(async () => {
      result.current.runCherryPick("a1", "b1");
    });
    await waitFor(() => expect(cherryPick).toHaveBeenCalledWith(["a1"]));
    expect(api.mergeCommit).not.toHaveBeenCalled();
    expect(api.rebaseCommitOnto).not.toHaveBeenCalled();
  });

  it("FR-311: Cherry-pick skips the checkout entirely when {B} is already HEAD", async () => {
    const cherryPick = vi.fn();
    const onSettled = vi.fn();
    const api = makeMockGitHydra({ repoState: { headSha: "b1" } });
    const { result } = renderHook(() =>
      useDragCommitActions({ api, repoState: makeRepoState({ headSha: "b1" }), cherryPick, onSettled }),
    );

    await act(async () => {
      result.current.runCherryPick("a1", "b1");
    });
    await waitFor(() => expect(cherryPick).toHaveBeenCalledWith(["a1"]));
    expect(api.switchBranch).not.toHaveBeenCalled();
    expect(api.switchToCommit).not.toHaveBeenCalled();
  });

  it("dismissError clears a surfaced error", async () => {
    const cherryPick = vi.fn();
    const onSettled = vi.fn();
    const api = makeMockGitHydra({ commits: [makeCommit("b1", [], { refs: [] })] });
    vi.mocked(api.switchToCommit).mockResolvedValueOnce({
      ok: false,
      error: { name: "BranchSwitchConflictError", message: "conflict" },
    });
    const { result } = renderHook(() =>
      useDragCommitActions({ api, repoState: makeRepoState({ headSha: "other" }), cherryPick, onSettled }),
    );

    await act(async () => {
      result.current.runMerge("a1", "b1");
    });
    await waitFor(() => expect(result.current.error).not.toBeNull());

    act(() => result.current.dismissError());
    expect(result.current.error).toBeNull();
  });
});
