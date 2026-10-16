// SPDX-License-Identifier: GPL-3.0-or-later
import { realpath as realpathCb } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  defaultWorktreePath,
  type AddWorktreeOptions,
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
import type { HookBoxRequest } from "./hookConfirmBox";
import type { HookDeclinedResult, WorktreeHookChoice, WorktreeHookInfo, WorktreeSetupHints } from "../shared/ipcContract";
import { detectWorktreeSetup } from "../shared/worktreeSetup";
import { computeRepoKey } from "./recoveryDrafts";
import type { HookTrustStore } from "./worktreeHookTrust";

/**
 * specs/worktrees.md FR-601..605, 632/633, 639..641, 644: main-process side of the worktree channels. The repository is always
 * the session's open repo (never a renderer path) and every argument is rebuilt here. A hook runs only when main itself builds
 * the options from the user's "run" choice (FR-644); the renderer has no field that reaches `runPostCheckoutHook`.
 */
export interface WorktreeRepo {
  listWorktrees(): Promise<WorktreeList>;
  validateWorktreeDestination(destination: string): Promise<DestinationCheck>;
  detectPostCheckoutHook(): Promise<PostCheckoutHookInfo>;
  addWorktree(destination: string, source: AddWorktreeSource, options?: AddWorktreeOptions): Promise<AddWorktreeResult>;
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

/** Option names of git-core and trust claims the renderer must never send (FR-644). */
const FORBIDDEN_ADD_KEYS = ["runPostCheckoutHook", "expectedHookFingerprint", "options", "trusted", "trust", "remembered"] as const;

function pickHookChoice(value: unknown): WorktreeHookChoice | undefined {
  if (value === undefined) return undefined;
  if (value === "run" || value === "skip") return value;
  throw new InvalidArgumentError("hookChoice is not acceptable.");
}

const refusal = (reason: "hookChanged" | "hookFingerprintRequired" | "hooksPathRelative", message: string): AddWorktreeResult => ({
  ok: false,
  reason,
  message,
});

const nativeRealpath = (p: string): Promise<string> =>
  new Promise((resolve, reject) => realpathCb.native(p, (err, real) => (err ? reject(err) : resolve(real))));

export interface WorktreeIpcDeps {
  /** Without a store nothing is ever remembered or recalled (fail closed). */
  trust?: HookTrustStore;
  realpath?: (p: string) => Promise<string>;
  platform?: string;
  /**
   * FR-644: main's OWN native confirmation, the authority for "run" (the renderer dialog only explains). Asked unless a remembered
   * "run" matches the current fingerprint. Absent or throwing means declined (fail closed).
   */
  confirmRun?: (hook: HookBoxRequest) => Promise<{ accepted: boolean; remember: boolean }>;
}

export function createWorktreeHandlers(getRepo: () => WorktreeRepo, deps: WorktreeIpcDeps = {}) {
  const realpath = deps.realpath ?? nativeRealpath;
  /** At most one native hook box can be pending: a second create gets a typed refusal instead of stacking boxes (security L7). */
  let boxPending = false;

  /** The argument-less repo key (FR-629): the git common dir's realpath, so every worktree of a repo shares one record. */
  async function repoKey(): Promise<string> {
    const list = await getRepo().listWorktrees();
    return computeRepoKey(await realpath(list.commonDir), deps.platform ?? process.platform);
  }
  async function recalled(fingerprint: string): Promise<WorktreeHookChoice | null> {
    if (!deps.trust) return null;
    try {
      return await deps.trust.get(await repoKey(), fingerprint);
    } catch {
      return null;
    }
  }
  /** A choice made again for a changed hook replaces the old one: an old record must not come back when the hook reverts. */
  async function dropStale(fingerprint: string): Promise<void> {
    if (!deps.trust) return;
    try {
      await deps.trust.dropStale(await repoKey(), fingerprint);
    } catch {
      // Best effort: a stale record still never applies to a different fingerprint.
    }
  }
  /** Called only after a successful create. A failed write never fails the create that already happened. */
  async function remembers(choice: WorktreeHookChoice, fingerprint: string): Promise<void> {
    if (!deps.trust) return;
    try {
      await deps.trust.set(await repoKey(), { choice, fingerprint, at: Date.now() });
    } catch {
      // The worktree exists; the dialog simply asks again next time.
    }
  }

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

    /** FR-644: argument-less; the repository and the key both come from the session. */
    async hookInfo(): Promise<WorktreeHookInfo> {
      const info = await getRepo().detectPostCheckoutHook();
      if (!info.present) return { ...info, remembered: null };
      // A relative core.hooksPath can never be remembered (it resolves inside the NEW worktree).
      return { ...info, remembered: info.hooksPathRelative ? null : await recalled(info.fingerprint) };
    },

    async add(req: unknown): Promise<AddWorktreeResult | HookDeclinedResult> {
      const r = (req ?? {}) as Record<string, unknown>;
      // git-core's own option names or a "trusted" claim from the renderer are refused outright (FR-644).
      for (const key of FORBIDDEN_ADD_KEYS) if (key in r) throw new InvalidArgumentError(`${key} is not accepted.`);
      const destination = pickText(r.destination, "destination");
      const source = pickWorktreeSource(r.source);
      const choice = pickHookChoice(r.hookChoice);
      const remember = r.remember === true;
      const shown = typeof r.hookFingerprint === "string" && r.hookFingerprint !== "" ? r.hookFingerprint : null;
      // No choice, or Skip: no options argument at all, so git-core's default "no hook can run" applies (FR-638).
      if (choice === undefined) return getRepo().addWorktree(destination, source);
      if (choice === "skip") {
        const info = await getRepo().detectPostCheckoutHook().catch(() => null);
        if (info?.present && !info.hooksPathRelative) await dropStale(info.fingerprint);
        const result = await getRepo().addWorktree(destination, source);
        // A remembered skip is bound to the hook the user was shown: stored only if that is still the hook.
        if (result.ok && remember && shown !== null && info?.present && !info.hooksPathRelative && info.fingerprint === shown) {
          await remembers("skip", info.fingerprint);
        }
        return result;
      }
      // Run: re-detect, take the fingerprint from git-core ITSELF, and compare it with the one the user was shown.
      if (shown === null) return refusal("hookFingerprintRequired", "Running the hook needs the fingerprint that was shown to you.");
      const info = await getRepo().detectPostCheckoutHook();
      if (!info.present) return refusal("hookChanged", "The hook changed since it was shown. Review it again.");
      if (info.hooksPathRelative) return refusal("hooksPathRelative", "A relative core.hooksPath resolves inside the new worktree and cannot be consented to.");
      if (info.fingerprint !== shown) return refusal("hookChanged", "The hook changed since it was shown. Review it again.");
      // The native box is the authority (a compromised renderer can send "run" without anyone clicking). Only a remembered "run"
      // for this exact fingerprint stands in for it.
      let boxRemember = false;
      if ((await recalled(info.fingerprint)) !== "run") {
        if (boxPending) return { ok: false, reason: "busy", message: "Another hook confirmation is still open. Answer it first." };
        boxPending = true;
        let accepted = false;
        try {
          await dropStale(info.fingerprint);
          // The renderer's `remember` only pre-ticks the box; a remembered "run" is stored from the box's own checkbox (M1).
          const answer = await deps.confirmRun?.({ hookPath: info.hookPath, contentSha256: info.contentSha256, lineCount: info.previewLineCount, rememberRequested: remember, canRemember: !info.hooksPathRelative });
          accepted = answer?.accepted === true;
          boxRemember = accepted && answer?.remember === true;
        } catch {
          accepted = false;
        } finally {
          boxPending = false;
        }
        if (!accepted) return { ok: false, reason: "hookDeclined", message: "The hook was not run and no worktree was created." };
      }
      const result = await getRepo().addWorktree(destination, source, { runPostCheckoutHook: true, expectedHookFingerprint: info.fingerprint });
      if (result.ok && boxRemember) await remembers("run", info.fingerprint);
      return result;
    },

    verify: async (id: unknown) => getRepo().verifyRegisteredWorktree(pickId(id)),

    async setupHints(id: unknown): Promise<WorktreeSetupHints> {
      const v = await getRepo().verifyRegisteredWorktree(pickId(id));
      if (!v.trusted) return { dependency: null, hasSubmodules: false };
      const names = new Set<string>();
      for (const name of ["package.json", "package-lock.json", "yarn.lock", "pnpm-lock.yaml", "pyproject.toml", "Cargo.toml", "go.mod", "Gemfile", "composer.json", ".gitmodules"]) {
        if (await regularFileExists(v.realPath, name)) names.add(name);
      }
      return detectWorktreeSetup(names);
    },

    removalState: async (id: unknown) => getRepo().getWorktreeRemovalState(pickId(id)),

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
