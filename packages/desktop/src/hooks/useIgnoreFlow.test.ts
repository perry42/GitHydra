// SPDX-License-Identifier: GPL-3.0-or-later
// specs/ignore-and-multiselect.md FR-495: the popover's previews must never be left "not fresh" by a destination flipped and flipped back
// while the first re-plan is still being read (seen on a slow Linux runner: aria-busy stayed true and Enter did nothing).
import { describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { IgnoreReport } from "@githydra/git-core";
import { currentPlan, useIgnoreFlow } from "./useIgnoreFlow";
import { makeMockGitHydra } from "../test/mockGitHydra";
import type { FileRow } from "../lib/fileSelection";

const row = { key: "untracked:build/a.log", path: "build/a.log", section: "untracked", mixed: false, partlyStaged: false, isDir: false } as unknown as FileRow;
const report = (): IgnoreReport => ({ rows: [], files: [], stopTracking: null, applied: false });

describe("useIgnoreFlow previews", () => {
  it("flipping the destination and back before the first re-plan lands leaves the popover fresh", async () => {
    window.localStorage.clear();
    const api = makeMockGitHydra();
    const pendingByTarget: Array<{ target: string; resolve: () => void }> = [];
    vi.mocked(api.planIgnore).mockImplementation(
      (req) =>
        new Promise((resolve) => {
          pendingByTarget.push({ target: req.target, resolve: () => resolve({ ok: true, data: report() }) });
        }),
    );
    const { result } = renderHook(() => useIgnoreFlow({ api, repoKey: "r", onChanged: () => {}, onResult: () => {} }));
    act(() => result.current.begin([row], { x: 0, y: 0, yAbove: 0 }));
    const original = result.current.pending!.target;
    const other = original === "nearest" ? "root" : "nearest";
    // The first read (original destination) settles; the user flips away, and back before the other destination's read returns.
    await waitFor(() => expect(pendingByTarget.length).toBeGreaterThan(0));
    await act(async () => pendingByTarget.splice(0).forEach((p) => p.resolve()));
    await waitFor(() => expect(currentPlan(result.current.pending!).fresh).toBe(true));
    act(() => result.current.setTarget(other));
    await waitFor(() => expect(pendingByTarget.length).toBeGreaterThan(0));
    act(() => result.current.setTarget(original));
    await act(async () => pendingByTarget.splice(0).forEach((p) => p.resolve()));
    await act(async () => {});
    expect(result.current.pending!.target).toBe(original);
    expect(currentPlan(result.current.pending!).fresh).toBe(true);
  });
});
