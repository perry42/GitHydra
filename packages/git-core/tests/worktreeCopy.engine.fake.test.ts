// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect } from "vitest";
import * as path from "node:path";
import { constants as C } from "node:fs";
import { copyFromManifest, type CopyManifest, type CopyOutcome } from "../src/worktreeCopyEngine";
import { MemFs } from "./memCopyFs";
import { SENTINEL } from "./worktreeCopyKit";

const SRC = path.resolve("/mem/src");
const DST = path.resolve("/mem/dst");
const OUT = path.resolve("/mem/outside");
const j = (root: string, rel: string) => path.join(root, ...rel.split("/"));

/** Source files, an empty destination worktree (with its .git file), and a manifest naming `rels` (one row per path). */
async function setup(files: Record<string, string>, rels = Object.keys(files)) {
  const fs = new MemFs();
  fs.mkdirp(DST);
  fs.addFile(path.join(DST, ".git"), "gitdir: x");
  fs.mkdirp(OUT);
  fs.mkdirp(SRC);
  for (const [rel, data] of Object.entries(files)) fs.addFile(j(SRC, rel), data, 0o644, 7n);
  const manifest: CopyManifest = { version: 1, createdAt: 0, sourceWorktreeId: null, sourceRoot: SRC, repoKey: null, token: "t", rows: [], files: [] };
  for (const rel of rels) {
    const st = await fs.lstat(j(SRC, rel)).catch(() => null);
    manifest.rows.push({ id: rel, path: rel, isDirectory: false, fileIndexes: [manifest.files.length], fileCount: 1, bytes: Number(st?.size ?? 0n), disabledReason: null });
    manifest.files.push({ path: rel, rowId: rel, size: String(st?.size ?? 0n), mtimeNs: String(st?.mtimeNs ?? 0n), dev: String(st?.dev ?? 1n), ino: String(st?.ino ?? 0n) });
  }
  const run = (ids = rels, opts: Parameters<typeof copyFromManifest>[3] = {}) => copyFromManifest(manifest, ids, DST, { fs, listTracked: async () => [], platform: "linux", ...opts });
  return { fs, manifest, run };
}
const reasons = (o: CopyOutcome) => o.results.map((r) => (r.outcome === "skipped" ? r.reason : "copied"));

