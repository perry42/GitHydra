// SPDX-License-Identifier: GPL-3.0-or-later
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import type { GitHydraApi, RecoveryDraft } from "../../shared/ipcContract";
import type { DirtyLeaveRegistry } from "./useDirtyLeaveGuard";

export interface RestoreOffer {
  path: string;
  draft: RecoveryDraft;
  /** The file's current hash differs from the draft's `expectedHash` (FR-551). */
  changedOnDisk: boolean;
}

export type RestoreChoice = "restore" | "discard" | "later";

export interface UseRecoveryRestoreOptions {
  api: GitHydraApi;
  /** The open repo's `state.workdir`; `null` while none is open. */
  repoPath: string | null;
  /** The repo finished opening (`graph.status === "ready"`). */
  ready: boolean;
  /** Changes on every open (including a restored tab's first activation, restore-tabs-on-relaunch.md FR-210). */
  openSequence: number;
  /** Another modal is open; the offer waits (FR-549 queueing). */
  modalOpen: boolean;
  dirtyGuard: DirtyLeaveRegistry;
  onRestore: (offer: { path: string; draft: RecoveryDraft }) => void;
}

/**
 * specs/edit-recovery-draft.md FR-549..552: the offer chain. Newest draft first, one at a time, and it ends after a Restore; never prompts over another
 * modal or a dirty editor buffer (it waits), and re-validates the file after the wait since the disk may have moved on.
 */
export function useRecoveryRestore({ api, repoPath, ready, openSequence, modalOpen, dirtyGuard, onRestore }: UseRecoveryRestoreOptions) {
  const [offer, setOffer] = useState<RestoreOffer | null>(null);
  const [draftCount, setDraftCount] = useState(0);
  const [, bumpDirty] = useReducer((n: number) => n + 1, 0);
  const chainRef = useRef(0);
  const answerRef = useRef<((c: RestoreChoice) => void) | null>(null);
  const waitersRef = useRef<Array<() => void>>([]);
  const onRestoreRef = useRef(onRestore);
  onRestoreRef.current = onRestore;
  const apiRef = useRef(api);
  apiRef.current = api;

  useEffect(() => dirtyGuard.subscribe(bumpDirty), [dirtyGuard]);
  const blocked = modalOpen || dirtyGuard.isDirty();
  const blockedRef = useRef(blocked);
  blockedRef.current = blocked;
  useEffect(() => {
    if (blocked) return;
    const w = waitersRef.current;
    waitersRef.current = [];
    w.forEach((f) => f());
  }, [blocked]);

  const cancelChain = useCallback(() => {
    chainRef.current += 1;
    // Release anything parked on the wait or on the dialog; the stale check then ends the chain.
    const w = waitersRef.current;
    waitersRef.current = [];
    w.forEach((f) => f());
    answerRef.current?.("later");
    answerRef.current = null;
  }, []);

  const runChain = useCallback(
    async (repo: string) => {
      const a = apiRef.current;
      if (typeof a.listDrafts !== "function") return;
      cancelChain();
      const token = chainRef.current;
      const stale = () => chainRef.current !== token;
      const waitUnblocked = async () => {
        while (blockedRef.current && !stale()) await new Promise<void>((resolve) => waitersRef.current.push(resolve));
      };
      try {
        const listed = await a.listDrafts(repo);
        if (stale()) return;
        if (!listed.ok) return;
        let remaining = listed.data.length;
        setDraftCount(remaining);
        for (const meta of listed.data) {
          if (stale()) return;
          const read = await a.readDraft(repo, meta.relativePath);
          if (stale()) return;
          if (!read.ok) continue;
          if (read.data === null) {
            setDraftCount(--remaining);
            continue;
          }
          const draft = read.data;
          await waitUnblocked();
          if (stale()) return;
          const probe = await a.probeEditableFile(meta.relativePath);
          if (stale()) return;
          // Ineligible for any other reason: no prompt, keep the draft until it expires (FR-549).
          if (!probe.ok) continue;
          if (!probe.data.eligible) {
            if (probe.data.reason === "deleted") {
              await a.deleteDraft(repo, meta.relativePath);
              setDraftCount(--remaining);
            }
            continue;
          }
          const disk = await a.readEditableFile(meta.relativePath);
          if (stale()) return;
          if (!disk.ok || !disk.data.eligible) continue;
          // The file read took time; a modal may have opened meanwhile.
          await waitUnblocked();
          if (stale()) return;
          const choice = await new Promise<RestoreChoice>((resolve) => {
            answerRef.current = resolve;
            setOffer({ path: meta.relativePath, draft, changedOnDisk: disk.data.eligible && disk.data.contentHash !== draft.expectedHash });
          });
          answerRef.current = null;
          setOffer(null);
          if (stale()) return;
          // One restore per open: a second dirty buffer would only queue behind the first; the rest stay on the palette command.
          if (choice === "restore") {
            onRestoreRef.current({ path: meta.relativePath, draft });
            return;
          } else if (choice === "discard") {
            await a.deleteDraft(repo, meta.relativePath);
            setDraftCount(--remaining);
          } else return;
        }
      } catch {
        /* an offer is a convenience; a failed IPC just means no prompt this time */
      }
    },
    [cancelChain],
  );

  const key = ready && repoPath ? `${repoPath}\n${openSequence}` : null;
  useEffect(() => {
    if (key === null || !repoPath) {
      cancelChain();
      setOffer(null);
      setDraftCount(0);
      return;
    }
    void runChain(repoPath);
    return () => cancelChain();
    // `key` already encodes repoPath and openSequence; runChain/cancelChain are stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const answer = useCallback((c: RestoreChoice) => answerRef.current?.(c), []);
  const restoreNow = useCallback(() => {
    if (repoPath && ready) void runChain(repoPath);
  }, [ready, repoPath, runChain]);
  /** Cheap recount for the palette entry's enabled state (FR-552). */
  const refreshCount = useCallback(async () => {
    const a = apiRef.current;
    if (!repoPath || typeof a.listDrafts !== "function") return;
    try {
      const r = await a.listDrafts(repoPath);
      if (r.ok) setDraftCount(r.data.length);
    } catch {
      /* keep the last count */
    }
  }, [repoPath]);

  return { offer, answer, hasDrafts: draftCount > 0, restoreNow, refreshCount, dialogOpen: offer !== null };
}
