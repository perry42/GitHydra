// SPDX-License-Identifier: GPL-3.0-or-later
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MAX_EDITABLE_FILE_BYTES } from "@githydra/git-core";
import { MAX_EDIT_CONTENT_CHARS, MAX_EDIT_PATH_CHARS } from "../shared/ipcContract";
import { createRecoveryDraftHandlers, pickDraftInput } from "./recoveryDraftIpc";
import { computeFileKey, computeRepoKey, RecoveryDraftStore } from "./recoveryDrafts";

// specs/edit-recovery-draft.md FR-554 (AC 10): validation and sanitized codes in front of the store.

const HASH = "c".repeat(64);
const draft = (over: Record<string, unknown> = {}) => ({ content: "hi\n", bom: false, eol: "lf", finalNewline: true, expectedHash: HASH, ...over });

let tmp: string;
let workdir: string;
let store: RecoveryDraftStore;
let open: { workdir: string | null } | null;
let h: ReturnType<typeof createRecoveryDraftHandlers>;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "githydra-draft-ipc-"));
  workdir = path.join(tmp, "repo");
  await fs.mkdir(workdir);
  store = new RecoveryDraftStore({ root: path.join(tmp, "ud", "recovery-drafts") });
  open = { workdir };
  h = createRecoveryDraftHandlers(
    () => {
      if (!open) throw new Error(`no repo at ${tmp}`);
      return { getState: () => open! };
    },
    () => store,
  );
});
afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

