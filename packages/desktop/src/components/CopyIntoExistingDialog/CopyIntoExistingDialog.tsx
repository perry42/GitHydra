// SPDX-License-Identifier: GPL-3.0-or-later
import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { formatCopySize, isSecretLooking } from "@githydra/git-core";
import type { GitHydraApi, WorktreeExistingCopyRequest, WorktreeExistingCopyResult, WorktreeExistingRow } from "../../../shared/ipcContract";
import { useCopyIntoExisting, type CopyIntoRowView } from "../../hooks/useCopyIntoExisting";
import { useDialogChrome } from "../../hooks/useDialogChrome";
import {
  CHECKING,
  copyIntro,
  DIALOG_TITLE,
  filesLabel,
  KEY_GUARD_MS,
  NOTHING_TO_COPY,
  rowEnabled,
  SECRET_NOT_IGNORED_SENTENCE,
  shown,
} from "../../lib/worktreeCopyExisting";
import { BannerIcon } from "../StatusBanner/BannerIcon";
import { IconWarning } from "../Icon/Icon";
import { REMEMBER_FOOTER, ROW_CAP, SECRET_LIST_WARNING } from "../CreateWorktreeDialog/CopyIgnoredSection";
import "../StatusBanner/StatusBanner.css";
import "../NewBranchDialog/NewBranchDialog.css";
import "../CreateWorktreeDialog/CreateWorktreeDialog.css";
import "../CreateWorktreeDialog/CopyIgnoredSection.css";
import "./CopyIntoExistingDialog.css";

export interface CopyIntoExistingDialogProps {
  api: GitHydraApi;
  /** A worktree id from main's own list (`null` = the main worktree). Never a path (FR-650). */
  destId: string | null;
  /** Only for the sentence when both folder names are equal (FR-651); main sends names, not paths. */
  sourcePath?: string;
  /** Runs the redeem and puts the banner up; owned by the controller so a tab switch mid-copy still ends in a banner (FR-657). */
  runCopy: (request: WorktreeExistingCopyRequest) => Promise<WorktreeExistingCopyResult>;
  /** Close without copying (Esc, Cancel, Close, backdrop) or after a copy ran. The owner restores focus to the invoker. */
  onClose: () => void;
}

function sizeText(r: WorktreeExistingRow): string {
  if (r.disabledText) return "";
  if (r.isDirectory) return `${filesLabel(r.copyableCount)} · ${formatCopySize(r.bytes)}`;
  return formatCopySize(r.bytes);
}

function Tags({ v, dest }: { v: CopyIntoRowView; dest: string }) {
  const { row } = v;
  return (
    <span className="gh-copy__tags">
      {row.secret && (
        <span className="gh-copy__tag gh-copy__tag--warn">
          <span aria-hidden="true" className="gh-copy__tag-icon">
            <IconWarning size={12} />
          </span>
          {row.isDirectory && !isSecretLooking(row.path) ? "contains secret files" : "secret"}
        </span>
      )}
      {v.remembered && <span className="gh-copy__tag">remembered</span>}
      {v.inInclude && <span className="gh-copy__tag">in .worktreeinclude</span>}
      {row.runsCode && <span className="gh-copy__tag gh-copy__tag--warn">runs code when opened</span>}
      {row.changesGit && <span className="gh-copy__tag gh-copy__tag--warn">changes how git behaves in {dest}</span>}
      {row.large && <span className="gh-copy__tag">large, consider reinstalling</span>}
      {row.notIgnoredInDestination && !row.secret && <span className="gh-copy__tag">not ignored in {dest}</span>}
      {row.notIgnoredInDestination && row.secret && (
        <span className="gh-copy__tag gh-copy-into__tag--critical">
          <span aria-hidden="true" className="gh-copy__tag-icon">
            <IconWarning size={12} />
          </span>
          not ignored in {dest}
        </span>
      )}
      {!row.disabledText && row.existingCount > 0 && (
        <span className="gh-copy__tag">
          {row.existingCount} of {row.fileCount} already exist
        </span>
      )}
      {row.disabledText && <span className="gh-copy__tag">{shown(row.disabledText)}</span>}
    </span>
  );
}

/**
 * specs/worktree-copy-ignored.md FR-651..657 (visual truth: DESIGN.md "Copy ignored files here..."): one sentence, the same
 * Review list as Create, a sticky footer with the readout. Everything shown comes from main as text; the list, ticks and memory are advice.
 */
