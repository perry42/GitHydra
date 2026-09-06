// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useRecentOpenRow } from "./useRecentOpenRow";

describe("useRecentOpenRow", () => {
  it("sets notFoundPath on a 'not-found' result and calls onOpened for 'opened'/'activated-existing' only", async () => {
    const onOpenRecent = vi
      .fn()
      .mockResolvedValueOnce("not-found")
      .mockResolvedValueOnce("opened")
      .mockResolvedValueOnce("activated-existing")
      .mockResolvedValueOnce("cancelled");
    const onOpened = vi.fn();
    const { result } = renderHook(() => useRecentOpenRow(onOpenRecent, onOpened));

    await act(async () => {
      await result.current.openRecent("/repoGone");
    });
    expect(result.current.notFoundPath).toBe("/repoGone");
    expect(onOpened).not.toHaveBeenCalled();

    await act(async () => {
      await result.current.openRecent("/repoA");
    });
    expect(result.current.notFoundPath).toBeNull();
    expect(onOpened).toHaveBeenCalledTimes(1);

    await act(async () => {
      await result.current.openRecent("/repoB");
    });
    expect(onOpened).toHaveBeenCalledTimes(2);

    await act(async () => {
      await result.current.openRecent("/repoC");
    });
    // Cancelled: no crash, no extra onOpened call.
    expect(onOpened).toHaveBeenCalledTimes(2);
  });

  it("busyPath is set only while the specific attempt is in flight", async () => {
    let resolve!: (v: "opened") => void;
    const onOpenRecent = vi.fn(() => new Promise<"opened">((r) => (resolve = r)));
    const { result } = renderHook(() => useRecentOpenRow(onOpenRecent));

    let openPromise!: Promise<void>;
    act(() => {
      openPromise = result.current.openRecent("/repoA");
    });
    expect(result.current.busyPath).toBe("/repoA");

    await act(async () => {
      resolve("opened");
      await openPromise;
    });
    expect(result.current.busyPath).toBeNull();
  });

  it("clearNotFound resets only when the path matches", () => {
    const { result } = renderHook(() => useRecentOpenRow(vi.fn()));
    act(() => {
      result.current.clearNotFound("/repoA");
    });
    expect(result.current.notFoundPath).toBeNull();
  });
});
