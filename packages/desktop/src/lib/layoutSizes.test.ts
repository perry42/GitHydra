import { describe, expect, it } from "vitest";
import {
  BLAME_PANEL_DEFAULT_WIDTH,
  BLAME_PANEL_MIN_WIDTH,
  CHANGES_PANEL_DEFAULT_WIDTH,
  CHANGES_PANEL_MIN_WIDTH,
  DETAIL_PANEL_DEFAULT_WIDTH,
  DETAIL_PANEL_MIN_WIDTH,
  RIGHT_PANEL_DEFAULT_WIDTH,
  RIGHT_PANEL_MIN_WIDTH,
  RIGHT_PANEL_STORAGE_KEY,
  STASH_PANEL_DEFAULT_WIDTH,
  STASH_PANEL_MIN_WIDTH,
} from "./layoutSizes";

/**
 * Layout-persistence fix: ChangesPanel/StashPanel/DetailPanel/BlamePanel share ONE right-panel-
 * slot width preference. This guards the reconciled values so nobody can silently drift one of the
 * four panel-specific aliases back out of sync with the others (which would reintroduce the
 * visible width-jump bug this fix addresses) without a failing test.
 */
describe("right-panel-slot width unification (lib/layoutSizes.ts)", () => {
  it("gives all four right-panel-slot components the exact same default width", () => {
    expect(CHANGES_PANEL_DEFAULT_WIDTH).toBe(RIGHT_PANEL_DEFAULT_WIDTH);
    expect(STASH_PANEL_DEFAULT_WIDTH).toBe(RIGHT_PANEL_DEFAULT_WIDTH);
    expect(DETAIL_PANEL_DEFAULT_WIDTH).toBe(RIGHT_PANEL_DEFAULT_WIDTH);
    expect(BLAME_PANEL_DEFAULT_WIDTH).toBe(RIGHT_PANEL_DEFAULT_WIDTH);
  });

  it("gives all four right-panel-slot components the exact same minimum width", () => {
    expect(CHANGES_PANEL_MIN_WIDTH).toBe(RIGHT_PANEL_MIN_WIDTH);
    expect(STASH_PANEL_MIN_WIDTH).toBe(RIGHT_PANEL_MIN_WIDTH);
    expect(DETAIL_PANEL_MIN_WIDTH).toBe(RIGHT_PANEL_MIN_WIDTH);
    expect(BLAME_PANEL_MIN_WIDTH).toBe(RIGHT_PANEL_MIN_WIDTH);
  });

  // layoutBudget.test.ts pins the exact arithmetic that keeps the commit-subject column legible at
  // the app's default window size — the unified default must stay at DetailPanel's already-safe
  // post-gutter-crush-fix value (560), never revert to the old ChangesPanel/StashPanel/BlamePanel
  // default (680) that caused that regression once the branch/tag gutter existed.
  it("keeps the unified default at 560, not the old pre-gutter-crush-fix 680", () => {
    expect(RIGHT_PANEL_DEFAULT_WIDTH).toBe(560);
  });

  it("uses a single, namespaced storage key shared by all four panels", () => {
    expect(RIGHT_PANEL_STORAGE_KEY).toBe("githydra:layout:rightPanelWidth");
  });
});
