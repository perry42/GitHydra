// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { FetchOutcome } from "../../shared/ipcContract";
import { makeMockGitHydra } from "../test/mockGitHydra";
import { useFetchAction } from "./useFetchAction";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe("useFetchAction", () => {
  it("starts idle and calls fetchAllRemotes with a fresh requestId on runFetch", async () => {
    const api = makeMockGitHydra({ fetchOutcomes: [{ remoteName: "origin", status: "ok" }] });
    const onSettled = vi.fn();
    const { result } = renderHook(() => useFetchAction({ api, onSettled }));

    expect(result.current.phase).toBe("idle");

    act(() => result.current.runFetch());
    expect(result.current.phase).toBe("fetching");
    expect(result.current.isFetching).toBe(true);

    await waitFor(() => expect(result.current.phase).toBe("done"));
    expect(result.current.outcomes).toEqual([{ remoteName: "origin", status: "ok" }]);
    expect(onSettled).toHaveBeenCalledTimes(1);

    const [requestId] = vi.mocked(api.fetchAllRemotes).mock.calls[0]!;
    expect(typeof requestId).toBe("string");
  });

  it("reports a per-remote failure in outcomes, distinct from topLevelError (FR-321 attribution)", async () => {
    const api = makeMockGitHydra({
      fetchOutcomes: [
        { remoteName: "origin", status: "ok" },
        {
          remoteName: "upstream",
          status: "error",
          error: { kind: "host-unreachable", message: "Could not reach the remote host.", rawStderr: "raw" },
        },
      ],
    });
    const { result } = renderHook(() => useFetchAction({ api, onSettled: vi.fn() }));

    act(() => result.current.runFetch());
    await waitFor(() => expect(result.current.phase).toBe("done"));

    expect(result.current.topLevelError).toBeNull();
    expect(result.current.outcomes).toHaveLength(2);
    expect(result.current.outcomes?.[1]).toMatchObject({ remoteName: "upstream", status: "error" });
  });

  it("surfaces a genuine top-level failure separately from outcomes", async () => {
    const api = makeMockGitHydra();
    vi.mocked(api.fetchAllRemotes).mockResolvedValueOnce({
      outcome: "settled",
      result: { ok: false, error: { name: "Error", message: "No repository is open" } },
    } satisfies FetchOutcome);
    const { result } = renderHook(() => useFetchAction({ api, onSettled: vi.fn() }));

    act(() => result.current.runFetch());
    await waitFor(() => expect(result.current.phase).toBe("done"));

    expect(result.current.outcomes).toBeNull();
    expect(result.current.topLevelError).toBe("No repository is open");
  });

  it("cancelling returns to idle without calling onSettled, and never populates outcomes", async () => {
    const api = makeMockGitHydra();
    const gate = deferred<FetchOutcome>();
    vi.mocked(api.fetchAllRemotes).mockReturnValueOnce(gate.promise);
    const onSettled = vi.fn();
    const { result } = renderHook(() => useFetchAction({ api, onSettled }));

    act(() => result.current.runFetch());
    expect(result.current.phase).toBe("fetching");

    act(() => result.current.cancelFetch());
    const [requestId] = vi.mocked(api.cancelFetch).mock.calls[0]!;
    expect(typeof requestId).toBe("string");

    gate.resolve({ outcome: "cancelled" });
    await waitFor(() => expect(result.current.phase).toBe("idle"));
    expect(result.current.outcomes).toBeNull();
    expect(onSettled).not.toHaveBeenCalled();
  });

  it("ignores progress events tagged with a different (stale/superseded) requestId", async () => {
    const api = makeMockGitHydra();
    let progressListener: ((requestId: string, event: import("@githydra/git-core").FetchProgressEvent) => void) | null =
      null;
    vi.mocked(api.onFetchProgress).mockImplementation((listener) => {
      progressListener = listener;
      return () => {
        progressListener = null;
      };
    });
    const gate = deferred<FetchOutcome>();
    vi.mocked(api.fetchAllRemotes).mockReturnValueOnce(gate.promise);
    const { result } = renderHook(() => useFetchAction({ api, onSettled: vi.fn() }));

    act(() => result.current.runFetch());
    act(() => {
      progressListener?.("some-other-stale-request-id", {
        remoteName: "origin",
        stage: "Compressing objects",
        percent: 50,
        raw: "remote: Compressing objects: 50% (1/2)",
      });
    });

    expect(result.current.latestProgress).toBeNull();

    const [ownRequestId] = vi.mocked(api.fetchAllRemotes).mock.calls[0]!;
    act(() => {
      progressListener?.(ownRequestId, {
        remoteName: "origin",
        stage: "Counting objects",
        percent: 10,
        raw: "remote: Counting objects: 10% (1/10)",
      });
    });
    expect(result.current.latestProgress?.stage).toBe("Counting objects");

    gate.resolve({ outcome: "settled", result: { ok: true, data: { outcomes: [] } } });
    await waitFor(() => expect(result.current.phase).toBe("done"));
  });

  it("dismiss() clears outcomes/topLevelError and returns to idle", async () => {
    const api = makeMockGitHydra({ fetchOutcomes: [{ remoteName: "origin", status: "ok" }] });
    const { result } = renderHook(() => useFetchAction({ api, onSettled: vi.fn() }));

    act(() => result.current.runFetch());
    await waitFor(() => expect(result.current.phase).toBe("done"));

    act(() => result.current.dismiss());
    expect(result.current.phase).toBe("idle");
    expect(result.current.outcomes).toBeNull();
  });
});
