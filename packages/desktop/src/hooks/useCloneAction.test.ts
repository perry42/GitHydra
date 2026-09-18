// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { CloneIpcOutcome } from "../../shared/ipcContract";
import { makeMockGitHydra } from "../test/mockGitHydra";
import { useCloneAction } from "./useCloneAction";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe("useCloneAction (specs/online-sync-clone.md FR-351/FR-354/FR-356/FR-357)", () => {
  it("starts idle, clones with a fresh requestId, and calls onCloned with the resolved path on success", async () => {
    const api = makeMockGitHydra();
    const onCloned = vi.fn();
    const { result } = renderHook(() => useCloneAction({ api, onCloned }));

    expect(result.current.phase).toBe("idle");

    act(() => result.current.runClone("https://example.com/owner/repo.git", "/dest/repo"));
    expect(result.current.phase).toBe("cloning");
    expect(result.current.isCloning).toBe(true);

    await waitFor(() => expect(onCloned).toHaveBeenCalledWith("/dest/repo"));
    // FR-356: a successful clone returns straight to idle (never a "done"-success banner state of
    // its own — the caller closes the dialog and hands off to the app's existing open-tab flow).
    expect(result.current.phase).toBe("idle");

    const [requestId, url, destination] = vi.mocked(api.clone).mock.calls[0]!;
    expect(typeof requestId).toBe("string");
    expect(url).toBe("https://example.com/owner/repo.git");
    expect(destination).toBe("/dest/repo");
  });

  it("FR-353: a destination-not-empty refusal (a GitCommandError with stderr) surfaces via classification, with the raw refusal text preserved for Details", async () => {
    const api = makeMockGitHydra();
    vi.mocked(api.clone).mockResolvedValueOnce({
      outcome: "settled",
      result: {
        ok: false,
        error: {
          name: "GitCommandError",
          message: "git clone exited with code 128: fatal: destination path 'repo' already exists and is not an empty directory.",
          stderr: "fatal: destination path 'repo' already exists and is not an empty directory.",
        },
      },
    });
    const onCloned = vi.fn();
    const { result } = renderHook(() => useCloneAction({ api, onCloned }));

    act(() => result.current.runClone("https://example.com/owner/repo.git", "/dest/repo"));
    await waitFor(() => expect(result.current.phase).toBe("done"));

    expect(onCloned).not.toHaveBeenCalled();
    expect(result.current.error).toBeTruthy();
    expect(result.current.rawStderr).toMatch(/already exists and is not an empty directory/i);
  });

  it("FR-357: a credential failure classifies with Phase 1's exact https-auth-failed message", async () => {
    const api = makeMockGitHydra();
    vi.mocked(api.clone).mockResolvedValueOnce({
      outcome: "settled",
      result: {
        ok: false,
        error: {
          name: "GitCommandError",
          message: "git clone exited with code 128: fatal: Authentication failed for 'https://example.com/owner/repo.git/'",
          stderr: "fatal: Authentication failed for 'https://example.com/owner/repo.git/'",
        },
      },
    });
    const { result } = renderHook(() => useCloneAction({ api, onCloned: vi.fn() }));

    act(() => result.current.runClone("https://example.com/owner/repo.git", "/dest/repo"));
    await waitFor(() => expect(result.current.phase).toBe("done"));

    expect(result.current.error).toMatch(/HTTPS authentication failed/i);
    expect(result.current.rawStderr).toMatch(/Authentication failed/i);
  });

  it("a genuine non-network refusal (no stderr) surfaces its own message verbatim", async () => {
    const api = makeMockGitHydra();
    vi.mocked(api.clone).mockResolvedValueOnce({
      outcome: "settled",
      result: {
        ok: false,
        error: { name: "InvalidArgumentError", message: "clone requires a non-empty URL." },
      },
    });
    const { result } = renderHook(() => useCloneAction({ api, onCloned: vi.fn() }));

    act(() => result.current.runClone(" ", "/dest/repo"));
    await waitFor(() => expect(result.current.phase).toBe("done"));

    expect(result.current.error).toMatch(/non-empty URL/i);
    expect(result.current.rawStderr).toBeNull();
  });

  it("FR-354: cancelClone calls api.cancelClone with the in-flight requestId, and a cancelled outcome returns to idle without calling onCloned", async () => {
    const api = makeMockGitHydra();
    const gate = deferred<CloneIpcOutcome>();
    vi.mocked(api.clone).mockReturnValueOnce(gate.promise);
    const onCloned = vi.fn();
    const { result } = renderHook(() => useCloneAction({ api, onCloned }));

    act(() => result.current.runClone("https://example.com/owner/repo.git", "/dest/repo"));
    expect(result.current.phase).toBe("cloning");

    act(() => result.current.cancelClone());
    const [requestId] = vi.mocked(api.cancelClone).mock.calls[0]!;
    expect(typeof requestId).toBe("string");

    gate.resolve({ outcome: "cancelled" });
    await waitFor(() => expect(result.current.phase).toBe("idle"));
    expect(onCloned).not.toHaveBeenCalled();
  });

  it("cancelClone is a safe no-op while nothing is in flight", () => {
    const api = makeMockGitHydra();
    const { result } = renderHook(() => useCloneAction({ api, onCloned: vi.fn() }));
    act(() => result.current.cancelClone());
    expect(api.cancelClone).not.toHaveBeenCalled();
  });

  it("ignores progress events tagged with a different (stale/superseded) requestId", async () => {
    const api = makeMockGitHydra();
    let progressListener:
      | ((requestId: string, event: import("@githydra/git-core").FetchProgressEvent) => void)
      | null = null;
    vi.mocked(api.onCloneProgress).mockImplementation((listener) => {
      progressListener = listener;
      return () => {
        progressListener = null;
      };
    });
    const gate = deferred<CloneIpcOutcome>();
    vi.mocked(api.clone).mockReturnValueOnce(gate.promise);
    const { result } = renderHook(() => useCloneAction({ api, onCloned: vi.fn() }));

    act(() => result.current.runClone("https://example.com/owner/repo.git", "/dest/repo"));
    act(() => {
      progressListener?.("some-other-stale-request-id", {
        remoteName: "origin",
        stage: "Receiving objects",
        percent: 50,
        raw: "Receiving objects: 50% (1/2)",
      });
    });
    expect(result.current.latestProgress).toBeNull();

    const [ownRequestId] = vi.mocked(api.clone).mock.calls[0]!;
    act(() => {
      progressListener?.(ownRequestId, {
        remoteName: "origin",
        stage: "Resolving deltas",
        percent: 10,
        raw: "Resolving deltas: 10% (1/10)",
      });
    });
    expect(result.current.latestProgress?.stage).toBe("Resolving deltas");

    gate.resolve({ outcome: "settled", result: { ok: true, data: { path: "/dest/repo" } } });
    await waitFor(() => expect(result.current.phase).toBe("idle"));
  });

  it("dismiss() clears error/rawStderr and returns to idle", async () => {
    const api = makeMockGitHydra();
    vi.mocked(api.clone).mockResolvedValueOnce({
      outcome: "settled",
      result: { ok: false, error: { name: "InvalidArgumentError", message: "clone requires a non-empty URL." } },
    });
    const { result } = renderHook(() => useCloneAction({ api, onCloned: vi.fn() }));

    act(() => result.current.runClone(" ", "/dest/repo"));
    await waitFor(() => expect(result.current.phase).toBe("done"));

    act(() => result.current.dismiss());
    expect(result.current.phase).toBe("idle");
    expect(result.current.error).toBeNull();
    expect(result.current.rawStderr).toBeNull();
  });

  it("runClone is a no-op while already cloning", async () => {
    const api = makeMockGitHydra();
    const gate = deferred<CloneIpcOutcome>();
    vi.mocked(api.clone).mockReturnValueOnce(gate.promise);
    const { result } = renderHook(() => useCloneAction({ api, onCloned: vi.fn() }));

    act(() => result.current.runClone("https://example.com/owner/repo.git", "/dest/repo"));
    act(() => result.current.runClone("https://example.com/owner/other.git", "/dest/other"));

    expect(api.clone).toHaveBeenCalledTimes(1);
    gate.resolve({ outcome: "settled", result: { ok: true, data: { path: "/dest/repo" } } });
    await waitFor(() => expect(result.current.phase).toBe("idle"));
  });
});
