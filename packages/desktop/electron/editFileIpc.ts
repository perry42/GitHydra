// SPDX-License-Identifier: GPL-3.0-or-later
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  EditFileAccessError,
  EditWriteError,
  InvalidArgumentError,
  type EditProbeResult,
  type EditReadResult,
  type WriteEditedFileOptions,
  type WriteEditedFileResult,
} from "@githydra/git-core";
import {
  MAX_EDIT_CONTENT_CHARS,
  MAX_EDIT_PATH_CHARS,
  type EditIpcFailureCode,
  type EditIpcResult,
  type WriteEditedFileIpcOptions,
} from "../shared/ipcContract";

/**
 * specs/edit-in-diff.md FR-471/FR-474/FR-536: main-process side of the three edit-file channels. The renderer is
 * untrusted, so every field is re-checked here and rebuilt, and failures leave as a closed code plus fixed text.
 */

export interface EditFileRepo {
  getState(): { workdir?: string | null };
  probeEditableFile(path: string): Promise<EditProbeResult>;
  readEditableFile(path: string): Promise<EditReadResult>;
  writeEditedFile(path: string, content: string, options: WriteEditedFileOptions): Promise<WriteEditedFileResult>;
}

const MESSAGES: Record<EditIpcFailureCode, string> = {
  "invalid-argument": "That file or save request was not accepted.",
  "no-repository": "No repository is open.",
  "read-only": "The file is read-only.",
  "content-too-large": "The text is over the 1 MB editing limit.",
  "contains-nul": "The text contains a NUL character.",
  "invalid-content": "The text is not valid Unicode.",
  io: "The file system reported an error while saving.",
  access: "The file could not be accessed.",
  internal: "Something went wrong.",
};

const failure = (code: EditIpcFailureCode): { ok: false; code: EditIpcFailureCode; message: string } => ({ ok: false, code, message: MESSAGES[code] });

class NoRepositoryError extends Error {}

/** Never forwards `err.message`: git-core's own texts embed the repo-relative path and the renderer adds nothing by seeing them. */
export function mapEditError(err: unknown): { ok: false; code: EditIpcFailureCode; message: string } {
  if (err instanceof NoRepositoryError) return failure("no-repository");
  if (err instanceof EditWriteError) return failure(err.code);
  if (err instanceof EditFileAccessError) return failure("access");
  if (err instanceof InvalidArgumentError) return failure("invalid-argument");
  return failure("internal");
}

export function pickEditPath(value: unknown): string {
  if (typeof value !== "string") throw new InvalidArgumentError("path must be a string.");
  if (value === "" || value.length > MAX_EDIT_PATH_CHARS || value.includes("\0")) throw new InvalidArgumentError("path is not acceptable.");
  return value;
}

export function pickEditContent(value: unknown): string {
  if (typeof value !== "string") throw new InvalidArgumentError("content must be a string.");
  if (value.length > MAX_EDIT_CONTENT_CHARS) throw new EditWriteError("", "content-too-large", "the text is over the 1 MB editing limit");
  return value;
}

const HASH = /^[0-9a-f]{64}$/;

/** Rebuilt field by field; unknown keys are dropped, never forwarded. */
export function pickWriteOptions(value: unknown): WriteEditedFileIpcOptions {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new InvalidArgumentError("options must be an object.");
  const o = value as Record<string, unknown>;
  if (typeof o.expectedHash !== "string" || !HASH.test(o.expectedHash)) throw new InvalidArgumentError("expectedHash is not valid.");
  if (o.eol !== "lf" && o.eol !== "crlf" && o.eol !== "mixed") throw new InvalidArgumentError("eol is not valid.");
  if (typeof o.hasBom !== "boolean") throw new InvalidArgumentError("hasBom must be a boolean.");
  if (typeof o.finalNewline !== "boolean") throw new InvalidArgumentError("finalNewline must be a boolean.");
  if (o.force !== undefined && typeof o.force !== "boolean") throw new InvalidArgumentError("force must be a boolean.");
  return { expectedHash: o.expectedHash, eol: o.eol, hasBom: o.hasBom, finalNewline: o.finalNewline, ...(o.force === true ? { force: true } : {}) };
}

