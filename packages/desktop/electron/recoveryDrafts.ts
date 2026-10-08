// SPDX-License-Identifier: GPL-3.0-or-later
import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { invalidPathReason, MAX_EDITABLE_FILE_BYTES } from "@githydra/git-core";
import { MAX_EDIT_PATH_CHARS } from "../shared/ipcContract";

/**
 * specs/edit-recovery-draft.md FR-541..548, FR-555: main-process store for unsaved-edit drafts under
 * `<userData>/recovery-drafts/<repoKey>/<fileKey>.json`. Callers pass only hashes and a validated repo-relative path, and
 * nothing here ever follows a symlink/junction or deletes recursively. No method throws and no result carries a path or
 * content. Policy: the caller writes only while the buffer differs from its base text and deletes when it is clean
 * (FR-545); the store cannot judge "dirty" because it never sees the base text.
 */

export const DRAFT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const MAX_TOTAL_BYTES = 50 * 1024 * 1024;
export const MAX_DRAFT_COUNT = 200;
export const STALE_TMP_MS = 60 * 60 * 1000;
/** Sanity limit, not the content cap: worst-case JSON escaping is 6x (control chars become \u00XX) plus metadata. Content is separately held to the editable cap. */
export const MAX_RECORD_BYTES = MAX_EDITABLE_FILE_BYTES * 6 + 4096;

const HEX64 = /^[0-9a-f]{64}$/;
const DRAFT_FILE = /^([0-9a-f]{64})\.json$/;
const TMP_FILE = /^[0-9a-f]{64}\.[0-9a-f]+\.tmp$/;

export type DraftEol = "lf" | "crlf" | "mixed";
export interface DraftFields {
  content: string;
  bom: boolean;
  eol: DraftEol;
  finalNewline: boolean;
  expectedHash: string;
}
export interface DraftRecord extends DraftFields {
  version: 1;
  relativePath: string;
  savedAt: number;
}
export interface DraftMeta {
  relativePath: string;
  savedAt: number;
  size: number;
}

export type StoreCode = "invalid" | "content-too-large" | "io";
export type StoreResult<T> = { ok: true; data: T } | { ok: false; code: StoreCode };
export type WriteOutcome = { status: "saved"; savedAt: number } | { status: "superseded" };

const sha256 = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");

/** FR-542: separators normalized and lowercased on Windows (case-insensitive volumes); `realRoot` must already be a realpath. */
export function computeRepoKey(realRoot: string, platform: string = process.platform): string {
  let p = platform === "win32" ? realRoot.replace(/\\/g, "/") : realRoot;
  // realpath.native may return the \\?\ form on Windows; the same folder must hash identically either way.
  if (platform === "win32") p = p.startsWith("//?/UNC/") ? `//${p.slice(8)}` : p.startsWith("//?/") ? p.slice(4) : p;
  while (p.length > 1 && p.endsWith("/")) p = p.slice(0, -1);
  if (platform === "win32") p = p.toLowerCase();
  return sha256(p);
}

export function computeFileKey(repoKey: string, relativePath: string): string {
  return sha256(`${repoKey}\0${relativePath}`);
}

/**
 * FR-554: the canonical stored form of a repo-relative path, or null when it is not acceptable (empty, NUL, too long,
 * absolute, drive-relative, any "", "." or ".." segment, `.git` internals, Windows stream/device names).
 */
export function normalizeDraftRelativePath(value: unknown, platform: string = process.platform): string | null {
  if (typeof value !== "string" || value === "" || value.length > MAX_EDIT_PATH_CHARS || value.includes("\0")) return null;
  if (path.posix.isAbsolute(value) || path.win32.isAbsolute(value)) return null;
  const rel = platform === "win32" ? value.replace(/\\/g, "/") : value;
  for (const seg of rel.split(/[\\/]/)) if (seg === "" || seg === "." || seg === "..") return null;
  if (invalidPathReason(rel, platform) !== null) return null;
  return rel;
}

const contentBytes = (f: Pick<DraftFields, "content" | "bom">): number => Buffer.byteLength(f.content, "utf8") + (f.bom ? 3 : 0);

