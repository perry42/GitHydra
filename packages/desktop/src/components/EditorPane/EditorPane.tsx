// SPDX-License-Identifier: GPL-3.0-or-later
import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MutableRefObject, type ReactNode } from "react";
import type { GitHydraApi } from "../../../shared/ipcContract";
import { useEditSession } from "../../hooks/useEditSession";
import { useConflictEditorContext } from "../../hooks/useConflictEditorContext";
import { EMPTY_SUMMARY, gateReason, plural, type ConflictEvent, type ConflictSummary } from "../../lib/conflictModel";
import { useRegisterDirtyLeaveSource, type DirtyLeaveRegistry } from "../../hooks/useDirtyLeaveGuard";
import {
  ALREADY_STAGED_LINE_NOTE,
  NO_EDITS_REASON,
  RECOVERY_UNAVAILABLE_NOTE,
  SAVE_AND_STAGE_WHOLE_TIP,
  STAGED_COPY_NOTE,
  baseName,
  dirName,
  footerText,
  type EditOpenTarget,
  type EditorCommandState,
  type EditorCommands,
} from "../../lib/editFile";
import { isMac } from "../../lib/platform";
import { ConfirmDialog } from "../ConfirmDialog/ConfirmDialog";
import { CodeEditor, type CodeEditorHandle } from "../CodeEditor/CodeEditor";
import { IconBack, IconCheck, IconInfo, IconMerge, IconPencil, IconWarning } from "../Icon/Icon";
import { ConflictNav, ConflictReference, ConflictToast, UndoRedo } from "./ConflictChrome";
import "./EditorPane.css";

export interface EditorPaneProps {
  api: GitHydraApi;
  /** Repo-relative path; the pane is keyed by it, never by Staged/Unstaged section (FR-532). */
  path: string;
  open: EditOpenTarget;
  guard: DirtyLeaveRegistry;
  liveRevision?: number;
  /** The index differs from the working copy (the file is listed under Unstaged or Untracked), so staging is meaningful even when clean (FR-530). */
  indexDiffersFromWorkingCopy: boolean;
  /** FR-540: the combined diff reports the file as ambiguous, i.e. a saved edit landed on an already-staged line. */
  lineWasStaged: boolean;
  /** `returnFocus`: the user chose to leave (Back/Esc) so focus belongs on the Edit button (FR-538). */
  onClose: (opts: { returnFocus: boolean }) => void;
  onSaved: () => void;
  onDirtyChange?: (dirty: boolean) => void;
  /** FR-533: filled with Save / Save and stage while mounted, so the Command Palette acts on this very editor. */
  commandsRef?: MutableRefObject<EditorCommands | null>;
  /** FR-533: what the palette may offer right now; `null` once the editor closes. */
  onCommandStateChange?: (state: EditorCommandState | null) => void;
  /** A modal inside the pane is open; the global keybinding layer stands down (FR-221). */
  onDialogOpenChange?: (open: boolean) => void;
  /** The open repo's working-tree path: the recovery-draft key (specs/edit-recovery-draft.md FR-554). Omitted: no drafts. */
  repoPath?: string | null;
  /** specs/edit-in-diff.md FR-563: Mark as resolved staged the file (the Changes list and graph refresh, the self-write gate closes). */
  onResolved?: () => void;
  onMutationStart?: () => void;
  onMutationSettled?: () => void;
}

