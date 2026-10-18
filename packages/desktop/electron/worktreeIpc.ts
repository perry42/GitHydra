// SPDX-License-Identifier: GPL-3.0-or-later
import { realpath as realpathCb } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  defaultWorktreePath,
  tagRow,
  COPY_SKIP_MESSAGES,
  escapeDisplayName,
  existingReasonText,
  existingSkipText,
  type CopyIntoExistingOptions,
  type ExistingCopyOutcome,
  type ExistingListing,
  type ListForExistingOptions,
  type ResolvedDestinationResult,
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
  WorktreeExistingCopyResult,
  WorktreeExistingListing,
  WorktreeExistingProgress,
  WorktreeExistingRefusal,
  WorktreeExistingRow,
  WorktreeExistingSkipped,
  WorktreeHookChoice,
  WorktreeHookInfo,
  WorktreeSetupHints,
} from "../shared/ipcContract";
import { detectWorktreeSetup } from "../shared/worktreeSetup";
import { computeRepoKey } from "./recoveryDrafts";
import { createCopyTokenStore, createRepoMutex, type CopyTokenRefusal, type CopyTokenStore, type RepoMutex } from "./worktreeCopyTokens";
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
  /** Section G (specs/worktree-copy-ignored.md FR-652/FR-653). */
  listIgnoredForExisting(destId: string | null, options?: ListForExistingOptions): Promise<ExistingListing>;
  copyIgnoredIntoExisting(
    manifest: CopyManifest,
    selectedRowIds: readonly string[],
    binding: { destId: string | null; boundRoot: string },
    options?: CopyIntoExistingOptions,
  ): Promise<ExistingCopyOutcome>;
  resolveDestinationWorktree(destId: string | null): Promise<ResolvedDestinationResult>;
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

/** Manifest drop reasons (git-core) as fixed user text; every path-hygiene reason reads "name not allowed". */
const DROPPED_TEXT: Record<string, string> = {
  unreadable: "cannot be read",
  "symbolic-link": "symbolic link",
  "not-a-regular-file": "not a regular file",
  "too-long": "path too long",
};

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

/** FR-652: strict plain-data shape `{destId}`; a worktree id (admin-dir name) or null for the main worktree. Never a path. */
export function pickExistingListRequest(raw: unknown): string | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new InvalidArgumentError("request is not acceptable.");
  const r = raw as Record<string, unknown>;
  for (const key of Object.keys(r)) if (key !== "destId") throw new InvalidArgumentError("request has an unexpected field.");
  if (r.destId === null) return null;
  return pickId(r.destId, "destId");
}

/** FR-653: strict `{token, rowIds}`; the same bounds as Create's copy request. */
export function pickExistingCopyRequest(raw: unknown): WorktreeCopyRequest {
  const picked = pickCopyRequest(raw === undefined ? null : raw);
  if (picked === null) throw new InvalidArgumentError("request is not acceptable.");
  return picked;
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
  "purpose-mismatch": "the list of files was not available any more",
};

/** FR-653 typed refusals of the copy into an existing worktree, each with its fixed FR-657 text (B is main's own escaped name). */
const EXISTING_REFUSAL_FROM_TOKEN: Record<CopyTokenRefusal, WorktreeExistingRefusal> = {
  unknown: "tokenInvalid",
  "purpose-mismatch": "purposeMismatch",
  expired: "tokenExpired",
  "other-repository": "tokenInvalid",
  "other-source": "tokenInvalid",
  "destination-changed": "destinationChanged",
  "selection-changed": "selectionChanged",
  "not-bound": "tokenInvalid",
};

function existingRefusalText(reason: WorktreeExistingRefusal, into: string): string {
  const b = into === "" ? "The destination" : into;
  switch (reason) {
    case "notAWorktree":
      return `${b} is no longer a worktree of this repository.`;
    case "destinationChanged":
      return `${b} changed. Open this dialog again.`;
    case "busy":
      return "Another copy is already running.";
    case "selectionChanged":
    case "overLimit":
      return "This selection is no longer valid. Review it again.";
    case "trackedCheckFailed":
      return `Couldn't check which files ${b} tracks.`;
    case "sourceChanged":
      return "The source worktree changed. Open this dialog again.";
    case "tokenExpired":
    case "tokenInvalid":
    case "purposeMismatch":
      return "This list is no longer valid. Open this dialog again.";
  }
}

