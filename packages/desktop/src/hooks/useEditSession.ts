// SPDX-License-Identifier: GPL-3.0-or-later
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import type { EditProbeEligible, LineEnding } from "@githydra/git-core";
import type { GitHydraApi } from "../../shared/ipcContract";
import type { CodeEditorHandle } from "../components/CodeEditor/CodeEditor";
import { SAVE_ERROR_SUMMARY, detectIndentUnit, formatSavedAt, type EditOpenTarget } from "../lib/editFile";
import { unwrap } from "./gitHydraClient";
import { useRecoveryDraft } from "./useRecoveryDraft";

/** What the write needs to hand back verbatim (FR-469/FR-471). */
export interface EditMeta {
  eol: LineEnding;
  hasBom: boolean;
  finalNewline: boolean;
  hasStagedContent: boolean;
  isNew: boolean;
  isUntracked: boolean;
}

export type EditLoad =
  | { status: "loading" }
  | { status: "ineligible"; message: string }
  | { status: "error"; message: string }
  | { status: "ready" };

export interface EditBanner {
  summary: string;
  details: string;
}

export interface ExternalChange {
  /** Hash of what is on disk now; Reload adopts it, Keep mine leaves the baseline alone so Save still asks (FR-474). */
  hash: string;
  content: string;
  meta: EditMeta;
  unavailable: string | null;
}

export type EditStatus = { kind: "saved"; at: string; staged: boolean } | { kind: "reloaded" } | null;

export interface EditorInit {
  value: string;
  caret: { line: number; column: number } | null;
  indentUnit: string;
  seq: number;
  /** Saved baseline when it is not `value` (a restored draft is dirty against the disk text, FR-550). */
  baseValue?: string;
}

export interface UseEditSessionOptions {
  api: GitHydraApi;
  path: string;
  open: EditOpenTarget;
  editorRef: RefObject<CodeEditorHandle | null>;
  /** specs/live-refresh.md: bumps after each completed working-tree read; one trigger for the disk re-check. */
  liveRevision?: number;
  /** FR-475: after a write (and stage) refresh the diff and the Changes list through the normal path. */
  onSaved: () => void;
  /** The open repo's working-tree path, the key for recovery drafts (specs/edit-recovery-draft.md FR-554); omitted: no drafts. */
  repoPath?: string | null;
}

const metaOf = (d: EditProbeEligible & { eol: LineEnding; hasBom: boolean; finalNewline: boolean }): EditMeta => ({
  eol: d.eol,
  hasBom: d.hasBom,
  finalNewline: d.finalNewline,
  hasStagedContent: d.hasStagedContent,
  isNew: d.isNew,
  isUntracked: d.isUntracked,
});

const failureText = (r: { code: string; message: string }): string => `${r.code}: ${r.message}`;

/**
 * specs/edit-in-diff.md FR-470..475, FR-530, FR-535, FR-537: the editor's data side. Reads the working copy, writes it
 * with the hash guard, stages on request, watches the disk for outside changes, and owns the overwrite/reload/leave prompts'
 * state. The text itself lives in CodeMirror (`editorRef`), never in React state.
 */
