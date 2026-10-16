// SPDX-License-Identifier: GPL-3.0-or-later
import { createHash, randomUUID } from "node:crypto";
import {
  GITHYDRA_TAB_ID,
  PROGRAM_ID_RE,
  type AddProgramResult,
  type LaunchProgramResult,
  type ProgramRefusal,
  type ProgramRefusalReason,
  type ProgramsSnapshot,
  type ProgramView,
  type SimpleProgramResult,
} from "../../shared/programsContract";
import { detectPrograms } from "./detect";
import { checkProgramPath, leafName, PROBLEM_TEXT, type RuleEnv } from "./exeRules";
import { resolveLaunchFolder } from "./folderRules";
import { launchProcess, type SpawnFn } from "./launcher";
import { MAX_CUSTOM_PROGRAMS, type CustomProgramRecord, type ProgramStore } from "./programStore";
import type { DetectedProgram } from "./types";

export interface ProgramsServiceDeps {
  store: ProgramStore;
  env: RuleEnv;
  home: string;
  spawnFn: SpawnFn;
  /** The main-side native picker (FR-642): the ONLY source of an Add/Locate path. Resolves null when cancelled. */
  pickFile(): Promise<string | null>;
  /** Injected for tests. */
  newPendingId?: () => string;
  now?: () => number;
}

interface Entry {
  id: string;
  name: string;
  exe: string;
  kind: "exe" | "app";
  source: "detected" | "custom";
  confirmedRisk: boolean;
}

interface Pending {
  id: string;
  exe: string;
  /** Set for Locate: the id whose path is being replaced. */
  replaces: string | null;
  at: number;
}

const PENDING_TTL_MS = 5 * 60 * 1000;
const refuse = (reason: ProgramRefusalReason, message: string): ProgramRefusal => ({ ok: false, reason, message });
const UNSAFE_TEXT = "It is inside a repository or a folder anyone can write to, so GitHydra will not start it.";

/** FR-642 ids for hand-added programs: stable per path, never a path themselves. */
function customId(exe: string, platform: string): string {
  const key = platform === "win32" ? exe.toLowerCase() : exe;
  return `usr-${createHash("sha1").update(key).digest("hex").slice(0, 12)}`;
}

function displayNameOf(exe: string): string {
  const leaf = leafName(exe).replace(/\.(exe|app)$/i, "");
  return (leaf || "Program").slice(0, 80);
}

/**
 * specs/external-programs.md FR-617..625, 642: the one place that owns program records, the detection cache and every launch. Nothing
 * here accepts an exe or a folder from the renderer: it receives ids, plus a folder callback that main itself provides.
 */
