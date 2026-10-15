// SPDX-License-Identifier: GPL-3.0-or-later
import { useCallback, useEffect, useRef, useState } from "react";
import type { PrunedEntry, WorktreeEntry } from "@githydra/git-core";
import type { GitHydraApi } from "../../shared/ipcContract";
import { DEPENDENCY_COMMANDS, SUBMODULE_COMMAND } from "../../shared/worktreeSetup";
import { addRefusalFailure, type CreateFailure, type CreateWorktreeValues, type WorktreeCreateRequest } from "../lib/worktreeCreate";
import {
  HOOK_NOT_RUN_NOTICE,
  SUBMODULE_DISABLED_REASON,
  SUBMODULE_NOTICE_DETAIL,
  SUBMODULE_NOTICE_TEXT,
  type WorktreeNotice,
} from "../lib/worktreeNotices";
import { removalRefusalMessage, type RemovalPlan } from "../lib/worktreeRemove";
import { looksLikeSamePath } from "../../shared/pathEquivalence";
import { findTabForPath, visibleText, worktreeName } from "../lib/worktrees";
import type { RemoveOutcome } from "../components/WorktreeDialogs/WorktreeDialogs";
import { unwrap, GitHydraIpcError } from "./gitHydraClient";
import type { DirtyLeaveRegistry } from "./useDirtyLeaveGuard";
import type { RecentOpenResult, RepoTab } from "./useRepoTabs";
import type { UseWorktreesResult } from "./useWorktrees";

export interface UseWorktreeActionsOptions {
  api: GitHydraApi;
  worktrees: UseWorktreesResult;
  tabs: readonly RepoTab[];
  activeTabId: string | null;
  /** FR-611: the app's one open-tab flow (dedups by path, guarded against a dirty editor). */
  openInNewTab: (path: string) => Promise<RecentOpenResult>;
  /** Focus an existing tab through the app's guarded tab switch. */
  focusTab: (id: string) => void;
  /** Closes a tab (the caller has already passed the dirty-leave guard for the active one). */
  closeTab: (id: string) => void;
  activateTab: (id: string) => Promise<void>;
  dirtyGuard: DirtyLeaveRegistry;
  /** FR-606: the self-write gate. beginMutation before every write, a refresh after (success or not). */
  beginMutation: () => void;
  refreshRefs: () => Promise<void>;
  /** Fire-and-forget refresh: must be the Background variant (CLAUDE.md pitfall). */
  refreshRefsAndRowsInBackground: () => Promise<void>;
  /** Bumps the Branches list so cards show the new/removed worktree glyph. */
  onBranchesChanged: () => void;
  /** "Open Branches" on the kept-branch notice. */
  onOpenBranches: () => void;
  currentBranchLabel: string;
}

export interface CleanUpState {
  entry: WorktreeEntry;
  alsoForgotten: PrunedEntry[];
  busy: boolean;
  notice: string | null;
}

export type WorktreePickerMode = "createFromBranch" | "open" | "remove";

/**
 * specs/worktrees.md FR-607..616, 632..634, 644: the one controller for create, open-as-tab, remove and clean up. Every write
 * goes through the self-write gate (FR-606) and every fire-and-forget refresh uses the Background variant.
 */
