// SPDX-License-Identifier: GPL-3.0-or-later
import { decide, type CopyCandidateRow } from "@githydra/git-core";
import { describe, expect, it, vi } from "vitest";
import { applyCopyDecision, readCopyRecord } from "./worktreeCopyMemory";

/** specs/worktree-copy-ignored.md FR-629, AC 2 and 3: the storage side of the memory. */

const KEY = "a".repeat(64);
const keyN = (n: number): string => n.toString(16).padStart(64, "0");

class FakeStorage implements Storage {
  data = new Map<string, string>();
  get length(): number {
    return this.data.size;
  }
  clear(): void {
    this.data.clear();
  }
  getItem = vi.fn((k: string) => this.data.get(k) ?? null);
  key(i: number): string | null {
    return [...this.data.keys()][i] ?? null;
  }
  removeItem = vi.fn((k: string) => void this.data.delete(k));
  setItem = vi.fn((k: string, v: string) => void this.data.set(k, v));
}

const throwing = (): Storage => {
  const boom = (): never => {
    throw new DOMException("denied", "SecurityError");
  };
  return { length: 0, clear: boom, getItem: boom, key: boom, removeItem: boom, setItem: boom } as unknown as Storage;
};

const row = (path: string): CopyCandidateRow => ({ path, isDirectory: path.endsWith("/"), fileCount: 1, bytes: 1 });

describe("copy memory storage", () => {
  it("writes a record and reads it back (names only)", () => {
    const s = new FakeStorage();
    applyCopyDecision(KEY, { action: "write", paths: [".env", ".vscode/"] }, () => 5, s);
    expect(readCopyRecord(KEY, s)).toEqual({ v: 1, paths: [".env", ".vscode/"], at: 5 });
    expect(JSON.stringify([...s.data.values()])).not.toMatch(/size|hash|content/);
  });

  it("none writes and deletes nothing; delete removes the record", () => {
    const s = new FakeStorage();
    applyCopyDecision(KEY, { action: "none" }, Date.now, s);
    expect(s.setItem).not.toHaveBeenCalled();
    expect(s.removeItem).not.toHaveBeenCalled();
    applyCopyDecision(KEY, { action: "write", paths: ["a"] }, () => 1, s);
    applyCopyDecision(KEY, { action: "delete" }, Date.now, s);
    expect(readCopyRecord(KEY, s)).toBeNull();
  });

  it("a storage whose methods throw SecurityError never throws and reads as no record", () => {
    const s = throwing();
    expect(() => applyCopyDecision(KEY, { action: "write", paths: ["a"] }, Date.now, s)).not.toThrow();
    expect(() => applyCopyDecision(KEY, { action: "delete" }, Date.now, s)).not.toThrow();
    expect(readCopyRecord(KEY, s)).toBeNull();
    expect(readCopyRecord(KEY, null)).toBeNull();
  });

  it("drops corrupt, wrong-shape, wrong-version and over-cap records without throwing", () => {
    const s = new FakeStorage();
    const bad = ["{", "null", "[]", '"x"', JSON.stringify({ v: 2, paths: ["a"], at: 1 }), JSON.stringify({ v: 1, paths: "a", at: 1 }), JSON.stringify({ v: 1, paths: ["a"] }), JSON.stringify({ v: 1, paths: new Array(201).fill(0).map((_, i) => `f${i}`), at: 1 })];
    for (const raw of bad) {
      s.data.set(`githydra:worktreeCopy:${KEY}`, raw);
      expect(readCopyRecord(KEY, s), raw.slice(0, 30)).toBeNull();
    }
  });

  it("filters hostile paths on read (.., absolute, NUL, control, .git)", () => {
    const s = new FakeStorage();
    s.data.set(`githydra:worktreeCopy:${KEY}`, JSON.stringify({ v: 1, paths: ["../x", "/etc/passwd", "C:\\x", "a\0b", "a\nb", ".git/config", "ok.txt"], at: 1 }));
    expect(readCopyRecord(KEY, s)?.paths).toEqual(["ok.txt"]);
    s.data.set(`githydra:worktreeCopy:${KEY}`, JSON.stringify({ v: 1, paths: ["../x"], at: 1 }));
    expect(readCopyRecord(KEY, s)).toBeNull();
  });

  it("ignores a key that is not a sha256 (nothing is stored for it)", () => {
    const s = new FakeStorage();
    applyCopyDecision("../../evil", { action: "write", paths: ["a"] }, Date.now, s);
    applyCopyDecision(null, { action: "write", paths: ["a"] }, Date.now, s);
    expect(s.setItem).not.toHaveBeenCalled();
    expect(readCopyRecord(null, s)).toBeNull();
  });

  it("the 201st record evicts the oldest, ties broken by a monotonic counter", () => {
    const s = new FakeStorage();
    // Same millisecond for every write: the counter keeps their order.
    for (let i = 1; i <= 200; i++) applyCopyDecision(keyN(i), { action: "write", paths: ["a"] }, () => 100, s);
    expect(s.data.size).toBe(200);
    applyCopyDecision(keyN(201), { action: "write", paths: ["a"] }, () => 100, s);
    expect(s.data.size).toBe(200);
    expect(readCopyRecord(keyN(1), s)).toBeNull();
    expect(readCopyRecord(keyN(2), s)).not.toBeNull();
    expect(readCopyRecord(keyN(201), s)).not.toBeNull();
  });

  it("a moved folder (a different key) reads as no record with no error", () => {
    const s = new FakeStorage();
    applyCopyDecision(KEY, { action: "write", paths: ["a"] }, () => 1, s);
    expect(readCopyRecord("b".repeat(64), s)).toBeNull();
  });
});

