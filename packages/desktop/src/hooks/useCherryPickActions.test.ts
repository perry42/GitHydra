import { describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useCherryPickActions } from "./useCherryPickActions";
import { makeMockGitHydra } from "../test/mockGitHydra";
import { makeRepoState } from "../test/fixtures";

describe("useCherryPickActions (specs/cherry-pick.md)", () => {
  it("FR-116: a clean cherry-pick calls the API directly, with no confirmation step, and calls onSettled on success", async () => {
    const onSettled = vi.fn();
    const api = makeMockGitHydra();
    const { result } = renderHook(() => useCherryPickActions({ api, onSettled }));

    await act(async () => {
      result.current.cherryPick(["c1", "c2"]);
    });
    await waitFor(() => expect(vi.mocked(api.cherryPick)).toHaveBeenCalledWith(["c1", "c2"]));
    await waitFor(() => expect(onSettled).toHaveBeenCalledTimes(1));
    expect(result.current.error).toBeNull();
  });

  it("a conflicting cherry-pick rejects, but is recognized as an expected pause (fresh getState shows cherry-pick in progress) — onSettled runs, no inline error", async () => {
    const onSettled = vi.fn();
    const api = makeMockGitHydra();
    vi.mocked(api.cherryPick).mockResolvedValueOnce({
      ok: false,
      error: { name: "GitCommandError", message: "fatal: conflict" },
    });
    vi.mocked(api.getState).mockResolvedValueOnce({
      ok: true,
      data: makeRepoState({
        inProgressOperation: "cherry-pick",
        inProgressOperationDetail: {
          kind: "cherry-pick",
          targetSha: "c2",
          targetSubject: "Second",
          isEmptyResult: false,
          remainingAfterCurrent: null,
        },
      }),
    });
    const { result } = renderHook(() => useCherryPickActions({ api, onSettled }));

    await act(async () => {
      result.current.cherryPick(["c1", "c2"]);
    });
    await waitFor(() => expect(onSettled).toHaveBeenCalledTimes(1));
    expect(result.current.error).toBeNull();
  });

  it("FR-120: a genuine refusal (e.g. another operation already in progress) surfaces verbatim; onSettled is not called", async () => {
    const onSettled = vi.fn();
    const api = makeMockGitHydra();
    vi.mocked(api.cherryPick).mockResolvedValueOnce({
      ok: false,
      error: { name: "OperationAlreadyInProgressError", message: "A merge is already in progress." },
    });
    // Fresh read shows the PRE-EXISTING merge, not a cherry-pick — this is a genuine refusal.
    vi.mocked(api.getState).mockResolvedValueOnce({
      ok: true,
      data: makeRepoState({ inProgressOperation: "merge" }),
    });
    const { result } = renderHook(() => useCherryPickActions({ api, onSettled }));

    await act(async () => {
      result.current.cherryPick(["c1"]);
    });
    await waitFor(() => expect(result.current.error).toMatch(/already in progress/i));
    expect(onSettled).not.toHaveBeenCalled();
  });

  it("FR-106/FR-118: skip and commitEmpty call the corresponding API methods and call onSettled on success", async () => {
    const onSettled = vi.fn();
    const api = makeMockGitHydra();
    const { result } = renderHook(() => useCherryPickActions({ api, onSettled }));

    await act(async () => {
      result.current.skip();
    });
    await waitFor(() => expect(vi.mocked(api.skipCherryPickCommit)).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(onSettled).toHaveBeenCalledTimes(1));

    await act(async () => {
      result.current.commitEmpty();
    });
    await waitFor(() => expect(vi.mocked(api.commitEmptyCherryPick)).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(onSettled).toHaveBeenCalledTimes(2));
  });

  it("dismissError clears a surfaced error", async () => {
    const onSettled = vi.fn();
    const api = makeMockGitHydra();
    vi.mocked(api.cherryPick).mockResolvedValueOnce({
      ok: false,
      error: { name: "InvalidArgumentError", message: "nothing to pick" },
    });
    vi.mocked(api.getState).mockResolvedValueOnce({ ok: true, data: makeRepoState() });
    const { result } = renderHook(() => useCherryPickActions({ api, onSettled }));

    await act(async () => {
      result.current.cherryPick([]);
    });
    await waitFor(() => expect(result.current.error).not.toBeNull());

    act(() => result.current.dismissError());
    expect(result.current.error).toBeNull();
  });
});
