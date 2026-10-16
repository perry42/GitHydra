// SPDX-License-Identifier: GPL-3.0-or-later
import { realpath as realpathCb } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  defaultWorktreePath,
  tagRow,
  COPY_SKIP_MESSAGES,
  type BuildManifestOptions,
  type BuildManifestResult,
  type CopyManifest,
  type CopyOptions,
  type CopyOutcome,
  type IgnoredCandidate,
  type IncludeResult,
  type ListIgnoredOptions,
  type ReadIncludeOptions,
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
import type {
  AddWorktreeIpcResult,
  HookDeclinedResult,
  WorktreeCopyCandidates,
  WorktreeCopyInclude,
  WorktreeCopyRequest,
  WorktreeCopyRow,
  WorktreeCopyResult,
  WorktreeHookChoice,
  WorktreeHookInfo,
  WorktreeSetupHints,
} from "../shared/ipcContract";
import { detectWorktreeSetup } from "../shared/worktreeSetup";
import { computeRepoKey } from "./recoveryDrafts";
import { createCopyTokenStore, type CopyTokenRefusal, type CopyTokenStore } from "./worktreeCopyTokens";
import type { HookTrustStore } from "./worktreeHookTrust";

/**
 * specs/worktrees.md FR-601..605, 632/633, 639..641, 644: main-process side of the worktree channels. The repository is always
 * the session's open repo (never a renderer path) and every argument is rebuilt here. A hook runs only when main itself builds
 * the options from the user's "run" choice (FR-644); the renderer has no field that reaches `runPostCheckoutHook`.
 */
export interface WorktreeRepo {
  /** The open repository's own worktree: the SOURCE of a copy (specs/worktree-copy-ignored.md FR-626). */
  readonly path: string;
  buildCopyManifest(sourceWorktreePath: string, options?: BuildManifestOptions): Promise<BuildManifestResult>;
  readWorktreeInclude(sourceWorktreePath: string, options?: ReadIncludeOptions & ListIgnoredOptions): Promise<IncludeResult>;
  copyFromManifest(manifest: CopyManifest, selectedRowIds: readonly string[], destinationWorktreePath: string, options?: CopyOptions): Promise<CopyOutcome>;
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
const FORBIDDEN_ADD_KEYS = [
  "runPostCheckoutHook",
  "expectedHookFingerprint",
  "options",
  "trusted",
  "trust",
  "remembered",
  // specs/worktree-copy-ignored.md FR-643: the manifest and every path stay in main; only `copy: {token, rowIds}` is accepted.
  "manifest",
  "sourcePath",
  "copyPaths",
  "paths",
] as const;

const MAX_COPY_IDS = 2000;
const MAX_COPY_ID_CHARS = 1024;
const MAX_TOKEN_CHARS = 256;
const SKIPPED_RETURNED = 20;

/** FR-643: strict plain-data shape; anything else (an extra key, a path-like object) is refused outright. */
export function pickCopyRequest(raw: unknown): WorktreeCopyRequest | null {
  if (raw === undefined) return null;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new InvalidArgumentError("copy is not acceptable.");
  const r = raw as Record<string, unknown>;
  for (const key of Object.keys(r)) if (key !== "token" && key !== "rowIds") throw new InvalidArgumentError("copy has an unexpected field.");
  if (typeof r.token !== "string" || r.token === "" || r.token.length > MAX_TOKEN_CHARS) throw new InvalidArgumentError("copy.token is not acceptable.");
  const ids = r.rowIds;
  if (!Array.isArray(ids) || ids.length > MAX_COPY_IDS) throw new InvalidArgumentError("copy.rowIds is not acceptable.");
  for (const id of ids) {
    if (typeof id !== "string" || id === "" || id.length > MAX_COPY_ID_CHARS) throw new InvalidArgumentError("copy.rowIds is not acceptable.");
  }
  return { token: r.token, rowIds: [...(ids as string[])] };
}

/** Fixed texts only (a raw error could carry a path). They complete "but nothing was copied: ...". */
const REFUSAL_MESSAGES: Record<CopyTokenRefusal, string> = {
  unknown: "the list of files was not available any more",
  expired: "the list of files expired",
  "other-repository": "the list of files belongs to another repository",
  "other-source": "the list of files belongs to another worktree",
  "destination-changed": "the folder changed after you reviewed",
  "selection-changed": "the selection changed after you reviewed",
  "not-bound": "the list of files was not available any more",
};

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
  /** specs/worktree-copy-ignored.md FR-643. Injectable so the clock can be faked. */
  copyTokens?: CopyTokenStore;
  /** Realpath of the NEW worktree after the add; the same flavour (`fs.realpath`) git-core's destination check reports. */
  destinationRealpath?: (p: string) => Promise<string>;
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

