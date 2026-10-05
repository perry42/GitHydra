// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCoalescedRunner } from "./coalescedRunner";

describe("coalesced runner (specs/live-refresh.md FR-459)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("collapses a burst into one run after the debounce", async () => {
    const run = vi.fn(async () => {});
    const r = createCoalescedRunner(run, 100);
    r.request();
    r.request();
    await vi.advanceTimersByTimeAsync(50);
    r.request();
    await vi.advanceTimersByTimeAsync(99);
    expect(run).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("runs one in flight plus exactly one trailing run", async () => {
    let release!: () => void;
    const run = vi.fn(() => new Promise<void>((res) => (release = res)));
    const r = createCoalescedRunner(run, 10);
    r.request();
    await vi.advanceTimersByTimeAsync(10);
    expect(run).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 5; i++) {
      r.request();
      await vi.advanceTimersByTimeAsync(10);
    }
    expect(run).toHaveBeenCalledTimes(1);
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(2);
    release();
    await vi.advanceTimersByTimeAsync(50);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("a continuous stream still runs at most every maxWait", async () => {
    const run = vi.fn(async () => {});
    const r = createCoalescedRunner(run, 250, 1000);
    for (let t = 0; t < 3500; t += 100) {
      r.request();
      await vi.advanceTimersByTimeAsync(100);
    }
    expect(run.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(run.mock.calls.length).toBeLessThanOrEqual(4);
  });

  it("cancel stops pending and trailing runs", async () => {
    const run = vi.fn(async () => {});
    const r = createCoalescedRunner(run, 10);
    r.request();
    r.cancel();
    await vi.advanceTimersByTimeAsync(100);
    expect(run).not.toHaveBeenCalled();
  });
});
