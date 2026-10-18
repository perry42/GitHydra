// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { makeMockGitHydra } from "../test/mockGitHydra";
import { FOCUS_MIN_INTERVAL_MS, useWorktrees } from "./useWorktrees";

afterEach(() => vi.useRealTimers());

const focus = () => act(async () => void window.dispatchEvent(new Event("focus")));

describe("useWorktrees window-focus refresh (FR-606, security LOW-5)", () => {
  it("coalesces a burst of focus events: none while a read is in flight, at most one per second", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const api = makeMockGitHydra({ repoPath: "/w/repo" });
    let release: () => void = () => {};
    const slow = new Promise<void>((r) => (release = r));
    const original = vi.mocked(api.listWorktrees).getMockImplementation()!;
    vi.mocked(api.listWorktrees).mockImplementation(async () => {
      await slow;
      return original();
    });
    renderHook(() => useWorktrees({ api, enabled: true }));
    expect(api.listWorktrees).toHaveBeenCalledTimes(1); // the initial load, still in flight
    vi.setSystemTime(Date.now() + 5000);
    await focus();
    expect(api.listWorktrees).toHaveBeenCalledTimes(1);

    await act(async () => {
      release();
      await slow;
    });
    // Finished and long ago: the next focus reads, a burst right after does not.
    vi.setSystemTime(Date.now() + 5000);
    await focus();
    await focus();
    await focus();
    expect(api.listWorktrees).toHaveBeenCalledTimes(2);
    vi.setSystemTime(Date.now() + FOCUS_MIN_INTERVAL_MS + 1);
    await focus();
    expect(api.listWorktrees).toHaveBeenCalledTimes(3);
  });
});