function Alert({
  tone,
  summary,
  details,
  actions,
  onDismiss,
  detailsId,
}: {
  tone: "warn" | "error";
  summary: string;
  details: ReactNode;
  actions?: ReactNode;
  onDismiss?: () => void;
  detailsId: string;
}) {
  const [open, setOpen] = useState(false);
  useEffect(() => setOpen(false), [summary]);
  return (
    <div className={`gh-edit__alert gh-edit__alert--${tone}`} role="alert">
      <div className="gh-edit__alert-row">
        <IconWarning size={14} />
        <span className="gh-edit__alert-sum" title={summary}>
          {summary}
        </span>
        {actions}
        <button type="button" className="gh-edit__link" aria-expanded={open} aria-controls={detailsId} onClick={() => setOpen((o) => !o)}>
          {open ? "Hide details" : "Show details"}
        </button>
        {onDismiss && (
          <button type="button" className="gh-edit__link" onClick={onDismiss}>
            Dismiss
          </button>
        )}
      </div>
      {open && (
        <div id={detailsId} className="gh-edit__alert-details" tabIndex={0} role="region" aria-label="Details">
          {details}
        </div>
      )}
    </div>
  );
}

/**
 * specs/edit-in-diff.md FR-467..475, FR-528..540: the editor that replaces the diff in the Changes panel's diff column. All
 * data work is in `useEditSession`; this component is header, notes, banners, footer and the three prompts.
 * Not built in this slice: Expand, Compare, gutter markers/peek (specs/edit-in-diff.md "Build slices", slice C).
 */
