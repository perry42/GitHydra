// SPDX-License-Identifier: GPL-3.0-or-later
import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MutableRefObject, type ReactNode } from "react";
import type { GitHydraApi } from "../../../shared/ipcContract";
import { useEditSession } from "../../hooks/useEditSession";
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
import { IconBack, IconCheck, IconPencil, IconWarning } from "../Icon/Icon";
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
}: EditorPaneProps) {
  const editorRef = useRef<CodeEditorHandle | null>(null);
  const rootRef = useRef<HTMLElement | null>(null);
  const toolbarRef = useRef<HTMLDivElement | null>(null);
  const uid = useId();
  const footId = `${uid}-foot`;
  const noteId = `${uid}-note`;
  const [cursor, setCursor] = useState({ line: 1, col: 1 });
  const s = useEditSession({ api, path, open, editorRef, liveRevision, onSaved, repoPath });
  const { dirty, meta } = s;
  const mac = isMac();
  const mod = mac ? "⌘" : "Ctrl";
  const shift = mac ? "⇧" : "Shift";

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
  const doSaveAndStage = useCallback(() => {
    if (!canStage) return s.announce(NO_EDITS_REASON);
    void s.save(true, { stageOnly: !dirty });
  }, [canStage, dirty, s]);

  const ready = s.load.status === "ready" && meta !== null && s.init !== null;
  const stagedContentNow = meta?.hasStagedContent ?? false;
  const cmdCanSave = ready && !saveDisabled;
  const cmdCanStage = ready && !stageDisabled;
  useEffect(() => {
    onCommandStateChange?.({ dirty, ready, canSave: cmdCanSave, canSaveAndStage: cmdCanStage, stagedContent: stagedContentNow });
  }, [dirty, ready, cmdCanSave, cmdCanStage, stagedContentNow, onCommandStateChange]);
  useEffect(() => () => onCommandStateChange?.(null), [onCommandStateChange]);
  useEffect(() => {
    if (!commandsRef) return;
    commandsRef.current = { save: () => handlersRef.current.doSave(), saveAndStage: () => handlersRef.current.doSaveAndStage() };
    return () => {
      commandsRef.current = null;
    };
  }, [commandsRef]);

  // FR-527: Save shortcuts by physical key (Hebrew layout), only while the editor is open and no other modal owns the keyboard.
  const handlersRef = useRef({ doSave, doSaveAndStage });
  handlersRef.current = { doSave, doSaveAndStage };
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

  if (s.load.status !== "ready" || !meta || !s.init) {
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
        {s.load.status === "loading" ? (
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
          ? "Saved and staged the whole file."
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
            <span className="gh-edit__tag">
              <IconPencil /> <span className="gh-edit__tag-text">Editing</span>
            </span>
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
          <button type="button" className="gh-edit__btn" title="Back to diff (Esc)" aria-label="Back to diff" onClick={() => void leave()}>
            <IconBack /> <span className="gh-edit__lbl-back">Back to diff</span>
          </button>
          <span className="gh-edit__right">
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
            <button
              type="button"
              className={`gh-edit__btn${dirty ? " gh-edit__btn--primary" : ""}`}
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

      <div className="gh-edit__frame">
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
          />
        </div>
        <div className="gh-edit__foot gh-mono" id={footId}>
          <span className="gh-edit__pos">{footerText({ line: cursor.line, col: cursor.col, eol: meta.eol, hasBom: meta.hasBom, finalNewline: meta.finalNewline })}</span>
          {s.draftUnavailable && (
            <span className="gh-edit__draft-note" role="status">
              {RECOVERY_UNAVAILABLE_NOTE}
            </span>
          )}
          <span className="gh-edit__keys" aria-hidden="true">
            {mod}+S save · {mod}+{shift}+S save and stage · Ctrl+M toolbar · Esc back
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