const SELF_WRITE_TTL_MS = 5000;
const MAX_SELF_WRITES = 64;
const MTIME_TOLERANCE_MS = 1;

export interface SelfWriteStat {
  mtimeMs: number;
  size: number;
}

async function statForSelfWrite(abs: string): Promise<SelfWriteStat | null> {
  try {
    const st = await fs.stat(abs, { bigint: true });
    return { mtimeMs: Number(st.mtimeNs) / 1e6, size: Number(st.size) };
  } catch {
    return null;
  }
}

/**
 * specs/edit-in-diff.md FR-536 (with specs/self-write-refresh-suppression.md): remembers files GitHydra just saved so the
 * work-tree watcher's echo of that save is dropped. Matching on the saved mtime and size, within a short window, means a
 * later outside edit of the same file still gets through.
 */
export class SelfWriteRegistry {
  private entries = new Map<string, SelfWriteStat & { at: number }>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly stat: (abs: string) => Promise<SelfWriteStat | null> = statForSelfWrite,
    private readonly caseInsensitive: boolean = process.platform === "win32" || process.platform === "darwin",
  ) {}

  private key(workdir: string, rel: string): string {
    const abs = path.resolve(workdir, rel);
    return this.caseInsensitive ? abs.toLowerCase() : abs;
  }

  record(workdir: string, rel: string, written: SelfWriteStat): void {
    const k = this.key(workdir, rel);
    this.entries.delete(k);
    this.entries.set(k, { mtimeMs: written.mtimeMs, size: written.size, at: this.now() });
    while (this.entries.size > MAX_SELF_WRITES) this.entries.delete(this.entries.keys().next().value as string);
  }

  /** True only when every reported path is a still-current self-write; anything else (truncated, unknown, changed since) is a real change. */
  async coversChange(workdir: string, change: { paths: readonly string[]; truncated: boolean }): Promise<boolean> {
    if (change.truncated || change.paths.length === 0) return false;
    for (const rel of change.paths) {
      const k = this.key(workdir, rel);
      const entry = this.entries.get(k);
      if (!entry) return false;
      if (this.now() - entry.at > SELF_WRITE_TTL_MS) {
        this.entries.delete(k);
        return false;
      }
      const cur = await this.stat(path.resolve(workdir, rel));
      if (!cur || cur.size !== entry.size || Math.abs(cur.mtimeMs - entry.mtimeMs) > MTIME_TOLERANCE_MS) {
        this.entries.delete(k);
        return false;
      }
    }
    return true;
  }
}

export function createEditFileHandlers(getRepo: () => EditFileRepo, selfWrites: SelfWriteRegistry) {
  const run = async <T>(work: () => Promise<T>): Promise<EditIpcResult<T>> => {
    try {
      return { ok: true, data: await work() };
    } catch (err) {
      return mapEditError(err);
    }
  };
  const repo = (): EditFileRepo => {
    try {
      return getRepo();
    } catch {
      throw new NoRepositoryError();
    }
  };
  return {
    probe: (rel: unknown) =>
      run(async () => {
        const p = pickEditPath(rel);
        return repo().probeEditableFile(p);
      }),
    read: (rel: unknown) =>
      run(async () => {
        const p = pickEditPath(rel);
        return repo().readEditableFile(p);
      }),
    write: (rel: unknown, content: unknown, options: unknown) =>
      run(async () => {
        const p = pickEditPath(rel);
        const text = pickEditContent(content);
        const opts = pickWriteOptions(options);
        const r = repo();
        const result = await r.writeEditedFile(p, text, opts);
        const workdir = r.getState().workdir;
        if (result.status === "written" && workdir) selfWrites.record(workdir, p, { mtimeMs: result.mtimeMs, size: result.size });
        return result;
      }),
  };
}