export function EditorPane({
  api,
  path,
  open,
  guard,
  liveRevision,
  indexDiffersFromWorkingCopy,
  lineWasStaged,
  onClose,
  onSaved,
  onDirtyChange,
  commandsRef,
  onCommandStateChange,
  onDialogOpenChange,
  repoPath,
  onResolved,
  onMutationStart,
  onMutationSettled,
}: EditorPaneProps) {
  const editorRef = useRef<CodeEditorHandle | null>(null);
  const rootRef = useRef<HTMLElement | null>(null);
  const toolbarRef = useRef<HTMLDivElement | null>(null);
  const uid = useId();
  const footId = `${uid}-foot`;
  const noteId = `${uid}-note`;
  const [cursor, setCursor] = useState({ line: 1, col: 1 });
  const s = useEditSession({ api, path, open, editorRef, liveRevision, onSaved, repoPath, onResolved, onMutationStart, onMutationSettled });
  const { dirty, meta } = s;
  const mac = isMac();
  const mod = mac ? "⌘" : "Ctrl";
  const shift = mac ? "⇧" : "Shift";

  // specs/edit-in-diff.md FR-556: decided once per open from the first probe, so a later "no longer conflicted" never remounts the editor.
  const conflictFirst = useRef<boolean | null>(null);
  if (meta && conflictFirst.current === null) conflictFirst.current = meta.conflicted;
  const conflictEligible = conflictFirst.current === true;
  const cctx = useConflictEditorContext(api, path, conflictEligible);
  const layerOn = conflictEligible && cctx.status === "ready" && !cctx.notUnmerged;
  const conflictUi = layerOn && meta?.conflicted === true && !s.resolvedDone;
  const ctxWait = conflictEligible && cctx.status !== "ready";
  const [summary, setSummary] = useState<ConflictSummary>(EMPTY_SUMMARY);
  const [toast, setToast] = useState<string | null>(null);
  const [flash, setFlash] = useState(0);
  const reasonRef = useRef<HTMLParagraphElement | null>(null);
  const announceRef = useRef(s.announce);
  announceRef.current = s.announce;
  const onConflictEvent = useCallback((e: ConflictEvent) => {
    announceRef.current(e.status);
    setToast(e.type === "advance" ? `Moved to conflict ${e.toN} of ${e.total}, the next unresolved one.` : null);
  }, []);
  const conflictOptions = useMemo(
    () => (layerOn ? { names: cctx.names, sidesOk: cctx.sidesOk, sidesReason: cctx.sidesReason, onSummary: setSummary, onEvent: onConflictEvent } : undefined),
    [layerOn, cctx.names, cctx.sidesOk, cctx.sidesReason, onConflictEvent],
  );
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 8000);
    return () => clearTimeout(t);
  }, [toast]);
  // The file left the unmerged state (resolved here or outside): drop the block layer, keep the text.
  useEffect(() => {
    if (layerOn && !conflictUi && summary.enabled) editorRef.current?.getConflict()?.disable();
  }, [layerOn, conflictUi, summary.enabled]);
  // Until the first summary arrives nothing is known about the markers, so the gate stays shut rather than flashing open.
  const gate = conflictUi ? (summary.enabled ? gateReason(summary.markerLines) : "Reading the conflicts…") : null;
  const cf = () => editorRef.current?.getConflict() ?? null;

  const dialogOpen = s.leaveAsk || s.overwrite !== null || s.reloadAsk;
  useEffect(() => {
    onDialogOpenChange?.(dialogOpen);
  }, [dialogOpen, onDialogOpenChange]);
  useEffect(() => () => onDialogOpenChange?.(false), [onDialogOpenChange]);
  // A closed prompt must not strand focus on <body> (FR-538); Ctrl+S is scoped to the pane, so it would also stop working.
  const wasDialogOpen = useRef(false);
  useEffect(() => {
    if (wasDialogOpen.current && !dialogOpen) {
      setTimeout(() => {
        const a = document.activeElement;
        if ((!a || a === document.body) && editorRef.current) editorRef.current.focus();
      }, 0);
    }
    wasDialogOpen.current = dialogOpen;
  }, [dialogOpen]);
  useEffect(() => {
    onDirtyChange?.(dirty);
    // The app-close guard mirrors the registry's dirty state to main (FR-535).
    guard.notify();
  }, [dirty, onDirtyChange, guard]);
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);

  useRegisterDirtyLeaveSource(guard, { isDirty: () => dirty, requestLeave: s.requestLeave });

  const leave = useCallback(async () => {
    if (await guard.confirmLeave()) onClose({ returnFocus: true });
  }, [guard, onClose]);

  const canStage = dirty || indexDiffersFromWorkingCopy;
  const saveDisabled = !dirty || s.saving;
  const unavailable = s.external?.unavailable != null;
  const stageDisabled = !canStage || s.saving || (!dirty && (unavailable || s.external !== null));
  const doSave = useCallback(() => {
    if (!dirty) return s.announce(NO_EDITS_REASON);
    void s.save(false);
  }, [dirty, s]);
  const doMarkResolved = useCallback(() => {
    if (gate) {
      s.announce(gate);
      setFlash((n) => n + 1);
      reasonRef.current?.focus();
      return;
    }
    void s.markResolved();
  }, [gate, s]);
  const doSaveAndStage = useCallback(() => {
    // FR-556: in a conflict the stage action is Mark as resolved; "Save and stage" would stage markers.
    if (conflictUi) return doMarkResolved();
    if (!canStage) return s.announce(NO_EDITS_REASON);
    void s.save(true, { stageOnly: !dirty });
  }, [canStage, conflictUi, dirty, doMarkResolved, s]);

  const ready = s.load.status === "ready" && meta !== null && s.init !== null;
  const stagedContentNow = meta?.hasStagedContent ?? false;
  const cmdCanSave = ready && !saveDisabled;
  const cmdCanStage = ready && (conflictUi ? !gate && !s.saving : !stageDisabled);
  useEffect(() => {
    onCommandStateChange?.({
      dirty,
      ready,
      canSave: cmdCanSave,
      canSaveAndStage: cmdCanStage,
      stagedContent: stagedContentNow,
      conflict: conflictUi,
      conflictCount: conflictUi ? summary.total : 0,
      stageBlockedReason: conflictUi ? gate : null,
    });
  }, [dirty, ready, cmdCanSave, cmdCanStage, stagedContentNow, onCommandStateChange, conflictUi, summary.total, gate]);
  useEffect(() => () => onCommandStateChange?.(null), [onCommandStateChange]);
  useEffect(() => {
    if (!commandsRef) return;
    commandsRef.current = {
      save: () => handlersRef.current.doSave(),
      saveAndStage: () => handlersRef.current.doSaveAndStage(),
      nextConflict: () => handlersRef.current.cf()?.next(),
      prevConflict: () => handlersRef.current.cf()?.prev(),
    };
    return () => {
      commandsRef.current = null;
    };
  }, [commandsRef]);

  // FR-527: Save shortcuts by physical key (Hebrew layout), only while the editor is open and no other modal owns the keyboard.
  const handlersRef = useRef({ doSave, doSaveAndStage, cf });
  handlersRef.current = { doSave, doSaveAndStage, cf };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== "KeyS" || e.altKey || !(mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey)) return;
      if (e.isComposing || document.querySelector('[aria-modal="true"]')) return;
      // Document-wide so the Hebrew layout and toolbar focus work, but only for keys aimed inside the editor: typing in the
      // commit-message box must never save or stage a file.
      if (!rootRef.current?.contains(e.target as Node | null)) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.shiftKey) handlersRef.current.doSaveAndStage();
      else handlersRef.current.doSave();
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [mac]);

  const focusToolbar = useCallback(() => toolbarRef.current?.querySelector<HTMLElement>("button")?.focus(), []);
  // Esc from the toolbar leaves too; Esc inside CodeMirror is handled (and stopped) there. Dialogs inside this tree bubble here, so they are excluded.
  const onRootKeyDown = (e: ReactKeyboardEvent<HTMLElement>) => {
    if (dialogOpen || e.nativeEvent.isComposing) return;
    // FR-562: conflict navigation by physical key code (Hebrew layout safe); F3/Shift+F3 and Alt+Down/Up.
    if (conflictUi && !e.ctrlKey && !e.metaKey) {
      const dir = e.code === "F3" ? (e.shiftKey ? -1 : 1) : e.altKey && !e.shiftKey && e.code === "ArrowDown" ? 1 : e.altKey && !e.shiftKey && e.code === "ArrowUp" ? -1 : 0;
      if (dir !== 0) {
        e.preventDefault();
        e.stopPropagation();
        if (dir === 1) cf()?.next();
        else cf()?.prev();
        return;
      }
    }
    if (e.key === "Escape" && !e.defaultPrevented) {
      e.preventDefault();
      e.stopPropagation();
      void leave();
    } else if (e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && e.code === "KeyM" && toolbarRef.current?.contains(e.target as Node)) {
      e.preventDefault();
      editorRef.current?.focus();
    }
  };

  const name = baseName(path);
  const dir = dirName(path);

  if (s.load.status !== "ready" || !meta || !s.init || ctxWait) {
    return (
      <section className="gh-edit" aria-label="File editor" ref={rootRef}>
        <div className="gh-edit__head">
          <div className="gh-edit__id">
            <h3 className="gh-edit__name gh-mono" title={path}>
              {name}
            </h3>
            <span className="gh-edit__dir gh-mono">
              <bdi>{dir}</bdi>
            </span>
          </div>
          <div className="gh-edit__actions">
            <button type="button" className="gh-edit__btn" onClick={() => onClose({ returnFocus: true })}>
              <IconBack /> Back to diff
            </button>
          </div>
        </div>
        {s.load.status === "loading" || (s.load.status === "ready" && ctxWait) ? (
          <div className="gh-edit__frame gh-edit__skeleton" role="status" aria-busy="true" aria-live="polite">
            <span className="gh-visually-hidden">Loading file…</span>
            {[62, 38, 74, 50, 28, 66].map((w, i) => (
              <span key={i} className="gh-edit__skeleton-bar" style={{ width: `${w}%` }} aria-hidden="true" />
            ))}
          </div>
        ) : (
          <p className="gh-edit__problem" role="alert">
            {s.load.status === "ineligible" ? `Edit unavailable: ${s.load.message}` : `Could not open the file for editing: ${s.load.status === "error" ? s.load.message : ""}`}
          </p>
        )}
      </section>
    );
  }

  const stagedCopy = meta.hasStagedContent;
  const verbatim = meta.eol === "mixed";
  const ssLabel = stagedCopy ? "Save and stage whole file" : "Save and stage";
  const ssTip = stagedCopy ? SAVE_AND_STAGE_WHOLE_TIP : `Saves, then stages every changed line in the file (${mod}+${shift}+S).`;
  const statusLine =
    s.status?.kind === "reloaded"
      ? "Reloaded from disk"
      : s.status?.kind === "saved"
        ? s.status.staged
          ? s.resolvedDone
            ? "Marked as resolved and staged."
            : "Saved and staged the whole file."
          : stagedCopy
            ? "Saved the working copy. Your staged version is unchanged."
            : null
        : null;
  const changedOnDisk = s.keptMine && s.external !== null;

  return (
    <section className="gh-edit" aria-label="File editor" ref={rootRef} onKeyDown={onRootKeyDown}>
      <div className="gh-edit__head">
        <div className="gh-edit__id">
          <h3 className="gh-edit__name gh-mono" title={path}>
            {name}
          </h3>
          <span className="gh-edit__dir gh-mono">
            <bdi>{dir}</bdi>
          </span>
          <span className="gh-edit__r">
            {statusLine && (
              <span className="gh-edit__stat" title={statusLine}>
                {statusLine}
              </span>
            )}
            {changedOnDisk && (
              <span className="gh-edit__state gh-edit__state--warn">
                <IconWarning size={14} /> Changed on disk
              </span>
            )}
            {conflictUi ? (
              <span className="gh-edit__tag" title="Editing the working file; the conflict markers are part of it">
                <IconMerge /> <span className="gh-edit__tag-text">Resolving</span>
              </span>
            ) : (
              <span className="gh-edit__tag">
                <IconPencil /> <span className="gh-edit__tag-text">Editing</span>
              </span>
            )}
            {stagedCopy && (
              <span className="gh-edit__tag gh-edit__tag--neutral" title="You are editing the file in your working directory, not the staged copy.">
                Working copy
              </span>
            )}
            {dirty ? (
              <span className="gh-edit__state">
                <span className="gh-edit__dot" aria-hidden="true" /> Unsaved
              </span>
            ) : s.status?.kind === "saved" ? (
              <span className="gh-edit__state gh-edit__state--saved">
                <IconCheck size={14} /> Saved {s.status.at}
              </span>
            ) : (
              <span className="gh-edit__state gh-edit__state--clean">
                <span className="gh-edit__ring" aria-hidden="true" /> No unsaved edits
              </span>
            )}
          </span>
        </div>
        <div className="gh-edit__actions" role="toolbar" aria-label="Editor actions" ref={toolbarRef}>
          <button type="button" className="gh-edit__btn" title={conflictUi ? "Back to changes (Esc)" : "Back to diff (Esc)"} aria-label={conflictUi ? "Back to changes" : "Back to diff"} onClick={() => void leave()}>
            <IconBack /> <span className="gh-edit__lbl-back">{conflictUi ? "Back to changes" : "Back to diff"}</span>
          </button>
          {conflictUi && (
            <ConflictNav
              summary={summary}
              onPrev={() => cf()?.prev()}
              onNext={() => cf()?.next()}
              onNextUnresolved={() => cf()?.nextUnresolved()}
            />
          )}
          <span className="gh-edit__right">
            {conflictUi && <UndoRedo onUndo={() => cf()?.undo()} onRedo={() => cf()?.redo()} />}
            {conflictUi ? (
              <button
                type="button"
                className="gh-edit__btn gh-edit__btn--primary"
                data-testid="mark-resolved"
                aria-disabled={gate || s.saving ? true : undefined}
                aria-describedby={gate ? `${uid}-reason` : undefined}
                title={dirty ? `Saves the file, then stages it as resolved (${mod}+${shift}+S).` : "Stages this file as resolved."}
                onClick={() => !s.saving && doMarkResolved()}
              >
                {dirty ? "Save and mark resolved" : "Mark as resolved"}
              </button>
            ) : (
            <button
              type="button"
              className="gh-edit__btn"
              aria-disabled={stageDisabled || undefined}
              aria-describedby={`${uid}-ssd`}
              title={!canStage ? `${NO_EDITS_REASON}. Use Stage on the file row to stage it as it is.` : undefined}
              data-tip={canStage ? ssTip : undefined}
              onClick={() => !stageDisabled && doSaveAndStage()}
            >
              {ssLabel}
            </button>
            )}
            <button
              type="button"
              className={`gh-edit__btn${dirty && !conflictUi ? " gh-edit__btn--primary" : ""}`}
              aria-disabled={saveDisabled || undefined}
              aria-describedby={`${uid}-sd`}
              title={!dirty ? NO_EDITS_REASON : `Save to the working file (${mod}+S)`}
              onClick={() => !saveDisabled && doSave()}
            >
              Save
            </button>
          </span>
          <span id={`${uid}-ssd`} className="gh-visually-hidden">
            {!canStage ? `${NO_EDITS_REASON}. ` : ""}
            {ssTip}
          </span>
          <span id={`${uid}-sd`} className="gh-visually-hidden">
            {!dirty ? NO_EDITS_REASON : `Saves the file. ${mod}+S.`}
          </span>
        </div>
      </div>

      {conflictUi && gate && (
        <p ref={reasonRef} id={`${uid}-reason`} tabIndex={-1} role="status" className={`gh-cf-reason${flash ? " gh-cf-reason--flash" : ""}`} key={flash}>
          <IconWarning size={14} />
          <span>{gate}</span>
        </p>
      )}
      <div className="gh-edit__frame">
        {conflictUi && (
          <p className="gh-edit__note" role="note">
            <IconInfo />
            <span>
              {cctx.names.rebase ? (
                <>
                  <b>Rebase swaps the sides:</b> Onto is what you rebase onto; Yours is the commit being replayed. Nothing is staged until you mark the file resolved.
                </>
              ) : (
                "Editing the working file. Pick a side, then click into the result and fix it. Nothing is staged until you mark it resolved."
              )}
            </span>
          </p>
        )}
        {stagedCopy && (
          <p className="gh-edit__note" role="note" id={noteId}>
            <IconPencil />
            <span>{STAGED_COPY_NOTE}</span>
          </p>
        )}
        {s.savedOnce && lineWasStaged && (
          <p className="gh-edit__note" role="note">
            <IconWarning size={14} />
            <span>{ALREADY_STAGED_LINE_NOTE}</span>
          </p>
        )}
        <div className="gh-edit__editor">
          <div className="gh-edit__alerts">
            {s.error && (
              <Alert
                tone="error"
                summary={s.error.summary}
                detailsId={`${uid}-err`}
                details={
                  <>
                    <p>Your edits are kept in the editor.</p>
                    <p className="gh-mono">{s.error.details}</p>
                  </>
                }
                onDismiss={() => {
                  s.dismissError();
                  editorRef.current?.focus();
                }}
              />
            )}
            {s.external && !s.keptMine && (
              <Alert
                tone="warn"
                detailsId={`${uid}-ext`}
                summary={
                  s.external.unavailable
                    ? `${s.external.unavailable}. Your editor still holds the last version.`
                    : `${name} changed on disk. Neither version was overwritten.`
                }
                details={
                  s.external.unavailable ? (
                    <p>Saving is unavailable until the file can be edited again.</p>
                  ) : (
                    <>
                      <p>The version on disk changed outside GitHydra. Your editor still holds your unsaved edits.</p>
                      <p>Reload discards your edits (asks first). Keep mine keeps them, and Save will ask before replacing the disk version.</p>
                    </>
                  )
                }
                actions={
                  s.external.unavailable ? undefined : (
                    <>
                      <button type="button" className="gh-edit__link" onClick={() => s.setReloadAsk(true)}>
                        Reload
                      </button>
                      <button type="button" className="gh-edit__link" onClick={s.keepMine}>
                        Keep mine
                      </button>
                    </>
                  )
                }
                onDismiss={s.external.unavailable ? s.dismissExternal : undefined}
              />
            )}
          </div>
          <CodeEditor
            key={`${path}:${s.init.seq}`}
            ref={editorRef}
            initialValue={s.init.value}
            baseValue={s.init.baseValue}
            onChange={s.onEditorChange}
            onBlur={s.onEditorBlur}
            ariaLabel={`Editing ${path}`}
            describedBy={footId}
            verbatimBreaks={verbatim}
            indentUnit={s.init.indentUnit}
            initialCaret={s.init.caret}
            onDirtyChange={s.setDirty}
            onCursorChange={(p) => setCursor((c) => (c.line === p.line && c.col === p.col ? c : p))}
            onEscape={() => void leave()}
            onFocusToolbar={focusToolbar}
            conflict={conflictOptions}
          />
          {conflictUi && toast && (
            <ConflictToast
              message={toast}
              onUndo={() => {
                setToast(null);
                cf()?.undo();
              }}
            />
          )}
        </div>
        {conflictUi && <ConflictReference summary={summary} names={cctx.names} />}
        <div className="gh-edit__foot gh-mono" id={footId}>
          <span className="gh-edit__pos">{footerText({ line: cursor.line, col: cursor.col, eol: meta.eol, hasBom: meta.hasBom, finalNewline: meta.finalNewline })}</span>
          {s.draftUnavailable && (
            <span className="gh-edit__draft-note" role="status">
              {RECOVERY_UNAVAILABLE_NOTE}
            </span>
          )}
          {conflictUi && (
            <span className={`gh-cf-status${summary.unresolved === 0 && summary.markerLines.length === 0 ? " gh-cf-status--ok" : ""}`}>
              <i aria-hidden="true" />
              {summary.markerLines.length > 0
                ? `${plural(summary.unresolved, "unresolved conflict")}, ${plural(summary.markerLines.length, "marker line")}`
                : "All decided, no markers left"}
            </span>
          )}
          <span className="gh-edit__keys" aria-hidden="true">
            {conflictUi ? `F3 next conflict · ${mod}+Z undo · ${mod}+S save` : <>{mod}+S save · {mod}+{shift}+S save and stage · Ctrl+M toolbar · Esc back</>}
          </span>
        </div>
      </div>

      <div className="gh-visually-hidden" role="status" aria-live="polite" aria-atomic="true">
        {s.announcement}
      </div>

      {s.leaveAsk && (
        <ConfirmDialog
          title={`Save changes to ${name}?`}
          message="You have unsaved edits. Save them before leaving, or discard them."
          confirmLabel="Save"
          busy={s.saving}
          secondaryAction={{ label: "Discard", destructive: true, onClick: s.leaveDiscard, disabled: s.saving }}
          onConfirm={() => void s.leaveSave()}
          onCancel={s.leaveCancel}
        />
      )}
      {s.overwrite && (
        <ConfirmDialog
          title="Overwrite the file on disk?"
          message="File changed on disk since you opened it. Overwrite?"
          confirmLabel="Overwrite"
          destructive
          initialFocus="cancel"
          onConfirm={() => s.answerOverwrite(true)}
          onCancel={() => s.answerOverwrite(false)}
        />
      )}
      {s.reloadAsk && (
        <ConfirmDialog
          title="Reload from disk?"
          message="Reloading replaces your unsaved edits with the version on disk. This cannot be undone."
          confirmLabel="Reload"
          destructive
          initialFocus="cancel"
          onConfirm={s.confirmReload}
          onCancel={() => s.setReloadAsk(false)}
        />
      )}
    </section>
  );
}
