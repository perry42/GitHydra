import { describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useStashActions } from "./useStashActions";
import { makeMockGitHydra } from "../test/mockGitHydra";
import { makeStash } from "../test/fixtures";

describe("useStashActions", () => {
  it("FR-96: applyStash/popStash call the API directly, with no confirmation step, and call onMutated on success", async () => {
    const onMutated = vi.fn();
    const onConflict = vi.fn();
    const api = makeMockGitHydra({ stashes: [makeStash(0)] });
    const { result } = renderHook(() => useStashActions({ api, onMutated, onConflict }));

    await act(async () => {
      result.current.applyStash(0);
    });
    await waitFor(() => expect(vi.mocked(api.applyStash)).toHaveBeenCalledWith(0));
    await waitFor(() => expect(onMutated).toHaveBeenCalledTimes(1));
    expect(onConflict).not.toHaveBeenCalled();
  });

  it("FR-98: a conflicting outcome calls onConflict with the action and conflicted paths, but still calls onMutated", async () => {
    const onMutated = vi.fn();
    const onConflict = vi.fn();
    const api = makeMockGitHydra({ stashes: [makeStash(0)] });
    vi.mocked(api.popStash).mockResolvedValueOnce({
      ok: true,
      data: { status: "conflict", conflictedPaths: ["a.ts", "b.ts"] },
    });
    const { result } = renderHook(() => useStashActions({ api, onMutated, onConflict }));

    await act(async () => {
      result.current.popStash(0);
    });
    await waitFor(() => expect(onConflict).toHaveBeenCalledWith("pop", ["a.ts", "b.ts"]));
    expect(onMutated).toHaveBeenCalledTimes(1);
  });

  it("FR-97: drop requires requestDrop -> confirmDrop; cancelDrop never calls the API", async () => {
    const onMutated = vi.fn();
    const api = makeMockGitHydra({ stashes: [makeStash(0)] });
    const { result } = renderHook(() => useStashActions({ api, onMutated, onConflict: vi.fn() }));

    act(() => result.current.requestDrop(0, "WIP on main"));
    expect(result.current.pendingDrop).toEqual({ index: 0, message: "WIP on main" });

    act(() => result.current.cancelDrop());
    expect(result.current.pendingDrop).toBeNull();
    expect(vi.mocked(api.dropStash)).not.toHaveBeenCalled();

    act(() => result.current.requestDrop(0, "WIP on main"));
    await act(async () => {
      result.current.confirmDrop();
    });
    await waitFor(() => expect(vi.mocked(api.dropStash)).toHaveBeenCalledWith(0));
    await waitFor(() => expect(onMutated).toHaveBeenCalledTimes(1));
  });

  it("surfaces a real refusal and calls onMutationSettled (closing the self-write gate) without calling onMutated", async () => {
    const onMutated = vi.fn();
    const onMutationStart = vi.fn();
    const onMutationSettled = vi.fn();
    const api = makeMockGitHydra({ stashes: [makeStash(0)] });
    vi.mocked(api.applyStash).mockResolvedValueOnce({
      ok: false,
      error: { name: "GitCommandError", message: "fatal: could not apply" },
    });
    const { result } = renderHook(() =>
      useStashActions({ api, onMutated, onMutationStart, onMutationSettled, onConflict: vi.fn() }),
    );

    expect(onMutationStart).not.toHaveBeenCalled();
    await act(async () => {
      result.current.applyStash(0);
    });
    expect(onMutationStart).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(result.current.error).toMatch(/could not apply/i));
    expect(onMutated).not.toHaveBeenCalled();
    expect(onMutationSettled).toHaveBeenCalledTimes(1);
  });
});
