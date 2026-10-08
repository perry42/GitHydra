// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it, vi } from "vitest";
import { createDirtyLeaveRegistry } from "./useDirtyLeaveGuard";

// specs/edit-in-diff.md FR-535: one guard every leave path asks.
describe("dirty leave registry", () => {
  it("lets a clean app leave without asking anyone", async () => {
    const reg = createDirtyLeaveRegistry();
    const requestLeave = vi.fn(() => Promise.resolve(false));
    reg.register({ isDirty: () => false, requestLeave });
    await expect(reg.confirmLeave()).resolves.toBe(true);
    expect(requestLeave).not.toHaveBeenCalled();
  });

  it("asks dirty sources one at a time and stops at the first refusal", async () => {
    const reg = createDirtyLeaveRegistry();
    const order: string[] = [];
    reg.register({ isDirty: () => true, requestLeave: async () => (order.push("a"), false) });
    reg.register({ isDirty: () => true, requestLeave: async () => (order.push("b"), true) });
    expect(reg.isDirty()).toBe(true);
    await expect(reg.confirmLeave()).resolves.toBe(false);
    expect(order).toEqual(["a"]);
  });

  it("an unregistered source is no longer asked", async () => {
    const reg = createDirtyLeaveRegistry();
    const off = reg.register({ isDirty: () => true, requestLeave: () => Promise.resolve(false) });
    off();
    await expect(reg.confirmLeave()).resolves.toBe(true);
  });

  it("guard() runs the action synchronously when clean, and only after an allow when dirty", async () => {
    const reg = createDirtyLeaveRegistry();
    let dirty = false;
    let answer = false;
    reg.register({ isDirty: () => dirty, requestLeave: () => Promise.resolve(answer) });
    const proceed = vi.fn();
    reg.guard(proceed);
    expect(proceed).toHaveBeenCalledTimes(1);

    dirty = true;
    reg.guard(proceed);
    await Promise.resolve();
    expect(proceed).toHaveBeenCalledTimes(1);

    answer = true;
    reg.guard(proceed);
    await vi.waitFor(() => expect(proceed).toHaveBeenCalledTimes(2));
  });

  it("notifies subscribers when a source registers, unregisters or reports a change", () => {
    const reg = createDirtyLeaveRegistry();
    const seen = vi.fn();
    const off = reg.subscribe(seen);
    const unregister = reg.register({ isDirty: () => false, requestLeave: () => Promise.resolve(true) });
    reg.notify();
    unregister();
    expect(seen).toHaveBeenCalledTimes(3);
    off();
    reg.notify();
    expect(seen).toHaveBeenCalledTimes(3);
  });
});
