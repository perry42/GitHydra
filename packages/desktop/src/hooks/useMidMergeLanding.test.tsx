// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { useMidMergeLanding, type UseMidMergeLandingOptions } from "./useMidMergeLanding";
import { makeRepoState } from "../test/fixtures";

const state = makeRepoState({
  inProgressOperation: "merge",
  inProgressOperationDetail: { kind: "merge", mergeHeadSha: "a" } as never,
});

function opts(over: Partial<UseMidMergeLandingOptions> = {}): UseMidMergeLandingOptions {
  return {
    tabId: "t1",
    repoState: state,
    conflicted: 2,
    settled: true,
    openSequence: 1,
    changesOpen: false,
    editorDirty: () => false,
    openChanges: vi.fn(),
    ...over,
  };
}

const hook = (initialProps: UseMidMergeLandingOptions) =>
  renderHook((p: UseMidMergeLandingOptions) => useMidMergeLanding(p), { initialProps });

describe("useMidMergeLanding (specs/mid-merge-landing.md FR-580)", () => {
  it("opens on first landing, not on later re-renders or re-activation of the same operation", () => {
    const openChanges = vi.fn();
    const { rerender } = hook(opts({ openChanges }));
    expect(openChanges).toHaveBeenCalledTimes(1);
    rerender(opts({ openChanges, conflicted: 1 }));
    // User closed the drawer; the tab is re-activated (new openSequence) on the same operation.
    rerender(opts({ openChanges, openSequence: 2 }));
    expect(openChanges).toHaveBeenCalledTimes(1);
  });

  it("waits for the repo to settle and the status to load", () => {
    const openChanges = vi.fn();
    const { rerender } = hook(opts({ openChanges, settled: false, conflicted: null }));
    rerender(opts({ openChanges, settled: true, conflicted: null }));
    expect(openChanges).not.toHaveBeenCalled();
    rerender(opts({ openChanges }));
    expect(openChanges).toHaveBeenCalledTimes(1);
  });

  it("never opens over unsaved edits and does not retry afterwards", () => {
    const openChanges = vi.fn();
    const { rerender } = hook(opts({ openChanges, editorDirty: () => true }));
    rerender(opts({ openChanges, openSequence: 2 }));
    expect(openChanges).not.toHaveBeenCalled();
  });

  it("is per tab: another tab on the same operation key still lands", () => {
    const openChanges = vi.fn();
    const { rerender } = hook(opts({ openChanges }));
    rerender(opts({ openChanges, tabId: "t2", openSequence: 2 }));
    expect(openChanges).toHaveBeenCalledTimes(2);
  });
});
