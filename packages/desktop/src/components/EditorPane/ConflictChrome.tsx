// SPDX-License-Identifier: GPL-3.0-or-later
import { useId, useState } from "react";
import { plural, type ConflictSummary, type SideNames } from "../../lib/conflictModel";
import { IconCheck, IconChevronDown, IconChevronLeft, IconChevronRight, IconRedo, IconUndo } from "../Icon/Icon";

// The conflict editor's React-side chrome (specs/edit-in-diff.md FR-556..FR-563): navigator, toast and the read-only reference strip.

export function ConflictNav({
  summary,
  onPrev,
  onNext,
  onNextUnresolved,
}: {
  summary: ConflictSummary;
  onPrev: () => void;
  onNext: () => void;
  onNextUnresolved: () => void;
}) {
  const cur = summary.blocks.findIndex((b) => b.id === summary.currentId) + 1;
  const left = summary.unresolved;
  return (
    <span className="gh-cf-nav" role="group" aria-label="Conflict navigator">
      <button type="button" className="gh-edit__btn gh-edit__btn--icon" aria-label="Previous conflict (Shift+F3)" title="Previous conflict (Shift+F3)" onClick={onPrev} aria-disabled={summary.total === 0 || undefined}>
        <IconChevronLeft />
      </button>
      <span className="gh-cf-nav__c">
        {!summary.enabled ? (
          <b>&hellip;</b>
        ) : summary.total === 0 ? (
          <b>No conflicts left</b>
        ) : (
          <>
            <b>
              Conflict {cur || 1} of {summary.total}
            </b>
          </>
        )}
      </span>
      <button type="button" className="gh-edit__btn gh-edit__btn--icon" aria-label="Next conflict (F3)" title="Next conflict (F3)" onClick={onNext} aria-disabled={summary.total === 0 || undefined}>
        <IconChevronRight />
      </button>
      {summary.total > 0 &&
        (left === 0 ? (
          <span className="gh-cf-nav__c" role="status">
            <b className="gh-cf-nav__done">
              <IconCheck size={14} /> All {summary.total} decided
            </b>
          </span>
        ) : (
          <button
            type="button"
            className="gh-edit__btn gh-edit__btn--link"
            aria-label={`${plural(left, "conflict")} unresolved. Jump to the next one`}
            title="Jump to the next unresolved conflict"
            onClick={onNextUnresolved}
          >
            <span className="gh-cf-nav__un" aria-hidden="true" />
            {left} unresolved
          </button>
        ))}
    </span>
  );
}

export function UndoRedo({ onUndo, onRedo }: { onUndo: () => void; onRedo: () => void }) {
  return (
    <>
      <button type="button" className="gh-edit__btn gh-edit__btn--icon" aria-label="Undo (Ctrl+Z)" title="Undo (Ctrl+Z). Chip changes and typing share one history." onClick={onUndo}>
        <IconUndo />
      </button>
      <button type="button" className="gh-edit__btn gh-edit__btn--icon" aria-label="Redo (Ctrl+Shift+Z)" title="Redo (Ctrl+Shift+Z)" onClick={onRedo}>
        <IconRedo />
      </button>
    </>
  );
}

export function ConflictToast({ message, onUndo }: { message: string; onUndo: () => void }) {
  return (
    <div className="gh-cf-toast" role="status">
      <span>{message}</span>
      <button type="button" className="gh-edit__link gh-cf-toast__undo" onClick={onUndo}>
        Undo
      </button>
    </div>
  );
}

export function ConflictReference({ summary, names }: { summary: ConflictSummary; names: SideNames }) {
  const [open, setOpen] = useState(true);
  const [showBase, setShowBase] = useState(false);
  const uid = useId();
  const cur = summary.current;
  if (!cur) return null;
  const hasBase = cur.base !== null;
  const cols = [
    { key: "top", side: names.top, text: cur.ours },
    { key: "bottom", side: names.bottom, text: cur.theirs },
  ];
  return (
    <section className={`gh-cf-ref${open ? "" : " gh-cf-ref--closed"}`} aria-label={`Reference: both sides of conflict ${cur.n} of ${summary.total}, read-only`}>
      <div className="gh-cf-ref__h">
        <button type="button" className="gh-cf-ref__tg" aria-expanded={open} aria-controls={`${uid}-cols`} onClick={() => setOpen((o) => !o)}>
          <IconChevronDown size={14} />
          Reference
        </button>
        <span className="gh-cf-ref__m">
          Conflict {cur.n} of {summary.total} · read-only
        </span>
        <span className="gh-cf-ref__sp" />
        {hasBase && (
          <button type="button" className="gh-edit__btn gh-edit__btn--sm" aria-pressed={showBase} onClick={() => setShowBase((b) => !b)}>
            Common ancestor
          </button>
        )}
      </div>
      <div id={`${uid}-cols`} className="gh-cf-ref__cols" hidden={!open} style={{ ["--n" as string]: showBase && hasBase ? 3 : 2 }}>
        {cols.map((c) => (
          <div key={c.key} className={`gh-cf-ref__col gh-cf-role--${c.side.role}`} tabIndex={0} role="region" aria-label={`${c.side.label}, read-only`}>
            <div className="gh-cf-ref__ch">
              <span className="gh-cf-ref__sw" aria-hidden="true" />
              {c.side.label}
            </div>
            {c.text === "" ? <div className="gh-cf-ref__e">(no lines on this side)</div> : <pre className="gh-cf-ref__pre">{c.text}</pre>}
          </div>
        ))}
        {showBase && hasBase && (
          <div className="gh-cf-ref__col gh-cf-ref__col--base" tabIndex={0} role="region" aria-label="Common ancestor, read-only">
            <div className="gh-cf-ref__ch">
              <span className="gh-cf-ref__sw" aria-hidden="true" />
              Common ancestor
            </div>
            {cur.base === "" ? <div className="gh-cf-ref__e">(nothing here before both sides added lines)</div> : <pre className="gh-cf-ref__pre">{cur.base}</pre>}
          </div>
        )}
      </div>
    </section>
  );
}
