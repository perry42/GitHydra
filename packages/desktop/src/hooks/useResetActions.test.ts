// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useResetActions } from "./useResetActions";
import { makeMockGitHydra } from "../test/mockGitHydra";
import { makeRepoState } from "../test/fixtures";

function setup(overrides: Parameters<typeof makeMockGitHydra>[0] = {}) {
  const api = makeMockGitHydra({ repoState: { headSha: "head1" }, ...overrides });
  const onSettled = vi.fn();
  const getLoadedCommitSubject = vi.fn(() => "Previous subject");
  const { result, rerender } = renderHook(
    (props: { repoState: ReturnType<typeof makeRepoState> | null }) =>
      useResetActions({ api, repoState: props.repoState, getLoadedCommitSubject, onSettled }),
    { initialProps: { repoState: makeRepoState({ headSha: "head1" }) } },
  );
  return { api, onSettled, getLoadedCommitSubject, result, rerender };
}

describe("useResetActions (specs/reset-to-here.md FR-373 through FR-376)", () => {
  it("FR-371: Soft calls resetCurrentBranch immediately, no fresh dirty-check read, and pushes an undo banner on success", async () => {
    const { api, result } = setup();
    act(() => result.current.requestReset("target1", "soft", "main"));
    await waitFor(() => expect(api.resetCurrentBranch).toHaveBeenCalledWith("target1", "soft"));
    expect(api.getWorkingDirStatus).not.toHaveBeenCalled();
    await waitFor(() => expect(result.current.undoBanner).not.toBeNull());
    expect(result.current.undoBanner).toMatchObject({
      mode: "soft",
      producedSha: "target1",
      previousSha: "head1",
      previousAbbrevSha: "head1".slice(0, 7),
      previousSubject: "Previous subject",
      branchLabel: "main",
    });
    expect(result.current.pendingHardConfirm).toBeNull();
  });

  it("FR-371: Mixed calls resetCurrentBranch immediately, same as Soft", async () => {
    const { api, result } = setup();
    act(() => result.current.requestReset("target1", "mixed", "main"));
    await waitFor(() => expect(api.resetCurrentBranch).toHaveBeenCalledWith("target1", "mixed"));
  });

  it("FR-371: Hard against a CLEAN working tree resets immediately, after a fresh dirty-check read — no second dialog", async () => {
    const { api, result } = setup({ workingDirStatus: { hasChanges: false, staged: 0, unstaged: 0, conflicted: 0, untracked: 0 } });
    act(() => result.current.requestReset("target1", "hard", "main"));
    await waitFor(() => expect(api.getWorkingDirStatus).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(api.resetCurrentBranch).toHaveBeenCalledWith("target1", "hard"));
    expect(result.current.pendingHardConfirm).toBeNull();
  });

  it("FR-369/371, security review: Hard against a DIRTY working tree does NOT reset yet — opens pendingHardConfirm with the exact fresh counts instead", async () => {
    const { api, result } = setup({
      workingDirStatus: { hasChanges: true, staged: 3, unstaged: 2, conflicted: 0, untracked: 0 },
    });
    act(() => result.current.requestReset("target1", "hard", "main"));
    await waitFor(() => expect(result.current.pendingHardConfirm).not.toBeNull());
    expect(result.current.pendingHardConfirm).toMatchObject({ staged: 3, unstaged: 2, conflicted: 0, isUndo: false });
    expect(api.resetCurrentBranch).not.toHaveBeenCalled();
  });

  it("cancelHardReset makes no git call and clears the pending escalation", async () => {
    const { api, result } = setup({
      workingDirStatus: { hasChanges: true, staged: 1, unstaged: 0, conflicted: 0, untracked: 0 },
    });
    act(() => result.current.requestReset("target1", "hard", "main"));
    await waitFor(() => expect(result.current.pendingHardConfirm).not.toBeNull());

    act(() => result.current.cancelHardReset());
    expect(result.current.pendingHardConfirm).toBeNull();
    expect(api.resetCurrentBranch).not.toHaveBeenCalled();
  });

  it("confirmHardReset performs the reset only after the second confirmation", async () => {
    const { api, result } = setup({
      workingDirStatus: { hasChanges: true, staged: 1, unstaged: 0, conflicted: 0, untracked: 0 },
    });
    act(() => result.current.requestReset("target1", "hard", "main"));
    await waitFor(() => expect(result.current.pendingHardConfirm).not.toBeNull());

    act(() => result.current.confirmHardReset());
    await waitFor(() => expect(api.resetCurrentBranch).toHaveBeenCalledWith("target1", "hard"));
    expect(result.current.pendingHardConfirm).toBeNull();
  });

  it("a genuine reset failure surfaces verbatim via error; no undo banner is pushed", async () => {
    const api = makeMockGitHydra({ repoState: { headSha: "head1" } });
    vi.mocked(api.resetCurrentBranch).mockResolvedValueOnce({
      ok: false,
      error: { name: "OperationAlreadyInProgressError", message: "A merge is already in progress." },
    });
    const onSettled = vi.fn();
    const { result } = renderHook(() =>
      useResetActions({ api, repoState: makeRepoState({ headSha: "head1" }), getLoadedCommitSubject: () => null, onSettled }),
    );
    act(() => result.current.requestReset("target1", "soft", "main"));
    await waitFor(() => expect(result.current.error).toMatch(/already in progress/i));
    expect(result.current.undoBanner).toBeNull();
    expect(onSettled).not.toHaveBeenCalled();
  });

  it("FR-375: undo() re-invokes the same mode against the captured previous SHA", async () => {
    const { api, result } = setup();
    act(() => result.current.requestReset("target1", "hard", "main"));
    await waitFor(() => expect(result.current.undoBanner).not.toBeNull());
    vi.mocked(api.resetCurrentBranch).mockClear();

    act(() => result.current.undo());
    await waitFor(() => expect(api.resetCurrentBranch).toHaveBeenCalledWith("head1", "hard"));
  });

  it("FR-375/376(b): undoing a Hard reset when the working tree is dirty again still routes through the full FR-369/371 escalation, and a successful Undo clears (never replaces) the banner", async () => {
    const api = makeMockGitHydra({
      repoState: { headSha: "head1" },
      workingDirStatus: { hasChanges: false, staged: 0, unstaged: 0, conflicted: 0, untracked: 0 },
    });
    const onSettled = vi.fn();
    const { result } = renderHook(() =>
      useResetActions({
        api,
        repoState: makeRepoState({ headSha: "head1" }),
        getLoadedCommitSubject: () => "Previous subject",
        onSettled,
      }),
    );
    // Original Hard reset against a clean tree — resets immediately, banner appears.
    act(() => result.current.requestReset("target1", "hard", "main"));
    await waitFor(() => expect(result.current.undoBanner).not.toBeNull());

    // The tree has since become dirty again — the next fresh read reflects that.
    vi.mocked(api.getWorkingDirStatus).mockResolvedValueOnce({
      ok: true,
      data: { hasChanges: true, staged: 1, unstaged: 0, conflicted: 0, untracked: 0 },
    });
    vi.mocked(api.resetCurrentBranch).mockClear(); // Clear the ORIGINAL Hard reset's own call first.
    act(() => result.current.undo());
    await waitFor(() => expect(result.current.pendingHardConfirm).not.toBeNull());
    expect(result.current.pendingHardConfirm).toMatchObject({ isUndo: true, staged: 1 });
    expect(api.resetCurrentBranch).not.toHaveBeenCalled(); // Never an unconfirmed hard reset.

    act(() => result.current.confirmHardReset());
    await waitFor(() => expect(api.resetCurrentBranch).toHaveBeenCalledWith("head1", "hard"));
    await waitFor(() => expect(result.current.undoBanner).toBeNull()); // FR-376(b): cleared, not replaced.
  });

  it("FR-376(c): the undo banner clears once repoState.headSha moves away from the produced SHA, for any reason", async () => {
    const { result, rerender } = setup();
    act(() => result.current.requestReset("target1", "soft", "main"));
    await waitFor(() => expect(result.current.undoBanner?.producedSha).toBe("target1"));

    // The App's own post-reset refresh lands, catching `repoState` up to the produced SHA — this
    // must happen (and be observed) BEFORE a later divergence counts as "HEAD moved away", or every
    // banner would clear itself the instant it's created (repoState is still showing the PRE-reset
    // headSha for that whole in-between window — see the hook's own doc comment on this exact race).
    rerender({ repoState: makeRepoState({ headSha: "target1" }) });
    expect(result.current.undoBanner).not.toBeNull();

    // NOW HEAD moves elsewhere (a new commit, a branch switch, ...) without ever clicking Undo.
    rerender({ repoState: makeRepoState({ headSha: "somewhere-else" }) });
    await waitFor(() => expect(result.current.undoBanner).toBeNull());
  });

  it("FR-376(c) edge case: does NOT clear the banner just because repoState hasn't caught up to the produced SHA yet (the ordinary post-reset refresh lag, not an external change)", async () => {
    const { result } = setup();
    act(() => result.current.requestReset("target1", "soft", "main"));
    await waitFor(() => expect(result.current.undoBanner?.producedSha).toBe("target1"));
    // No rerender at all — `repoState.headSha` is still "head1" (the PRE-reset value), exactly the
    // state the real app is briefly in before its own async refresh lands.
    expect(result.current.undoBanner).not.toBeNull();
  });

  it("FR-376(a): dismissUndoBanner clears it explicitly", async () => {
    const { result } = setup();
    act(() => result.current.requestReset("target1", "soft", "main"));
    await waitFor(() => expect(result.current.undoBanner).not.toBeNull());

    act(() => result.current.dismissUndoBanner());
    expect(result.current.undoBanner).toBeNull();
  });

  it("dismissError clears a surfaced error", async () => {
    const api = makeMockGitHydra({ repoState: { headSha: "head1" } });
    vi.mocked(api.resetCurrentBranch).mockResolvedValueOnce({
      ok: false,
      error: { name: "InvalidArgumentError", message: "bad sha" },
    });
    const { result } = renderHook(() =>
      useResetActions({
        api,
        repoState: makeRepoState({ headSha: "head1" }),
        getLoadedCommitSubject: () => null,
        onSettled: () => {},
      }),
    );
    act(() => result.current.requestReset("target1", "soft", "main"));
    await waitFor(() => expect(result.current.error).not.toBeNull());

    act(() => result.current.dismissError());
    expect(result.current.error).toBeNull();
  });
});