  /** A listing that finished after a newer one (or a release) started must not issue a token the renderer no longer holds. */
  let listSeq = 0;
  const tokens = deps.copyTokens ?? createCopyTokenStore(deps.platform ? { platform: deps.platform } : {});
  const destRealpath = deps.destinationRealpath ?? ((p: string) => fs.realpath(p));

  const refusedCopy = (message: string, from: string): WorktreeCopyResult => ({
    status: "refused",
    copied: 0,
    total: 0,
    bytes: 0,
    skipped: [],
    skippedTotal: 0,
    message,
    from,
  });

  function summarize(outcome: CopyOutcome, unknownIds: readonly string[], from: string): WorktreeCopyResult {
    if (outcome.status === "refused") {
      return refusedCopy(outcome.reason === "source-changed" ? "the source folder changed" : "the new worktree folder could not be verified", from);
    }
    const skipped: { path: string; reason: string; message: string }[] = [];
    for (const r of outcome.results) if (r.outcome === "skipped") skipped.push({ path: r.path, reason: r.reason, message: r.message });
    for (const id of unknownIds) skipped.push({ path: id, reason: "not-in-manifest", message: COPY_SKIP_MESSAGES["not-in-manifest"] });
    const copied = outcome.totals.copied;
    return {
      status: copied > 0 ? (skipped.length > 0 ? "partial" : "copied") : "nothing",
      copied,
      total: copied + skipped.length,
      bytes: outcome.totals.bytes,
      skipped: skipped.slice(0, SKIPPED_RETURNED),
      skippedTotal: skipped.length,
      ...(copied === 0 && skipped.length === 0 ? { message: "the chosen folders had no files" } : {}),
      from,
    };
  }

  /** FR-643: the optional copy after a SUCCESSFUL add; it never changes whether the add succeeded. */
  async function addWithCopy(destination: string, copy: WorktreeCopyRequest, run: () => Promise<AddWorktreeResult | HookDeclinedResult>): Promise<AddWorktreeIpcResult> {
    const repo = getRepo();
    const fallbackFrom = path.basename(repo.path);
    const ctx = { repoKey: await repoKey(), sourceRoot: repo.path };
    // FR-639 again, here: the copy is bound to the destination main validated itself, not to anything the renderer said.
    const check = await repo.validateWorktreeDestination(destination).catch(() => null);
    const bound = check?.ok ? tokens.bind(copy.token, ctx, check.realPath, copy.rowIds) : null;
    const result = await run();
    if (!result.ok) {
      tokens.unbind(copy.token);
      return result;
    }
    if (!check?.ok || bound === null || !bound.ok) {
      return { ...result, copy: refusedCopy(REFUSAL_MESSAGES[bound && !bound.ok ? bound.reason : "unknown"], fallbackFrom) };
    }
    const from = path.basename(bound.manifest.sourceRoot);
    if (result.warning) {
      tokens.release();
      return { ...result, copy: refusedCopy("git reported a problem while creating the worktree", from) };
    }
    let real: string;
    try {
      real = await destRealpath(result.path);
    } catch {
      tokens.release();
      return { ...result, copy: refusedCopy("the new worktree folder could not be verified", from) };
    }
    const used = tokens.consume(copy.token, ctx, real, copy.rowIds);
    if (!used.ok) return { ...result, copy: refusedCopy(REFUSAL_MESSAGES[used.reason], from) };
    const wanted = [...new Set(copy.rowIds)];
    const inManifest = new Set(used.manifest.rows.map((row) => row.id));
    try {
      const outcome = await repo.copyFromManifest(
        used.manifest,
        wanted.filter((id) => inManifest.has(id)),
        result.path,
      );
      return { ...result, copy: summarize(outcome, wanted.filter((id) => !inManifest.has(id)), from) };
    } catch {
      // Fixed text only: a raw error could carry a path or file content.
      return { ...result, copy: refusedCopy("the files could not be copied", from) };
    }
  }