export function useWorktreeActions(opts: UseWorktreeActionsOptions) {
  const optsRef = useRef(opts);
  optsRef.current = opts;

  const [createRequest, setCreateRequest] = useState<WorktreeCreateRequest | null>(null);
  const [removeRequest, setRemoveRequest] = useState<{ entry: WorktreeEntry; wantsDeleteBranch: boolean } | null>(null);
  const [cleanUp, setCleanUp] = useState<CleanUpState | null>(null);
  const [picker, setPicker] = useState<WorktreePickerMode | null>(null);
  const [notices, setNotices] = useState<(WorktreeNotice & { repoKey: string | null })[]>([]);
  const noticeSeq = useRef(0);
  const headingRef = useRef<HTMLHeadingElement | null>(null);

  const repoKey = () => optsRef.current.worktrees.list?.commonDir ?? null;

  const pushNotices = useCallback((list: Omit<WorktreeNotice, "id">[]) => {
    const key = repoKey();
    setNotices((prev) => [...prev, ...list.map((n) => ({ ...n, id: ++noticeSeq.current, repoKey: key }))]);
  }, []);

  const dismissNotice = useCallback((id: number) => setNotices((prev) => prev.filter((n) => n.id !== id)), []);

  const focusHeading = useCallback(() => {
    // After the dialog unmounts, so the focus is not taken back by it (FR-615).
    setTimeout(() => headingRef.current?.focus(), 0);
  }, []);

  /** Create and the pickers name the previous repo's branches. The remove flow is not reset: closing the worktree's own tab (FR-616) changes the repo under it. */
  const resetForRepoChange = useCallback(() => {
    setCreateRequest(null);
    setPicker(null);
  }, []);

  const afterWrite = useCallback((succeeded: boolean) => {
    const o = optsRef.current;
    // The gate opened by beginMutation closes on a refresh either way (a refusal changes nothing).
    if (succeeded) void o.refreshRefsAndRowsInBackground();
    else void o.refreshRefs();
    o.onBranchesChanged();
    o.worktrees.reload();
  }, []);

  // --- open (FR-611, FR-640) ---

  const openWorktree = useCallback(
    async (entry: WorktreeEntry): Promise<void> => {
      const o = optsRef.current;
      if (entry.isBare) return;
      const fail = (text: string) => pushNotices([{ tone: "error", text, actions: [] }]);
      let path = entry.path;
      let realPath = entry.path;
      if (entry.id !== null) {
        // FR-640: a registered path is repository-controlled; verified before it ever becomes a tab.
        try {
          const v = unwrap(await o.api.verifyWorktree(entry.id));
          if (!v.trusted) {
            fail("Not a worktree of this repository.");
            return;
          }
          path = v.path;
          realPath = v.realPath;
        } catch (err) {
          fail(err instanceof Error ? err.message : String(err));
          return;
        }
      }
      // A linked worktree already open as a plain repo tab counts as open (compare spelled and resolved paths).
      const existing = findTabForPath(optsRef.current.tabs, path, realPath, entry.path);
      if (existing) {
        if (existing.id !== optsRef.current.activeTabId) optsRef.current.focusTab(existing.id);
        return;
      }
      const result = await o.openInNewTab(path);
      if (result === "not-found") fail("Could not open that worktree. Its folder may be missing or no longer a repository.");
    },
    [pushNotices],
  );

  const openWorktreeAtPath = useCallback(
    async (path: string) => {
      setCreateRequest(null);
      const entry = optsRef.current.worktrees.list?.entries.find((e) => e.path === path || looksLikeSamePath(e.path, path));
      if (entry) await openWorktree(entry);
    },
    [openWorktree],
  );

  // --- create (FR-602, FR-608, FR-632, FR-633, FR-644) ---

  const requestCreate = useCallback((request: WorktreeCreateRequest) => setCreateRequest(request), []);
  const cancelCreate = useCallback(() => setCreateRequest(null), []);

  const submitCreate = useCallback(
    async (values: CreateWorktreeValues): Promise<CreateFailure | null> => {
      const o = optsRef.current;
      o.beginMutation();
      let hookPresent = false;
      try {
        // FR-644: detected only. This slice never passes runPostCheckoutHook, so git-core disables every hook.
        hookPresent = unwrap(await o.api.detectPostCheckoutHook()).present;
      } catch {
        hookPresent = false;
      }
      let result;
      try {
        result = unwrap(await o.api.addWorktree({ destination: values.destination, source: values.source }));
      } catch (err) {
        afterWrite(false);
        return { field: "general", message: createErrorMessage(err) };
      }
      if (!result.ok) {
        afterWrite(false);
        return addRefusalFailure(result);
      }
      afterWrite(true);
      setCreateRequest(null);

      let entry: WorktreeEntry | null = result.entry;
      if (!entry) {
        try {
          const list = unwrap(await o.api.listWorktrees());
          entry = list.entries.find((e) => e.path === result.path || looksLikeSamePath(e.path, result.path)) ?? null;
        } catch {
          entry = null;
        }
      }
      const name = visibleText(result.branch ?? entry?.branch ?? `detached ${result.head.slice(0, 7)}`);
      const next: Omit<WorktreeNotice, "id">[] = [
        result.warning
          ? {
              tone: "warning",
              text: `Created worktree "${name}", but git reported a problem after creating it. The worktree was kept.`,
              actions: [],
            }
          : { tone: "success", text: `Created worktree "${name}".`, actions: [] },
      ];
      if (entry?.id) {
        try {
          const hints = unwrap(await o.api.getWorktreeSetupHints(entry.id));
          if (hints.dependency) {
            next.push({
              tone: "info",
              text: `${hints.dependency.manifest} found - dependencies are not installed in this worktree.`,
              // FR-633: a fixed string from a built-in table, copied only; GitHydra never runs it.
              actions: [{ kind: "copy", label: "Copy command", text: DEPENDENCY_COMMANDS[hints.dependency.kind] }],
            });
          }
          if (hints.hasSubmodules) {
            next.push({
              tone: "info",
              text: SUBMODULE_NOTICE_TEXT,
              detail: SUBMODULE_NOTICE_DETAIL,
              actions: [
                { kind: "disabled", label: "Initialize submodules", reason: SUBMODULE_DISABLED_REASON },
                { kind: "copy", label: "Copy command", text: SUBMODULE_COMMAND },
              ],
            });
          }
        } catch {
          // Hints are a courtesy; a failure to read them must not hide the create result.
        }
      }
      if (hookPresent) next.push({ tone: "warning", text: HOOK_NOT_RUN_NOTICE, actions: [] });
      pushNotices(next);

      if (values.openAfter && entry) await openWorktree(entry);
      return null;
    },
    [afterWrite, openWorktree, pushNotices],
  );

  // --- remove (FR-615, FR-616, FR-641) ---

  const requestRemove = useCallback((entry: WorktreeEntry, wantsDeleteBranch: boolean) => setRemoveRequest({ entry, wantsDeleteBranch }), []);
  const cancelRemove = useCallback(() => {
    setRemoveRequest(null);
    focusHeading();
  }, [focusHeading]);

  /** FR-616: the worktree's tab (active or background) is closed first through the dirty-leave guard; a refusal stops the removal. */
  const closeTabFor = useCallback(async (entry: WorktreeEntry): Promise<boolean> => {
    const o = optsRef.current;
    const tab = findTabForPath(o.tabs, entry.path);
    if (!tab) return true;
    const allowed = await new Promise<boolean>((resolve) => {
      o.dirtyGuard.guard(
        () => resolve(true),
        () => resolve(false),
      );
    });
    if (!allowed) return false;
    if (tab.id === o.activeTabId) {
      // The session must land on a tab of this repository so the removal below runs against it.
      const list = o.worktrees.list;
      const mainPath = list?.mainPath ?? null;
      const other = o.tabs.find((t) => t.id !== tab.id && mainPath !== null && findTabForPath([t], mainPath) !== null);
      if (other) await o.activateTab(other.id);
      else if (mainPath !== null) {
        const r = await o.openInNewTab(mainPath);
        if (r === "not-found" || r === "cancelled") return false;
      } else return false;
    }
    o.closeTab(tab.id);
    return true;
  }, []);

  const confirmRemove = useCallback(
    async (plan: RemovalPlan): Promise<RemoveOutcome | null> => {
      const o = optsRef.current;
      const request = removeRequest;
      if (!request || request.entry.id === null) return { notice: "The main worktree cannot be removed." };
      const { entry, wantsDeleteBranch } = request;
      if (!(await closeTabFor(entry))) {
        return { notice: "Nothing was removed: the open tab for this worktree has unsaved edits. Save or discard them, then try again." };
      }
      o.beginMutation();
      // A force is bound to the exact count and submodules the user was shown (and typed the count for): git-core refuses otherwise.
      const req = {
        id: entry.id!,
        confirmedPath: entry.path,
        force: plan.force,
        ...(plan.force ? { expectedCount: plan.count, expectedSubmodules: plan.submodules } : {}),
      };
      try {
        const branch = entry.branch;
        const keptUnmerged = () => keptNotice(branch ?? "", o.currentBranchLabel);
        if (plan.deleteBranch) {
          const res = unwrap(await o.api.removeWorktreeAndDeleteBranch({ ...req, expectedMerged: true }));
          if (!res.ok) {
            afterWrite(false);
            return refusalOutcome(res);
          }
          afterWrite(true);
          const b = res.branch;
          if (b.status === "deleted") pushNotices([{ tone: "success", text: "Worktree and branch removed.", actions: [] }]);
          else if (b.status === "kept" && b.why === "unmerged") pushNotices([keptUnmerged()]);
          else if (b.status === "kept")
            pushNotices([
              {
                tone: "info",
                text: `Worktree removed. The branch ${visibleText(b.name)} was kept because ${
                  b.why === "checkedOutElsewhere" ? "it is checked out in another worktree" : b.why === "missing" ? "it no longer exists" : "git could not delete it"
                }.`,
                actions: [],
              },
            ]);
          else pushNotices([{ tone: "success", text: "Worktree removed.", actions: [] }]);
        } else {
          const res = unwrap(await o.api.removeWorktree(req));
          if (!res.ok) {
            afterWrite(false);
            return refusalOutcome(res);
          }
          afterWrite(true);
          if (wantsDeleteBranch && branch && plan.keptUnmerged) {
            pushNotices([keptUnmerged()]);
          } else pushNotices([{ tone: "success", text: "Worktree removed.", actions: [] }]);
        }
      } catch (err) {
        afterWrite(false);
        return { notice: err instanceof Error ? err.message : String(err) };
      }
      setRemoveRequest(null);
      focusHeading();
      return null;
    },
    [afterWrite, closeTabFor, focusHeading, pushNotices, removeRequest],
  );

  // --- clean up (FR-604, FR-614) ---

  const requestCleanUp = useCallback((entry: WorktreeEntry) => setCleanUp({ entry, alsoForgotten: [], busy: false, notice: null }), []);
  const cancelCleanUp = useCallback(() => {
    setCleanUp(null);
    focusHeading();
  }, [focusHeading]);

  const confirmCleanUp = useCallback(async () => {
    const o = optsRef.current;
    const state = cleanUp;
    if (!state || state.entry.id === null) return;
    setCleanUp({ ...state, busy: true, notice: null });
    o.beginMutation();
    try {
      // The ids the user saw listed are the only ones git-core may also forget.
      const accept = state.alsoForgotten.map((p) => p.id);
      const res = unwrap(await o.api.pruneWorktree(state.entry.id, accept));
      if (res.ok) {
        afterWrite(true);
        const extra = res.alsoForgot.length > 0 ? ` Also forgot ${res.alsoForgot.map((p) => visibleText(p.id)).join(", ")}.` : "";
        pushNotices([{ tone: "success", text: `Cleaned up the leftover record of ${visibleText(worktreeName(state.entry))}. No files were deleted.${extra}`, actions: [] }]);
        setCleanUp(null);
        focusHeading();
        return;
      }
      afterWrite(false);
      if (res.reason === "confirmationRequired") setCleanUp({ ...state, alsoForgotten: res.alsoForgotten, busy: false, notice: null });
      else setCleanUp({ ...state, busy: false, notice: res.message });
    } catch (err) {
      afterWrite(false);
      setCleanUp({ ...state, busy: false, notice: err instanceof Error ? err.message : String(err) });
    }
  }, [afterWrite, cleanUp, focusHeading, pushNotices]);

  return {
    createRequest,
    requestCreate,
    cancelCreate,
    submitCreate,
    openWorktree,
    openWorktreeAtPath,
    removeRequest,
    requestRemove,
    cancelRemove,
    confirmRemove,
    cleanUp,
    requestCleanUp,
    cancelCleanUp,
    confirmCleanUp,
    picker,
    openPicker: setPicker,
    closePicker: () => setPicker(null),
    notices,
    dismissNotice,
    headingRef,
    resetForRepoChange,
    anyDialogOpen: createRequest !== null || removeRequest !== null || cleanUp !== null || picker !== null,
  };
}

