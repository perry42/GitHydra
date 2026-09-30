// SPDX-License-Identifier: GPL-3.0-or-later
import type { CreateBranchOptions, CreateBranchResult, SwitchResult } from "@githydra/git-core";
import type { OrphanedHeadResult } from "@githydra/git-core";
import type { GitHydraApi } from "../../shared/ipcContract";
import { GitHydraIpcError, unwrap, withGitLockRetryThrowing } from "../hooks/gitHydraClient";

/**
 * specs/branch-panel-drag-merge.md FR-430: THE single choke point every GitHydra-initiated
 * checkout that can leave a detached HEAD goes through. Nothing else in the renderer may call
 * `api.switchBranch`, `api.switchToCommit`, or `api.createBranch({ switchToIt: true })` directly
 * (enforced by `guardedCheckout.noDirectCalls.test.ts`).
 *
 * Flow per call: ask git-core (`getOrphanedHeadCommits`) -> `none` proceeds silently; anything
 * else (`orphaned` AND `unknown`, fail closed) asks the user via the injected `prompt`. On
 * "leave" the confirmed `headSha` is passed as `expectedDetachedHeadSha` so git-core re-verifies
 * HEAD inside the mutation itself; a `HeadMovedError` changes nothing and re-runs the guard.
 */

export type OrphanGuardAction = "checkout" | "merge" | "rebase" | "cherry-pick";

export interface GuardContext {
  action: OrphanGuardAction;
  /** Plain-text sentence shown above the commit list, e.g. "Merging A into B needs to check out B
   * first." Rendered as a React text node only. Null for a plain user-requested checkout. */
  description: string | null;
}

export interface OrphanPromptRequest {
  result: OrphanedHeadResult;
  context: GuardContext;
  /** True when this prompt follows a `HeadMovedError` (HEAD changed while the previous dialog was open). */
  headMoved: boolean;
}

/** "created": the user saved the commits on a new branch - the guard re-queries rather than retrying blindly. */
export type OrphanPromptDecision = "leave" | "cancel" | "created";

export interface LeftBehindInfo {
  headSha: string;
  shortSha: string;
  total: number;
  totalIsCapped: boolean;
  /** True when the guard could not determine the count (status `unknown`). */
  unknown: boolean;
}

export type GuardedOutcome<T> = { cancelled: true } | { cancelled: false; value: T };

export interface GuardedCallOptions {
  context?: GuardContext;
  /** Called right before the mutating call (after the user's decision), so the self-write gate is
   * never held open across a dialog. */
  onMutationStart?: () => void;
  /** Called when a mutating call this function issued failed with HeadMovedError (the caller's
   * own catch handles every other failure). */
  onMutationSettled?: () => void;
  /** Retry once on a transient git lock collision (drag flows). */
  retryOnLock?: boolean;
}

export interface GuardedCheckout {
  switchBranch(branchName: string, options?: GuardedCallOptions): Promise<GuardedOutcome<SwitchResult>>;
  switchToCommit(commitish: string, options?: GuardedCallOptions): Promise<GuardedOutcome<SwitchResult>>;
  /** `createBranch` with `switchToIt: true` (the switch half is what can orphan commits). */
  createBranchAndSwitch(
    branchOptions: Omit<CreateBranchOptions, "switchToIt" | "expectedDetachedHeadSha">,
    options?: GuardedCallOptions,
  ): Promise<GuardedOutcome<CreateBranchResult>>;
}

export const HEAD_CHANGED_MESSAGE = "HEAD changed while the dialog was open, so nothing was changed. Please try again.";

export class HeadChangedDuringGuardError extends Error {
  constructor() {
    super(HEAD_CHANGED_MESSAGE);
    this.name = "HeadChangedDuringGuardError";
  }
}

