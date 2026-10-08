// SPDX-License-Identifier: GPL-3.0-or-later
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MAX_EDITABLE_FILE_BYTES } from "@githydra/git-core";
import {
  computeFileKey,
  computeRepoKey,
  DRAFT_TTL_MS,
  MAX_DRAFT_COUNT,
  MAX_RECORD_BYTES,
  MAX_TOTAL_BYTES,
  normalizeDraftRelativePath,
  RecoveryDraftStore,
  STALE_TMP_MS,
  type DraftFields,
} from "./recoveryDrafts";

// specs/edit-recovery-draft.md FR-541..548, FR-555 (AC 1, 3-5, 10).

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const HASH = "a".repeat(64);
const fields = (over: Partial<DraftFields> = {}): DraftFields => ({ content: "hello\n", bom: false, eol: "lf", finalNewline: true, expectedHash: HASH, ...over });

let tmp: string;
let root: string;
let clock: number;
let store: RecoveryDraftStore;
const repoKey = computeRepoKey("/work/repo", "linux");

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "githydra-drafts-test-"));
  root = path.join(tmp, "recovery-drafts");
  clock = 1_700_000_000_000;
  store = new RecoveryDraftStore({ root, now: () => clock });
});
afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

const fileFor = (rel: string, rk = repoKey): string => path.join(root, rk, `${computeFileKey(rk, rel)}.json`);
const tree = async (dir: string): Promise<string[]> => {
  const out: string[] = [];
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    out.push(path.relative(root, p));
    if (e.isDirectory() && !e.isSymbolicLink()) out.push(...(await tree(p)));
  }
  return out.sort();
};

describe("keys and layout (FR-542)", () => {
  it("hashes the root with normalized separators, lowercased only on win32", () => {
    const sha = (s: string) => createHash("sha256").update(s).digest("hex");
    expect(computeRepoKey("C:\\Users\\Me\\Repo\\", "win32")).toBe(sha("c:/users/me/repo"));
    expect(computeRepoKey("c:/USERS/me/repo", "win32")).toBe(sha("c:/users/me/repo"));
    expect(computeRepoKey("/Work/Repo/", "linux")).toBe(sha("/Work/Repo"));
    expect(computeRepoKey("/work/repo", "linux")).not.toBe(computeRepoKey("/Work/repo", "linux"));
  });

  it("hashes the extended-length prefix form of a Windows root like the plain one", () => {
    expect(computeRepoKey("\\\\?\\C:\\Repo", "win32")).toBe(computeRepoKey("C:\\repo", "win32"));
    expect(computeRepoKey("\\\\?\\UNC\\srv\\share\\r", "win32")).toBe(computeRepoKey("\\\\srv\\share\\r", "win32"));
  });

  it("derives fileKey from repoKey, NUL and the posix path", () => {
    const sha = (s: string) => createHash("sha256").update(s).digest("hex");
    expect(computeFileKey("k".repeat(64), "src/a.ts")).toBe(sha(`${"k".repeat(64)}\0src/a.ts`));
  });

  it("stores under <root>/<repoKey>/<fileKey>.json with no readable names on disk", async () => {
    expect((await store.write(repoKey, "src/secret-name.ts", fields())).ok).toBe(true);
    const files = await tree(root);
    expect(files).toEqual([repoKey, path.join(repoKey, `${computeFileKey(repoKey, "src/secret-name.ts")}.json`)].sort());
    expect(files.join("/")).not.toMatch(/secret|src|work|repo\b/);
  });
});

describe("record round trip (FR-543)", () => {
  it.each([
    ["CRLF", { content: "a\r\nb\r\n", eol: "crlf" as const }],
    ["BOM", { content: "x\n", bom: true }],
    ["mixed", { content: "a\r\nb\nc\r\n", eol: "mixed" as const }],
    ["no final newline", { content: "tail", finalNewline: false }],
    ["unicode and lone surrogate", { content: "héllo \u{1F600} \ud800 end\n" }],
  ])("keeps %s exactly", async (_n, over) => {
    const f = fields(over);
    const w = await store.write(repoKey, "a.txt", f);
    expect(w).toEqual({ ok: true, data: { status: "saved", savedAt: clock } });
    const r = await store.read(repoKey, "a.txt");
    expect(r).toEqual({ ok: true, data: { version: 1, relativePath: "a.txt", ...f, savedAt: clock } });
  });

  it("does not store the absolute repo path", async () => {
    await store.write(repoKey, "a.txt", fields());
    const raw = await fs.readFile(fileFor("a.txt"), "utf8");
    expect(Object.keys(JSON.parse(raw)).sort()).toEqual(["bom", "content", "eol", "expectedHash", "finalNewline", "relativePath", "savedAt", "version"]);
  });

  it("reads null when there is no draft", async () => {
    expect(await store.read(repoKey, "nope.txt")).toEqual({ ok: true, data: null });
  });
});

