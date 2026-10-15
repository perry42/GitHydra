// SPDX-License-Identifier: GPL-3.0-or-later
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  defaultWorktreePath,
  InvalidArgumentError,
  type AddWorktreeResult,
  type AddWorktreeSource,
  type BranchMergeState,
  type DestinationCheck,
  type PostCheckoutHookInfo,
  type PruneWorktreeResult,
  type RemoveWorktreeAndDeleteBranchResult,
  type RemoveWorktreeResult,
  type WorktreeList,
  type WorktreeRemovalState,
  type WorktreeVerification,
} from "@githydra/git-core";
import type { AddWorktreeIpcRequest, RemoveWorktreeIpcRequest, WorktreeSetupHints } from "../shared/ipcContract";
import { detectWorktreeSetup } from "../shared/worktreeSetup";

/**
 * specs/worktrees.md FR-601..605, 632/633, 639..641, 644: main-process side of the worktree channels. The repository is always
 * the session's open repo (never a renderer path), every argument is rebuilt here, and this slice never forwards a hook option:
 * a post-checkout hook is detected but not run (FR-644 consent is a later step).
 */
export interface WorktreeRepo {
  listWorktrees(): Promise<WorktreeList>;
  validateWorktreeDestination(destination: string): Promise<DestinationCheck>;
  detectPostCheckoutHook(): Promise<PostCheckoutHookInfo>;
  addWorktree(destination: string, source: AddWorktreeSource): Promise<AddWorktreeResult>;
  verifyRegisteredWorktree(id: string): Promise<WorktreeVerification>;
  getWorktreeRemovalState(id: string): Promise<WorktreeRemovalState>;
  getBranchMergeState(branch: string): Promise<BranchMergeState>;
  removeWorktree(id: string | null, options: RemoveOpts): Promise<RemoveWorktreeResult>;
  removeWorktreeAndDeleteBranch(
    id: string,
    options: RemoveOpts & { expectedMerged?: boolean },
  ): Promise<RemoveWorktreeAndDeleteBranchResult>;
  pruneWorktree(id: string, options?: { acceptAlsoForgotten?: readonly string[] }): Promise<PruneWorktreeResult>;
}

interface RemoveOpts {
  confirmedPath: string;
  force?: boolean;
  expectedCount?: number;
  expectedSubmodules?: readonly string[];
}

const MAX_TEXT = 4096;
const MAX_SUBMODULES = 200;
const MAX_SUBMODULE_CHARS = 1024;
const MAX_ACCEPTED_IDS = 200;

function pickText(value: unknown, name: string): string {
  if (typeof value !== "string" || value === "" || value.length > MAX_TEXT || value.includes("\0")) {
    throw new InvalidArgumentError(`${name} is not acceptable.`);
  }
  return value;
}

/** A worktree id is an admin-directory name: never a path (defence in depth, specs/worktrees.md FR-641). */
function pickId(value: unknown, name = "id"): string {
  const id = pickText(value, name);
  if (/[\\/]/.test(id) || id.includes("..")) throw new InvalidArgumentError(`${name} is not acceptable.`);
  return id;
}

/** Rebuilt from known fields only; anything else (a `runPostCheckoutHook`, extra keys) is dropped. */
export function pickWorktreeSource(raw: unknown): AddWorktreeSource {
  const r = (raw ?? {}) as Record<string, unknown>;
  switch (r.kind) {
    case "branch":
      return { kind: "branch", branch: pickText(r.branch, "branch") };
    case "newBranch":
      return { kind: "newBranch", branch: pickText(r.branch, "branch"), startPoint: pickText(r.startPoint, "startPoint") };
    case "detached":
      return { kind: "detached", commit: pickText(r.commit, "commit") };
    case "remoteBranch":
      return { kind: "remoteBranch", remote: pickText(r.remote, "remote"), branch: pickText(r.branch, "branch") };
    default:
      throw new InvalidArgumentError("source is not a valid value.");
  }
}

/** The numbers the user was shown. Anything malformed is dropped (git-core then refuses a force with `expectationRequired`). */
function pickExpectation(r: Record<string, unknown>): { expectedCount?: number; expectedSubmodules?: string[] } {
  const out: { expectedCount?: number; expectedSubmodules?: string[] } = {};
  if (typeof r.expectedCount === "number" && Number.isSafeInteger(r.expectedCount) && r.expectedCount >= 0) out.expectedCount = r.expectedCount;
  const subs = r.expectedSubmodules;
  if (Array.isArray(subs) && subs.length <= MAX_SUBMODULES && subs.every((s) => typeof s === "string" && s.length <= MAX_SUBMODULE_CHARS)) {
    out.expectedSubmodules = [...(subs as string[])];
  }
  return out;
}