export function CopyIntoExistingDialog({ api, destId, sourcePath, runCopy, onClose }: CopyIntoExistingDialogProps) {
  const titleId = useId();
  const introId = useId();
  const model = useCopyIntoExisting({ api, destId, runCopy, onDone: onClose });
  const { phase, meta, views } = model;
  const copying = phase === "copying";
  const refused = phase === "refused";
  const openedAt = useRef(Date.now());
  // M1: Enter counts only after a key was released inside the dialog (a menu's held Enter must not press Copy).
  const armed = useRef(false);
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const primaryRef = useRef<HTMLButtonElement | null>(null);
  const firstRowRef = useRef<HTMLInputElement | null>(null);
  const [showAll, setShowAll] = useState(false);

  const guardedClose = () => {
    if (Date.now() - openedAt.current < KEY_GUARD_MS) return;
    if (copying) return;
    onClose();
  };
  const { onOverlayMouseDown } = useDialogChrome({
    onEscape: guardedClose,
    escapeDeps: [copying, onClose],
    getFocusTarget: () => cancelRef.current,
    onBackdropClick: () => {
      if (!copying) onClose();
    },
  });

  const zero = model.zero;
  const rowsLoaded = phase === "ready" && !zero;
  const visible = showAll || views.length <= ROW_CAP ? views : views.slice(0, ROW_CAP);
  const firstEnabled = views.findIndex((v) => rowEnabled(v.row));

  // FR-651 (3): focus starts on the first enabled row; none enabled (or nothing to copy) keeps it on Cancel/Close.
  useEffect(() => {
    if (!rowsLoaded) return;
    if (firstEnabled >= ROW_CAP) setShowAll(true);
    const active = document.activeElement;
    if (firstEnabled >= 0 && (active === cancelRef.current || active === document.body || active === null)) {
      // After the list that may be expanding has rendered.
      queueMicrotask(() => firstRowRef.current?.focus());
    }
  }, [rowsLoaded, firstEnabled]);

  // FR-651 (2): nothing to copy leaves one Close button, and it has the focus (Cancel is gone with the list).
  useEffect(() => {
    if (zero) primaryRef.current?.focus();
  }, [zero]);

  // The body goes inert while copying: keep keyboard users on Cancel, the only control that works.
  useEffect(() => {
    if (copying) cancelRef.current?.focus();
  }, [copying]);

  const secretListed = views.some((v) => v.row.secret);
  const destName = meta ? shown(meta.destName) : "";
  const sourceName = meta ? shown(meta.sourceName) : "";
  const sameName = meta !== null && sourceName === destName;
  const fromLabel = sameName && sourcePath ? shown(sourcePath) : sourceName;
  const intoLabel = sameName && meta ? shown(meta.destPath) : destName;

  const primaryIsClose = zero;
  const primaryIsRetry = refused;
  const primaryDisabled = !primaryIsClose && !primaryIsRetry && !model.canCopy;
  const primaryLabel = primaryIsClose ? "Close" : primaryIsRetry ? "Try again" : copying ? "Copying..." : "Copy";

  const onPrimary = () => {
    if (primaryIsClose) return onClose();
    if (primaryIsRetry) return model.retry();
    if (primaryDisabled || copying) return;
    void model.startCopy();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    // M1: every key is ignored while the dialog is new, so a held Enter from the opening menu is harmless.
    if (Date.now() - openedAt.current < KEY_GUARD_MS) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    if (e.key !== "Enter") return;
    if (e.repeat || copying) {
      e.preventDefault();
      return;
    }
    const button = (e.target as HTMLElement).closest("button");
    const wasArmed = armed.current;
    armed.current = false;
    if (button && button !== primaryRef.current) return; // Cancel, Select none, Show all, Try again: their own keys.
    if (button === primaryRef.current) {
      if (!wasArmed) e.preventDefault();
      return;
    }
    e.preventDefault();
    if (!wasArmed || primaryIsClose || primaryIsRetry) return;
    // A ticked secret, run-code or not-ignored row needs a deliberate press on Copy itself.
    if (model.needsExplicitCopy) return;
    if (model.canCopy) void model.startCopy();
  };

  const progress = model.progress;
  const readoutText = copying && progress ? `Copying ${progress.filesDone} of ${progress.filesTotal} files...` : model.readout;
  const readoutClass = model.selection.overLimit
    ? "gh-copy-into__readout gh-copy-into__readout--critical"
    : !model.anyTicked && !copying
      ? "gh-copy-into__readout gh-copy-into__readout--muted"
      : "gh-copy-into__readout";

  return (
    <div className="gh-new-branch__overlay" onMouseDown={onOverlayMouseDown}>
      <div
        className="gh-new-branch gh-create-worktree gh-copy-into"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={meta ? introId : undefined}
        onKeyDown={onKeyDown}
        onKeyUp={() => {
          armed.current = true;
        }}
      >
        <h2 id={titleId} className="gh-new-branch__title gh-create-worktree__title">
          {DIALOG_TITLE}
        </h2>
        <div className="gh-create-worktree__form">
          <div className="gh-create-worktree__body" inert={copying} aria-busy={phase === "checking" ? true : undefined}>
            {meta && (
              <div className="gh-copy-into__where">
                <p className="gh-copy-into__sentence">
                  From <strong className="gh-mono">{fromLabel}</strong> into <strong className="gh-mono">{intoLabel}</strong>.
                </p>
                <p className="gh-copy-into__path gh-mono">{shown(meta.destPath)}</p>
              </div>
            )}

            {phase === "checking" && (
              <p className="gh-copy__text gh-copy-into__status" role="status">
                {CHECKING}
              </p>
            )}

            {phase === "failed" && (
              <div className="gh-copy-into__failed">
                <p className="gh-copy__text">
                  <span aria-hidden="true" className="gh-copy__tag-icon gh-copy__tag-icon--warn">
                    <IconWarning size={12} />
                  </span>
                  <span>{model.failMessage}</span>
                </p>
                <button type="button" className="gh-copy__link" onClick={model.retry}>
                  Try again
                </button>
              </div>
            )}

            {zero && <p className="gh-copy__text gh-copy__text--muted">{NOTHING_TO_COPY}</p>}

            {(rowsLoaded || copying || refused) && !zero && meta && (
              <>
                <p id={introId} className="gh-create-worktree__intro">
                  {copyIntro(destName)}
                </p>
                {secretListed && (
                  <p className="gh-copy__warning">
                    <span aria-hidden="true" className="gh-copy__tag-icon gh-copy__tag-icon--warn">
                      <IconWarning size={12} />
                    </span>
                    <span>{SECRET_LIST_WARNING}</span>
                  </p>
                )}
                <ul className="gh-copy__rows gh-copy-into__rows" aria-label="Ignored files">
                  {visible.map((v) => {
                    const r = v.row;
                    const disabled = !rowEnabled(r);
                    const warnId = `${titleId}-warn-${visible.indexOf(v)}`;
                    const critical = r.secret && r.notIgnoredInDestination;
                    return (
                      <li key={r.id} className="gh-copy__row">
                        <label className="gh-copy__rowlabel" data-disabled={disabled ? "true" : undefined}>
                          <input
                            ref={views.indexOf(v) === firstEnabled ? firstRowRef : undefined}
                            type="checkbox"
                            checked={model.ticked.has(r.id) && !disabled}
                            disabled={disabled}
                            aria-describedby={critical ? warnId : undefined}
                            onChange={() => model.toggleRow(r.id)}
                          />
                          <span className="gh-copy__name gh-mono">{shown(r.displayPath)}</span>
                          <Tags v={v} dest={destName} />
                          <span className="gh-copy__size">{sizeText(r)}</span>
                        </label>
                        {critical && (
                          <p id={warnId} className="gh-copy-into__critical">
                            {SECRET_NOT_IGNORED_SENTENCE(destName)}
                          </p>
                        )}
                      </li>
                    );
                  })}
                </ul>
                <div className="gh-copy-into__controls">
                  {model.anyTicked && (
                    <button type="button" className="gh-copy__link" onClick={model.selectNone}>
                      Select none
                    </button>
                  )}
                  {!showAll && views.length > ROW_CAP && (
                    <button type="button" className="gh-copy__link" onClick={() => setShowAll(true)}>
                      Show all {views.length}
                    </button>
                  )}
                </div>
                <p className="gh-copy__footer">{REMEMBER_FOOTER}</p>
              </>
            )}

            {refused && model.refusal && (
              <div className="gh-status-banner gh-status-banner--critical gh-copy-into__alert" role="alert">
                <BannerIcon tone="error" />
                <span>Could not copy: {model.refusal}</span>
              </div>
            )}
          </div>

          <div className="gh-create-worktree__footer gh-copy-into__footer">
            {!zero && (
              <div className="gh-copy-into__readout-wrap">
                <p className={readoutClass} role="status" aria-live="polite">
                  {phase === "ready" || copying ? readoutText : ""}
                </p>
                {copying && progress && (
                  <div
                    className="gh-copy-into__bar"
                    role="progressbar"
                    aria-label="Copy progress"
                    aria-valuemin={0}
                    aria-valuemax={progress.filesTotal}
                    aria-valuenow={Math.min(progress.filesDone, progress.filesTotal)}
                  >
                    <span style={{ width: `${progress.filesTotal === 0 ? 0 : Math.min(100, (progress.filesDone / progress.filesTotal) * 100)}%` }} />
                  </div>
                )}
              </div>
            )}
            <div className="gh-copy-into__buttons">
              {!zero && (
                <button
                  ref={cancelRef}
                  type="button"
                  className="gh-new-branch__cancel"
                  onClick={() => {
                    if (copying) model.cancelCopy();
                    else onClose();
                  }}
                >
                  Cancel
                </button>
              )}
              <button
                ref={(el) => {
                  primaryRef.current = el;
                  if (zero) cancelRef.current = el;
                }}
                type="button"
                className="gh-new-branch__submit gh-copy-into__primary"
                aria-disabled={primaryDisabled || copying ? true : undefined}
                onClick={onPrimary}
              >
                {primaryLabel}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
