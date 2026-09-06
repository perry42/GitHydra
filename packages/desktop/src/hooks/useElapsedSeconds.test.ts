// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useElapsedSeconds } from "./useElapsedSeconds";

/** specs/repo-open-feedback.md FR-166/AC1/AC6: the client-side elapsed-time clock backing the
 * "Opening repository…" spinner's running readout. */
describe("useElapsedSeconds", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts at 0 the instant `active` becomes true (AC1)", () => {
    const { result } = renderHook(() => useElapsedSeconds(true, "gen-1"));
    expect(result.current).toBe(0);
  });

  it("ticks at least once per second while active (AC1)", () => {
    const { result } = renderHook(() => useElapsedSeconds(true, "gen-1"));
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(result.current).toBe(1);
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(result.current).toBe(3);
  });

  it("never reports a nonzero value if it goes inactive before the first tick (AC6, fast open)", () => {
    const { result, rerender } = renderHook(({ active }: { active: boolean }) => useElapsedSeconds(active, "gen-1"), {
      initialProps: { active: true },
    });
    act(() => {
      vi.advanceTimersByTime(400); // well under the first 1s tick
    });
    rerender({ active: false });
    expect(result.current).toBe(0);
  });

  it("resets to 0 when `active` flips back to false, then true again", () => {
    const { result, rerender } = renderHook(({ active }: { active: boolean }) => useElapsedSeconds(active, "gen-1"), {
      initialProps: { active: true },
    });
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(result.current).toBe(5);

    rerender({ active: false });
    expect(result.current).toBe(0);

    rerender({ active: true });
    expect(result.current).toBe(0);
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(result.current).toBe(1);
  });

  // Regression coverage for the "stale timer bleeds into a new attempt" pitfall called out in the
  // task: `graph.status` can stay `"opening"` across a rapid re-open that supersedes an in-flight
  // one (useRepositoryGraph.openRepo sets status to "opening" again unconditionally, generation
  // bump or not), so `active` alone never transitions false -> true for that second attempt.
  it("restarts the clock at 0 when `resetKey` changes even though `active` stays true the whole time (no stale-timer bleed across a superseded open)", () => {
    const { result, rerender } = renderHook(
      ({ resetKey }: { resetKey: number }) => useElapsedSeconds(true, resetKey),
      { initialProps: { resetKey: 1 } },
    );
    act(() => {
      vi.advanceTimersByTime(9000);
    });
    expect(result.current).toBe(9);

    // A new, superseding openRepo() call bumps openSequence while status is still "opening".
    rerender({ resetKey: 2 });
    expect(result.current).toBe(0);

    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(result.current).toBe(1);
  });

  it("clears its interval on unmount (no leaked timer / state update after unmount)", () => {
    const { unmount } = renderHook(() => useElapsedSeconds(true, "gen-1"));
    unmount();
    // Advancing timers after unmount must not throw (e.g. a `setState` on an unmounted component).
    expect(() => {
      act(() => {
        vi.advanceTimersByTime(5000);
      });
    }).not.toThrow();
  });
});
