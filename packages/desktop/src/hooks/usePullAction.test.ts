// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { PullIpcOutcome } from "../../shared/ipcContract";
import { makeRepoState } from "../test/fixtures";
import { makeMockGitHydra } from "../test/mockGitHydra";
import { usePullAction } from "./usePullAction";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe("usePullAction (specs/online-sync-pull.md FR-338/FR-339)", () => {
  it("starts idle with strategy 'auto', and calls api.pull with a fresh requestId and no strategy override on runPull", async () => {
    const api = makeMockGitHydra();
    const onSettled = vi.fn();
    const { result } = renderHook(() => usePullAction({ api, onSettled }));

    expect(result.current.phase).toBe("idle");
    expect(result.current.strategy).toBe("auto");

    act(() => result.current.runPull());
    expect(result.current.phase).toBe("pulling");
    expect(result.current.isPulling).toBe(true);

    await waitFor(() => expect(result.current.phase).toBe("done"));
    expect(result.current.outcome).toEqual({ kind: "up-to-date" });
    expect(onSettled).toHaveBeenCalledTimes(1);

    const [requestId, options] = vi.mocked(api.pull).mock.calls[0]!;
    expect(typeof requestId).toBe("string");
    expect(options).toEqual({});
  });

  it("FR-339: passes the explicit strategy override straight through once selected", async () => {
    const api = makeMockGitHydra();
    const { result } = renderHook(() => usePullAction({ api, onSettled: vi.fn() }));

    act(() => result.current.setStrategy("rebase"));
    act(() => result.current.runPull());

    await waitFor(() => expect(result.current.phase).toBe("done"));
    const [, options] = vi.mocked(api.pull).mock.calls[0]!;
    expect(options).toEqual({ strategy: "rebase" });
  });

  it("distinguishes all three PullOutcome kinds in .outcome", async () => {
    const api = makeMockGitHydra();
    const { result } = renderHook(() => usePullAction({ api, onSettled: vi.fn() }));

    vi.mocked(api.pull).mockResolvedValueOnce({
      outcome: "settled",
      result: { ok: true, data: { kind: "fast-forward", fromSha: "a".repeat(40), toSha: "b".repeat(40) } },
    });
    act(() => result.current.runPull());
    await waitFor(() => expect(result.current.outcome).toMatchObject({ kind: "fast-forward" }));

    act(() => result.current.dismiss());
    vi.mocked(api.pull).mockResolvedValueOnce({
      outcome: "settled",
      result: { ok: true, data: { kind: "integrated", strategy: "merge" } },
    });
    act(() => result.current.runPull());
    await waitFor(() => expect(result.current.outcome).toMatchObject({ kind: "integrated", strategy: "merge" }));
  });

  it("a conflicting pull rejects but is recognized as an expected pause (fresh getState shows merge/rebase in progress) — onSettled runs, no inline error, no outcome set", async () => {
    const api = makeMockGitHydra();
    const onSettled = vi.fn();
    vi.mocked(api.pull).mockResolvedValueOnce({
      outcome: "settled",
      result: { ok: false, error: { name: "GitCommandError", message: "fatal: conflict" } },
    });
    vi.mocked(api.getState).mockResolvedValueOnce({
      ok: true,
      data: makeRepoState({ inProgressOperation: "rebase" }),
    });
    const { result } = renderHook(() => usePullAction({ api, onSettled }));

    act(() => result.current.runPull());
    await waitFor(() => expect(onSettled).toHaveBeenCalled());
    expect(result.current.error).toBeNull();
    expect(result.current.outcome).toBeNull();
    expect(result.current.phase).toBe("idle");
  });

  it("a genuine refusal (fresh getState shows no in-progress merge/rebase) surfaces verbatim as .error, and onMutationSettled closes the gate", async () => {
    const api = makeMockGitHydra();
    const onSettled = vi.fn();
    const onMutationStart = vi.fn();
    const onMutationSettled = vi.fn();
    vi.mocked(api.pull).mockResolvedValueOnce({
      outcome: "settled",
      result: { ok: false, error: { name: "NoUpstreamConfiguredError", message: "No upstream is configured for the current branch." } },
    });
    vi.mocked(api.getState).mockResolvedValueOnce({ ok: true, data: makeRepoState({ inProgressOperation: null }) });
    const { result } = renderHook(() => usePullAction({ api, onSettled, onMutationStart, onMutationSettled }));

    act(() => result.current.runPull());
    expect(onMutationStart).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(result.current.error).toMatch(/no upstream/i));
    expect(result.current.phase).toBe("done");
    expect(onSettled).not.toHaveBeenCalled();
    expect(onMutationSettled).toHaveBeenCalledTimes(1);
  });

  it("cancelling returns to idle without calling onSettled, closes the mutation gate, and never populates outcome", async () => {
    const api = makeMockGitHydra();
    const gate = deferred<PullIpcOutcome>();
    vi.mocked(api.pull).mockReturnValueOnce(gate.promise);
    const onSettled = vi.fn();
    const onMutationSettled = vi.fn();
    const { result } = renderHook(() => usePullAction({ api, onSettled, onMutationSettled }));

    act(() => result.current.runPull());
    expect(result.current.phase).toBe("pulling");

    act(() => result.current.cancelPull());
    const [requestId] = vi.mocked(api.cancelPull).mock.calls[0]!;
    expect(typeof requestId).toBe("string");

    gate.resolve({ outcome: "cancelled" });
    await waitFor(() => expect(result.current.phase).toBe("idle"));
    expect(result.current.outcome).toBeNull();
    expect(onSettled).not.toHaveBeenCalled();
    expect(onMutationSettled).toHaveBeenCalledTimes(1);
  });

  it("ignores progress events tagged with a different (stale/superseded) requestId", async () => {
    const api = makeMockGitHydra();
    let progressListener:
      | ((requestId: string, event: import("@githydra/git-core").FetchProgressEvent) => void)
      | null = null;
    vi.mocked(api.onPullProgress).mockImplementation((listener) => {
      progressListener = listener;
      return () => {
        progressListener = null;
      };
    });
    const gate = deferred<PullIpcOutcome>();
    vi.mocked(api.pull).mockReturnValueOnce(gate.promise);
    const { result } = renderHook(() => usePullAction({ api, onSettled: vi.fn() }));

    act(() => result.current.runPull());
    act(() => {
      progressListener?.("some-other-stale-request-id", {
        remoteName: "origin",
        stage: "Compressing objects",
        percent: 50,
        raw: "remote: Compressing objects: 50% (1/2)",
      });
    });
    expect(result.current.latestProgress).toBeNull();

    const [ownRequestId] = vi.mocked(api.pull).mock.calls[0]!;
    act(() => {
      progressListener?.(ownRequestId, {
        remoteName: "origin",
        stage: "Counting objects",
        percent: 10,
        raw: "remote: Counting objects: 10% (1/10)",
      });
    });
    expect(result.current.latestProgress?.stage).toBe("Counting objects");

    gate.resolve({ outcome: "settled", result: { ok: true, data: { kind: "up-to-date" } } });
    await waitFor(() => expect(result.current.phase).toBe("done"));
  });

  it("dismiss() clears outcome/error and returns to idle", async () => {
    const api = makeMockGitHydra();
    const { result } = renderHook(() => usePullAction({ api, onSettled: vi.fn() }));

    act(() => result.current.runPull());
    await waitFor(() => expect(result.current.phase).toBe("done"));

    act(() => result.current.dismiss());
    expect(result.current.phase).toBe("idle");
    expect(result.current.outcome).toBeNull();
  });
});
