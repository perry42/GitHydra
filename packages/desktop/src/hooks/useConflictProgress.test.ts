import { describe, expect, it } from "vitest";
import { renderHook } from "@testing-library/react";
import { useConflictProgress } from "./useConflictProgress";

describe("useConflictProgress (FR-67)", () => {
  it("reports all-zero progress when no operation is in progress", () => {
    const { result } = renderHook(() => useConflictProgress(0, false));
    expect(result.current).toEqual({ remaining: 0, resolved: 0, total: 0 });
  });

  it("captures the starting count as the ceiling and derives resolved-so-far as conflicts shrink", () => {
    const { result, rerender } = renderHook(({ remaining, active }) => useConflictProgress(remaining, active), {
      initialProps: { remaining: 5, active: true },
    });
    expect(result.current).toEqual({ remaining: 5, resolved: 0, total: 5 });

    rerender({ remaining: 3, active: true });
    expect(result.current).toEqual({ remaining: 3, resolved: 2, total: 5 });

    rerender({ remaining: 0, active: true });
    expect(result.current).toEqual({ remaining: 0, resolved: 5, total: 5 });
  });

  it("bumps the ceiling up if a later step surfaces more conflicts than initially seen", () => {
    const { result, rerender } = renderHook(({ remaining, active }) => useConflictProgress(remaining, active), {
      initialProps: { remaining: 2, active: true },
    });
    expect(result.current.total).toBe(2);

    rerender({ remaining: 4, active: true });
    expect(result.current).toEqual({ remaining: 4, resolved: 0, total: 4 });
  });

  it("resets the ceiling once the operation clears, so a later operation starts fresh", () => {
    const { result, rerender } = renderHook(({ remaining, active }) => useConflictProgress(remaining, active), {
      initialProps: { remaining: 3, active: true },
    });
    rerender({ remaining: 1, active: true });
    expect(result.current.resolved).toBe(2);

    rerender({ remaining: 0, active: false });
    expect(result.current).toEqual({ remaining: 0, resolved: 0, total: 0 });

    // A brand-new operation starting later begins its own fresh ceiling, not the old one.
    rerender({ remaining: 2, active: true });
    expect(result.current).toEqual({ remaining: 2, resolved: 0, total: 2 });
  });
});
