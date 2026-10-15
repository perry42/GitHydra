// SPDX-License-Identifier: GPL-3.0-or-later
import type { WorktreeList, WorktreeVerification } from "@githydra/git-core";
import {
  PROGRAM_ID_RE,
  type AddProgramResult,
  type LaunchTarget,
  type LaunchProgramResult,
  type ProgramRefusal,
  type ProgramsSnapshot,
  type SimpleProgramResult,
} from "../shared/programsContract";
import type { ProgramsService } from "./programs/programsService";

/** What the launch IPC needs from the session's open repository (never a renderer-supplied path). */
export interface ProgramsRepo {
  getState(): { workdir: string | null; isBare: boolean };
  listWorktrees(): Promise<WorktreeList>;
  verifyRegisteredWorktree(id: string): Promise<WorktreeVerification>;
}

const refuse = (reason: ProgramRefusal["reason"], message: string): ProgramRefusal => ({ ok: false, reason, message });
const WORKTREE_ID_RE = /^[^\\/\0]{1,255}$/;

/**
 * specs/external-programs.md FR-642: the launch request is `{ programId, target }` and nothing else. Any extra key (an `exe`, a
 * `folder`, a `path`, a `cwd`, `args`) refuses the whole request, so a renderer cannot smuggle a path in next to valid ids.
 */
export function parseLaunchRequest(req: unknown): { programId: string; target: LaunchTarget } | ProgramRefusal {
  if (typeof req !== "object" || req === null || Array.isArray(req)) return refuse("invalid-request", "The request is not valid.");
  const r = req as Record<string, unknown>;
  const keys = Object.keys(r);
  if (keys.length !== 2 || !keys.includes("programId") || !keys.includes("target")) return refuse("invalid-request", "The request is not valid.");
  if (typeof r.programId !== "string" || !PROGRAM_ID_RE.test(r.programId)) return refuse("invalid-request", "That program id is not valid.");
  const t = r.target;
  if (typeof t !== "object" || t === null || Array.isArray(t)) return refuse("invalid-request", "The target is not valid.");
  const target = t as Record<string, unknown>;
  const tkeys = Object.keys(target);
  if (tkeys.length !== 1) return refuse("invalid-request", "The target is not valid.");
  if (tkeys[0] === "worktreeId" && typeof target.worktreeId === "string" && WORKTREE_ID_RE.test(target.worktreeId) && target.worktreeId !== "." && !target.worktreeId.includes("..")) {
    return { programId: r.programId, target: { worktreeId: target.worktreeId } };
  }
  if (tkeys[0] === "repoRoot" && target.repoRoot === true) return { programId: r.programId, target: { repoRoot: true } };
  if (tkeys[0] === "mainWorktree" && target.mainWorktree === true) return { programId: r.programId, target: { mainWorktree: true } };
  return refuse("invalid-request", "The target is not valid.");
}

export function createProgramsHandlers(service: ProgramsService, getRepo: () => ProgramsRepo) {
  /** main resolves the folder itself: a verified registered worktree, the main worktree, or the open repo's top level. */
  async function folderFor(target: LaunchTarget): Promise<string | null> {
    const repo = getRepo();
    if ("worktreeId" in target) {
      const v = await repo.verifyRegisteredWorktree(target.worktreeId);
      return v.trusted ? v.realPath : null;
    }
    if ("repoRoot" in target) {
      const s = repo.getState();
      return s.isBare ? null : s.workdir;
    }
    const list = await repo.listWorktrees();
    const main = list.entries[0];
    if (list.untrusted || !main || !main.isMain || main.isBare || list.mainPathIsGitDir) return null;
    return list.mainPath;
  }

  return {
    list: (): Promise<ProgramsSnapshot> => service.snapshot(),
    rescan: (): Promise<ProgramsSnapshot> => service.rescan(),
    add: (): Promise<AddProgramResult> => service.add(),
    locate: (id: unknown): Promise<AddProgramResult> => service.locate(id),
    confirmAdd: (pendingId: unknown): Promise<AddProgramResult> => service.confirmAdd(pendingId),
    remove: (id: unknown): Promise<SimpleProgramResult> => service.remove(id),
    setHidden: (id: unknown, hidden: unknown): Promise<SimpleProgramResult> => service.setHidden(id, hidden),
    setDefault: (id: unknown): Promise<SimpleProgramResult> => service.setDefault(id),

    async launch(req: unknown): Promise<LaunchProgramResult> {
      const parsed = parseLaunchRequest(req);
      if ("ok" in parsed) return parsed;
      try {
        getRepo();
      } catch {
        return refuse("no-repository", "Open a repository first.");
      }
      return service.launch(parsed.programId, async () => {
        try {
          return await folderFor(parsed.target);
        } catch {
          return null;
        }
      });
    },
  };
}

export type ProgramsHandlers = ReturnType<typeof createProgramsHandlers>;