describe("atomic write and serialization (FR-545)", () => {
  it("leaves no temp file behind", async () => {
    for (let i = 0; i < 5; i++) await store.write(repoKey, "a.txt", fields({ content: `v${i}` }));
    expect((await fs.readdir(path.join(root, repoKey))).filter((n) => n.endsWith(".tmp"))).toEqual([]);
  });

  it("newest write wins and writes issued before it that have not started are superseded", async () => {
    const results = await Promise.all(["one", "two", "three", "four"].map((content) => store.write(repoKey, "a.txt", fields({ content }))));
    expect(results.map((r) => (r.ok ? r.data.status : r.code))).toEqual(["superseded", "superseded", "superseded", "saved"]);
    expect((await store.read(repoKey, "a.txt") as { ok: true; data: { content: string } }).data.content).toBe("four");
  });

  it("a delete issued after a pending write outranks it, so the draft is never resurrected", async () => {
    const first = store.write(repoKey, "a.txt", fields({ content: "first" }));
    const second = store.write(repoKey, "a.txt", fields({ content: "second" }));
    const del = store.delete(repoKey, "a.txt");
    const results = await Promise.all([first, second, del]);
    expect(results[1]).toEqual({ ok: true, data: { status: "superseded" } });
    expect(results[2].ok).toBe(true);
    await expect(fs.stat(fileFor("a.txt"))).rejects.toThrow();
    expect(await store.read(repoKey, "a.txt")).toEqual({ ok: true, data: null });
  });

  it("a write issued after a delete is kept", async () => {
    await store.write(repoKey, "a.txt", fields());
    const del = store.delete(repoKey, "a.txt");
    const w = store.write(repoKey, "a.txt", fields({ content: "again" }));
    await Promise.all([del, w]);
    expect((await store.read(repoKey, "a.txt") as { ok: true; data: { content: string } }).data.content).toBe("again");
  });

  it("delete is idempotent and different files do not collide", async () => {
    expect(await store.delete(repoKey, "missing.txt")).toEqual({ ok: true, data: undefined });
    await store.write(repoKey, "a.txt", fields({ content: "A" }));
    await store.write(repoKey, "b.txt", fields({ content: "B" }));
    await store.delete(repoKey, "a.txt");
    expect((await store.read(repoKey, "b.txt") as { ok: true; data: { content: string } }).data.content).toBe("B");
  });
});

