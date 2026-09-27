// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useKeybindingOverrides } from "./useKeybindingOverrides";

const STORAGE_KEY = "githydra:keybindings:overrides";

afterEach(() => {
  window.localStorage.clear();
});

/** specs/keyboard-shortcut-rebinding.md FR-394/FR-405/AC9. */
describe("useKeybindingOverrides", () => {
  it("starts empty when nothing has ever been persisted", () => {
    const { result } = renderHook(() => useKeybindingOverrides());
    expect(result.current.overrides).toEqual({});
  });

  it("setOverride persists a custom rebinding, readable by a fresh hook instance (AC9: survives a remount against the same localStorage)", () => {
    const { result } = renderHook(() => useKeybindingOverrides());
    act(() => result.current.setOverride("new-branch", [{ key: "b", mod: true, shift: true }]));
    expect(result.current.overrides).toEqual({ "new-branch": [{ key: "b", mod: true, shift: true }] });

    const { result: result2 } = renderHook(() => useKeybindingOverrides());
    expect(result2.current.overrides).toEqual({ "new-branch": [{ key: "b", mod: true, shift: true }] });
  });

  it('setOverride can also record "unbound" (AC8)', () => {
    const { result } = renderHook(() => useKeybindingOverrides());
    act(() => result.current.setOverride("toggle-theme", "unbound"));
    expect(result.current.overrides).toEqual({ "toggle-theme": "unbound" });
  });

  it("resetOverride removes just that command's entry, restoring the default (FR-400)", () => {
    const { result } = renderHook(() => useKeybindingOverrides());
    act(() => {
      result.current.setOverride("a", [{ key: "b", mod: true }]);
      result.current.setOverride("c", "unbound");
    });
    act(() => result.current.resetOverride("a"));
    expect(result.current.overrides).toEqual({ c: "unbound" });
  });

  it("resetOverride is a no-op when the command has no override", () => {
    const { result } = renderHook(() => useKeybindingOverrides());
    act(() => result.current.resetOverride("never-set"));
    expect(result.current.overrides).toEqual({});
  });

  it("resetAll clears every override at once (FR-401/AC7)", () => {
    const { result } = renderHook(() => useKeybindingOverrides());
    act(() => {
      result.current.setOverride("a", [{ key: "b", mod: true }]);
      result.current.setOverride("c", "unbound");
    });
    act(() => result.current.resetAll());
    expect(result.current.overrides).toEqual({});
  });

  it("falls back to {} for corrupt JSON in localStorage rather than throwing", () => {
    window.localStorage.setItem(STORAGE_KEY, "{not valid json");
    const { result } = renderHook(() => useKeybindingOverrides());
    expect(result.current.overrides).toEqual({});
  });

  it("drops malformed entries from a stored value while keeping the well-formed ones", () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ good: [{ key: "b", mod: true }], bad: { notKey: 1 } }),
    );
    const { result } = renderHook(() => useKeybindingOverrides());
    expect(result.current.overrides).toEqual({ good: [{ key: "b", mod: true }] });
  });

  it("degrades to a no-op (never throws) when localStorage.setItem throws", () => {
    const original = window.localStorage.setItem;
    window.localStorage.setItem = () => {
      throw new Error("storage unavailable");
    };
    const { result } = renderHook(() => useKeybindingOverrides());
    expect(() => act(() => result.current.setOverride("a", [{ key: "b", mod: true }]))).not.toThrow();
    window.localStorage.setItem = original;
  });
});