const EXISTING_LIST_FAILURE_TEXT = "Couldn't list ignored files.";
const EXISTING_NOT_A_WORKTREE_TEXT = "Not a worktree of this repository.";
const EXISTING_SKIPPED_RETURNED = 20;
const EXISTING_POLL_MS = 250;

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
  /** FR-653 (M8): the one per-repo mutex; injectable so tests can hold it. */
  repoMutex?: RepoMutex;
  /** FR-657: progress of the running copy into an existing worktree, pushed to the renderer. */
  emitExistingProgress?: (progress: WorktreeExistingProgress) => void;
  /** How often a running copy checks that the active repo is still the one it started in (tab switch aborts like Cancel). */
  existingPollMs?: number;
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
  /** LOW-4: the running listing; a newer call or a release kills its git children instead of letting them finish for nobody. */
  let listAbort: AbortController | null = null;
  const tokens = deps.copyTokens ?? createCopyTokenStore(deps.platform ? { platform: deps.platform } : {});
  const destRealpath = deps.destinationRealpath ?? ((p: string) => fs.realpath(p));
  const mutex = deps.repoMutex ?? createRepoMutex();
  /** The mutex key is the repo key; an unreadable worktree list must not make remove or prune impossible, so fall back to the path. */
  async function lockKey(): Promise<string> {
    try {
      return await repoKey();
    } catch {
      return getRepo().path;
    }
  }
  /** Section G: the running listing and the running copy, each abortable on its own. */
  let existingSeq = 0;
  let existingListAbort: AbortController | null = null;
  let existingCopyAbort: AbortController | null = null;

  const refusedCopy = (message: string, from: string): WorktreeCopyResult => ({
    status: "refused",
    copied: 0,
    total: 0,
    bytes: 0,
    skipped: [],
    skippedTotal: 0,
    droppedFiles: 0,
    droppedReasons: [],
    message,
    from,
  });

  /** LOW-6: what the manifest left out of the SELECTED rows, as fixed texts. */
  function droppedOf(manifest: CopyManifest, ids: readonly string[]): { droppedFiles: number; droppedReasons: string[] } {
    const wanted = new Set(ids);
    let droppedFiles = 0;
    const reasons = new Set<string>();
    for (const row of manifest.rows) {
      if (!wanted.has(row.id) || row.droppedFiles === 0) continue;
      droppedFiles += row.droppedFiles;
      for (const reason of Object.keys(row.droppedReasons)) reasons.add(DROPPED_TEXT[reason] ?? "name not allowed");
    }
    return { droppedFiles, droppedReasons: [...reasons] };
  }

  function summarize(outcome: CopyOutcome, unknownIds: readonly string[], from: string, dropped: { droppedFiles: number; droppedReasons: string[] }): WorktreeCopyResult {
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
      ...dropped,
      ...(copied === 0 && skipped.length === 0 && dropped.droppedFiles === 0 ? { message: "the chosen folders had no files" } : {}),
      from,
    };
  }

  /** FR-643: the optional copy after a SUCCESSFUL add; it never changes whether the add succeeded. */
  async function addWithCopy(destination: string, copy: WorktreeCopyRequest, run: (repo: WorktreeRepo) => Promise<AddWorktreeResult | HookDeclinedResult>): Promise<AddWorktreeIpcResult> {
    // FR-653 (M8): a Create copy counts as "a copy is running". When another one holds the mutex the worktree is still created, without copying.
    const release = mutex.tryAcquire(await lockKey());
    if (release === null) {
      const repo = getRepo();
      const result = await run(repo);
      return result.ok ? { ...result, copy: refusedCopy("another copy is already running", path.basename(repo.path)) } : result;
    }
    try {
      return await addWithCopyLocked(destination, copy, run);
    } finally {
      release();
    }
  }

  async function addWithCopyLocked(destination: string, copy: WorktreeCopyRequest, run: (repo: WorktreeRepo) => Promise<AddWorktreeResult | HookDeclinedResult>): Promise<AddWorktreeIpcResult> {
    const repo = getRepo();
    const fallbackFrom = path.basename(repo.path);
    const ctx = { repoKey: await repoKey(), sourceRoot: repo.path };
    // FR-639 again, here: the copy is bound to the destination main validated itself, not to anything the renderer said.
    const check = await repo.validateWorktreeDestination(destination).catch(() => null);
    const bound = check?.ok ? tokens.bind(copy.token, ctx, check.realPath, copy.rowIds) : null;
    const result = await run(repo);
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
    // LOW-5: the repo that was bound and added to must still be the open one when files are written.
    if (getRepo() !== repo) {
      tokens.release();
      return { ...result, copy: refusedCopy("the open repository changed", from) };
    }
    const used = tokens.consume(copy.token, ctx, real, copy.rowIds);
    if (!used.ok) return { ...result, copy: refusedCopy(REFUSAL_MESSAGES[used.reason], from) };
    const wanted = [...new Set(copy.rowIds)];
    const inManifest = new Set(used.manifest.rows.map((row) => row.id));
    try {
      const outcome = await repo.copyFromManifest(
        used.manifest,
        wanted.filter((id) => inManifest.has(id)),
        // The validated realpath, not the path git echoed: the engine refuses a folder that no longer resolves to it (MED-1).
        real,
        { expectedDestReal: real },
      );
      return { ...result, copy: summarize(outcome, wanted.filter((id) => !inManifest.has(id)), from, droppedOf(used.manifest, wanted)) };
    } catch {
      // Fixed text only: a raw error could carry a path or file content.
      return { ...result, copy: refusedCopy("the files could not be copied", from) };
    }
  }

  async function addCore(r: Record<string, unknown>, repo: WorktreeRepo = getRepo()): Promise<AddWorktreeResult | HookDeclinedResult> {
    const destination = pickText(r.destination, "destination");
    const source = pickWorktreeSource(r.source);
    const choice = pickHookChoice(r.hookChoice);
    const remember = r.remember === true;
    const shown = typeof r.hookFingerprint === "string" && r.hookFingerprint !== "" ? r.hookFingerprint : null;
    // No choice, or Skip: no options argument at all, so git-core's default "no hook can run" applies (FR-638).
    if (choice === undefined) return repo.addWorktree(destination, source);
    if (choice === "skip") {
      const info = await repo.detectPostCheckoutHook().catch(() => null);
      if (info?.present && !info.hooksPathRelative) await dropStale(info.fingerprint);
      const result = await repo.addWorktree(destination, source);
      // A remembered skip is bound to the hook the user was shown: stored only if that is still the hook.
      if (result.ok && remember && shown !== null && info?.present && !info.hooksPathRelative && info.fingerprint === shown) {
        await remembers("skip", info.fingerprint);
      }
      return result;
    }
    // Run: re-detect, take the fingerprint from git-core ITSELF, and compare it with the one the user was shown.
    if (shown === null) return refusal("hookFingerprintRequired", "Running the hook needs the fingerprint that was shown to you.");
    const info = await repo.detectPostCheckoutHook();
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
    const result = await repo.addWorktree(destination, source, { runPostCheckoutHook: true, expectedHookFingerprint: info.fingerprint });
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
      listAbort?.abort();
      const ac = (listAbort = new AbortController());
      const key = await repoKey();
      const built = await repo.buildCopyManifest(repo.path, { repoKey: key, signal: ac.signal });
      if (seq !== listSeq) return { status: "failed", reason: "cancelled" };
      if (built.status === "failed") return { status: "failed", reason: built.reason };
      const manifest = built.manifest;
      const rows: WorktreeCopyRow[] = manifest.rows.map((row) => {
        const base = {
          path: row.path,
          isDirectory: row.isDirectory,
          fileCount: row.fileCount,
          bytes: row.bytes,
          disabledReason: row.disabledReason,
          // MED-2: flags that looked inside a directory row, so a planted local/.env is not hidden behind a plain name.
          secret: row.secret,
          runsCode: row.runsCode,
        };
        return { id: row.id, ...base, ...tagRow(base), droppedFiles: row.droppedFiles, droppedReasons: row.droppedReasons };
      });
      let include: WorktreeCopyInclude = { status: "absent", matchedRows: [], skipped: [] };
      if (rows.length === 0) {
        tokens.release();
        return { status: "ok", token: "", bare: false, rows, include };
      }
      const candidates: IgnoredCandidate[] = rows.map((row) => ({ ...row, sizeComputed: row.disabledReason === null }));
      try {
        const inc = await repo.readWorktreeInclude(repo.path, { candidates, signal: ac.signal });
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
      listAbort?.abort();
      listAbort = null;
      tokens.release();
    },

    /**
     * Section G, FR-652/FR-653: argument-less on repo and paths. Lists the open repository's ignored files, classifies them against
     * the existing worktree `destId` (a worktree id from main's own list, null = main), keeps the manifest here and returns rows,
     * names (from main) and a purpose-bound token.
     */
    async listIgnoredForExisting(req: unknown): Promise<WorktreeExistingListing> {
      const destId = pickExistingListRequest(req);
      const repo = getRepo();
      const seq = ++existingSeq;
      existingListAbort?.abort();
      const ac = (existingListAbort = new AbortController());
      const key = await repoKey();
      const listed = await repo.listIgnoredForExisting(destId, { repoKey: key, signal: ac.signal });
      if (seq !== existingSeq) return { status: "failed", reason: "cancelled", message: EXISTING_LIST_FAILURE_TEXT };
      if (listed.status === "failed") {
        const b = listed.destinationName ?? "the destination";
        if (listed.reason === "tracked-check-failed") return { status: "failed", reason: listed.reason, message: `Couldn't check which files ${b} tracks.` };
        const notWorktree = ["not-a-worktree", "untrusted-list", "source-is-destination", "locked", "missing", "unsupported", "bare"].includes(listed.reason);
        return { status: "failed", reason: listed.reason as never, message: notWorktree ? EXISTING_NOT_A_WORKTREE_TEXT : EXISTING_LIST_FAILURE_TEXT };
      }
      const dest = listed.destination;
      const rows: WorktreeExistingRow[] = listed.rows.map((row) => ({
        id: row.id,
        path: row.path,
        displayPath: row.displayPath,
        isDirectory: row.isDirectory,
        fileCount: row.fileCount,
        copyableCount: row.copyableCount,
        existingCount: row.existingCount,
        bytes: row.bytes,
        disabledReason: row.disabledReason,
        disabledText: row.disabledReason ? existingReasonText(row.disabledReason, dest.name) : null,
        secret: row.secret,
        runsCode: row.runsCode,
        large: row.large,
        changesGit: row.changesGit,
        notIgnoredInDestination: row.notIgnoredInDestination,
        droppedFiles: row.droppedFiles,
        droppedReasons: row.droppedReasons,
      }));
      const destination = {
        id: dest.id,
        name: dest.name,
        path: escapeDisplayName(dest.root),
        branch: dest.branch === null ? null : escapeDisplayName(dest.branch),
        detached: dest.detached,
        shortHead: dest.shortHead,
      };
      const source = { name: listed.source.name };
      let include: WorktreeCopyInclude = { status: "absent", matchedRows: [], skipped: [] };
      if (rows.length === 0) {
        tokens.releaseExisting();
        return { status: "ok", token: "", source, destination, rows, include };
      }
      const candidates: IgnoredCandidate[] = listed.rows.map((row) => ({
        path: row.path,
        isDirectory: row.isDirectory,
        fileCount: row.fileCount,
        bytes: row.bytes,
        disabledReason: null,
        secret: row.secret,
        runsCode: row.runsCode,
        sizeComputed: true,
        large: row.large,
      }));
      try {
        const inc = await repo.readWorktreeInclude(repo.path, { candidates, signal: ac.signal });
        if (inc.status === "ok") {
          include = { status: "ok", matchedRows: inc.matchedRows, skipped: inc.skipped.map((x) => ({ line: x.line, pattern: x.pattern, reason: x.reason })) };
        } else if (inc.status !== "absent") include = { status: inc.status, matchedRows: [], skipped: [] };
      } catch {
        include = { status: "failed", matchedRows: [], skipped: [] };
      }
      if (seq !== existingSeq) return { status: "failed", reason: "cancelled", message: EXISTING_LIST_FAILURE_TEXT };
      const token = tokens.issueExisting(listed.manifest, key, repo.path, { id: dest.id, root: dest.root });
      return { status: "ok", token, source, destination, rows, include };
    },

    /** FR-653: redeem the token. Order matters: purpose and cheap checks, then the mutex, then the destination, then single use. */
    async copyIgnoredIntoExisting(req: unknown): Promise<WorktreeExistingCopyResult> {
      const request = pickExistingCopyRequest(req);
      const repo = getRepo();
      const key = await repoKey();
      const ctx = { repoKey: key, sourceRoot: repo.path };
      const refuse = (reason: WorktreeExistingRefusal, into = ""): WorktreeExistingCopyResult => ({ status: "refused", reason, message: existingRefusalText(reason, into), into });

      const checked = tokens.checkExisting(request.token, ctx, request.rowIds);
      if (!checked.ok) return refuse(EXISTING_REFUSAL_FROM_TOKEN[checked.reason]);
      const into = escapeDisplayName(path.basename(checked.destRoot));
      // A busy repository is refused WITHOUT consuming the token: the user can press Try again once the other copy ends.
      const release = mutex.tryAcquire(await lockKey());
      if (release === null) return refuse("busy", into);
      const ac = (existingCopyAbort = new AbortController());
      let poll: ReturnType<typeof setInterval> | null = null;
      try {
        const fresh = await repo.resolveDestinationWorktree(checked.destId);
        if (!fresh.ok) {
          tokens.releaseExisting();
          return refuse("notAWorktree", into);
        }
        const used = tokens.consumeExisting(request.token, ctx, request.rowIds, { destId: checked.destId, destRoot: fresh.dest.root });
        if (!used.ok) return refuse(EXISTING_REFUSAL_FROM_TOKEN[used.reason], into);
        // Switching the active tab or closing it aborts like Cancel (FR-657); the engine stops after the current file.
        poll = setInterval(() => {
          let still = false;
          try {
            still = getRepo() === repo;
          } catch {
            still = false;
          }
          if (!still) ac.abort();
        }, deps.existingPollMs ?? EXISTING_POLL_MS);
        const wanted = [...new Set(request.rowIds)];
        let outcome: ExistingCopyOutcome;
        try {
          outcome = await repo.copyIgnoredIntoExisting(used.manifest, wanted, { destId: used.destId, boundRoot: used.destRoot }, {
            signal: ac.signal,
            onProgress: (p) => deps.emitExistingProgress?.({ filesDone: p.filesDone, filesTotal: p.filesTotal, bytesDone: p.bytesDone }),
          });
        } catch {
          // Fixed text only: a raw error could carry a path or file content.
          return refuse("sourceChanged", into);
        }
        if (outcome.status === "refused") {
          const map = { "not-a-worktree": "notAWorktree", "destination-changed": "destinationChanged", "source-changed": "sourceChanged", "over-limit": "overLimit", "tracked-check-failed": "trackedCheckFailed" } as const;
          return refuse(map[outcome.reason], into);
        }
        const from = escapeDisplayName(path.basename(used.manifest.sourceRoot));
        const skipped: WorktreeExistingSkipped[] = [];
        let skippedTotal = 0;
        for (const r of outcome.results) {
          // A cancelled copy reports its unprocessed files as skipped "cancelled": that is the stop, not a failure to list.
          if (r.outcome !== "skipped" || r.reason === "cancelled") continue;
          skippedTotal++;
          if (skipped.length < EXISTING_SKIPPED_RETURNED) skipped.push({ path: escapeDisplayName(r.path), reason: r.reason, text: existingSkipText(r.reason, into) });
        }
        return { status: outcome.status, copied: outcome.totals.copied, bytes: outcome.totals.bytes, skipped, skippedTotal, from, into };
      } finally {
        if (poll) clearInterval(poll);
        if (existingCopyAbort === ac) existingCopyAbort = null;
        release();
      }
    },

    /** FR-657 Cancel: argument-less. */
    copyExistingCancel(): void {
      existingCopyAbort?.abort();
    },

    /** FR-653: the dialog closed; kills the token and listing of THIS purpose only. */
    copyExistingRelease(): void {
      existingSeq++;
      existingListAbort?.abort();
      existingListAbort = null;
      tokens.releaseExisting();
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
      return addWithCopy(pickText(r.destination, "destination"), copy, (repo) => addCore(r, repo));
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
      return mutex.run(await lockKey(), async () => getRepo().removeWorktree(r.id, { confirmedPath: r.confirmedPath, force: r.force, ...expectationOf(r) }));
    },

    async removeAndDeleteBranch(req: unknown): Promise<RemoveWorktreeAndDeleteBranchResult> {
      const r = pickRemoval(req);
      return mutex.run(await lockKey(), async () =>
        getRepo().removeWorktreeAndDeleteBranch(r.id, {
          confirmedPath: r.confirmedPath,
          force: r.force,
          ...expectationOf(r),
          ...(r.expectedMerged !== undefined ? { expectedMerged: r.expectedMerged } : {}),
        }),
      );
    },

    async prune(id: unknown, accept: unknown): Promise<PruneWorktreeResult> {
      const ids: string[] = [];
      if (accept !== undefined) {
        if (!Array.isArray(accept) || accept.length > MAX_ACCEPTED_IDS) throw new InvalidArgumentError("acceptAlsoForgotten is not acceptable.");
        for (const a of accept) ids.push(pickText(a, "acceptAlsoForgotten"));
      }
      const wanted = pickId(id);
      return mutex.run(await lockKey(), async () => getRepo().pruneWorktree(wanted, { acceptAlsoForgotten: ids }));
    },
  };
}
