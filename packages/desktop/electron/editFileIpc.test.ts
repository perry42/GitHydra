// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from "vitest";
import { EditFileAccessError, EditWriteError, InvalidArgumentError } from "@githydra/git-core";
import { MAX_EDIT_CONTENT_CHARS, MAX_EDIT_PATH_CHARS } from "../shared/ipcContract";
import { createEditFileHandlers, mapEditError, SelfWriteRegistry, type EditFileRepo } from "./editFileIpc";
import { createRealGitHydraApi, type RealGitHydraHandle } from "../src/test/realGitHydraApi";
import { cleanup, commitAll, initRepo, readFile, writeFile } from "../src/test/gitFixture";

// specs/edit-in-diff.md FR-471/FR-474/FR-536/FR-537.

const HASH = "a".repeat(64);
const OPTS = { expectedHash: HASH, eol: "lf", hasBom: false, finalNewline: true } as const;
const WRITTEN = { status: "written" as const, contentHash: "b".repeat(64), mtimeMs: 1000, size: 5 };

function fakeRepo(over: Partial<EditFileRepo> = {}) {
  const repo = {
    getState: () => ({ workdir: "/work" }),
    probeEditableFile: vi.fn(async () => ({ eligible: false as const, reason: "deleted" as const, message: "m" })),
    readEditableFile: vi.fn(async () => ({ eligible: false as const, reason: "deleted" as const, message: "m" })),
    writeEditedFile: vi.fn(async () => WRITTEN),
    ...over,
  };
  return repo;
}

describe("edit-file IPC validation", () => {
  it("rejects bad paths before git-core is reached", async () => {
    const repo = fakeRepo();
    const h = createEditFileHandlers(() => repo, new SelfWriteRegistry());
    for (const p of [undefined, null, 5, {}, ["a"], "", "a\0b", "a".repeat(MAX_EDIT_PATH_CHARS + 1)]) {
      for (const r of [await h.probe(p), await h.read(p), await h.write(p, "x", OPTS)]) {
        expect(r).toMatchObject({ ok: false, code: "invalid-argument" });
      }
    }
    expect(repo.probeEditableFile).not.toHaveBeenCalled();
    expect(repo.readEditableFile).not.toHaveBeenCalled();
    expect(repo.writeEditedFile).not.toHaveBeenCalled();
  });

  it("rejects non-string and oversize content", async () => {
    const repo = fakeRepo();
    const h = createEditFileHandlers(() => repo, new SelfWriteRegistry());
    expect(await h.write("a.txt", 5, OPTS)).toMatchObject({ ok: false, code: "invalid-argument" });
    expect(await h.write("a.txt", { length: 1 }, OPTS)).toMatchObject({ ok: false, code: "invalid-argument" });
    expect(await h.write("a.txt", "x".repeat(MAX_EDIT_CONTENT_CHARS + 1), OPTS)).toMatchObject({ ok: false, code: "content-too-large" });
    expect(repo.writeEditedFile).not.toHaveBeenCalled();
    expect((await h.write("a.txt", "x".repeat(MAX_EDIT_CONTENT_CHARS), OPTS)).ok).toBe(true);
  });

  it("rejects every malformed option and rebuilds a clean object from good ones", async () => {
    const repo = fakeRepo();
    const h = createEditFileHandlers(() => repo, new SelfWriteRegistry());
    const bad: unknown[] = [
      undefined, null, "x", [], {},
      { ...OPTS, expectedHash: undefined },
      { ...OPTS, expectedHash: "" },
      { ...OPTS, expectedHash: "A".repeat(64) },
      { ...OPTS, expectedHash: "a".repeat(63) },
      { ...OPTS, eol: "cr" },
      { ...OPTS, eol: undefined },
      { ...OPTS, hasBom: "yes" },
      { ...OPTS, hasBom: undefined },
      { ...OPTS, finalNewline: 1 },
      { ...OPTS, force: "true" },
      { ...OPTS, force: 1 },
    ];
    for (const o of bad) expect(await h.write("a.txt", "x", o)).toMatchObject({ ok: false, code: "invalid-argument" });
    expect(repo.writeEditedFile).not.toHaveBeenCalled();

    await h.write("a.txt", "x", { ...OPTS, force: true, evil: { toString: 1 }, __proto__: { polluted: 1 } });
    await h.write("a.txt", "x", { ...OPTS, force: false });
    expect(repo.writeEditedFile.mock.calls[0]).toEqual(["a.txt", "x", { ...OPTS, force: true }]);
    expect(repo.writeEditedFile.mock.calls[1]).toEqual(["a.txt", "x", { ...OPTS }]);
  });

  it("maps an unknown repo to no-repository, after argument checks", async () => {
    const h = createEditFileHandlers(() => {
      throw new Error("No repository is open");
    }, new SelfWriteRegistry());
    expect(await h.probe("a.txt")).toMatchObject({ ok: false, code: "no-repository" });
    expect(await h.read("a.txt")).toMatchObject({ ok: false, code: "no-repository" });
    expect(await h.write("a.txt", "x", OPTS)).toMatchObject({ ok: false, code: "no-repository" });
    expect(await h.probe(5)).toMatchObject({ ok: false, code: "invalid-argument" });
  });

  it("passes a traversal path to git-core's containment check and maps its refusal without echoing the path", async () => {
    const repo = fakeRepo({
      writeEditedFile: vi.fn(async () => {
        throw new InvalidArgumentError('File path escapes the repository working directory: "../../etc/passwd"');
      }),
    });
    const h = createEditFileHandlers(() => repo, new SelfWriteRegistry());
    const r = await h.write("../../etc/passwd", "x", OPTS);
    expect(r).toMatchObject({ ok: false, code: "invalid-argument" });
    expect(JSON.stringify(r)).not.toMatch(/passwd|etc/);
  });
});

