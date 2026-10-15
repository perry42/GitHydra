// SPDX-License-Identifier: GPL-3.0-or-later
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { PROGRAM_ID_RE } from "../../shared/programsContract";

/**
 * specs/external-programs.md FR-642: the program records live in a main-process file under userData, never in renderer storage
 * (a compromised renderer must not be able to register `C:\x\evil.exe`). Read defensively, written atomically, capped.
 */
export interface CustomProgramRecord {
  id: string;
  name: string;
  /** Absolute; an `.app` bundle on macOS. */
  exe: string;
  /** The user confirmed a program that sits inside a repository, a worktree or a world-writable folder (FR-642). */
  confirmedRisk?: boolean;
}

export interface ProgramRecords {
  version: 1;
  /** A program id or the GitHydra-tab id; null until the first choice. */
  defaultId: string | null;
  hidden: string[];
  custom: CustomProgramRecord[];
}

export const MAX_CUSTOM_PROGRAMS = 50;
export const MAX_HIDDEN_IDS = 200;
const MAX_PATH_CHARS = 1024;
const MAX_NAME_CHARS = 80;
const FILE_NAME = "external-programs.json";
const MAX_FILE_BYTES = 256 * 1024;

export const emptyRecords = (): ProgramRecords => ({ version: 1, defaultId: null, hidden: [], custom: [] });

const isId = (v: unknown): v is string => typeof v === "string" && PROGRAM_ID_RE.test(v);

/** Anything malformed is dropped field by field: a damaged file never blocks the app and never widens what is trusted. */
export function validateRecords(raw: unknown): ProgramRecords {
  const out = emptyRecords();
  if (typeof raw !== "object" || raw === null) return out;
  const r = raw as Record<string, unknown>;
  if (isId(r.defaultId)) out.defaultId = r.defaultId;
  if (Array.isArray(r.hidden)) out.hidden = [...new Set(r.hidden.filter(isId))].slice(0, MAX_HIDDEN_IDS);
  if (Array.isArray(r.custom)) {
    const seen = new Set<string>();
    for (const item of r.custom) {
      if (out.custom.length >= MAX_CUSTOM_PROGRAMS) break;
      if (typeof item !== "object" || item === null) continue;
      const c = item as Record<string, unknown>;
      if (!isId(c.id) || seen.has(c.id)) continue;
      if (typeof c.exe !== "string" || c.exe === "" || c.exe.length > MAX_PATH_CHARS || c.exe.includes("\0")) continue;
      if (typeof c.name !== "string" || c.name.trim() === "") continue;
      seen.add(c.id);
      out.custom.push({
        id: c.id,
        name: c.name.slice(0, MAX_NAME_CHARS),
        exe: c.exe,
        ...(c.confirmedRisk === true ? { confirmedRisk: true } : {}),
      });
    }
  }
  return out;
}

export interface ProgramStore {
  read(): Promise<ProgramRecords>;
  write(records: ProgramRecords): Promise<void>;
}

export function createFileProgramStore(dir: string): ProgramStore {
  const file = path.join(dir, FILE_NAME);
  // Serialised: two quick writes must not interleave their temp files.
  let queue: Promise<unknown> = Promise.resolve();
  return {
    async read() {
      try {
        const st = await fs.stat(file);
        if (!st.isFile() || st.size > MAX_FILE_BYTES) return emptyRecords();
        return validateRecords(JSON.parse(await fs.readFile(file, "utf8")));
      } catch {
        return emptyRecords();
      }
    },
    write(records) {
      const next = queue.then(async () => {
        const clean = validateRecords(records);
        await fs.mkdir(dir, { recursive: true });
        const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
        await fs.writeFile(tmp, JSON.stringify(clean, null, 2), "utf8");
        await fs.rename(tmp, file);
      });
      queue = next.catch(() => undefined);
      return next;
    },
  };
}
