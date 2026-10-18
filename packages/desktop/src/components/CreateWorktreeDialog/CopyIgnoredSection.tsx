// SPDX-License-Identifier: GPL-3.0-or-later
import { useEffect, useId, useRef, useState } from "react";
import { formatCopySize, isSecretLooking } from "@githydra/git-core";
import type { CopyIgnoredModel, CopyRowView } from "../../hooks/useCopyIgnored";
import { visibleText } from "../../lib/worktrees";
import { IconChevronDown, IconChevronRight, IconWarning } from "../Icon/Icon";
import "./CopyIgnoredSection.css";

/** FR-628 exact strings that are not part of `copyLineText`. */
export const REVIEW_INTRO = "A new worktree has only tracked files. Tick the ignored files you want copied.";
export const SECRET_LIST_WARNING = 'Rows marked "secret" look like passwords, tokens or keys. Copy them only if the new worktree needs them.';
export const REMEMBER_FOOTER = "Changes you make here are remembered for this repository, on this computer.";
export const SKIPPED_PATTERNS_HEADING = "Skipped: these patterns point outside the repository";
export const ROW_CAP = 6;
/** Not in FR-628's table: the question must never be absent from the dialog, so the empty cases say so quietly. */
export const NO_CANDIDATES_TEXT = "No ignored files to copy in this repository.";
export const BARE_REPOSITORY_TEXT = "This is a bare repository: there is nothing to copy.";
const FAIL_REASON_TEXT: Record<string, string> = {
  "not-a-worktree": "This folder is not a worktree of the repository.",
  "untrusted-list": "Git's worktree list and this repository's records disagree.",
};

function sizeText(v: CopyRowView): string {
  const { row } = v;
  if (v.disabledText) return "";
  if (row.bytes === null) return "size not computed";
  if (row.isDirectory && row.fileCount !== null) return `${row.fileCount === 1 ? "1 file" : `${row.fileCount} files`} · ${formatCopySize(row.bytes)}`;
  return formatCopySize(row.bytes);
}

function Tags({ v }: { v: CopyRowView }) {
  const path = v.row.path;
  return (
    <span className="gh-copy__tags">
      {v.row.secret && (
        <span className="gh-copy__tag gh-copy__tag--warn">
          <span aria-hidden="true" className="gh-copy__tag-icon">
            <IconWarning size={12} />
          </span>
          {v.row.isDirectory && !isSecretLooking(path) ? "contains secret files" : "secret"}
        </span>
      )}
      {v.remembered && <span className="gh-copy__tag">remembered</span>}
      {v.inInclude && <span className="gh-copy__tag">in .worktreeinclude</span>}
      {v.row.runsCode && <span className="gh-copy__tag gh-copy__tag--warn">runs code when opened</span>}
      {v.row.large && <span className="gh-copy__tag">large, consider reinstalling</span>}
      {v.disabledText && <span className="gh-copy__tag">{v.disabledText}</span>}
    </span>
  );
}

/**
 * specs/worktree-copy-ignored.md FR-628: the ONE line (inside Advanced) and the Review list. Strings come from git-core's
 * `copyLineText` so the renderer and the tests share one source. Native checkboxes only; no pin, popover or manager.
 */
