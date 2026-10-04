// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { createIdleGate, useIdleGate, useIdleSources } from "./useIdleGate";

describe("idle gate (specs/live-refresh.md FR-465)", () => {
  it("is idle only while no source is busy and notifies on each busy-to-idle transition", () => {
    const gate = createIdleGate();
    const listener = vi.fn();
    gate.subscribe(listener);
    expect(gate.isIdle()).toBe(true);
    gate.setBusy("modal", true);
    gate.setBusy("composer", true);
    expect(gate.isIdle()).toBe(false);
    gate.setBusy("modal", false);
    expect(listener).not.toHaveBeenCalled();
    gate.setBusy("composer", false);
    expect(listener).toHaveBeenCalledTimes(1);
    gate.setBusy("composer", false);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("useIdleSources mirrors flags into the gate and clears them on unmount", () => {
    const { result, rerender, unmount } = renderHook(
      ({ busy }) => {
        const gate = useIdleGate();
        useIdleSources(gate, { modal: busy, drag: false });
        return gate;
      },
      { initialProps: { busy: true } },
    );
    expect(result.current.isIdle()).toBe(false);
    rerender({ busy: false });
    expect(result.current.isIdle()).toBe(true);
    rerender({ busy: true });
    expect(result.current.isIdle()).toBe(false);
    const gate = result.current;
    unmount();
    expect(gate.isIdle()).toBe(true);
  });
});
