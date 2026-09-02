import { afterEach, describe, expect, it } from "vitest";
import {
  getPersistedRightPanel,
  getPersistedSidebarCollapsed,
  persistRightPanel,
  persistSidebarCollapsed,
} from "./useLayoutPreferences";

afterEach(() => {
  window.localStorage.clear();
});

/** specs/layout-and-view-polish.md Must-have C16/C17/C18/AC11/AC15. */
describe("useLayoutPreferences", () => {
  it("defaults to 'none' when nothing has ever been persisted", () => {
    expect(getPersistedRightPanel()).toBe("none");
  });

  it("round-trips 'changes' and 'stashes'", () => {
    persistRightPanel("changes");
    expect(getPersistedRightPanel()).toBe("changes");
    persistRightPanel("stashes");
    expect(getPersistedRightPanel()).toBe("stashes");
    persistRightPanel("none");
    expect(getPersistedRightPanel()).toBe("none");
  });

  it("falls back to 'none' for a corrupt/unexpected stored value rather than throwing", () => {
    window.localStorage.setItem("githydra:layout:rightPanel", "commit");
    expect(getPersistedRightPanel()).toBe("none");
  });

  // design-pass "Branches panel relocation": "branches" is no longer a valid persisted value
  // (the panel is a persistent sidebar now, not one of the toggleable right panels) — a value
  // left over from before this change must degrade to "none" exactly like any other unrecognized
  // stored string, not throw or resurrect a right panel that no longer exists.
  it("falls back to 'none' for a stale pre-relocation 'branches' value", () => {
    window.localStorage.setItem("githydra:layout:rightPanel", "branches");
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

describe("useLayoutPreferences — sidebar collapsed (design-pass Branches panel relocation)", () => {
  it("defaults to expanded (false) when nothing has ever been persisted", () => {
    expect(getPersistedSidebarCollapsed()).toBe(false);
  });

  it("round-trips true and false", () => {
    persistSidebarCollapsed(true);
    expect(getPersistedSidebarCollapsed()).toBe(true);
    persistSidebarCollapsed(false);
    expect(getPersistedSidebarCollapsed()).toBe(false);
  });

  it("degrades to a no-op (never throws) when localStorage.setItem throws", () => {
    const original = window.localStorage.setItem;
    window.localStorage.setItem = () => {
      throw new Error("storage unavailable");
    };
    expect(() => persistSidebarCollapsed(true)).not.toThrow();
    window.localStorage.setItem = original;
  });
});