describe("caps and eviction (FR-547)", () => {
  it("imports the per-draft cap from git-core and refuses over-cap content (bytes, BOM counted)", async () => {
    const atCap = "x".repeat(MAX_EDITABLE_FILE_BYTES);
    expect(await store.write(repoKey, "ok.txt", fields({ content: atCap }))).toMatchObject({ ok: true });
    expect(await store.write(repoKey, "big.txt", fields({ content: atCap + "x" }))).toEqual({ ok: false, code: "content-too-large" });
    expect(await store.write(repoKey, "bom.txt", fields({ content: atCap, bom: true }))).toEqual({ ok: false, code: "content-too-large" });
    // Multi-byte characters count as bytes, not UTF-16 units.
    expect(await store.write(repoKey, "mb.txt", fields({ content: "é".repeat(MAX_EDITABLE_FILE_BYTES / 2 + 1) }))).toEqual({ ok: false, code: "content-too-large" });
    await expect(fs.stat(fileFor("big.txt"))).rejects.toThrow();
  });

  it("accepts a ~1 MB CRLF/tab/quote/control-heavy file despite JSON escaping, and reads it back", async () => {
    expect(MAX_RECORD_BYTES).toBeGreaterThanOrEqual(MAX_EDITABLE_FILE_BYTES * 6);
    for (const [name, unit] of [["crlf", "\r\n"], ["tab", "\t"], ["quote", '"'], ["ctl", "\u0001"]] as const) {
      const content = unit.repeat(Math.floor(MAX_EDITABLE_FILE_BYTES / unit.length));
      expect(await store.write(repoKey, `${name}.txt`, fields({ content })), name).toMatchObject({ ok: true });
      expect(await store.read(repoKey, `${name}.txt`), name).toMatchObject({ ok: true, data: { content } });
    }
    await store.purge();
    await expect(fs.stat(fileFor("ctl.txt"))).resolves.toBeTruthy();
  });

  it("evicts oldest savedAt first past 200 drafts and never the one just written", async () => {
    // Plant 200 valid drafts, oldest first, then write one more.
    for (let i = 0; i < MAX_DRAFT_COUNT; i++) {
      clock += 1000;
      await store.write(repoKey, `f${i}.txt`, fields({ content: `c${i}` }));
    }
    expect((await fs.readdir(path.join(root, repoKey))).length).toBe(MAX_DRAFT_COUNT);
    clock += 1000;
    await store.write(repoKey, "newest.txt", fields({ content: "new" }));
    const names = await fs.readdir(path.join(root, repoKey));
    expect(names.length).toBe(MAX_DRAFT_COUNT);
    await expect(fs.stat(fileFor("f0.txt"))).rejects.toThrow();
    await expect(fs.stat(fileFor("f1.txt"))).resolves.toBeTruthy();
    await expect(fs.stat(fileFor("newest.txt"))).resolves.toBeTruthy();
  });

  it("keeps the just-written draft even when it is the oldest by savedAt", async () => {
    for (let i = 0; i < MAX_DRAFT_COUNT; i++) {
      clock += 1000;
      await store.write(repoKey, `f${i}.txt`, fields());
    }
    clock -= 10 * DAY; // a clock that went backwards: the new draft sorts oldest
    await store.write(repoKey, "backwards.txt", fields({ content: "keep me" }));
    await expect(fs.stat(fileFor("backwards.txt"))).resolves.toBeTruthy();
    expect((await fs.readdir(path.join(root, repoKey))).length).toBe(MAX_DRAFT_COUNT);
    await expect(fs.stat(fileFor("f0.txt"))).rejects.toThrow();
  });

  it("evicts by total size past 50 MB", async () => {
    const big = "y".repeat(MAX_EDITABLE_FILE_BYTES - 16);
    const per = Math.ceil(MAX_TOTAL_BYTES / MAX_EDITABLE_FILE_BYTES);
    for (let i = 0; i <= per; i++) {
      clock += 1000;
      await store.write(repoKey, `big${i}.txt`, fields({ content: big }));
    }
    let total = 0;
    for (const n of await fs.readdir(path.join(root, repoKey))) total += (await fs.stat(path.join(root, repoKey, n))).size;
    expect(total).toBeLessThanOrEqual(MAX_TOTAL_BYTES);
    await expect(fs.stat(fileFor("big0.txt"))).rejects.toThrow();
    await expect(fs.stat(fileFor(`big${per}.txt`))).resolves.toBeTruthy();
  }, 60_000);
});

describe("expiry (FR-547, AC4)", () => {
  it("keeps a 6d23h draft and purges a 7d0h1m one", async () => {
    await store.write(repoKey, "a.txt", fields());
    clock += 7 * DAY - HOUR;
    await store.purge();
    await expect(fs.stat(fileFor("a.txt"))).resolves.toBeTruthy();
    clock += HOUR + 60_000; // 7 d 0 h 1 m after savedAt
    await store.purge();
    await expect(fs.stat(fileFor("a.txt"))).rejects.toThrow();
    await expect(fs.stat(path.join(root, repoKey))).rejects.toThrow(); // empty repoKey dir removed
  });

  it("purges on list, and read treats an expired draft as gone", async () => {
    await store.write(repoKey, "a.txt", fields());
    await store.write(repoKey, "b.txt", fields());
    clock += DRAFT_TTL_MS + 60_000;
    expect(await store.read(repoKey, "a.txt")).toEqual({ ok: true, data: null });
    expect(await store.list(repoKey)).toEqual({ ok: true, data: [] });
    await expect(fs.stat(fileFor("b.txt"))).rejects.toThrow();
  });
});

describe("list (FR-549, FR-554)", () => {
  it("returns metadata only, newest first, scoped to the repo", async () => {
    await store.write(repoKey, "old.txt", fields({ content: "abc" }));
    clock += 1000;
    await store.write(repoKey, "new.txt", fields({ content: "é" }));
    await store.write(computeRepoKey("/other", "linux"), "x.txt", fields());
    const r = await store.list(repoKey);
    expect(r).toEqual({
      ok: true,
      data: [
        { relativePath: "new.txt", savedAt: clock, size: 2 },
        { relativePath: "old.txt", savedAt: clock - 1000, size: 3 },
      ],
    });
  });
});

