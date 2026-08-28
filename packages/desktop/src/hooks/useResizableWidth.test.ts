import { afterEach, describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { KeyboardEvent } from "react";
import { useResizableWidth } from "./useResizableWidth";

afterEach(() => {
  window.localStorage.clear();
});

/**
 * specs/layout-and-view-polish.md Must-have C13/C15/C16/C19/AC9/AC10/AC13/AC14: the drag-math,
 * clamping, keyboard-step, and persistence logic shared by all five resize handles.
 */
describe("useResizableWidth", () => {
  it("starts at the default width when nothing is persisted", () => {
    const { result } = renderHook(() =>
      useResizableWidth({
        storageKey: "test:width:a",
        defaultWidth: 680,
        min: 420,
        getMax: () => 1200,
        direction: -1,
      }),
    );
    expect(result.current.width).toBe(680);
    expect(result.current.separatorProps["aria-valuemin"]).toBe(420);
    expect(result.current.separatorProps["aria-valuemax"]).toBe(1200);
  });

  it("clamps a persisted value that now exceeds the live max down to that max (AC13)", () => {
    window.localStorage.setItem("test:width:clamp", "5000");
    const { result } = renderHook(() =>
      useResizableWidth({
        storageKey: "test:width:clamp",
        defaultWidth: 680,
        min: 420,
        getMax: () => 1000,
        direction: -1,
      }),
    );
    expect(result.current.width).toBe(1000);
  });

  it("never clamps below the panel's own minimum even if max is smaller (AC13)", () => {
    window.localStorage.setItem("test:width:floor", "5000");
    const { result } = renderHook(() =>
      useResizableWidth({
        storageKey: "test:width:floor",
        defaultWidth: 680,
        min: 420,
        getMax: () => 100, // pathologically tiny window
        direction: -1,
      }),
    );
    expect(result.current.width).toBe(420);
  });

  it("reads back a validly-persisted width instead of the default", () => {
    window.localStorage.setItem("test:width:persisted", "555");
    const { result } = renderHook(() =>
      useResizableWidth({
        storageKey: "test:width:persisted",
        defaultWidth: 680,
        min: 420,
        getMax: () => 1200,
        direction: -1,
      }),
    );
    expect(result.current.width).toBe(555);
  });

  it("ArrowRight/ArrowLeft resize in fixed 16px increments and persist immediately (Must-have C15)", () => {
    const { result } = renderHook(() =>
      useResizableWidth({
        storageKey: "test:width:keyboard",
        defaultWidth: 680,
        min: 420,
        getMax: () => 1200,
        direction: -1,
      }),
    );
    const preventDefault = () => {};
    act(() => {
      result.current.separatorProps.onKeyDown({
        key: "ArrowRight",
        preventDefault,
      } as unknown as KeyboardEvent<HTMLDivElement>);
    });
    expect(result.current.width).toBe(696);
    expect(window.localStorage.getItem("test:width:keyboard")).toBe("696");

    act(() => {
      result.current.separatorProps.onKeyDown({
        key: "ArrowLeft",
        preventDefault,
      } as unknown as KeyboardEvent<HTMLDivElement>);
      result.current.separatorProps.onKeyDown({
        key: "ArrowLeft",
        preventDefault,
      } as unknown as KeyboardEvent<HTMLDivElement>);
    });
    expect(result.current.width).toBe(664);
  });

  it("clamps keyboard steps at the min/max boundary rather than overshooting", () => {
    window.localStorage.setItem("test:width:atmin", "420");
    const { result } = renderHook(() =>
      useResizableWidth({
        storageKey: "test:width:atmin",
        defaultWidth: 680,
        min: 420,
        getMax: () => 1200,
        direction: -1,
      }),
    );
    act(() => {
      result.current.separatorProps.onKeyDown({
        key: "ArrowLeft",
        preventDefault: () => {},
      } as unknown as KeyboardEvent<HTMLDivElement>);
    });
    expect(result.current.width).toBe(420); // never below min
  });

  it("ignores keys other than ArrowLeft/ArrowRight", () => {
    const { result } = renderHook(() =>
      useResizableWidth({
        storageKey: "test:width:otherkey",
        defaultWidth: 680,
        min: 420,
        getMax: () => 1200,
        direction: -1,
      }),
    );
    act(() => {
      result.current.separatorProps.onKeyDown({
        key: "Tab",
        preventDefault: () => {},
      } as unknown as KeyboardEvent<HTMLDivElement>);
    });
    expect(result.current.width).toBe(680);
  });
});