function isDraftFields(o: Record<string, unknown>): boolean {
  return (
    typeof o.content === "string" &&
    typeof o.bom === "boolean" &&
    (o.eol === "lf" || o.eol === "crlf" || o.eol === "mixed") &&
    typeof o.finalNewline === "boolean" &&
    typeof o.expectedHash === "string" &&
    HEX64.test(o.expectedHash)
  );
}

type Loaded =
  | { kind: "ok"; record: DraftRecord }
  | { kind: "missing" }
  | { kind: "bad" } // corrupt, oversized, unknown version, or not this file's own key: safe to delete
  | { kind: "unsafe" }; // not a regular file or unreadable: never read, never deleted

function parseRecord(text: string, repoKey: string, fileKey: string, platform: string): DraftRecord | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (o.version !== 1 || !isDraftFields(o)) return null;
  const rel = normalizeDraftRelativePath(o.relativePath, platform);
  if (rel === null || rel !== o.relativePath || computeFileKey(repoKey, rel) !== fileKey) return null;
  if (typeof o.savedAt !== "number" || !Number.isFinite(o.savedAt) || o.savedAt < 0) return null;
  const f = o as unknown as DraftFields;
  if (contentBytes(f) > MAX_EDITABLE_FILE_BYTES) return null;
  return { version: 1, relativePath: rel, content: f.content, bom: f.bom, eol: f.eol, finalNewline: f.finalNewline, expectedHash: f.expectedHash, savedAt: o.savedAt };
}

const errCode = (e: unknown): string | undefined => (e as { code?: string } | null)?.code;

async function isRealDir(p: string): Promise<boolean> {
  try {
    const st = await fs.lstat(p);
    return st.isDirectory() && !st.isSymbolicLink();
  } catch {
    return false;
  }
}

/** A planted symlink/junction (or file) in place of a directory must make the write fail, never be written through. */
async function ensureRealDir(p: string): Promise<void> {
  try {
    await fs.mkdir(p, { mode: 0o700 });
    return;
  } catch (e) {
    if (errCode(e) !== "EEXIST") throw e;
  }
  if (!(await isRealDir(p))) throw new Error("unsafe");
}

async function removeRegular(file: string): Promise<boolean> {
  try {
    const st = await fs.lstat(file);
    if (!st.isFile()) return false;
    await fs.unlink(file);
    return true;
  } catch {
    return false;
  }
}

async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.rename(from, to);
      return;
    } catch (e) {
      // Windows reports a briefly-open target (AV scanner, indexer) as EPERM/EBUSY.
      if (attempt >= 3 || (errCode(e) !== "EPERM" && errCode(e) !== "EBUSY" && errCode(e) !== "EACCES")) throw e;
      await new Promise((r) => setTimeout(r, 15 * (attempt + 1)));
    }
  }
}

interface KeyState {
  tail: Promise<void>;
  version: number;
  pending: number;
}

export interface RecoveryDraftStoreOptions {
  /** The `recovery-drafts` directory itself (`<userData>/recovery-drafts`). */
  root: string;
  now?: () => number;
  platform?: string;
}

export class RecoveryDraftStore {
  private readonly root: string;
  private readonly now: () => number;
  private readonly platform: string;
  private readonly keys = new Map<string, KeyState>();
  private purging: Promise<void> | null = null;
  private evictTail: Promise<void> = Promise.resolve();

  constructor(opts: RecoveryDraftStoreOptions) {
    this.root = opts.root;
    this.now = opts.now ?? Date.now;
    this.platform = opts.platform ?? process.platform;
  }

  private state(fileKey: string): KeyState {
    let st = this.keys.get(fileKey);
    if (!st) {
      st = { tail: Promise.resolve(), version: 0, pending: 0 };
      this.keys.set(fileKey, st);
    }
    return st;
  }