describe("purge safety (FR-555, AC10)", () => {
  const plant = async (rk: string, name: string, body: string | Buffer): Promise<string> => {
    await fs.mkdir(path.join(root, rk), { recursive: true });
    const p = path.join(root, rk, name);
    await fs.writeFile(p, body);
    return p;
  };

  it("never follows or deletes a junction/symlink planted in recovery-drafts", async () => {
    const outside = path.join(tmp, "outside");
    await fs.mkdir(outside);
    const victim = path.join(outside, `${"b".repeat(64)}.json`);
    await fs.writeFile(victim, "not json, would be purged if followed");
    await fs.mkdir(root, { recursive: true });
    await fs.symlink(outside, path.join(root, "c".repeat(64)), "junction");
    await store.purge();
    await store.list("c".repeat(64));
    expect(await fs.readFile(victim, "utf8")).toBe("not json, would be purged if followed");
    expect((await fs.lstat(path.join(root, "c".repeat(64)))).isSymbolicLink()).toBe(true);
  });

  it("never follows a symlink/junction planted inside a repoKey dir", async () => {
    const outside = path.join(tmp, "outside2");
    await fs.mkdir(outside);
    const victim = path.join(outside, "keep.txt");
    await fs.writeFile(victim, "x");
    await fs.mkdir(path.join(root, repoKey), { recursive: true });
    const link = path.join(root, repoKey, `${"d".repeat(64)}.json`);
    await fs.symlink(outside, link, "junction");
    await store.purge();
    expect(await fs.readFile(victim, "utf8")).toBe("x");
    expect((await fs.lstat(link)).isSymbolicLink()).toBe(true);
    expect(await store.read(repoKey, "whatever.txt")).toEqual({ ok: true, data: null });
  });

  it("refuses to write through a planted repoKey-dir link", async () => {
    const outside = path.join(tmp, "outside3");
    await fs.mkdir(outside);
    await fs.mkdir(root, { recursive: true });
    await fs.symlink(outside, path.join(root, repoKey), "junction");
    expect(await store.write(repoKey, "a.txt", fields())).toEqual({ ok: false, code: "io" });
    expect(await fs.readdir(outside)).toEqual([]);
  });

  it("refuses to write through a planted recovery-drafts root link", async () => {
    const outside = path.join(tmp, "outside4");
    await fs.mkdir(outside);
    await fs.symlink(outside, root, "junction");
    expect(await store.write(repoKey, "a.txt", fields())).toEqual({ ok: false, code: "io" });
    expect(await fs.readdir(outside)).toEqual([]);
  });

  it("leaves unknown names, unknown dirs and directories named like drafts untouched", async () => {
    const a = await plant(repoKey, "notes.txt", "mine");
    const b = await plant(repoKey, `${"e".repeat(64)}.JSON`, "mine");
    const c = await plant(repoKey, `${"e".repeat(63)}.json`, "mine");
    const d = await plant("not-a-key", "x.json", "mine");
    await fs.mkdir(path.join(root, repoKey, `${"f".repeat(64)}.json`));
    await store.purge();
    for (const p of [a, b, c, d]) expect(await fs.readFile(p, "utf8")).toBe("mine");
    expect((await fs.stat(path.join(root, repoKey, `${"f".repeat(64)}.json`))).isDirectory()).toBe(true);
  });

  it("removes corrupt, unknown-version, oversized, foreign-key and tampered-path records silently", async () => {
    const good = computeFileKey(repoKey, "good.txt");
    await store.write(repoKey, "good.txt", fields());
    const valid = JSON.parse(await fs.readFile(fileFor("good.txt"), "utf8"));
    const k = (n: string) => `${n.repeat(64)}.json`;
    const corrupt = await plant(repoKey, k("1"), "{not json");
    const v2 = await plant(repoKey, k("2"), JSON.stringify({ ...valid, version: 2 }));
    const huge = await plant(repoKey, k("3"), Buffer.alloc(MAX_RECORD_BYTES + 10, 32));
    const wrongKey = await plant(repoKey, k("4"), JSON.stringify(valid)); // valid record under another file's name
    const dotdot = "../evil.txt";
    const evilKey = computeFileKey(repoKey, dotdot);
    const evil = await plant(repoKey, `${evilKey}.json`, JSON.stringify({ ...valid, relativePath: dotdot }));
    const badType = await plant(repoKey, k("5"), JSON.stringify({ ...valid, eol: "weird" }));
    await store.purge();
    for (const p of [corrupt, v2, huge, wrongKey, evil, badType]) await expect(fs.stat(p)).rejects.toThrow();
    await expect(fs.stat(path.join(root, repoKey, `${good}.json`))).resolves.toBeTruthy();
  });

  it("deletes a .tmp only when older than 1 hour", async () => {
    const fresh = await plant(repoKey, `${"a".repeat(64)}.abc123.tmp`, "x");
    const stale = await plant(repoKey, `${"b".repeat(64)}.abc123.tmp`, "x");
    const other = await plant(repoKey, `notes.tmp`, "x");
    const nowSec = clock / 1000;
    await fs.utimes(fresh, nowSec - (STALE_TMP_MS / 1000 - 60), nowSec - (STALE_TMP_MS / 1000 - 60));
    await fs.utimes(stale, nowSec - (STALE_TMP_MS / 1000 + 60), nowSec - (STALE_TMP_MS / 1000 + 60));
    await fs.utimes(other, nowSec - 10 * 3600, nowSec - 10 * 3600);
    await store.purge();
    await expect(fs.stat(fresh)).resolves.toBeTruthy();
    await expect(fs.stat(stale)).rejects.toThrow();
    await expect(fs.stat(other)).resolves.toBeTruthy();
  });

  it("does not remove a repoKey dir that still holds something", async () => {
    await plant(repoKey, "notes.txt", "mine");
    await store.purge();
    await expect(fs.stat(path.join(root, repoKey))).resolves.toBeTruthy();
  });

  it("purge of a missing root is a no-op and never rejects", async () => {
    await expect(store.purge()).resolves.toBeUndefined();
  });
});