describe("recovery draft IPC handlers", () => {
  it("round-trips write, read, list and delete for the open repo", async () => {
    const w = await h.write(workdir, "src/a.ts", draft({ content: "a\r\nb", eol: "crlf", finalNewline: false, bom: true }));
    expect(w).toMatchObject({ ok: true, data: { status: "saved" } });
    expect(await h.read(workdir, "src/a.ts")).toMatchObject({
      ok: true,
      data: { relativePath: "src/a.ts", content: "a\r\nb", eol: "crlf", finalNewline: false, bom: true, expectedHash: HASH },
    });
    expect(await h.list(workdir)).toMatchObject({ ok: true, data: [{ relativePath: "src/a.ts", size: 4 }] });
    expect(await h.delete(workdir, "src/a.ts")).toEqual({ ok: true, data: undefined });
    expect(await h.read(workdir, "src/a.ts")).toEqual({ ok: true, data: null });
    expect(await h.list(workdir)).toEqual({ ok: true, data: [] });
  });

  it("keys the draft by the realpath of the open working tree", async () => {
    await h.write(workdir, "a.txt", draft());
    const key = computeRepoKey(await fs.realpath(workdir));
    await expect(fs.stat(path.join(tmp, "ud", "recovery-drafts", key, `${computeFileKey(key, "a.txt")}.json`))).resolves.toBeTruthy();
  });

  it("rejects traversal-shaped and malformed paths before touching disk", async () => {
    const bad: unknown[] = [undefined, null, 5, {}, ["a"], "", "..", "../x", "a/../../x", "/etc/passwd", "C:\\x", "\\\\h\\s\\f", "a\0b", "a".repeat(MAX_EDIT_PATH_CHARS + 1), ".git/config"];
    for (const p of bad) {
      expect(await h.write(workdir, p, draft())).toMatchObject({ ok: false, code: "invalid-argument" });
      expect(await h.read(workdir, p)).toMatchObject({ ok: false, code: "invalid-argument" });
      expect(await h.delete(workdir, p)).toMatchObject({ ok: false, code: "invalid-argument" });
    }
    await expect(fs.stat(path.join(tmp, "ud"))).rejects.toThrow();
  });

  it("rejects bad draft fields and drops unknown keys", async () => {
    const bads = [
      undefined, null, "x", [], draft({ content: 5 }), draft({ eol: "CRLF" }), draft({ bom: "yes" }), draft({ bom: 1 }), draft({ finalNewline: null }),
      draft({ expectedHash: "A".repeat(64) }), draft({ expectedHash: "abc" }), draft({ expectedHash: 5 }),
    ];
    for (const d of bads) expect(await h.write(workdir, "a.txt", d)).toMatchObject({ ok: false, code: "invalid-argument" });
    expect(pickDraftInput({ ...draft(), evil: 1, __proto__: { x: 1 } })).toEqual(draft());
    await h.write(workdir, "a.txt", { ...draft(), savedAt: 1, relativePath: "../hijack", extra: true });
    const r = await h.read(workdir, "a.txt");
    expect(r).toMatchObject({ ok: true, data: { relativePath: "a.txt" } });
    expect(Object.keys((r as { data: object }).data).sort()).toEqual(["bom", "content", "eol", "expectedHash", "finalNewline", "relativePath", "savedAt"]);
  });

  it("enforces the content caps with a closed code", async () => {
    expect(await h.write(workdir, "a.txt", draft({ content: "x".repeat(MAX_EDIT_CONTENT_CHARS + 1) }))).toMatchObject({ ok: false, code: "content-too-large" });
    expect(await h.write(workdir, "a.txt", draft({ content: "x".repeat(MAX_EDITABLE_FILE_BYTES + 1) }))).toMatchObject({ ok: false, code: "content-too-large" });
    expect(await h.write(workdir, "a.txt", draft({ content: "x".repeat(MAX_EDITABLE_FILE_BYTES) }))).toMatchObject({ ok: true });
  });

  it("answers no-repository when nothing (or a bare repo) is open", async () => {
    open = null;
    expect(await h.list(workdir)).toMatchObject({ ok: false, code: "no-repository" });
    expect(await h.write(workdir, "a.txt", draft())).toMatchObject({ ok: false, code: "no-repository" });
    open = { workdir: null };
    expect(await h.read(workdir, "a.txt")).toMatchObject({ ok: false, code: "no-repository" });
  });

  it("re-validates a stored path on read and hides tampered records from list", async () => {
    await h.write(workdir, "a.txt", draft());
    const key = computeRepoKey(await fs.realpath(workdir));
    const dir = path.join(tmp, "ud", "recovery-drafts", key);
    const file = path.join(dir, `${computeFileKey(key, "a.txt")}.json`);
    const rec = JSON.parse(await fs.readFile(file, "utf8"));
    await fs.writeFile(file, JSON.stringify({ ...rec, relativePath: "../../escape" }));
    expect(await h.read(workdir, "a.txt")).toEqual({ ok: true, data: null });
    expect(await h.list(workdir)).toEqual({ ok: true, data: [] });
  });

  it("keeps drafts of two repos separate", async () => {
    await h.write(workdir, "a.txt", draft({ content: "one" }));
    const other = path.join(tmp, "repo2");
    await fs.mkdir(other);
    open = { workdir: other };
    expect(await h.read(other, "a.txt")).toEqual({ ok: true, data: null });
    await h.write(other, "a.txt", draft({ content: "two" }));
    open = { workdir };
    expect(await h.read(workdir, "a.txt")).toMatchObject({ data: { content: "one" } });
  });

  it("a delete sent right after a write always wins, even across the first realpath", async () => {
    const w = h.write(workdir, "a.txt", draft());
    const d = h.delete(workdir, "a.txt");
    await Promise.all([w, d]);
    expect(await h.read(workdir, "a.txt")).toEqual({ ok: true, data: null });
  });

  it("M1: a call naming a repo that is no longer open is refused, including a switch while the key is resolving", async () => {
    const other = path.join(tmp, "repo2");
    await fs.mkdir(other);
    open = { workdir: other };
    expect(await h.write(workdir, "a.txt", draft())).toMatchObject({ ok: false, code: "no-repository" });
    expect(await h.delete(workdir, "a.txt")).toMatchObject({ ok: false, code: "no-repository" });
    expect(await h.list(workdir)).toMatchObject({ ok: false, code: "no-repository" });
    expect(await h.read(123, "a.txt")).toMatchObject({ ok: false, code: "invalid-argument" });
    // Switch lands between send and the end of the async key lookup.
    open = { workdir };
    const slow = createRecoveryDraftHandlers(
      () => ({ getState: () => open! }),
      () => store,
      { realpath: async (p) => (await new Promise((r) => setTimeout(r, 30)), fs.realpath(p)) },
    );
    const pending = slow.write(workdir, "a.txt", draft());
    open = { workdir: other };
    expect(await pending).toMatchObject({ ok: false, code: "no-repository" });
    open = { workdir };
    expect(await h.read(workdir, "a.txt")).toEqual({ ok: true, data: null });
    open = { workdir: other };
    expect(await h.read(other, "a.txt")).toEqual({ ok: true, data: null });
  });

  it("M2: a delete cannot overtake an earlier write even when the first realpath is slower", async () => {
    let n = 0;
    const real = fs.realpath;
    const ordered = createRecoveryDraftHandlers(
      () => ({ getState: () => open! }),
      () => store,
      { realpath: async (p) => (await new Promise((r) => setTimeout(r, n++ === 0 ? 60 : 1)), real(p)) },
    );
    const w = ordered.write(workdir, "a.txt", draft());
    const d = ordered.delete(workdir, "a.txt");
    await Promise.all([w, d]);
    expect(await h.read(workdir, "a.txt")).toEqual({ ok: true, data: null });
  });

  it("error messages never contain paths or content", async () => {
    const key = computeRepoKey(await fs.realpath(workdir));
    await fs.mkdir(path.join(tmp, "ud", "recovery-drafts"), { recursive: true });
    await fs.writeFile(path.join(tmp, "ud", "recovery-drafts", key), "block the repo dir");
    const results = [
      await h.write(workdir, "secret-dir/secret-file.txt", draft({ content: "TOP-SECRET-BODY" })),
      await h.write(workdir, "../secret-file.txt", draft({ content: "TOP-SECRET-BODY" })),
      await h.write(workdir, "a.txt", draft({ content: "TOP-SECRET-BODY".repeat(MAX_EDIT_CONTENT_CHARS) })),
    ];
    for (const r of results) {
      expect(r.ok).toBe(false);
      expect(JSON.stringify(r)).not.toMatch(/secret|TOP|githydra|repo|ud|[A-Za-z]:\\|\/tmp/i);
    }
    open = null;
    expect(JSON.stringify(await h.list(workdir))).not.toContain(tmp);
  });
});