describe("save rule end to end with decide (FR-629)", () => {
  it("an unchanged selection writes nothing at all", () => {
    const s = new FakeStorage();
    const d = decide([".env"], [".env"], true, [row(".env")], null);
    applyCopyDecision(KEY, d, Date.now, s);
    expect(s.setItem).not.toHaveBeenCalled();
    expect(s.removeItem).not.toHaveBeenCalled();
  });

  it("checkbox off writes nothing", () => {
    const s = new FakeStorage();
    applyCopyDecision(KEY, decide([], ["a.txt"], false, [row("a.txt")], null), Date.now, s);
    expect(s.setItem).not.toHaveBeenCalled();
  });

  it("an empty decided result stores an empty record; an undecided one deletes it", () => {
    const s = new FakeStorage();
    applyCopyDecision(KEY, { action: "write", paths: ["a.txt"] }, () => 1, s);
    const record = readCopyRecord(KEY, s);
    applyCopyDecision(KEY, decide(["a.txt"], [], true, [row("a.txt")], record), Date.now, s);
    expect(readCopyRecord(KEY, s)).toBeNull();
    applyCopyDecision(KEY, decide([], [], true, [row("a.txt")], null, true), () => 5, s);
    expect(readCopyRecord(KEY, s)?.paths).toEqual([]);
  });

  it("a secret seeded from a repo file is never written, a hand-ticked one is", () => {
    const s = new FakeStorage();
    const rows = [row(".env"), row("notes.txt")];
    // .env was in the initial set only because of a seed; the user then ticked notes.txt.
    applyCopyDecision(KEY, decide([".env"], [".env", "notes.txt"], true, rows, null), () => 1, s);
    expect(readCopyRecord(KEY, s)?.paths).toEqual(["notes.txt"]);
    // Ticked by hand: not in the initial set.
    const t = new FakeStorage();
    applyCopyDecision(KEY, decide([], [".env"], true, rows, null), () => 1, t);
    expect(readCopyRecord(KEY, t)?.paths).toEqual([".env"]);
  });

  it("keeps remembered paths that were not candidates this time", () => {
    const s = new FakeStorage();
    applyCopyDecision(KEY, { action: "write", paths: ["a", "b"] }, () => 1, s);
    const record = readCopyRecord(KEY, s);
    applyCopyDecision(KEY, decide(["a"], [], true, [row("a")], record), () => 2, s);
    expect(readCopyRecord(KEY, s)?.paths).toEqual(["b"]);
  });
});
