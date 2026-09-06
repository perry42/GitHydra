// SPDX-License-Identifier: GPL-3.0-or-later
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

  // Regression test for the bug test-agent found in commit 0caf066: a file-list divider's max is
  // derived from its *panel's* live width (`getMax = () => panelWidth.width * 0.5`), which
  // changes on every panel-width drag — not on a `window resize` event — so the hook must
  // re-clamp whenever `getMax` itself changes identity, not only when the browser window resizes.
  it("re-clamps immediately when getMax's value drops, without any window resize event (bugfix)", () => {
    let currentMax = 1000; // e.g. 50% of an initial 2000px-wide panel
    const { result, rerender } = renderHook(
      ({ getMax }: { getMax: () => number }) =>
        useResizableWidth({
          storageKey: "test:width:getmax-staleness",
          defaultWidth: 680,
          min: 160,
          getMax,
          direction: 1,
        }),
      { initialProps: { getMax: () => currentMax } },
    );
    expect(result.current.width).toBe(680);

    // Simulate the parent panel shrinking to 420px (50% = 210) — a real panel-width drag, not a
    // window resize — by re-rendering with a *new* getMax closure reflecting the smaller value.
    currentMax = 210;
    rerender({ getMax: () => currentMax });

    expect(result.current.width).toBe(210); // clamped down immediately, not left at 680
    expect(result.current.separatorProps["aria-valuemax"]).toBe(210);
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

  it("ArrowRight/ArrowLeft resize in fixed 16px increments and persist immediately (direction: 1, Must-have C15)", () => {
    const { result } = renderHook(() =>
      useResizableWidth({
        storageKey: "test:width:keyboard",
        defaultWidth: 680,
        min: 420,
        getMax: () => 1200,
        direction: 1,
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

  it("clamps keyboard steps at the min/max boundary rather than overshooting (direction: 1)", () => {
    window.localStorage.setItem("test:width:atmin", "420");
    const { result } = renderHook(() =>
      useResizableWidth({
        storageKey: "test:width:atmin",
        defaultWidth: 680,
        min: 420,
        getMax: () => 1200,
        direction: 1,
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

  // Regression test for the bug test-agent found in commit 0caf066: keyboard direction must
  // mirror physical drag direction, which for a `direction: -1` handle (the three panel-width
  // handles — dragging the pointer *left* grows the panel, since the panel sits to the right of
  // its own handle) means ArrowLeft grows and ArrowRight shrinks, the mirror image of a
  // `direction: 1` handle (a file-list divider, where dragging *right* grows the file list).
  it("keyboard direction mirrors drag direction for a direction: -1 handle (bugfix)", () => {
    const { result } = renderHook(() =>
      useResizableWidth({
        storageKey: "test:width:direction-negative",
        defaultWidth: 680,
        min: 420,
        getMax: () => 1200,
        direction: -1,
      }),
    );
    const preventDefault = () => {};
    act(() => {
      result.current.separatorProps.onKeyDown({
        key: "ArrowLeft",
        preventDefault,
      } as unknown as KeyboardEvent<HTMLDivElement>);
    });
    // ArrowLeft mirrors "drag left", which grows a direction: -1 handle.
    expect(result.current.width).toBe(696);

    act(() => {
      result.current.separatorProps.onKeyDown({
        key: "ArrowRight",
        preventDefault,
      } as unknown as KeyboardEvent<HTMLDivElement>);
      result.current.separatorProps.onKeyDown({
        key: "ArrowRight",
        preventDefault,
      } as unknown as KeyboardEvent<HTMLDivElement>);
    });
    // ArrowRight mirrors "drag right", which shrinks a direction: -1 handle.
    expect(result.current.width).toBe(664);
  });

  it("clamps keyboard steps at the min boundary for a direction: -1 handle without overshooting (bugfix)", () => {
    window.localStorage.setItem("test:width:direction-negative-min", "420");
    const { result } = renderHook(() =>
      useResizableWidth({
        storageKey: "test:width:direction-negative-min",
        defaultWidth: 680,
        min: 420,
        getMax: () => 1200,
        direction: -1,
      }),
    );
    act(() => {
      // ArrowRight shrinks a direction: -1 handle — already at min, must not go below it.
      result.current.separatorProps.onKeyDown({
        key: "ArrowRight",
        preventDefault: () => {},
      } as unknown as KeyboardEvent<HTMLDivElement>);
    });
    expect(result.current.width).toBe(420);
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

  // Layout-persistence fix: ChangesPanel/StashPanel/DetailPanel/BlamePanel now all pass the SAME
  // storageKey (RIGHT_PANEL_STORAGE_KEY) to their own `useResizableWidth` call, relying on
  // App.tsx's render gating to guarantee at most one of the four is ever mounted at a time (see
  // RIGHT_PANEL_STORAGE_KEY's doc comment in lib/layoutSizes.ts). These tests simulate that
  // "switch which right-panel-slot component is mounted" sequence directly against the hook,
  // without needing to mount all four real panel components.
  describe("shared storageKey across mutually-exclusive mounts (right-panel-slot unification)", () => {
    it("a width set by one mounted instance is picked up by a later instance sharing the same key (simulating switching panels)", () => {
      const sharedKey = "test:width:shared-right-panel";
      const first = renderHook(() =>
        useResizableWidth({
          storageKey: sharedKey,
          defaultWidth: 560,
          min: 420,
          getMax: () => 1200,
          direction: -1,
        }),
      );
      expect(first.result.current.width).toBe(560);

      // Simulate the user resizing the first panel (e.g. ChangesPanel) via keyboard.
      act(() => {
        first.result.current.separatorProps.onKeyDown({
          key: "ArrowLeft", // grows a direction: -1 handle
          preventDefault: () => {},
        } as unknown as KeyboardEvent<HTMLDivElement>);
      });
      expect(first.result.current.width).toBe(576);

      // Simulate switching away — the panel unmounts (App.tsx's rightPanel state changing away
      // from it, e.g. "changes" -> "stashes").
      first.unmount();

      // A different panel (e.g. StashPanel) mounts into the same slot, using the same shared key.
      const second = renderHook(() =>
        useResizableWidth({
          storageKey: sharedKey,
          defaultWidth: 560,
          min: 420,
          getMax: () => 1200,
          direction: -1,
        }),
      );
      // Shows the width the first panel left behind, not its own independent default — this is
      // the fix: no more jarring width jump when switching between the four panels.
      expect(second.result.current.width).toBe(576);
    });

    it("two instances sharing the key never fight when only one is ever mounted at a time (sequential mounts each persist independently)", () => {
      const sharedKey = "test:width:shared-right-panel-sequence";
      const preventDefault = () => {};

      const a = renderHook(() =>
        useResizableWidth({ storageKey: sharedKey, defaultWidth: 560, min: 420, getMax: () => 1200, direction: -1 }),
      );
      act(() => {
        a.result.current.separatorProps.onKeyDown({ key: "ArrowLeft", preventDefault } as unknown as KeyboardEvent<HTMLDivElement>);
      });
      expect(window.localStorage.getItem(sharedKey)).toBe("576");
      a.unmount();

      const b = renderHook(() =>
        useResizableWidth({ storageKey: sharedKey, defaultWidth: 560, min: 420, getMax: () => 1200, direction: -1 }),
      );
      expect(b.result.current.width).toBe(576);
      act(() => {
        b.result.current.separatorProps.onKeyDown({ key: "ArrowRight", preventDefault } as unknown as KeyboardEvent<HTMLDivElement>);
      });
      expect(window.localStorage.getItem(sharedKey)).toBe("560");
      b.unmount();

      const c = renderHook(() =>
        useResizableWidth({ storageKey: sharedKey, defaultWidth: 560, min: 420, getMax: () => 1200, direction: -1 }),
      );
      // c reflects b's final persisted value, not a's or the shipped default — confirms writes
      // from sequential (never-concurrent) mounts don't clobber or race each other.
      expect(c.result.current.width).toBe(560);
    });
  });
});