describe("edit-file result-code mapping", () => {
  it("maps each typed error to a closed code with fixed text", () => {
    for (const code of ["read-only", "content-too-large", "contains-nul", "invalid-content", "io"] as const) {
      const r = mapEditError(new EditWriteError("secret/dir/file.txt", code, "detail"));
      expect(r.code).toBe(code);
      expect(r.message).not.toMatch(/secret|detail/);
    }
    const access = mapEditError(new EditFileAccessError("secret/dir/file.txt", "EACCES"));
    expect(access).toMatchObject({ ok: false, code: "access" });
    expect(access.message).not.toMatch(/secret|EACCES/);
    const other = mapEditError(new Error("C:\\Users\\me\\repo failed"));
    expect(other).toMatchObject({ code: "internal" });
    expect(other.message).not.toMatch(/Users/);
  });

  it("returns ineligible and changed-on-disk results as ok data, not failures", async () => {
    const repo = fakeRepo({ writeEditedFile: vi.fn(async () => ({ status: "changed-on-disk" as const, currentHash: "c".repeat(64) })) });
    const h = createEditFileHandlers(() => repo, new SelfWriteRegistry());
    expect(await h.write("a.txt", "x", OPTS)).toEqual({ ok: true, data: { status: "changed-on-disk", currentHash: "c".repeat(64) } });
    expect(await h.probe("a.txt")).toMatchObject({ ok: true, data: { eligible: false, reason: "deleted" } });
  });
});