function createErrorMessage(err: unknown): string {
  if (err instanceof GitHydraIpcError) {
    const reason = typeof err.details?.reason === "string" ? err.details.reason : null;
    if (reason === "timeout") return "Creating the worktree took too long and was stopped. Nothing was created.";
    if (reason === "io-failed") return "The file system reported an error while creating the worktree. Nothing was created.";
    return err.message;
  }
  return err instanceof Error ? err.message : String(err);
}

function keptNotice(branch: string, current: string): Omit<WorktreeNotice, "id"> {
  return {
    tone: "warning",
    text: `Worktree removed. The branch ${visibleText(branch)} was kept because it has commits that are not merged into ${visibleText(current)} or its upstream. Delete it anyway from the Branches panel if you are sure.`,
    actions: [{ kind: "openBranches", label: "Open Branches" }],
  };
}

function refusalOutcome(res: Parameters<typeof removalRefusalMessage>[0]): RemoveOutcome {
  const reload = res.reason === "dirty" || res.reason === "hasSubmodules" || res.reason === "expectationRequired";
  return {
    // Never retried automatically: the dialog re-reads the fresh numbers and asks again.
    notice:
      res.reason === "expectationRequired"
        ? removalRefusalMessage(res)
        : reload
          ? "This worktree changed since you opened this. Review it again."
          : removalRefusalMessage(res),
    reload,
  };
}