  /** Per-fileKey FIFO. The tail swallows rejections so one failed task never wedges the key. */
  private run<T>(fileKey: string, fn: () => Promise<T>): Promise<T> {
    const st = this.state(fileKey);
    st.pending++;
    const p = st.tail.then(fn);
    st.tail = p.then(
      () => undefined,
      () => undefined,
    );
    void st.tail.then(() => {
      if (--st.pending === 0 && this.keys.get(fileKey) === st) this.keys.delete(fileKey);
    });
    return p;
  }

  private dirOf(repoKey: string): string {
    return path.join(this.root, repoKey);
  }
  private fileOf(repoKey: string, fileKey: string): string {
    return path.join(this.root, repoKey, `${fileKey}.json`);
  }

  private async load(file: string, repoKey: string, fileKey: string): Promise<Loaded> {
    let lst;
    try {
      lst = await fs.lstat(file);
    } catch (e) {
      return errCode(e) === "ENOENT" ? { kind: "missing" } : { kind: "unsafe" };
    }
    if (!lst.isFile()) return { kind: "unsafe" };
    if (lst.size > MAX_RECORD_BYTES) return { kind: "bad" };
    let handle;
    try {
      handle = await fs.open(file, "r");
    } catch {
      return { kind: "unsafe" };
    }
    try {
      const st = await handle.stat();
      if (!st.isFile()) return { kind: "unsafe" };
      if (st.size > MAX_RECORD_BYTES) return { kind: "bad" };
      const buf = Buffer.alloc(st.size + 1); // st.size is already capped above, so a file that grows mid-read just fails to parse
      const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
      if (bytesRead > MAX_RECORD_BYTES) return { kind: "bad" };
      const record = parseRecord(buf.toString("utf8", 0, bytesRead), repoKey, fileKey, this.platform);
      return record ? { kind: "ok", record } : { kind: "bad" };
    } catch {
      return { kind: "unsafe" };
    } finally {
      await handle.close().catch(() => undefined);
    }
  }

  private expired(r: DraftRecord): boolean {
    return this.now() - r.savedAt > DRAFT_TTL_MS;
  }

  private target(repoKey: unknown, relativePath: unknown): { rel: string; repoKey: string; fileKey: string } | null {
    if (typeof repoKey !== "string" || !HEX64.test(repoKey)) return null;
    const rel = normalizeDraftRelativePath(relativePath, this.platform);
    return rel === null ? null : { rel, repoKey, fileKey: computeFileKey(repoKey, rel) };
  }

  /** FR-545. See `WriteOutcome`: a write skipped because a newer write or a delete was issued after it reports "superseded". */
  async write(repoKeyIn: string, relativePath: string, fields: DraftFields): Promise<StoreResult<WriteOutcome>> {
    const t = this.target(repoKeyIn, relativePath);
    if (!t || !isDraftFields(fields as unknown as Record<string, unknown>)) return { ok: false, code: "invalid" };
    if (contentBytes(fields) > MAX_EDITABLE_FILE_BYTES) return { ok: false, code: "content-too-large" };
    const st = this.state(t.fileKey);
    const myVersion = ++st.version;
    const result = await this.run(t.fileKey, async (): Promise<StoreResult<WriteOutcome>> => {
      if (st.version !== myVersion) return { ok: true, data: { status: "superseded" } };
      const savedAt = this.now();
      const record: DraftRecord = {
        version: 1,
        relativePath: t.rel,
        content: fields.content,
        bom: fields.bom,
        eol: fields.eol,
        finalNewline: fields.finalNewline,
        expectedHash: fields.expectedHash,
        savedAt,
      };
      const json = JSON.stringify(record);
      if (Buffer.byteLength(json, "utf8") > MAX_RECORD_BYTES) return { ok: false, code: "content-too-large" };
      try {
        await this.atomicWrite(t.repoKey, t.fileKey, json);
      } catch {
        return { ok: false, code: "io" };
      }
      return { ok: true, data: { status: "saved", savedAt } };
    });
    // Outside the per-key task: eviction queues behind other keys' tasks, so running it inside one could deadlock.
    if (result.ok && result.data.status === "saved") await this.enforceCaps(this.fileOf(t.repoKey, t.fileKey));
    return result;
  }