function pickRemoval(req: unknown): { id: string; confirmedPath: string; force: boolean; expectedMerged?: boolean; expectedCount?: number; expectedSubmodules?: string[] } {
  const r = (req ?? {}) as Record<string, unknown>;
  return {
    ...pickExpectation(r),
    id: pickId(r.id),
    confirmedPath: pickText(r.confirmedPath, "confirmedPath"),
    // Only an explicit `true` forces; git-core still refuses it for locked and main.
    force: r.force === true,
    ...(typeof r.expectedMerged === "boolean" ? { expectedMerged: r.expectedMerged } : {}),
  };
}

/** Regular files only: a symlink planted as `package.json` is never followed. */
async function regularFileExists(dir: string, name: string): Promise<boolean> {
  try {
    return (await fs.lstat(path.join(dir, name))).isFile();
  } catch {
    return false;
  }
}

const expectationOf = (r: { expectedCount?: number; expectedSubmodules?: string[] }) => ({
  ...(r.expectedCount !== undefined ? { expectedCount: r.expectedCount } : {}),
  ...(r.expectedSubmodules !== undefined ? { expectedSubmodules: r.expectedSubmodules } : {}),
});

export function createWorktreeHandlers(getRepo: () => WorktreeRepo) {
  return {
    list: () => getRepo().listWorktrees(),

    async defaultPath(branchName: unknown): Promise<string> {
      const branch = pickText(branchName, "branchName");
      const list = await getRepo().listWorktrees();
      const probe = defaultWorktreePath({ mainWorktreePath: list.mainPath, branchName: branch });
      const existing = await fs.readdir(path.dirname(probe)).catch(() => [] as string[]);
      return defaultWorktreePath({ mainWorktreePath: list.mainPath, branchName: branch, existingNames: existing });
    },

    validateDestination: async (destination: unknown) => getRepo().validateWorktreeDestination(pickText(destination, "destination")),

    async hook(): Promise<{ present: boolean }> {
      return { present: (await getRepo().detectPostCheckoutHook()).present };
    },

    async add(req: unknown): Promise<AddWorktreeResult> {
      const r = (req ?? {}) as Partial<AddWorktreeIpcRequest>;
      // No options argument at all: git-core's default is "no hook can run" (FR-638).
      return getRepo().addWorktree(pickText(r.destination, "destination"), pickWorktreeSource(r.source));
    },

    verify: (id: unknown) => getRepo().verifyRegisteredWorktree(pickId(id)),

    async setupHints(id: unknown): Promise<WorktreeSetupHints> {
      const v = await getRepo().verifyRegisteredWorktree(pickId(id));
      if (!v.trusted) return { dependency: null, hasSubmodules: false };
      const names = new Set<string>();
      for (const name of ["package.json", "package-lock.json", "yarn.lock", "pnpm-lock.yaml", "pyproject.toml", "Cargo.toml", "go.mod", "Gemfile", "composer.json", ".gitmodules"]) {
        if (await regularFileExists(v.realPath, name)) names.add(name);
      }
      return detectWorktreeSetup(names);
    },

    removalState: (id: unknown) => getRepo().getWorktreeRemovalState(pickId(id)),

    mergeState: (branch: unknown) => getRepo().getBranchMergeState(pickText(branch, "branch")),

    async remove(req: unknown): Promise<RemoveWorktreeResult> {
      const r = pickRemoval(req);
      return getRepo().removeWorktree(r.id, { confirmedPath: r.confirmedPath, force: r.force, ...expectationOf(r) });
    },

    async removeAndDeleteBranch(req: unknown): Promise<RemoveWorktreeAndDeleteBranchResult> {
      const r = pickRemoval(req);
      return getRepo().removeWorktreeAndDeleteBranch(r.id, {
        confirmedPath: r.confirmedPath,
        force: r.force,
        ...expectationOf(r),
        ...(r.expectedMerged !== undefined ? { expectedMerged: r.expectedMerged } : {}),
      });
    },

    async prune(id: unknown, accept: unknown): Promise<PruneWorktreeResult> {
      const ids: string[] = [];
      if (accept !== undefined) {
        if (!Array.isArray(accept) || accept.length > MAX_ACCEPTED_IDS) throw new InvalidArgumentError("acceptAlsoForgotten is not acceptable.");
        for (const a of accept) ids.push(pickText(a, "acceptAlsoForgotten"));
      }
      return getRepo().pruneWorktree(pickId(id), { acceptAlsoForgotten: ids });
    },
  };
}
