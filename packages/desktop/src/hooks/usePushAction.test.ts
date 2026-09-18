// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { PushIpcOutcome } from "../../shared/ipcContract";
import { makeMockGitHydra } from "../test/mockGitHydra";
import { usePushAction } from "./usePushAction";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe("usePushAction (specs/online-sync-push.md FR-344/FR-346/FR-347/FR-348)", () => {
  it("starts idle, and a zero/null behind count pushes immediately with a fresh requestId", async () => {
    const api = makeMockGitHydra();
    const onSettled = vi.fn();
    const { result } = renderHook(() => usePushAction({ api, onSettled }));

    expect(result.current.phase).toBe("idle");
    expect(result.current.pendingBehindConfirm).toBeNull();

    act(() => result.current.requestPush("origin", "main", null));
    expect(result.current.phase).toBe("pushing");
    expect(result.current.isPushing).toBe(true);
    expect(result.current.pendingBehindConfirm).toBeNull();

    await waitFor(() => expect(result.current.phase).toBe("done"));
    expect(result.current.outcome).toMatchObject({ kind: "pushed", remoteName: "origin", localBranch: "main" });
    expect(onSettled).toHaveBeenCalledTimes(1);

    const [requestId, remoteName, localBranchName] = vi.mocked(api.push).mock.calls[0]!;
    expect(typeof requestId).toBe("string");
    expect(remoteName).toBe("origin");
    expect(localBranchName).toBe("main");
  });

  it("FR-347: a positive behind count opens pendingBehindConfirm instead of pushing immediately", () => {
    const api = makeMockGitHydra();
    const { result } = renderHook(() => usePushAction({ api, onSettled: vi.fn() }));

    act(() => result.current.requestPush("origin", "main", 3));

    expect(result.current.phase).toBe("idle");
    expect(api.push).not.toHaveBeenCalled();
    expect(result.current.pendingBehindConfirm).toEqual({ remoteName: "origin", localBranchName: "main", behind: 3 });
  });

  it("FR-347: confirmPendingPush proceeds with the exact pending remote/branch", async () => {
    const api = makeMockGitHydra();
    const { result } = renderHook(() => usePushAction({ api, onSettled: vi.fn() }));

    act(() => result.current.requestPush("origin", "main", 2));
    act(() => result.current.confirmPendingPush());

    expect(result.current.pendingBehindConfirm).toBeNull();
    expect(result.current.phase).toBe("pushing");
    const [, remoteName, localBranchName] = vi.mocked(api.push).mock.calls[0]!;
    expect(remoteName).toBe("origin");
    expect(localBranchName).toBe("main");

    await waitFor(() => expect(result.current.phase).toBe("done"));
  });

  it("FR-347: cancelPendingPush clears the pending state and makes no push call", () => {
    const api = makeMockGitHydra();
    const { result } = renderHook(() => usePushAction({ api, onSettled: vi.fn() }));

    act(() => result.current.requestPush("origin", "main", 5));
    act(() => result.current.cancelPendingPush());

    expect(result.current.pendingBehindConfirm).toBeNull();
    expect(api.push).not.toHaveBeenCalled();
    expect(result.current.phase).toBe("idle");
  });

  it("FR-346: a non-fast-forward rejection classifies with the specific 'pull first' message and isNonFastForwardRejection=true", async () => {
    const api = makeMockGitHydra();
    const onSettled = vi.fn();
    const onMutationSettled = vi.fn();
    vi.mocked(api.push).mockResolvedValueOnce({
      outcome: "settled",
      result: {
        ok: false,
        error: {
          name: "GitCommandError",
          message: "git push exited with code 1: ! [rejected]  main -> main (non-fast-forward)",
          stderr:
            "! [rejected]        main -> main (non-fast-forward)\nerror: failed to push some refs\nhint: Updates were rejected",
        },
      },
    });
    const { result } = renderHook(() => usePushAction({ api, onSettled, onMutationSettled }));

    act(() => result.current.requestPush("origin", "main", null));
    await waitFor(() => expect(result.current.phase).toBe("done"));

    expect(result.current.isNonFastForwardRejection).toBe(true);
    expect(result.current.error).toMatch(/pull first/i);
    // The classified message legitimately reassures that no force retry ever happens ("GitHydra
    // never auto-retries... any force option") — the non-goal is never OFFERING a force escalation,
    // not avoiding the word in prose that explains one won't happen.
    expect(result.current.error).toMatch(/never auto-retries.*force option/i);
    expect(result.current.rawStderr).toMatch(/non-fast-forward/);
    expect(onSettled).not.toHaveBeenCalled();
    expect(onMutationSettled).toHaveBeenCalledTimes(1);
  });

  it("a genuine non-network refusal (no stderr) surfaces its own message verbatim, with isNonFastForwardRejection=false", async () => {
    const api = makeMockGitHydra();
    vi.mocked(api.push).mockResolvedValueOnce({
      outcome: "settled",
      result: {
        ok: false,
        error: { name: "InvalidArgumentError", message: '"main" is not a local branch in this repository.' },
      },
    });
    const { result } = renderHook(() => usePushAction({ api, onSettled: vi.fn() }));

    act(() => result.current.requestPush("origin", "main", null));
    await waitFor(() => expect(result.current.phase).toBe("done"));

    expect(result.current.isNonFastForwardRejection).toBe(false);
    expect(result.current.error).toMatch(/not a local branch/i);
    expect(result.current.rawStderr).toBeNull();
  });

  it("cancelling returns to idle without calling onSettled, closes the mutation gate, and never populates outcome", async () => {
    const api = makeMockGitHydra();
    const gate = deferred<PushIpcOutcome>();
    vi.mocked(api.push).mockReturnValueOnce(gate.promise);
    const onSettled = vi.fn();
    const onMutationSettled = vi.fn();
    const { result } = renderHook(() => usePushAction({ api, onSettled, onMutationSettled }));

    act(() => result.current.requestPush("origin", "main", null));
    expect(result.current.phase).toBe("pushing");

    act(() => result.current.cancelPush());
    const [requestId] = vi.mocked(api.cancelPush).mock.calls[0]!;
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
    vi.mocked(api.onPushProgress).mockImplementation((listener) => {
      progressListener = listener;
      return () => {
        progressListener = null;
      };
    });
    const gate = deferred<PushIpcOutcome>();
    vi.mocked(api.push).mockReturnValueOnce(gate.promise);
    const { result } = renderHook(() => usePushAction({ api, onSettled: vi.fn() }));

    act(() => result.current.requestPush("origin", "main", null));
    act(() => {
      progressListener?.("some-other-stale-request-id", {
        remoteName: "origin",
        stage: "Compressing objects",
        percent: 50,
        raw: "Compressing objects: 50% (1/2)",
      });
    });
    expect(result.current.latestProgress).toBeNull();

    const [ownRequestId] = vi.mocked(api.push).mock.calls[0]!;
    act(() => {
      progressListener?.(ownRequestId, {
        remoteName: "origin",
        stage: "Writing objects",
        percent: 10,
        raw: "Writing objects: 10% (1/10)",
      });
    });
    expect(result.current.latestProgress?.stage).toBe("Writing objects");

    gate.resolve({
      outcome: "settled",
      result: { ok: true, data: { kind: "pushed", remoteName: "origin", localBranch: "main", remoteBranch: "main", sha: "a".repeat(40) } },
    });
    await waitFor(() => expect(result.current.phase).toBe("done"));
  });

  it("dismiss() clears outcome/error/classification and returns to idle", async () => {
    const api = makeMockGitHydra();
    const { result } = renderHook(() => usePushAction({ api, onSettled: vi.fn() }));

    act(() => result.current.requestPush("origin", "main", null));
    await waitFor(() => expect(result.current.phase).toBe("done"));

    act(() => result.current.dismiss());
    expect(result.current.phase).toBe("idle");
    expect(result.current.outcome).toBeNull();
    expect(result.current.error).toBeNull();
    expect(result.current.isNonFastForwardRejection).toBe(false);
    expect(result.current.rawStderr).toBeNull();
  });

  it("requestPush is a no-op while already pushing", async () => {
    const api = makeMockGitHydra();
    const gate = deferred<PushIpcOutcome>();
    vi.mocked(api.push).mockReturnValueOnce(gate.promise);
    const { result } = renderHook(() => usePushAction({ api, onSettled: vi.fn() }));

    act(() => result.current.requestPush("origin", "main", null));
    act(() => result.current.requestPush("origin", "main", null));

    expect(api.push).toHaveBeenCalledTimes(1);
    gate.resolve({
      outcome: "settled",
      result: { ok: true, data: { kind: "pushed", remoteName: "origin", localBranch: "main", remoteBranch: "main", sha: "a".repeat(40) } },
    });
    await waitFor(() => expect(result.current.phase).toBe("done"));
  });
});