describe("copy engine with a fake fs (AC 8)", () => {
  it("copies bytes exactly, creating parents one level at a time, with exclusive create", async () => {
    const { fs, run } = await setup({ ".env": "A=1\n", "cfg/deep/x.json": "{}" });
    const out = await run();
    expect(out.status).toBe("done");
    expect(out.totals).toEqual({ copied: 2, skipped: 0, bytes: 6 });
    expect(fs.read(j(DST, ".env"))!.toString()).toBe("A=1\n");
    expect(fs.read(j(DST, "cfg/deep/x.json"))!.toString()).toBe("{}");
    for (const o of fs.opens.filter((x) => x.path.startsWith(DST))) {
      expect(o.flags & C.O_EXCL).toBe(C.O_EXCL);
      expect(o.flags & C.O_CREAT).toBe(C.O_CREAT);
    }
  });

  it("refuses unsafe names on every platform without touching the filesystem", async () => {
    const bad = ["../x", "a/../b", ".git/config", "NUL.txt", "a:b", "x.", "PROGRA~1/f", "a\u202eb", "C:\\x", "a\nb"];
    const { fs, run } = await setup({}, bad);
    const out = await run();
    expect(reasons(out)).toEqual(bad.map(() => "unsafe-path"));
    expect(fs.opens).toEqual([]);
    expect(out.totals.copied).toBe(0);
  });

  it("refuses ids that are not in the manifest, and rows that are disabled", async () => {
    const { manifest, run } = await setup({ "a.log": "1" });
    manifest.rows.push({ id: "sub/", path: "sub/", isDirectory: true, fileIndexes: [], fileCount: 0, bytes: 0, disabledReason: "nested-repository" });
    const out = await run(["../../etc/passwd", "src/a.txt", "sub/", "a.log"]);
    expect(reasons(out)).toEqual(["not-in-manifest", "not-in-manifest", "row-disabled", "copied"]);
  });

  it("skips a faked source symlink and never follows or opens it", async () => {
    const { fs, run } = await setup({ ".env": "x" });
    fs.addFile(path.resolve("/mem/secret"), SENTINEL);
    // after review the file is replaced by a link to the secret
    fs.nodes.delete(path.resolve(j(SRC, ".env")).toLowerCase() === path.resolve(j(SRC, ".env")) ? path.resolve(j(SRC, ".env")) : "");
    fs.addLink(j(SRC, ".env"), path.resolve("/mem/secret"));
    const out = await run();
    expect(reasons(out)).toEqual(["source-symlink"]);
    expect(fs.opens.some((o) => o.path === j(SRC, ".env"))).toBe(false);
    expect(fs.exists(j(DST, ".env"))).toBe(false);
  });

  it("a symlinked source PARENT directory is refused", async () => {
    const { fs, run } = await setup({ "d/x": "x" });
    fs.nodes.delete(path.resolve(j(SRC, "d")));
    fs.nodes.delete(path.resolve(j(SRC, "d/x")));
    fs.addFile(path.join(OUT, "x"), SENTINEL);
    fs.addLink(j(SRC, "d"), OUT);
    const out = await run();
    expect(reasons(out)).toEqual(["source-parent-link"]);
    expect(fs.written.size).toBe(0);
  });

  it("a file swapped for a link between lstat and open is refused (link followed on Windows only to a changed file)", async () => {
    const { fs, run } = await setup({ ".env": "x" });
    fs.addFile(path.resolve("/mem/secret"), SENTINEL);
    fs.onOpen = (p) => {
      if (p === j(SRC, ".env")) {
        fs.nodes.delete(path.resolve(p));
        fs.addLink(p, path.resolve("/mem/secret"));
      }
    };
    const out = await run();
    expect(["source-symlink", "changed-since-review"]).toContain(reasons(out)[0]);
    expect(fs.exists(j(DST, ".env"))).toBe(false);
  });

  it("a file changed after review is skipped 'changed since you reviewed'", async () => {
    const { fs, run } = await setup({ "a.log": "one" });
    fs.addFile(j(SRC, "a.log"), "two!", 0o644, 8n);
    const out = await run();
    expect(reasons(out)).toEqual(["changed-since-review"]);
    const r = out.results[0]!;
    expect(r.outcome === "skipped" && r.message).toBe("changed since you reviewed");
  });

  it("a file that grows while streaming is cut off and its partial copy removed", async () => {
    const { fs, run } = await setup({ "a.log": "x".repeat(10) });
    fs.onRead = () => {
      const n = fs.nodes.get(path.resolve(j(SRC, "a.log")));
      if (n?.type === "file" && n.data.length === 10) n.data = Buffer.concat([n.data, Buffer.from("more")]);
    };
    const out = await run();
    expect(reasons(out)).toEqual(["changed-since-review"]);
    expect(fs.exists(j(DST, "a.log"))).toBe(false);
  });

  it("never overwrites and never overwrites a tracked file; reports both", async () => {
    const { fs, run } = await setup({ "keep.log": "new", "t.txt": "src" });
    fs.addFile(j(DST, "keep.log"), "existing");
    const out = await run(undefined, { listTracked: async () => ["t.txt"] });
    expect(reasons(out)).toEqual(["already-exists", "tracked-in-destination"]);
    expect(fs.read(j(DST, "keep.log"))!.toString()).toBe("existing");
  });

  it("skips case and Unicode-normalisation collisions, and a tracked link used as a parent (symlink-via-case)", async () => {
    const { fs, run } = await setup({ "Doc.TXT": "1", "link/x": "2", "caf\u00e9.log": "3", "cafe\u0301.log": "4", "A.log": "5", "a.LOG": "6" });
    const out = await run(undefined, { listTracked: async () => ["doc.txt", "Link"] });
    expect(reasons(out)).toEqual(["tracked-in-destination", "case-collision", "copied", "case-collision", "copied", "case-collision"]);
    expect(fs.exists(j(DST, "link"))).toBe(false);
  });

  it("writes zero bytes through a destination parent that is a link", async () => {
    const { fs, run } = await setup({ ".cache/x": "payload" });
    fs.addLink(j(DST, ".cache"), OUT);
    const out = await run();
    expect(reasons(out)).toEqual(["destination-parent-link"]);
    expect(fs.written.size).toBe(0);
    expect(fs.exists(path.join(OUT, "x"))).toBe(false);
  });

  it("removes a file it created when the parent resolves elsewhere after the open (junction swap), before any byte", async () => {
    const { fs, run } = await setup({ "d/x": "payload" });
    fs.realpathOverride = (p) => (p === path.dirname(j(DST, "d/x")) ? OUT : undefined);
    const out = await run();
    expect(reasons(out)).toEqual(["destination-parent-link"]);
    expect(fs.written.size).toBe(0);
    expect(fs.exists(j(DST, "d/x"))).toBe(false);
  });

  it("masks the mode to 0o777: never setuid/setgid, a 0600 file stays 0600", async () => {
    const { fs, run } = await setup({ "a.sh": "x", ".env": "y" });
    for (const [rel, mode] of [["a.sh", 0o6755], [".env", 0o600]] as const) {
      const n = fs.nodes.get(path.resolve(j(SRC, rel)));
      if (n?.type === "file") n.mode = mode;
    }
    await run();
    const mode = (rel: string) => fs.opens.find((o) => o.path === j(DST, rel))!.mode;
    expect(mode("a.sh")).toBe(0o755);
    expect(mode(".env")).toBe(0o600);
  });

  it("enforces the file budget, the byte budget (while streaming) and reports the rest", async () => {
    const a = await setup({ "1.log": "a", "2.log": "b", "3.log": "c" });
    const files = await a.run(undefined, { limits: { maxFiles: 2 } });
    expect(files.status).toBe("limit");
    expect(reasons(files)).toEqual(["copied", "copied", "file-limit"]);

    const b = await setup({ "1.log": "x".repeat(100), "2.log": "y".repeat(100) });
    const bytes = await b.run(undefined, { limits: { maxBytes: 150 } });
    expect(bytes.status).toBe("limit");
    expect(reasons(bytes)).toEqual(["copied", "size-limit"]);
    expect(b.fs.exists(j(DST, "2.log"))).toBe(false);

    // the manifest lies about the size: the streamed count still stops it
    const c = await setup({ "big.log": "z".repeat(100) });
    c.manifest.files[0]!.size = "10";
    const lie = await c.run();
    expect(reasons(lie)).toEqual(["changed-since-review"]);
    expect(c.fs.exists(j(DST, "big.log"))).toBe(false);
  });

  it("stops at the time budget (fake clock) and on cancel; progress only after 2 s", async () => {
    let t = 0;
    const now = () => t;
    const s = await setup({ "1.log": "a", "2.log": "b", "3.log": "c" });
    s.fs.onRead = () => (t += 40_000);
    const timed = await s.run(undefined, { now, limits: { maxMs: 60_000 } });
    expect(reasons(timed)).toEqual(["copied", "time-limit", "time-limit"]);
    expect(timed.status).toBe("limit");

    t = 0;
    const p = await setup({ "1.log": "a", "2.log": "b", "3.log": "c" });
    const calls: number[] = [];
    p.fs.onRead = () => (t += 900);
    await p.run(undefined, { now, onProgress: (x) => calls.push(x.filesDone) });
    expect(calls.length).toBeGreaterThan(0);
    const early = await setup({ "1.log": "a" });
    t = 0;
    const none: number[] = [];
    await early.run(undefined, { now, onProgress: () => none.push(1) });
    expect(none).toEqual([]);

    const c = await setup({ "1.log": "a", "2.log": "b" });
    const ac = new AbortController();
    c.fs.onRead = () => ac.abort();
    const out = await c.run(undefined, { signal: ac.signal });
    expect(out.status).toBe("cancelled");
    expect(reasons(out)).toEqual(["cancelled", "cancelled"]);
    expect(c.fs.exists(j(DST, "1.log"))).toBe(false);
  });

  it("refuses a destination that is not a worktree folder, or is the source", async () => {
    const { fs, manifest } = await setup({ "a.log": "x" });
    const base = { fs, listTracked: async () => [] as string[] };
    expect((await copyFromManifest(manifest, ["a.log"], SRC, base)).status).toBe("refused");
    fs.mkdirp(path.resolve("/mem/empty"));
    expect(await copyFromManifest(manifest, ["a.log"], path.resolve("/mem/empty"), base)).toMatchObject({ status: "refused", reason: "destination-invalid" });
    expect(await copyFromManifest(manifest, ["a.log"], path.resolve("/mem/none"), base)).toMatchObject({ status: "refused" });
  });

  it("applies the Windows path-length rule when the platform is win32", async () => {
    const long = `${"d".repeat(100)}/${"e".repeat(100)}/${"f".repeat(50)}.log`;
    const { run } = await setup({ [long]: "x" });
    expect(reasons(await run(undefined, { platform: "win32" }))).toEqual(["path-too-long"]);
  });

  it("never puts file content or raw error text in any result", async () => {
    const { fs, run } = await setup({ ".env": SENTINEL });
    fs.failWrite = new Error(`disk said ${SENTINEL}`);
    const out = await run();
    expect(reasons(out)).toEqual(["write-failed"]);
    expect(JSON.stringify(out)).not.toContain(SENTINEL);
    expect(fs.exists(j(DST, ".env"))).toBe(false);
    const ok = await (await setup({ ".env": SENTINEL })).run();
    expect(JSON.stringify(ok)).not.toContain(SENTINEL);
  });
});
