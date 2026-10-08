// SPDX-License-Identifier: GPL-3.0-or-later
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import type { GitHydraApi } from "../../shared/ipcContract";
import type { CodeEditorHandle } from "../components/CodeEditor/CodeEditor";

export const DRAFT_DEBOUNCE_MS = 2000;
// A hung IPC must never hold up a leave or the app close (FR-548); main's own hang timer is longer.
const DELETE_WAIT_MS = 2000;
// Continuous typing never leaves a quiet 2 s, so the debounce is capped (FR-545 intent: lose little on a crash).
const DRAFT_MAX_WAIT_MS = 10_000;

export interface DraftContext {
  eol: "lf" | "crlf" | "mixed";
  hasBom: boolean;
  finalNewline: boolean;
  /** The session's recorded FR-474 hash. */
  expectedHash: string;
}

export interface UseRecoveryDraftOptions {
  api: GitHydraApi;
  /** The open repo's `state.workdir`; `null` disables the feature (no repo identity, nothing to key on). */
  repoPath: string | null;
  path: string;
  editorRef: RefObject<CodeEditorHandle | null>;
  /** `null` until the file is loaded and eligible (FR-545: nothing is written for ineligible files). */
  getContext: () => DraftContext | null;
}

/**
 * specs/edit-recovery-draft.md FR-545/546/548: the write side of the recovery draft. Debounced write while the buffer
 * differs from its base, immediate on blur / window hidden / unmount; every delete cancels the pending write and blocks
 * the unmount flush so a late write can never resurrect a deleted draft. Policy lives here; main only stores.
 */
export function useRecoveryDraft({ api, repoPath, path, editorRef, getContext }: UseRecoveryDraftOptions) {
  const [unavailable, setUnavailable] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Set by any delete; cleared by the next buffer change. Stops blur/unmount flushes after a Discard or Save.
  const blockedRef = useRef(false);
  const tooLargeAtRef = useRef<number | null>(null);
  const aliveRef = useRef(true);
  const firstPendingRef = useRef<number | null>(null);
  const lastWrittenRef = useRef<string | null>(null);
  const ctxRef = useRef({ api, repoPath, path, getContext });
  ctxRef.current = { api, repoPath, path, getContext };

  const clearTimer = () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
  };

  const write = useCallback(async () => {
    clearTimer();
    firstPendingRef.current = null;
    const { api: a, repoPath: repo, path: p, getContext: ctxOf } = ctxRef.current;
    const ed = editorRef.current;
    const ctx = ctxOf();
    if (!repo || !ed || !ctx || blockedRef.current || !ed.getView() || !ed.isDirty()) return;
    const content = ed.getValue();
    if (tooLargeAtRef.current !== null && content.length >= tooLargeAtRef.current) return;
    if (content === lastWrittenRef.current) return;
    try {
      const r = await a.writeDraft(repo, p, {
        content,
        bom: ctx.hasBom,
        eol: ctx.eol,
        finalNewline: ctx.finalNewline,
        expectedHash: ctx.expectedHash,
      });
      if (!aliveRef.current) return;
      if (r.ok) {
        // `superseded` means a newer write or a delete outranked this one: not a failure.
        if (r.data.status === "saved") lastWrittenRef.current = content;
        setUnavailable(false);
        return;
      }
      if (r.code === "no-repository") return;
      if (r.code === "content-too-large") tooLargeAtRef.current = content.length;
      setUnavailable(true);
    } catch {
      if (aliveRef.current) setUnavailable(true);
    }
  }, [editorRef]);

  const schedule = useCallback(() => {
    clearTimer();
    const now = Date.now();
    firstPendingRef.current ??= now;
    const wait = Math.max(0, Math.min(DRAFT_DEBOUNCE_MS, firstPendingRef.current + DRAFT_MAX_WAIT_MS - now));
    timerRef.current = setTimeout(() => void write(), wait);
  }, [write]);

  /** Best-effort and never throws or blocks for long; resolves true only when main confirmed the delete. */
  const deleteNow = useCallback(async (): Promise<boolean> => {
    clearTimer();
    firstPendingRef.current = null;
    // Stays blocked even on failure: a Discarded buffer must not write the draft back on unmount.
    blockedRef.current = true;
    const { api: a, repoPath: repo, path: p } = ctxRef.current;
    if (!repo) return false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const r = await Promise.race([
        a.deleteDraft(repo, p),
        new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), DELETE_WAIT_MS);
        }),
      ]);
      if (r !== null && r.ok) {
        lastWrittenRef.current = null;
        return true;
      }
    } catch {
      /* the draft expires on its own (FR-547); a failed delete must not block leaving */
    } finally {
      if (timer) clearTimeout(timer);
    }
    return false;
  }, []);

  /** The draft was kept after all (a vanished file came back, or a prompt was cancelled): writes may resume. */
  const resume = useCallback(() => {
    blockedRef.current = false;
    if (editorRef.current?.isDirty()) schedule();
  }, [editorRef, schedule]);

  /** Wire to the editor's every document change. */
  const onEditorChange = useCallback(() => {
    const ed = editorRef.current;
    if (!ed) return;
    blockedRef.current = false;
    // A change event with a clean buffer is only ever the transition back to the base text (FR-545).
    if (ed.isDirty()) schedule();
    else void deleteNow();
  }, [deleteNow, editorRef, schedule]);

  const onEditorBlur = useCallback(() => {
    void write();
  }, [write]);

  /** After a successful write to the real file: the draft is obsolete, but typing during the save still needs one. */
  const afterSave = useCallback(async () => {
    await deleteNow();
    const ed = editorRef.current;
    if (ed?.isDirty()) {
      blockedRef.current = false;
      schedule();
    }
  }, [deleteNow, editorRef, schedule]);

  useEffect(() => {
    aliveRef.current = true;
    const onVis = () => {
      if (document.visibilityState === "hidden") void write();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      aliveRef.current = false;
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [write]);

  // Layout cleanup runs before CodeEditor's own passive cleanup destroys the view, so the text is still readable.
  useLayoutEffect(
    () => () => {
      void write();
      clearTimer();
    },
    [write],
  );

  return { unavailable, onEditorChange, onEditorBlur, deleteNow, afterSave, resume };
}