  async function addCore(r: Record<string, unknown>): Promise<AddWorktreeResult | HookDeclinedResult> {
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
  }

  return {
    list: () => getRepo().listWorktrees(),

    /** FR-629: argument-less; a keyed call would be a realpath-existence oracle. */
    repoKey,

    /** FR-626/FR-643: lists in the open repo's own worktree, keeps the manifest here and returns rows plus a token. */
    async copyCandidates(): Promise<WorktreeCopyCandidates> {
      const repo = getRepo();
      const seq = ++listSeq;
      const key = await repoKey();
      const built = await repo.buildCopyManifest(repo.path, { repoKey: key });
      if (seq !== listSeq) return { status: "failed", reason: "cancelled" };
      if (built.status === "failed") return { status: "failed", reason: built.reason };
      const manifest = built.manifest;
      const rows: WorktreeCopyRow[] = manifest.rows.map((row) => {
        const base = { path: row.path, isDirectory: row.isDirectory, fileCount: row.fileCount, bytes: row.bytes, disabledReason: row.disabledReason };
        return { id: row.id, ...base, ...tagRow(base) };
      });
      let include: WorktreeCopyInclude = { status: "absent", matchedRows: [], skipped: [] };
      if (rows.length === 0) {
        tokens.release();
        return { status: "ok", token: "", bare: false, rows, include };
      }
      const candidates: IgnoredCandidate[] = rows.map((row) => ({ ...row, sizeComputed: row.disabledReason === null }));
      try {
        const inc = await repo.readWorktreeInclude(repo.path, { candidates });
        if (inc.status === "ok") {
          include = { status: "ok", matchedRows: inc.matchedRows, skipped: inc.skipped.map((s) => ({ line: s.line, pattern: s.pattern, reason: s.reason })) };
        } else if (inc.status !== "absent") include = { status: inc.status, matchedRows: [], skipped: [] };
      } catch {
        include = { status: "failed", matchedRows: [], skipped: [] };
      }
      if (seq !== listSeq) return { status: "failed", reason: "cancelled" };
      return { status: "ok", token: tokens.issue(manifest, key, repo.path), bare: false, rows, include };
    },

    /** FR-643: the dialog closed. */
    copyRelease(): void {
      listSeq++;
      tokens.release();
    },

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

    async add(req: unknown): Promise<AddWorktreeIpcResult> {
      const r = (req ?? {}) as Record<string, unknown>;
      // git-core's own option names or a "trusted" claim from the renderer are refused outright (FR-644).
      for (const key of FORBIDDEN_ADD_KEYS) if (key in r) throw new InvalidArgumentError(`${key} is not accepted.`);
      const copy = pickCopyRequest(r.copy);
      // Nothing selected: the plain path, the token is not touched.
      if (copy === null || copy.rowIds.length === 0) return addCore(r);
      return addWithCopy(pickText(r.destination, "destination"), copy, () => addCore(r));
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
