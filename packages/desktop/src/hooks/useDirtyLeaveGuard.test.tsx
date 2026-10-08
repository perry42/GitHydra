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
});