describe("input validation", () => {
  it.each([
    ["empty", ""],
    ["parent segment", "a/../b"],
    ["leading ..", "../x"],
    ["backslash parent", "a\\..\\b"],
    ["absolute posix", "/etc/passwd"],
    ["absolute win", "C:\\x"],
    ["unc", "\\\\host\\share\\f"],
    ["NUL", "a\0b"],
    ["dot segment", "./a"],
    ["empty segment", "a//b"],
    ["trailing slash", "a/"],
    ["git internals", ".git/config"],
    ["non-string", 5],
    ["too long", "a".repeat(5000)],
  ])("rejects relativePath: %s", (_n, v) => {
    expect(normalizeDraftRelativePath(v, "linux")).toBeNull();
  });

  it("applies Windows-only name rules on win32 and normalizes separators", () => {
    expect(normalizeDraftRelativePath("a.txt:stream", "win32")).toBeNull();
    expect(normalizeDraftRelativePath("NUL.txt", "win32")).toBeNull();
    expect(normalizeDraftRelativePath("src\\a.ts", "win32")).toBe("src/a.ts");
    expect(normalizeDraftRelativePath("src/a.ts", "linux")).toBe("src/a.ts");
  });

  it("rejects bad repo keys and bad fields at the store boundary", async () => {
    expect(await store.write("../x", "a.txt", fields())).toEqual({ ok: false, code: "invalid" });
    expect(await store.write(repoKey, "../a.txt", fields())).toEqual({ ok: false, code: "invalid" });
    expect(await store.write(repoKey, "a.txt", fields({ eol: "x" as never }))).toEqual({ ok: false, code: "invalid" });
    expect(await store.write(repoKey, "a.txt", fields({ expectedHash: "short" }))).toEqual({ ok: false, code: "invalid" });
    expect(await store.read("nope", "a.txt")).toEqual({ ok: false, code: "invalid" });
    expect(await store.delete(repoKey, "..")).toEqual({ ok: false, code: "invalid" });
    expect(await store.list("nope")).toEqual({ ok: false, code: "invalid" });
  });

  it("failure results carry only a code, never a path or content", async () => {
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(path.join(root, repoKey), "a file where the repo dir must go");
    const r = await store.write(repoKey, "secret/dir/file.txt", fields({ content: "TOP-SECRET" }));
    expect(r).toEqual({ ok: false, code: "io" });
    expect(JSON.stringify(r)).not.toMatch(/secret|TOP|tmp|githydra/i);
  });
});