export interface CreateGuardedCheckoutOptions {
  api: GitHydraApi;
  prompt: (request: OrphanPromptRequest) => Promise<OrphanPromptDecision>;
  /** Called after a confirmed "Leave commits behind" checkout actually succeeded. */
  onLeftBehind?: (info: LeftBehindInfo) => void;
  /** Called after a HeadMovedError so the caller can refresh what it shows about HEAD. */
  onHeadMoved?: () => void;
}

const DEFAULT_CONTEXT: GuardContext = { action: "checkout", description: null };

/** A prompt for callers without dialog UI: always cancels (fail closed). */
export const cancelPrompt = async (): Promise<OrphanPromptDecision> => "cancel";

function unknownResult(): OrphanedHeadResult {
  return { status: "unknown", reason: "error", headSha: null, total: 0, totalIsCapped: false, shown: [] } as OrphanedHeadResult;
}

async function queryGuard(api: GitHydraApi): Promise<OrphanedHeadResult> {
  try {
    const res = await api.getOrphanedHeadCommits();
    return res.ok ? res.data : unknownResult(); // an IPC failure is "unknown", never "none".
  } catch {
    return unknownResult();
  }
}

function isHeadMoved(err: unknown): boolean {
  return err instanceof GitHydraIpcError ? err.errorName === "HeadMovedError" : err instanceof Error && err.name === "HeadMovedError";
}

export function createGuardedCheckout(opts: CreateGuardedCheckoutOptions): GuardedCheckout {
  const { api, prompt, onLeftBehind, onHeadMoved } = opts;

  async function run<T>(
    perform: (expectedDetachedHeadSha: string | undefined) => Promise<T>,
    callOptions: GuardedCallOptions | undefined,
  ): Promise<GuardedOutcome<T>> {
    const context = callOptions?.context ?? DEFAULT_CONTEXT;
    let headMoved = false;
    for (;;) {
      const result = await queryGuard(api);
      let expected: string | undefined;
      let leftBehind: LeftBehindInfo | null = null;
      if (result.status === "none") {
        // HEAD moved under an open dialog and now has nothing to lose: still do NOT proceed
        // silently - the user confirmed a different situation. Tell them instead.
        if (headMoved) throw new HeadChangedDuringGuardError();
      } else {
        const decision = await prompt({ result, context, headMoved });
        if (decision === "cancel") return { cancelled: true };
        if (decision === "created") {
          headMoved = false;
          continue; // re-run the guard against the new state; never blindly retry the checkout.
        }
        expected = result.headSha ?? undefined;
        if (result.headSha) {
          leftBehind = {
            headSha: result.headSha,
            shortSha: result.headSha.slice(0, 7),
            total: result.total,
            totalIsCapped: result.totalIsCapped,
            unknown: result.status !== "orphaned",
          };
        }
      }
      callOptions?.onMutationStart?.();
      try {
        const value = await (callOptions?.retryOnLock ? withGitLockRetryThrowing(() => perform(expected)) : perform(expected));
        if (leftBehind) onLeftBehind?.(leftBehind);
        return { cancelled: false, value };
      } catch (err) {
        if (!isHeadMoved(err)) throw err;
        callOptions?.onMutationSettled?.();
        onHeadMoved?.();
        headMoved = true;
      }
    }
  }


  return {
    switchBranch: (branchName, o) =>
      run(async (expected) => unwrap(await (expected ? api.switchBranch(branchName, { expectedDetachedHeadSha: expected }) : api.switchBranch(branchName))), o),
    switchToCommit: (commitish, o) =>
      run(async (expected) => unwrap(await (expected ? api.switchToCommit(commitish, { expectedDetachedHeadSha: expected }) : api.switchToCommit(commitish))), o),
    createBranchAndSwitch: (branchOptions, o) =>
      run(
        async (expected) =>
          unwrap(
            await api.createBranch({
              ...branchOptions,
              switchToIt: true,
              ...(expected ? { expectedDetachedHeadSha: expected } : {}),
            } as CreateBranchOptions),
          ),
        o,
      ),
  };
}