export function CopyIgnoredSection({ model }: { model: CopyIgnoredModel }) {
  const reviewId = useId();
  const lineId = useId();
  const [reviewOpen, setReviewOpen] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [focusFirst, setFocusFirst] = useState(false);
  const firstRef = useRef<HTMLInputElement | null>(null);
  const reviewRef = useRef<HTMLButtonElement | null>(null);

  // [Choose files] opens Review and lands on the first row that can be ticked.
  useEffect(() => {
    if (!focusFirst || !reviewOpen) return;
    setFocusFirst(false);
    // No row can be ticked (all disabled): stay on a control that is really there.
    (firstRef.current ?? reviewRef.current)?.focus();
  }, [focusFirst, reviewOpen]);

  const { line, phase } = model;
  if (phase === "none") {
    return (
      <div className="gh-copy" role="group" aria-label="Ignored files">
        <p className="gh-copy__text gh-copy__text--muted">{model.noneKind === "bare" ? BARE_REPOSITORY_TEXT : NO_CANDIDATES_TEXT}</p>
      </div>
    );
  }
  const checking = phase === "checking";
  const canToggle = phase === "ready" && model.anyTicked;
  const rows = model.rows;
  const secretRowExists = rows.some((v) => v.row.secret);
  const visible = showAll || rows.length <= ROW_CAP ? rows : rows.slice(0, ROW_CAP);
  const firstEnabled = visible.findIndex((v) => v.disabledText === null);
  const showLineCheckbox = phase === "ready" && model.anyTicked;

  return (
    <div className="gh-copy" role="group" aria-label="Ignored files" aria-busy={checking ? true : undefined}>
      <div className="gh-copy__line">
        {showLineCheckbox ? (
          <label className="gh-copy__check">
            <input type="checkbox" checked={model.checkboxOn} onChange={(e) => model.setCheckboxOn(e.target.checked)} aria-describedby={line.detail ? lineId : undefined} />
            <span>{line.text}</span>
            {line.note && <span className="gh-copy__note"> {line.note}</span>}
          </label>
        ) : (
          <p className="gh-copy__text" id={lineId}>
            {phase === "failed" && (
              <span aria-hidden="true" className="gh-copy__tag-icon gh-copy__tag-icon--warn">
                <IconWarning size={12} />
              </span>
            )}
            <span>{line.text}</span>
          </p>
        )}
        {line.action === "Choose files" && (
          <button
            type="button"
            className="gh-copy__link"
            onClick={() => {
              setReviewOpen(true);
              setFocusFirst(true);
            }}
          >
            Choose files
          </button>
        )}
        {line.action === "Try again" && (
          <button type="button" className="gh-copy__link" onClick={model.retry}>
            Try again
          </button>
        )}
      </div>
      {phase === "failed" && model.failReason && FAIL_REASON_TEXT[model.failReason] && <p className="gh-copy__detail">{FAIL_REASON_TEXT[model.failReason]}</p>}
      {showLineCheckbox && line.detail && (
        <p className="gh-copy__detail gh-mono" id={lineId}>
          {line.detail}
        </p>
      )}
      {model.warnings.map((w) => (
        <p key={w.text} className="gh-copy__warning">
          <span aria-hidden="true" className="gh-copy__tag-icon gh-copy__tag-icon--warn">
            <IconWarning size={12} />
          </span>
          <span>{w.text}</span>
        </p>
      ))}

      {phase === "ready" && (
        <>
          <button ref={reviewRef} type="button" className="gh-copy__review" aria-expanded={reviewOpen} aria-controls={reviewId} onClick={() => setReviewOpen((v) => !v)}>
            <span aria-hidden="true">{reviewOpen ? <IconChevronDown size={12} /> : <IconChevronRight size={12} />}</span> Review
          </button>
          <div id={reviewId} className="gh-copy__panel" hidden={!reviewOpen}>
            <p className="gh-copy__intro">{REVIEW_INTRO}</p>
            {secretRowExists && (
              <p className="gh-copy__warning">
                <span aria-hidden="true" className="gh-copy__tag-icon gh-copy__tag-icon--warn">
                  <IconWarning size={12} />
                </span>
                <span>{SECRET_LIST_WARNING}</span>
              </p>
            )}
            <ul className="gh-copy__rows" aria-label="Ignored files">
              {visible.map((v, i) => {
                const id = v.row.path;
                const disabled = v.disabledText !== null || !model.checkboxOn;
                return (
                  <li key={id} className="gh-copy__row">
                    <label className="gh-copy__rowlabel" data-disabled={disabled ? "true" : undefined}>
                      <input
                        ref={i === firstEnabled ? firstRef : undefined}
                        type="checkbox"
                        checked={model.ticked.has(id)}
                        disabled={disabled}
                        onChange={() => model.toggleRow(id)}
                      />
                      <span className="gh-copy__name gh-mono">{visibleText(id)}</span>
                      <Tags v={v} />
                      <span className="gh-copy__size">{sizeText(v)}</span>
                    </label>
                  </li>
                );
              })}
            </ul>
            {!showAll && rows.length > ROW_CAP && (
              <button type="button" className="gh-copy__link" onClick={() => setShowAll(true)}>
                Show all {rows.length}
              </button>
            )}
            {canToggle && (
              <button type="button" className="gh-copy__link" onClick={model.selectNone}>
                Select none
              </button>
            )}
            {model.include.skipped.length > 0 && (
              <div className="gh-copy__skipped">
                <p className="gh-copy__intro">{SKIPPED_PATTERNS_HEADING}</p>
                <ul>
                  {model.include.skipped.map((s) => (
                    <li key={`${s.line}:${s.pattern}`} className="gh-mono">
                      {visibleText(s.pattern)}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <p className="gh-copy__footer">{REMEMBER_FOOTER}</p>
          </div>
          <div className="gh-visually-hidden" role="status" aria-live="polite">
            {model.live}
          </div>
        </>
      )}
    </div>
  );
}