export function createProgramsService(deps: ProgramsServiceDeps) {
  const { store, env } = deps;
  const now = deps.now ?? Date.now;
  const newPendingId = deps.newPendingId ?? randomUUID;
  // One shared in-flight detection: concurrent list calls must not each scan, and none may read the records before it ends.
  let detecting: Promise<DetectedProgram[]> | null = null;
  let pending: Pending | null = null;

  function ensureDetected(): Promise<DetectedProgram[]> {
    // Cached until Rescan or app start (FR-621).
    return (detecting ??= detectPrograms(env));
  }

  async function entries(): Promise<{ list: Entry[]; records: Awaited<ReturnType<ProgramStore["read"]>> }> {
    const found = await ensureDetected();
    // Read AFTER the (possibly slow) detection: a program added meanwhile must not be missing from this answer.
    const records = await store.read();
    const byId = new Map<string, Entry>();
    for (const d of found) {
      byId.set(d.id, { id: d.id, name: d.name, exe: d.exe, kind: d.kind, source: "detected", confirmedRisk: false });
    }
    for (const c of records.custom) {
      byId.set(c.id, {
        id: c.id,
        name: c.name,
        exe: c.exe,
        kind: env.platform === "darwin" && c.exe.toLowerCase().endsWith(".app") ? "app" : "exe",
        source: "custom",
        confirmedRisk: c.confirmedRisk === true,
      });
    }
    return { list: [...byId.values()], records };
  }

  /** Re-run at EVERY snapshot and launch, not only at save (FR-642). */
  async function availability(e: Entry): Promise<{ available: boolean; reason: string | null; resolved: string | null; kind: "exe" | "app" }> {
    const check = await checkProgramPath(e.exe, env);
    if (!check.ok) {
      return { available: false, reason: check.problem === "missing" ? `Not found at ${e.exe}` : PROBLEM_TEXT[check.problem], resolved: null, kind: e.kind };
    }
    if (check.risk && !(e.source === "custom" && e.confirmedRisk)) {
      return { available: false, reason: UNSAFE_TEXT, resolved: check.resolved, kind: check.kind };
    }
    return { available: true, reason: null, resolved: check.resolved, kind: check.kind };
  }

  async function snapshot(): Promise<ProgramsSnapshot> {
    const { list, records } = await entries();
    const hidden = new Set(records.hidden);
    const programs: ProgramView[] = [];
    for (const e of list) {
      const a = await availability(e);
      programs.push({
        id: e.id,
        name: e.name,
        path: e.exe,
        resolvedPath: a.resolved && a.resolved !== e.exe ? a.resolved : null,
        source: e.source,
        hidden: hidden.has(e.id),
        available: a.available,
        unavailableReason: a.reason,
        isDefault: false,
      });
    }
    programs.sort((a, b) => a.name.localeCompare(b.name));
    const stored = records.defaultId;
    let defaultId: string | null = null;
    let fallbackReason: string | null = null;
    if (stored === GITHYDRA_TAB_ID) defaultId = GITHYDRA_TAB_ID;
    else if (stored !== null) {
      const p = programs.find((x) => x.id === stored);
      if (p && p.available) {
        defaultId = p.id;
        p.isDefault = true;
      } else {
        defaultId = GITHYDRA_TAB_ID;
        fallbackReason = `${p ? p.name : "Your default program"} was not found, so GitHydra tab is used instead.`;
        if (p) p.isDefault = true;
      }
    }
    return { programs, defaultId, fallbackReason };
  }

  async function save(mutate: (r: Awaited<ReturnType<ProgramStore["read"]>>) => void): Promise<void> {
    const records = await store.read();
    mutate(records);
    await store.write(records);
  }

  async function findProgram(id: unknown): Promise<{ entry: Entry } | ProgramRefusal> {
    if (typeof id !== "string" || !PROGRAM_ID_RE.test(id)) return refuse("invalid-request", "That program id is not valid.");
    const entry = (await entries()).list.find((e) => e.id === id);
    return entry ? { entry } : refuse("unknown-program", "That program is not in the list.");
  }

  async function validatePicked(exe: string): Promise<{ ok: true; kind: "exe" | "app"; risk: "repository" | "world-writable" | null } | Extract<AddProgramResult, { status: "rejected" }>> {
    const check = await checkProgramPath(exe, env);
    if (!check.ok) return { status: "rejected", problem: check.problem, message: PROBLEM_TEXT[check.problem] };
    return { ok: true, kind: check.kind, risk: check.risk };
  }

  async function commit(exe: string, confirmedRisk: boolean, replaces: string | null): Promise<AddProgramResult> {
    const { list, records } = await entries();
    const replaced = replaces ? list.find((e) => e.id === replaces) : undefined;
    const id = replaced ? replaced.id : customId(exe, env.platform);
    if (!replaced && list.some((e) => e.id === id)) return refuse("already-added", "That program is already in the list.");
    if (!replaced && records.custom.length >= MAX_CUSTOM_PROGRAMS) return refuse("invalid-request", "Too many programs have been added. Remove one first.");
    const record: CustomProgramRecord = { id, name: replaced?.name ?? displayNameOf(exe), exe, ...(confirmedRisk ? { confirmedRisk: true } : {}) };
    await save((r) => {
      r.custom = [...r.custom.filter((c) => c.id !== id), record];
    });
    const view = (await snapshot()).programs.find((p) => p.id === id);
    return view ? { status: "added", program: view } : refuse("unknown-program", "That program is not in the list.");
  }

  async function pickAndStage(replaces: string | null): Promise<AddProgramResult> {
    const picked = await deps.pickFile();
    if (!picked) return { status: "cancelled" };
    const v = await validatePicked(picked);
    if (!("ok" in v)) return v;
    if (v.risk) {
      // A hand-added program in such a place is a trust decision the user makes with the full path in front of them.
      pending = { id: newPendingId(), exe: picked, replaces, at: now() };
      return { status: "needs-confirm", pendingId: pending.id, path: picked, why: v.risk };
    }
    return commit(picked, false, replaces);
  }

  return {
    snapshot,

    async rescan(): Promise<ProgramsSnapshot> {
      detecting = null;
      return snapshot();
    },

    add: () => pickAndStage(null),

    async locate(id: unknown): Promise<AddProgramResult> {
      const found = await findProgram(id);
      if ("ok" in found) return found;
      return pickAndStage(found.entry.id);
    },

    async confirmAdd(pendingId: unknown): Promise<AddProgramResult> {
      const p = pending;
      pending = null;
      if (!p || typeof pendingId !== "string" || p.id !== pendingId || now() - p.at > PENDING_TTL_MS) {
        return refuse("confirm-expired", "That confirmation expired. Add the program again.");
      }
      // The file may have changed while the dialog was open: every rule is re-run before it is saved.
      const v = await validatePicked(p.exe);
      if (!("ok" in v)) return v;
      return commit(p.exe, v.risk !== null, p.replaces);
    },

    async remove(id: unknown): Promise<SimpleProgramResult> {
      const found = await findProgram(id);
      if ("ok" in found) return found;
      if (found.entry.source !== "custom") return refuse("invalid-request", "Detected programs can be hidden, not removed.");
      const handAdded = found.entry.id.startsWith("usr-");
      await save((r) => {
        r.custom = r.custom.filter((c) => c.id !== found.entry.id);
        // A located override reverts to the detected entry; a hand-added program disappears entirely.
        if (handAdded) {
          r.hidden = r.hidden.filter((h) => h !== found.entry.id);
          if (r.defaultId === found.entry.id) r.defaultId = null;
        }
      });
      return { ok: true, snapshot: await snapshot() };
    },

    async setHidden(id: unknown, hidden: unknown): Promise<SimpleProgramResult> {
      if (typeof hidden !== "boolean") return refuse("invalid-request", "hidden must be true or false.");
      const found = await findProgram(id);
      if ("ok" in found) return found;
      const records = await store.read();
      if (hidden && records.defaultId === found.entry.id) return refuse("default-cannot-hide", "The default program cannot be hidden. Choose another default first.");
      await save((r) => {
        const set = new Set(r.hidden);
        if (hidden) set.add(found.entry.id);
        else set.delete(found.entry.id);
        r.hidden = [...set];
      });
      return { ok: true, snapshot: await snapshot() };
    },

    async setDefault(id: unknown): Promise<SimpleProgramResult> {
      if (id === GITHYDRA_TAB_ID) {
        await save((r) => {
          r.defaultId = GITHYDRA_TAB_ID;
        });
        return { ok: true, snapshot: await snapshot() };
      }
      const found = await findProgram(id);
      if ("ok" in found) return found;
      const records = await store.read();
      if (records.hidden.includes(found.entry.id)) return refuse("hidden", "Show that program first to make it the default.");
      await save((r) => {
        r.defaultId = found.entry.id;
      });
      return { ok: true, snapshot: await snapshot() };
    },

    /**
     * FR-622/FR-642. `resolveFolder` is main's own derivation (a verified worktree or the open repo's top level); it may still
     * fail, and its answer is checked again here. The program's rules are re-run now, not trusted from save time.
     */
    async launch(programId: unknown, resolveFolder: () => Promise<string | null>): Promise<LaunchProgramResult> {
      const found = await findProgram(programId);
      if ("ok" in found) return found;
      const e = found.entry;
      const a = await availability(e);
      if (!a.available) {
        const unsafe = a.reason === UNSAFE_TEXT;
        return refuse(unsafe ? "unsafe-location" : a.reason?.startsWith("Not found") ? "not-found" : "refused-program", `${e.name}: ${a.reason?.startsWith("Not found") ? "the program was not found." : (a.reason ?? "it cannot be started.")}`);
      }
      const candidate = await resolveFolder();
      const folder = candidate === null ? null : await resolveLaunchFolder(candidate, env);
      if (folder === null) return refuse("folder-not-allowed", "That folder cannot be opened: it is not a worktree or repository GitHydra has verified.");
      const records = await store.read();
      const wasDefault = records.defaultId === e.id;
      const res = await launchProcess({ exe: e.exe, kind: a.kind, folder, platform: env.platform, home: deps.home, env: env.env, spawnFn: deps.spawnFn });
      if (!res.ok) {
        return refuse(res.reason === "spawn-failed" ? "spawn-failed" : "folder-not-allowed", res.reason === "spawn-failed" ? `${e.name} could not be started.` : "That folder cannot be opened.");
      }
      // Default = last used (FR-617): one stored value.
      await save((r) => {
        r.defaultId = e.id;
      });
      return { ok: true, programName: e.name, wasDefault };
    },

    /** The built-in GitHydra tab is also "last used"; the renderer reports it here so the one stored default stays right. */
    noteTabUsed: () =>
      save((r) => {
        r.defaultId = GITHYDRA_TAB_ID;
      }),
  };
}

export type ProgramsService = ReturnType<typeof createProgramsService>;