  private async atomicWrite(repoKey: string, fileKey: string, json: string): Promise<void> {
    const finalPath = this.fileOf(repoKey, fileKey);
    // A concurrent purge may remove the just-created (empty) repo dir, so one retry on ENOENT.
    for (let attempt = 0; ; attempt++) {
      await fs.mkdir(path.dirname(this.root), { recursive: true });
      await ensureRealDir(this.root);
      await ensureRealDir(this.dirOf(repoKey));
      const tmp = path.join(this.dirOf(repoKey), `${fileKey}.${randomBytes(6).toString("hex")}.tmp`);
      try {
        const h = await fs.open(tmp, "wx", 0o600);
        try {
          await h.writeFile(json, "utf8");
          await h.sync().catch(() => undefined);
        } finally {
          await h.close();
        }
        await renameWithRetry(tmp, finalPath);
        return;
      } catch (e) {
        await removeRegular(tmp);
        if (attempt === 0 && errCode(e) === "ENOENT") continue;
        throw e;
      }
    }
  }

  /** FR-546: idempotent. Outranks any write issued before it that has not started yet. */
  async delete(repoKeyIn: string, relativePath: string): Promise<StoreResult<void>> {
    const t = this.target(repoKeyIn, relativePath);
    if (!t) return { ok: false, code: "invalid" };
    this.state(t.fileKey).version++;
    return this.run(t.fileKey, async (): Promise<StoreResult<void>> => {
      const file = this.fileOf(t.repoKey, t.fileKey);
      try {
        const lst = await fs.lstat(file);
        if (lst.isFile()) await fs.unlink(file);
        // A symlink/directory under a draft name is not ours to remove.
      } catch (e) {
        if (errCode(e) !== "ENOENT") return { ok: false, code: "io" };
      }
      return { ok: true, data: undefined };
    });
  }

  /** FR-555: null for missing, expired, corrupt or unsafe; corrupt/expired records are removed silently. */
  async read(repoKeyIn: string, relativePath: string): Promise<StoreResult<DraftRecord | null>> {
    const t = this.target(repoKeyIn, relativePath);
    if (!t) return { ok: false, code: "invalid" };
    return this.run(t.fileKey, async (): Promise<StoreResult<DraftRecord | null>> => {
      const file = this.fileOf(t.repoKey, t.fileKey);
      const l = await this.load(file, t.repoKey, t.fileKey);
      if (l.kind === "ok") {
        if (!this.expired(l.record)) return { ok: true, data: l.record };
        await removeRegular(file);
      } else if (l.kind === "bad") await removeRegular(file);
      return { ok: true, data: null };
    });
  }

  /** FR-549: purges first (FR-547), then returns this repo's drafts newest first, metadata only. */
  async list(repoKeyIn: string): Promise<StoreResult<DraftMeta[]>> {
    if (typeof repoKeyIn !== "string" || !HEX64.test(repoKeyIn)) return { ok: false, code: "invalid" };
    await this.purge();
    const dir = this.dirOf(repoKeyIn);
    if (!(await isRealDir(this.root)) || !(await isRealDir(dir))) return { ok: true, data: [] };
    let names: string[];
    try {
      names = await fs.readdir(dir);
    } catch {
      return { ok: true, data: [] };
    }
    const out: DraftMeta[] = [];
    for (const name of names) {
      const m = DRAFT_FILE.exec(name);
      if (!m) continue;
      const fileKey = m[1]!;
      const l = await this.run(fileKey, () => this.load(path.join(dir, name), repoKeyIn, fileKey));
      if (l.kind === "ok" && !this.expired(l.record)) {
        out.push({ relativePath: l.record.relativePath, savedAt: l.record.savedAt, size: Buffer.byteLength(l.record.content, "utf8") });
      }
    }
    out.sort((a, b) => b.savedAt - a.savedAt || (a.relativePath < b.relativePath ? -1 : 1));
    return { ok: true, data: out };
  }

  /** FR-547/FR-555: shares one in-flight run; never rejects. */
  purge(): Promise<void> {
    this.purging ??= this.doPurge().finally(() => {
      this.purging = null;
    });
    return this.purging;
  }

