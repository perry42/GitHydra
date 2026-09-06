// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { useBlame, useFileHistory, type BlameTarget } from "./useBlame";
import { makeMockGitHydra } from "../test/mockGitHydra";
import { makeCommit } from "../test/fixtures";

describe("useBlame", () => {
  it("fetches getFileBlame for the given target and resolves to ready", async () => {
    const api = makeMockGitHydra({ blameResult: { status: "empty" } });
    const target: BlameTarget = { path: "src/a.ts", revision: null };
    const { result } = renderHook(() => useBlame(api, target));

    expect(result.current.status).toBe("loading");
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.status === "ready" && result.current.result).toEqual({ status: "empty" });
    expect(vi.mocked(api.getFileBlame)).toHaveBeenCalledWith("src/a.ts", null);
  });

  it("passes a historical revision through unchanged", async () => {
    const sha = "a".repeat(40);
    const api = makeMockGitHydra({ blameResult: { status: "empty" } });
    renderHook(() => useBlame(api, { path: "src/a.ts", revision: sha }));
    await waitFor(() => expect(vi.mocked(api.getFileBlame)).toHaveBeenCalledWith("src/a.ts", sha));
  });

  it("surfaces a rejected getFileBlame call as an error state", async () => {
    const api = makeMockGitHydra();
    vi.mocked(api.getFileBlame).mockResolvedValueOnce({
      ok: false,
      error: { name: "GitCommandError", message: "boom" },
    });
    const { result } = renderHook(() => useBlame(api, { path: "src/a.ts", revision: null }));
    await waitFor(() => expect(result.current.status).toBe("error"));
    expect(result.current.status === "error" && result.current.message).toBe("boom");
  });

  it("drops a stale response when the target changes before the first fetch resolves", async () => {
    const api = makeMockGitHydra();
    let resolveFirst!: (value: { ok: true; data: { status: "empty" } }) => void;
    vi.mocked(api.getFileBlame).mockImplementationOnce(
      () => new Promise((resolve) => { resolveFirst = resolve; }),
    );
    vi.mocked(api.getFileBlame).mockResolvedValueOnce({ ok: true, data: { status: "binary" } });

    const { result, rerender } = renderHook(({ target }: { target: BlameTarget }) => useBlame(api, target), {
      initialProps: { target: { path: "a.ts", revision: null } as BlameTarget },
    });

    rerender({ target: { path: "b.ts", revision: null } });
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.status === "ready" && result.current.result.status).toBe("binary");

    // The first (superseded) fetch resolving late must never clobber the second target's result.
    resolveFirst({ ok: true, data: { status: "empty" } });
    await new Promise((r) => setTimeout(r, 0));
    expect(result.current.status === "ready" && result.current.result.status).toBe("binary");
  });
});

describe("useFileHistory", () => {
  it("opens a reader and exposes its first page immediately", async () => {
    const commits = [makeCommit("c1"), makeCommit("c2"), makeCommit("c3")];
    const api = makeMockGitHydra({ fileHistoryCommits: commits });
    const { result } = renderHook(() => useFileHistory(api, { path: "src/a.ts", revision: null }));

    expect(result.current.status).toBe("loading");
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.commits.map((c) => c.sha)).toEqual(["c1", "c2", "c3"]);
    expect(result.current.hasMore).toBe(false);
    // A `null` (working-tree) revision starts the `--follow` walk from HEAD.
    expect(vi.mocked(api.createFileHistoryReader)).toHaveBeenCalledWith("HEAD", "src/a.ts");
  });

  it("passes a historical revision through as the history walk's start point", async () => {
    const sha = "a".repeat(40);
    const api = makeMockGitHydra({ fileHistoryCommits: [] });
    renderHook(() => useFileHistory(api, { path: "src/a.ts", revision: sha }));
    await waitFor(() => expect(vi.mocked(api.createFileHistoryReader)).toHaveBeenCalledWith(sha, "src/a.ts"));
  });

  it("loadMore appends the next page and updates hasMore (FR-129/AC13)", async () => {
    const commits = Array.from({ length: 35 }, (_, i) => makeCommit(`c${i}`));
    const api = makeMockGitHydra({ fileHistoryCommits: commits });
    const { result } = renderHook(() => useFileHistory(api, { path: "src/a.ts", revision: null }));

    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.commits).toHaveLength(30);
    expect(result.current.hasMore).toBe(true);

    result.current.loadMore();
    await waitFor(() => expect(result.current.commits).toHaveLength(35));
    expect(result.current.hasMore).toBe(false);
  });

  it("closes the previous reader and opens a fresh one when the target changes", async () => {
    const api = makeMockGitHydra({ fileHistoryCommits: [makeCommit("c1")] });
    const { rerender } = renderHook(({ target }: { target: BlameTarget }) => useFileHistory(api, target), {
      initialProps: { target: { path: "a.ts", revision: null } as BlameTarget },
    });

    await waitFor(() => expect(vi.mocked(api.createFileHistoryReader)).toHaveBeenCalledTimes(1));
    rerender({ target: { path: "b.ts", revision: null } });
    await waitFor(() => expect(vi.mocked(api.createFileHistoryReader)).toHaveBeenCalledTimes(2));
    expect(vi.mocked(api.closeReader)).toHaveBeenCalled();
  });
});