export function useEditSession({ api, path, open, editorRef, liveRevision, onSaved, repoPath }: UseEditSessionOptions) {
  const [load, setLoad] = useState<EditLoad>({ status: "loading" });
  const [meta, setMeta] = useState<EditMeta | null>(null);
  const [init, setInit] = useState<EditorInit | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<EditStatus>(null);
  const [savedOnce, setSavedOnce] = useState(false);
  const [error, setError] = useState<EditBanner | null>(null);
  const [external, setExternal] = useState<ExternalChange | null>(null);
  const [keptMine, setKeptMine] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const [overwrite, setOverwrite] = useState<{ andStage: boolean } | null>(null);
  const [reloadAsk, setReloadAsk] = useState(false);
  const [leaveAsk, setLeaveAsk] = useState(false);

  const metaRef = useRef<EditMeta | null>(null);
  const hashRef = useRef("");
  const dirtyRef = useRef(false);
  dirtyRef.current = dirty;
  const savingRef = useRef(false);
  const aliveRef = useRef(true);
  // Bumped when a write starts and finishes: a disk check that began before cannot report on a file we just wrote ourselves (FR-536).
  const writeEpochRef = useRef(0);
  const externalHashRef = useRef<string | null>(null);
  const externalRef = useRef<ExternalChange | null>(null);
  externalRef.current = external;
  const overwriteResolve = useRef<((ok: boolean) => void) | null>(null);
  const leavePromise = useRef<Promise<boolean> | null>(null);
  const leaveResolve = useRef<((ok: boolean) => void) | null>(null);
  const leaveFocusRef = useRef<HTMLElement | null>(null);
  const initSeq = useRef(0);
  const loadRef = useRef<EditLoad["status"]>("loading");
  loadRef.current = load.status;

  const draft = useRecoveryDraft({
    api,
    repoPath: repoPath ?? null,
    path,
    editorRef,
    getContext: () =>
      loadRef.current === "ready" && metaRef.current && externalRef.current?.unavailable == null
        ? { eol: metaRef.current.eol, hasBom: metaRef.current.hasBom, finalNewline: metaRef.current.finalNewline, expectedHash: hashRef.current }
        : null,
  });

  const announce = useCallback((text: string) => {
    // An identical repeat would not change the region's text and so stay silent; a trailing no-break space makes it a change.
    setAnnouncement((prev) => (prev === text ? `${text} ` : text));
  }, []);

  const adoptMeta = (m: EditMeta) => {
    metaRef.current = m;
    setMeta(m);
  };

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      overwriteResolve.current?.(false);
      leaveResolve.current?.(false);
    };
  }, []);

  // Initial read: always the WORKING copy (FR-467).
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      let r: Awaited<ReturnType<GitHydraApi["readEditableFile"]>>;
      try {
        r = await api.readEditableFile(path);
      } catch (e) {
        if (!cancelled) setLoad({ status: "error", message: e instanceof Error ? e.message : String(e) });
        return;
      }
      if (cancelled) return;
      if (!r.ok) return setLoad({ status: "error", message: r.message });
      if (!r.data.eligible) return setLoad({ status: "ineligible", message: r.data.message });
      const rs = open.restore;
      // A restored draft keeps its OLD hash so the FR-473 banner and FR-474 overwrite guard cover a changed file.
      hashRef.current = rs ? rs.expectedHash : r.data.contentHash;
      adoptMeta(rs ? { ...metaOf(r.data), eol: rs.eol, hasBom: rs.bom, finalNewline: rs.finalNewline } : metaOf(r.data));
      setInit({
        value: rs ? rs.content : r.data.content,
        baseValue: rs ? r.data.content : undefined,
        indentUnit: detectIndentUnit(rs ? rs.content : r.data.content),
        caret: open.line ? { line: open.line, column: open.column ?? 0 } : null,
        seq: ++initSeq.current,
      });
      setLoad({ status: "ready" });
    })();
    return () => {
      cancelled = true;
    };
    // The target is consumed once, at open: a later prop change must not re-read over the user's edits.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, path]);

  const applyDiskContent = useCallback(
    (content: string, hash: string, m: EditMeta, caretFromEditor: boolean) => {
      const ed = editorRef.current;
      const wasVerbatim = metaRef.current?.eol === "mixed";
      hashRef.current = hash;
      adoptMeta(m);
      setExternal(null);
      setKeptMine(false);
      externalHashRef.current = null;
      if (ed && wasVerbatim === (m.eol === "mixed")) ed.replaceAll(content);
      else {
        const c = caretFromEditor && ed ? ed.getCursor() : null;
        setInit({ value: content, indentUnit: detectIndentUnit(content), caret: c, seq: ++initSeq.current });
        setDirty(false);
      }
    },
    [editorRef],
  );

  // FR-472..474: re-read the file and compare hashes. Quiet reload when clean, banner when dirty.
  const checkDisk = useCallback(async () => {
    if (savingRef.current || !aliveRef.current || loadRef.current !== "ready") return;
    const epoch = writeEpochRef.current;
    let r;
    try {
      r = await api.readEditableFile(path);
    } catch {
      return;
    }
    if (!aliveRef.current || epoch !== writeEpochRef.current || savingRef.current) return;
    if (!r.ok) return;
    // Never rewrite the document under an IME composition: try again once it has ended.
    if (editorRef.current?.isComposing()) {
      setTimeout(() => void checkRef.current(), 300);
      return;
    }
    if (!r.data.eligible) {
      const msg = r.data.message;
      if (externalHashRef.current === `gone:${msg}`) return;
      externalHashRef.current = `gone:${msg}`;
      // specs/edit-recovery-draft.md FR-546: a vanished file has nothing to restore onto, so no prompt, just delete.
      // A single "deleted" read can be an editor's save-by-rename gap, so look again before dropping the draft.
      if (r.data.reason === "deleted") {
        setTimeout(() => {
          void (async () => {
            try {
              const again = await api.probeEditableFile(path);
              if (!aliveRef.current) return;
              if (again.ok && again.data.eligible) {
                if (dirtyRef.current) draft.resume();
                return;
              }
              if (again.ok && again.data.reason === "deleted") void draft.deleteNow();
            } catch {
              /* unknown: keep the draft */
            }
          })();
        }, 1000);
      }
      setExternal({ hash: "", content: "", meta: metaRef.current!, unavailable: msg });
      announce(`${msg}. Your editor still holds the last version.`);
      return;
    }
    const { contentHash: hash, content } = r.data;
    if (hash === hashRef.current) {
      if (externalHashRef.current?.startsWith("gone:") && dirtyRef.current) draft.resume();
      externalHashRef.current = null;
      setExternal(null);
      return;
    }
    const m = metaOf(r.data);
    if (!dirtyRef.current) {
      applyDiskContent(content, hash, m, true);
      setStatus({ kind: "reloaded" });
      announce("File reloaded from disk (changed outside GitHydra).");
      return;
    }
    if (externalHashRef.current === hash) return;
    externalHashRef.current = hash;
    setKeptMine(false);
    setExternal({ hash, content, meta: m, unavailable: null });
    announce("The file changed on disk. Your unsaved edits were kept.");
  }, [announce, api, applyDiskContent, draft.deleteNow, draft.resume, path]);

  const checkRef = useRef(checkDisk);
  checkRef.current = checkDisk;
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleCheck = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      void checkRef.current();
    }, 120);
  }, []);
  // FR-551: a restored draft carries an old hash, so compare with the disk once it is loaded to raise the FR-473 banner.
  useEffect(() => {
    if (load.status === "ready" && open.restore) scheduleCheck();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load.status]);
  useEffect(() => {
    const off = api.onWorktreeChanged?.(scheduleCheck);
    return () => {
      off?.();
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [api, scheduleCheck]);
  const firstRevision = useRef(liveRevision);
  useEffect(() => {
    if (liveRevision === firstRevision.current) return;
    firstRevision.current = liveRevision;
    scheduleCheck();
  }, [liveRevision, scheduleCheck]);

  // Undoing back to clean while an outside change is pending: take it quietly rather than keep a banner for nothing (FR-472).
  useEffect(() => {
    if (!dirty && external && !external.unavailable) scheduleCheck();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dirty]);

  // A reload note is stale the moment the user edits on top of it.
  useEffect(() => {
    if (dirty) setStatus((s) => (s?.kind === "reloaded" ? null : s));
  }, [dirty]);

  const refreshProbe = useCallback(async () => {
    try {
      const p = await api.probeEditableFile(path);
      if (p.ok && p.data.eligible && metaRef.current && aliveRef.current) {
        adoptMeta({ ...metaRef.current, hasStagedContent: p.data.hasStagedContent, isNew: p.data.isNew, isUntracked: p.data.isUntracked });
      }
    } catch {
      /* the note is advisory; a failed probe leaves the last answer */
    }
  }, [api, path]);

  /**
   * FR-470/FR-530: write, then optionally stage the whole file. Resolves true when the buffer's text is on disk (and, for
   * `andStage`, staged); false for a cancelled overwrite, a refused write, or a failed stage. A stage failure after a good
   * write leaves the file saved and the buffer clean (FR-530).
   */
  const save = useCallback(
    async (andStage: boolean, opts: { stageOnly?: boolean } = {}): Promise<boolean> => {
      const ed = editorRef.current;
      const m = metaRef.current;
      if (!ed || !m || savingRef.current) return false;
      // Staging a clean buffer stages whatever is on disk, so refuse while disk and editor disagree: a deleted or
      // changed file must not be staged by a stale "Save and stage".
      if (opts.stageOnly && (externalHashRef.current !== null || externalRef.current !== null)) {
        announce("The file changed on disk. Resolve that before staging.");
        return false;
      }
      savingRef.current = true;
      setSaving(true);
      writeEpochRef.current++;
      setError(null);
      try {
        let wrote = false;
        if (!opts.stageOnly) {
          let force = false;
          for (;;) {
            const snap = ed.snapshot();
            const content = ed.getValue();
            const r = await api.writeEditedFile(path, content, {
              expectedHash: hashRef.current,
              eol: m.eol,
              hasBom: m.hasBom,
              finalNewline: m.finalNewline,
              force,
            });
            if (!r.ok) {
              setError({ summary: SAVE_ERROR_SUMMARY, details: failureText(r) });
              announce("Couldn't save. Your edits are kept.");
              return false;
            }
            if (r.data.status === "written") {
              hashRef.current = r.data.contentHash;
              ed.markSaved(snap);
              wrote = true;
              break;
            }
            if (r.data.status === "ineligible") {
              setError({ summary: SAVE_ERROR_SUMMARY, details: `${r.data.reason}: ${r.data.message}` });
              announce("Couldn't save. Your edits are kept.");
              return false;
            }
            // changed-on-disk (FR-474): never overwrite without an explicit yes, Cancel focused.
            const confirmed = await new Promise<boolean>((resolve) => {
              overwriteResolve.current = resolve;
              setOverwrite({ andStage });
            });
            overwriteResolve.current = null;
            setOverwrite(null);
            if (!confirmed || !aliveRef.current) return false;
            force = true;
          }
        }
        if (wrote) {
          await draft.afterSave();
          setExternal(null);
          setKeptMine(false);
          externalHashRef.current = null;
          setSavedOnce(true);
        }
        let staged = false;
        if (andStage) {
          try {
            unwrap(await api.stageFile(path));
            staged = true;
          } catch (e) {
            setError({
              summary: wrote ? "Saved, but staging failed. The file is saved; nothing was staged." : "Couldn't stage the file.",
              details: e instanceof Error ? e.message : String(e),
            });
            announce("Saved, but staging failed.");
          }
        }
        const at = formatSavedAt(new Date());
        if (wrote || staged) setStatus({ kind: "saved", at, staged });
        if (wrote && (!andStage || staged)) {
          announce(staged ? "Saved and staged." : metaRef.current?.hasStagedContent ? "Saved the working copy. Your staged version is unchanged." : "Saved.");
        } else if (staged) announce("Staged the whole file.");
        onSaved();
        void refreshProbe();
        return !andStage || staged;
      } catch (e) {
        setError({ summary: SAVE_ERROR_SUMMARY, details: e instanceof Error ? e.message : String(e) });
        announce("Couldn't save. Your edits are kept.");
        return false;
      } finally {
        writeEpochRef.current++;
        savingRef.current = false;
        if (aliveRef.current) setSaving(false);
      }
    },
    [announce, api, draft.afterSave, editorRef, onSaved, path, refreshProbe],
  );

  const answerOverwrite = useCallback((ok: boolean) => overwriteResolve.current?.(ok), []);

  /** FR-473: Reload discards the dirty buffer, so the caller shows a ConfirmDialog first. */
  const confirmReload = useCallback(() => {
    setReloadAsk(false);
    const ext = external;
    if (!ext || ext.unavailable !== null) return;
    applyDiskContent(ext.content, ext.hash, ext.meta, true);
    void draft.deleteNow();
    setStatus({ kind: "reloaded" });
    announce("Reloaded from disk. Your unsaved edits were discarded.");
  }, [announce, applyDiskContent, draft.deleteNow, external]);

  const keepMine = useCallback(() => {
    setKeptMine(true);
    announce("Keeping your version. Saving will ask before it overwrites the file on disk.");
    editorRef.current?.focus();
  }, [announce, editorRef]);

  /** FR-535: ask the user, resolve true when the caller may drop the editor. */
  const requestLeave = useCallback((): Promise<boolean> => {
    if (!dirtyRef.current) return Promise.resolve(true);
    if (leavePromise.current) return leavePromise.current;
    leaveFocusRef.current = document.activeElement as HTMLElement | null;
    const p = new Promise<boolean>((resolve) => {
      leaveResolve.current = (ok) => {
        leaveResolve.current = null;
        leavePromise.current = null;
        setLeaveAsk(false);
        resolve(ok);
      };
    });
    leavePromise.current = p;
    setLeaveAsk(true);
    return p;
  }, []);

  const leaveSave = useCallback(async () => {
    const ok = (await save(false)) && !editorRef.current?.isDirty();
    if (!ok) {
      const el = leaveFocusRef.current;
      (el?.isConnected && el.closest(".gh-edit") ? el : null)?.focus();
    }
    leaveResolve.current?.(ok);
  }, [save, editorRef]);
  // The delete is awaited so it reaches main before the tab, repo or window goes away (specs/edit-recovery-draft.md FR-546).
  const discardingRef = useRef(false);
  const leaveDiscard = useCallback(async () => {
    const resolve = leaveResolve.current;
    if (!resolve || discardingRef.current) return;
    discardingRef.current = true;
    try {
      await draft.deleteNow();
    } finally {
      discardingRef.current = false;
    }
    resolve(true);
  }, [draft.deleteNow]);
  const leaveCancel = useCallback(() => {
    // A Discard is already deleting; letting Cancel through would keep a buffer whose draft is gone.
    if (discardingRef.current) return;
    leaveResolve.current?.(false);
    // Closing the prompt hands focus back to where it was (FR-538).
    const el = leaveFocusRef.current;
    // Back to where focus was, unless that was the file row the user clicked to leave: staying means staying in the editor.
    setTimeout(() => (el?.isConnected && el.closest(".gh-edit") ? el.focus() : editorRef.current?.focus()), 0);
  }, [editorRef]);

  return {
    load,
    meta,
    init,
    dirty,
    setDirty,
    saving,
    status,
    savedOnce,
    error,
    dismissError: () => setError(null),
    external,
    keptMine,
    announcement,
    announce,
    overwrite,
    answerOverwrite,
    reloadAsk,
    setReloadAsk,
    confirmReload,
    keepMine,
    dismissExternal: () => setExternal(null),
    leaveAsk,
    requestLeave,
    leaveSave,
    leaveDiscard,
    leaveCancel,
    save,
    draftUnavailable: draft.unavailable,
    onEditorChange: draft.onEditorChange,
    onEditorBlur: draft.onEditorBlur,
  };
}