describe("self-write registration (FR-536)", () => {
  const path = "src/a.txt";
  const change = { paths: [path], truncated: false };

  it("registers only a successful save, with the returned mtime and size", async () => {
    const stat = vi.fn(async () => ({ mtimeMs: 1000, size: 5 }));
    const reg = new SelfWriteRegistry(() => 0, stat, false);
    const failing = fakeRepo({ writeEditedFile: vi.fn(async () => ({ status: "changed-on-disk" as const, currentHash: "c".repeat(64) })) });
    await createEditFileHandlers(() => failing, reg).write(path, "x", OPTS);
    expect(await reg.coversChange("/work", change)).toBe(false);

    await createEditFileHandlers(() => fakeRepo(), reg).write(path, "x", OPTS);
    expect(await reg.coversChange("/work", change)).toBe(true);
  });

  it("covers the echo only while the file still matches the saved mtime and size, and only inside the window", async () => {
    let now = 0;
    let cur: { mtimeMs: number; size: number } | null = { mtimeMs: 1000, size: 5 };
    const reg = new SelfWriteRegistry(() => now, async () => cur, false);
    reg.record("/work", path, { mtimeMs: 1000, size: 5 });
    now = 1000;
    expect(await reg.coversChange("/work", change)).toBe(true);
    expect(await reg.coversChange("/work", change)).toBe(true); // several watcher events per save

    cur = { mtimeMs: 1000, size: 6 }; // an outside edit lands after our save
    expect(await reg.coversChange("/work", change)).toBe(false);
    cur = { mtimeMs: 1000, size: 5 };
    expect(await reg.coversChange("/work", change)).toBe(false); // entry dropped once contradicted

    reg.record("/work", path, { mtimeMs: 1000, size: 5 });
    now = 7000;
    expect(await reg.coversChange("/work", change)).toBe(false);

    reg.record("/work", path, { mtimeMs: 1000, size: 5 });
    cur = null;
    expect(await reg.coversChange("/work", change)).toBe(false);
  });

  it("never suppresses a mixed, truncated, empty or unknown-path change", async () => {
    const reg = new SelfWriteRegistry(() => 0, async () => ({ mtimeMs: 1, size: 1 }), false);
    reg.record("/work", path, { mtimeMs: 1, size: 1 });
    expect(await reg.coversChange("/work", { paths: [path, "other.txt"], truncated: false })).toBe(false);
    reg.record("/work", path, { mtimeMs: 1, size: 1 });
    expect(await reg.coversChange("/work", { paths: [path], truncated: true })).toBe(false);
    expect(await reg.coversChange("/work", { paths: [], truncated: false })).toBe(false);
    expect(await reg.coversChange("/other-repo", change)).toBe(false);
  });

  it("matches case-insensitively only where the file system is", async () => {
    const stat = async () => ({ mtimeMs: 1, size: 1 });
    const ci = new SelfWriteRegistry(() => 0, stat, true);
    ci.record("/work", "A.txt", { mtimeMs: 1, size: 1 });
    expect(await ci.coversChange("/work", { paths: ["a.txt"], truncated: false })).toBe(true);
    const cs = new SelfWriteRegistry(() => 0, stat, false);
    cs.record("/work", "A.txt", { mtimeMs: 1, size: 1 });
    expect(await cs.coversChange("/work", { paths: ["a.txt"], truncated: false })).toBe(false);
  });
});

describe("edit-file channels against a real repository", () => {
  let handle: RealGitHydraHandle | undefined;
  let dir: string | undefined;
  afterEach(async () => {
    handle?.dispose();
    handle = undefined;
    if (dir) await cleanup(dir);
    dir = undefined;
  });

  it("probe, read and a guarded write round-trip; stale hash and traversal are refused", async () => {
    dir = await initRepo();
    await writeFile(dir, "a.txt", "one\r\ntwo\r\n");
    await commitAll(dir, "init");
    handle = createRealGitHydraApi();
    const api = handle.api;
    expect(await api.probeEditableFile("a.txt")).toMatchObject({ ok: false, code: "no-repository" });
    await api.openRepo(dir);

    const probe = await api.probeEditableFile("a.txt");
    expect(probe).toMatchObject({ ok: true, data: { eligible: true } });
    const read = await api.readEditableFile("a.txt");
    if (!read.ok || !read.data.eligible) throw new Error("expected an eligible read");
    expect(read.data).toMatchObject({ content: "one\r\ntwo\r\n", eol: "crlf", hasBom: false, finalNewline: true });

    const opts = { expectedHash: read.data.contentHash, eol: read.data.eol, hasBom: false, finalNewline: true };
    const saved = await api.writeEditedFile("a.txt", "one\ntwo\nthree\n", opts);
    expect(saved).toMatchObject({ ok: true, data: { status: "written" } });
    expect(await readFile(dir, "a.txt")).toBe("one\r\ntwo\r\nthree\r\n");

    // The first read's hash is now stale.
    expect(await api.writeEditedFile("a.txt", "x\n", opts)).toMatchObject({ ok: true, data: { status: "changed-on-disk" } });

    expect(await api.writeEditedFile("../outside.txt", "x", opts)).toMatchObject({ ok: false, code: "invalid-argument" });
    expect(await api.probeEditableFile("../outside.txt")).toMatchObject({ ok: true, data: { eligible: false, reason: "outside-repo" } });
    expect(await api.writeEditedFile("a.txt", "x", { ...opts, expectedHash: "nope" })).toMatchObject({ ok: false, code: "invalid-argument" });
  });
});
