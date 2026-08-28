import { afterEach, describe, expect, it } from "vitest";
import { getPersistedRightPanel, persistRightPanel } from "./useLayoutPreferences";

afterEach(() => {
  window.localStorage.clear();
});

/** specs/layout-and-view-polish.md Must-have C16/C17/C18/AC11/AC15. */
describe("useLayoutPreferences", () => {
  it("defaults to 'none' when nothing has ever been persisted", () => {
    expect(getPersistedRightPanel()).toBe("none");
  });

  it("round-trips 'changes' and 'branches'", () => {
    persistRightPanel("changes");
    expect(getPersistedRightPanel()).toBe("changes");
    persistRightPanel("branches");
    expect(getPersistedRightPanel()).toBe("branches");
    persistRightPanel("none");
    expect(getPersistedRightPanel()).toBe("none");
  });

  it("falls back to 'none' for a corrupt/unexpected stored value rather than throwing", () => {
    window.localStorage.setItem("githydra:layout:rightPanel", "commit");
    expect(getPersistedRightPanel()).toBe("none");
  });

  it("degrades to a no-op (never throws) when localStorage.setItem throws (AC15)", () => {
    const original = window.localStorage.setItem;
    window.localStorage.setItem = () => {
      throw new Error("storage unavailable");
    };
    expect(() => persistRightPanel("changes")).not.toThrow();
    window.localStorage.setItem = original;
  });
});
