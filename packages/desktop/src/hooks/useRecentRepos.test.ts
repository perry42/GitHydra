import { afterEach, describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import {
  MAX_RECENT_REPOS,
  addPersistedRecentRepo,
  getPersistedRecentRepos,
  removePersistedRecentRepo,
  useRecentRepos,
} from "./useRecentRepos";

afterEach(() => {
  window.localStorage.clear();
});

/** specs/repo-list.md Must-have 1/AC1/AC3/AC6/AC9. */
describe("useRecentRepos persistence", () => {
  it("AC9: a fresh profile has no persisted recent repos", () => {
    expect(getPersistedRecentRepos()).toEqual([]);
  });

  it("AC1: adding a path persists it, most-recent-first", () => {
    addPersistedRecentRepo("/repoA");
    expect(getPersistedRecentRepos()).toEqual(["/repoA"]);
    addPersistedRecentRepo("/repoB");
    expect(getPersistedRecentRepos()).toEqual(["/repoB", "/repoA"]);
  });

  it("Must-have 1: re-adding an already-present path moves it to the front instead of duplicating it", () => {
    addPersistedRecentRepo("/repoA");
    addPersistedRecentRepo("/repoB");
    addPersistedRecentRepo("/repoA");
    expect(getPersistedRecentRepos()).toEqual(["/repoA", "/repoB"]);
  });

  it("AC3: opening 25 distinct paths caps the persisted list at 20, most-recent-first, oldest evicted", () => {
    for (let i = 0; i < 25; i++) addPersistedRecentRepo(`/repo${i}`);
    const list = getPersistedRecentRepos();
    expect(list).toHaveLength(MAX_RECENT_REPOS);
    // Most recent (repo24) first; the oldest 5 (repo0..repo4) evicted.
    expect(list[0]).toBe("/repo24");
    expect(list[list.length - 1]).toBe("/repo5");
    expect(list).not.toContain("/repo0");
    expect(list).not.toContain("/repo4");
  });

  it("AC6: removing an entry deletes only that entry, leaving the others' order untouched", () => {
    addPersistedRecentRepo("/repoA");
    addPersistedRecentRepo("/repoB");
    addPersistedRecentRepo("/repoC");
    // Order is now [C, B, A].
    removePersistedRecentRepo("/repoB");
    expect(getPersistedRecentRepos()).toEqual(["/repoC", "/repoA"]);
  });

  it("removing an absent path is a harmless no-op", () => {
    addPersistedRecentRepo("/repoA");
    removePersistedRecentRepo("/does-not-exist");
    expect(getPersistedRecentRepos()).toEqual(["/repoA"]);
  });

  it("degrades to an empty list (never throws) when localStorage is corrupt", () => {
    window.localStorage.setItem("githydra:recentRepos", "{not valid json");
    expect(getPersistedRecentRepos()).toEqual([]);
  });

  it("test-agent/security review: a hand-tampered stored array with duplicate paths is deduped on read, keeping the first (most-recent) occurrence", () => {
    window.localStorage.setItem("githydra:recentRepos", JSON.stringify(["/repoA", "/repoB", "/repoA", "/repoC", "/repoB"]));
    expect(getPersistedRecentRepos()).toEqual(["/repoA", "/repoB", "/repoC"]);
  });

  it("dedupes tampered data even when combined with the 20-entry cap", () => {
    const tampered = ["/repoA", "/repoA", ...Array.from({ length: 25 }, (_, i) => `/repo${i}`)];
    window.localStorage.setItem("githydra:recentRepos", JSON.stringify(tampered));
    const list = getPersistedRecentRepos();
    expect(list).toHaveLength(MAX_RECENT_REPOS);
    expect(new Set(list).size).toBe(MAX_RECENT_REPOS);
  });

  it("degrades to a no-op (never throws) when localStorage.setItem throws", () => {
    const original = window.localStorage.setItem;
    window.localStorage.setItem = () => {
      throw new Error("storage unavailable");
    };
    expect(() => addPersistedRecentRepo("/repoA")).not.toThrow();
    window.localStorage.setItem = original;
  });
});

describe("useRecentRepos hook", () => {
  it("AC9: starts empty on a fresh profile", () => {
    const { result } = renderHook(() => useRecentRepos());
    expect(result.current.recentRepos).toEqual([]);
  });

  it("addRecentRepo updates both the returned state and the persisted store", () => {
    const { result } = renderHook(() => useRecentRepos());
    act(() => result.current.addRecentRepo("/repoA"));
    expect(result.current.recentRepos).toEqual(["/repoA"]);
    expect(getPersistedRecentRepos()).toEqual(["/repoA"]);
  });

  it("removeRecentRepo updates both the returned state and the persisted store", () => {
    const { result } = renderHook(() => useRecentRepos());
    act(() => result.current.addRecentRepo("/repoA"));
    act(() => result.current.addRecentRepo("/repoB"));
    act(() => result.current.removeRecentRepo("/repoA"));
    expect(result.current.recentRepos).toEqual(["/repoB"]);
    expect(getPersistedRecentRepos()).toEqual(["/repoB"]);
  });

  it("a second hook instance sees a fresh-read seed from whatever was already persisted", () => {
    addPersistedRecentRepo("/repoA");
    const { result } = renderHook(() => useRecentRepos());
    expect(result.current.recentRepos).toEqual(["/repoA"]);
  });
});