  private async doPurge(): Promise<void> {
    try {
      if (!(await isRealDir(this.root))) return;
      for (const name of await fs.readdir(this.root)) {
        if (!HEX64.test(name)) continue;
        const dir = path.join(this.root, name);
        if (!(await isRealDir(dir))) continue;
        await this.purgeRepoDir(name, dir).catch(() => undefined);
      }
    } catch {
      // Quiet by design (FR-548): a purge failure is retried at the next start or list.
    }
  }

  private async purgeRepoDir(repoKey: string, dir: string): Promise<void> {
    for (const name of await fs.readdir(dir)) {
      const file = path.join(dir, name);
      const m = DRAFT_FILE.exec(name);
      if (m) {
        const fileKey = m[1]!;
        // Decided inside the per-key queue so a purge can never delete a draft written after it was read.
        await this.run(fileKey, async () => {
          const l = await this.load(file, repoKey, fileKey);
          if (l.kind === "bad" || (l.kind === "ok" && this.expired(l.record))) await removeRegular(file);
        }).catch(() => undefined);
      } else if (TMP_FILE.test(name)) {
        try {
          const st = await fs.lstat(file);
          if (st.isFile() && this.now() - st.mtimeMs > STALE_TMP_MS) await fs.unlink(file);
        } catch {
          // Gone or locked: next purge.
        }
      }
    }
    // rmdir (never recursive) only succeeds on an empty directory.
    if ((await fs.readdir(dir)).length === 0) await fs.rmdir(dir).catch(() => undefined);
  }

  /** FR-547: oldest `savedAt` first until within 50 MB and 200 drafts; never `protectedFile`. Serialized so two writes never double-evict. */
  private enforceCaps(protectedFile: string): Promise<void> {
    const task = this.evictTail.then(() => this.evict(protectedFile)).catch(() => undefined);
    this.evictTail = task;
    return task;
  }

  private async evict(protectedFile: string): Promise<void> {
    interface Entry {
      file: string;
      repoKey: string;
      fileKey: string;
      size: number;
      mtimeMs: number;
    }
    const entries: Entry[] = [];
    if (!(await isRealDir(this.root))) return;
    for (const repoKey of await fs.readdir(this.root)) {
      const dir = path.join(this.root, repoKey);
      if (!HEX64.test(repoKey) || !(await isRealDir(dir))) continue;
      for (const name of await fs.readdir(dir)) {
        const m = DRAFT_FILE.exec(name);
        if (!m) continue;
        const file = path.join(dir, name);
        const st = await fs.lstat(file).catch(() => null);
        if (st?.isFile()) entries.push({ file, repoKey, fileKey: m[1]!, size: st.size, mtimeMs: st.mtimeMs });
      }
    }
    let total = entries.reduce((n, e) => n + e.size, 0);
    let count = entries.length;
    if (count <= MAX_DRAFT_COUNT && total <= MAX_TOTAL_BYTES) return;
    const dated: Array<Entry & { savedAt: number }> = [];
    for (const e of entries) {
      const l = await this.load(e.file, e.repoKey, e.fileKey);
      dated.push({ ...e, savedAt: l.kind === "ok" ? l.record.savedAt : 0 });
    }
    dated.sort((a, b) => a.savedAt - b.savedAt || a.mtimeMs - b.mtimeMs || (a.file < b.file ? -1 : 1));
    for (const e of dated) {
      if (count <= MAX_DRAFT_COUNT && total <= MAX_TOTAL_BYTES) break;
      if (e.file === protectedFile) continue;
      // Re-checked inside the key's queue: a rewrite since the scan changes mtime, so a fresh save is never unlinked.
      const removed = await this.run(e.fileKey, async () => {
        const now = await fs.lstat(e.file).catch(() => null);
        return now?.isFile() && now.mtimeMs === e.mtimeMs ? removeRegular(e.file) : false;
      });
      if (removed) {
        count--;
        total -= e.size;
      }
    }
  }
}
