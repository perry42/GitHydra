// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { useStashList } from "./useStashList";
import { makeMockGitHydra } from "../test/mockGitHydra";
import { makeStash } from "../test/fixtures";

describe("useStashList", () => {
  it("FR-81: lists every stash in stash@{0}-first order", async () => {
    const api = makeMockGitHydra({ stashes: [makeStash(0), makeStash(1)] });
    const { result } = renderHook(() => useStashList({ api }));
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.stashes.map((s) => s.ref)).toEqual(["stash@{0}", "stash@{1}"]);
  });

  it("returns an explicit 'bare' status (not an error) for a bare repository", async () => {
    const api = makeMockGitHydra({ stashes: null });
    const { result } = renderHook(() => useStashList({ api }));
    await waitFor(() => expect(result.current.status).toBe("bare"));
    expect(result.current.stashes).toEqual([]);
  });

  it("reloads when reloadToken changes", async () => {
    const api = makeMockGitHydra({ stashes: [makeStash(0)] });
    const { result, rerender } = renderHook(({ reloadToken }) => useStashList({ api, reloadToken }), {
      initialProps: { reloadToken: 0 },
    });
    await waitFor(() => expect(result.current.stashes.length).toBe(1));

    vi.mocked(api.listStashes).mockResolvedValueOnce({
      ok: true,
      data: [makeStash(0), makeStash(1)],
    });
    rerender({ reloadToken: 1 });
    await waitFor(() => expect(result.current.stashes.length).toBe(2));
  });
});
