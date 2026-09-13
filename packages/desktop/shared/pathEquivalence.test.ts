// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { detectPlatform, isCaseInsensitiveFileSystem, looksLikeSamePath, resolveOpenedPath } from "./pathEquivalence";

/**
 * ROADMAP.md "Open tech debt — repo-open dedup uses exact string equality, no path normalization":
 * `isCaseInsensitiveFileSystem`/`looksLikeSamePath` both accept an explicit platform/flag override
 * so these tests can be fully deterministic regardless of which real OS actually runs them (unlike
 * `process.platform`, which can't be reassigned cleanly in every Node version, and unlike stubbing
 * `navigator`, which only covers one of this module's two detection paths).
 */
describe("isCaseInsensitiveFileSystem", () => {
  it("win32 and darwin are case-insensitive", () => {
    expect(isCaseInsensitiveFileSystem("win32")).toBe(true);
    expect(isCaseInsensitiveFileSystem("darwin")).toBe(true);
  });

  it("linux is case-sensitive", () => {
    expect(isCaseInsensitiveFileSystem("linux")).toBe(false);
  });

  it("an undetectable platform defaults to case-sensitive (never over-merges two distinct paths)", () => {
    expect(isCaseInsensitiveFileSystem("unknown")).toBe(false);
  });
});

describe("detectPlatform", () => {
  it("returns one of the known platforms or \"unknown\" for the real host environment (smoke test)", () => {
    expect(["win32", "darwin", "linux", "unknown"]).toContain(detectPlatform());
  });
});

describe("looksLikeSamePath", () => {
  it("treats a forward-slash vs backslash spelling of the same directory as equal on win32", () => {
    expect(looksLikeSamePath("D:/Repos/Foo", "D:\\Repos\\Foo", true, "win32")).toBe(true);
  });

  it("treats a trailing separator as insignificant", () => {
    expect(looksLikeSamePath("/repo/", "/repo")).toBe(true);
    expect(looksLikeSamePath("D:\\Repos\\Foo\\", "D:\\Repos\\Foo", true, "win32")).toBe(true);
  });

  it("a genuinely different directory is never treated as the same path", () => {
    expect(looksLikeSamePath("/repo/one", "/repo/two")).toBe(false);
  });

  describe("backslash folding, gated to win32 (security review finding, 2026-09-14)", () => {
    it("does NOT fold backslash-as-separator on Linux, where '\\' is a legal filename character", () => {
      // A directory literally named "a\b" (one path component) vs. the genuinely different two-
      // component path "a/b" must never look like "the same path" on a platform where '\' isn't a
      // separator at all -- folding unconditionally would be a false-merge, worse than a missed
      // dedup.
      expect(looksLikeSamePath("/repo/a\\b", "/repo/a/b", false, "linux")).toBe(false);
    });

    it("does NOT fold backslash on darwin either (native separator is already '/', no-op by design)", () => {
      expect(looksLikeSamePath("/repo/a\\b", "/repo/a/b", true, "darwin")).toBe(false);
    });

    it("an undetectable platform also does not fold backslash (safe default, same bias as case-folding)", () => {
      expect(looksLikeSamePath("/repo/a\\b", "/repo/a/b", false, "unknown")).toBe(false);
    });
  });

  describe("case folding, explicitly driven via the override parameter (never relies on the host OS)", () => {
    it("folds case when caseInsensitive is true (win32/macOS default filesystem behavior)", () => {
      expect(looksLikeSamePath("C:\\Repos\\Foo", "c:\\repos\\foo", true)).toBe(true);
    });

    it("does NOT fold case when caseInsensitive is false (Linux default filesystem behavior) — two", () => {
      // genuinely different, case-differing directories must never look like "the same path" on a
      // case-sensitive filesystem (that would be a real over-merge, not just a missed dedup).
      expect(looksLikeSamePath("/repo/Foo", "/repo/foo", false)).toBe(false);
    });

    it("still folds separator/trailing-slash differences even when case-folding is off", () => {
      expect(looksLikeSamePath("/repo/foo/", "/repo/foo", false)).toBe(true);
    });

    it("defaults to the real detected platform when the override is omitted", () => {
      const expected = isCaseInsensitiveFileSystem();
      expect(looksLikeSamePath("/Repo", "/repo")).toBe(expected);
    });
  });
});

describe("resolveOpenedPath", () => {
  it("a bare repository always keeps the caller-supplied path unchanged", () => {
    expect(resolveOpenedPath("/bare.git", { isBare: true, workdir: null })).toBe("/bare.git");
  });

  it("no workdir at all keeps the caller-supplied path unchanged", () => {
    expect(resolveOpenedPath("/some/path", { isBare: false, workdir: null })).toBe("/some/path");
  });

  it("a non-divergent pick (git's workdir matches, modulo trivial spelling) preserves the ORIGINAL spelling", () => {
    expect(resolveOpenedPath("D:\\Repos\\Foo", { isBare: false, workdir: "D:/Repos/Foo" })).toBe("D:\\Repos\\Foo");
  });

  it("a genuinely divergent pick (e.g. a subfolder, or a symlink git itself resolved) returns git's workdir", () => {
    expect(resolveOpenedPath("D:\\Repos\\Foo\\sub", { isBare: false, workdir: "D:/Repos/Foo" })).toBe("D:/Repos/Foo");
  });
});
