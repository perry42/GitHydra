// SPDX-License-Identifier: GPL-3.0-or-later
import { forwardRef, useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { plural, type ConflictSummary, type SideNames } from "../../lib/conflictModel";
import { IconCheck, IconChevronDown, IconChevronLeft, IconChevronRight, IconMoreHorizontal, IconRedo, IconUndo } from "../Icon/Icon";

// The conflict editor's React-side chrome (specs/edit-in-diff.md FR-556..FR-563, FR-573..FR-579): pill, overflow menu, toast and the read-only reference strip.

/**
 * The top-right slot over the text (specs/edit-in-diff.md FR-574). Generic on purpose: Find (ROADMAP "Find in editor") will
 * mount its bar in this same slot, so nothing here may assume the conflict pill is its only child.
 */
export const EditorFloat = forwardRef<HTMLDivElement, { children: ReactNode }>(function EditorFloat({ children }, ref) {
  return (
    <div ref={ref} className="gh-edit__float">
      {children}
    </div>
  );
});

/** A mouse click hands focus back to the text; keyboard activation (a click with detail 0) keeps it on the button (FR-575). */
export type NavSource = "mouse" | "keyboard";
const sourceOf = (e: MouseEvent<HTMLElement>): NavSource => (e.detail === 0 ? "keyboard" : "mouse");

/**
 * specs/edit-in-diff.md FR-574/FR-575: the pinned conflict navigator. A labelled region (not a toolbar: no roving arrows);
 * the visible count is aria-hidden and a hidden status line speaks the same thing after each move.
 */
export function ConflictPill({
  summary,
  onPrev,
  onNext,
  onNextUnresolved,
  onEscape,
}: {
  summary: ConflictSummary;
  onPrev: (s: NavSource) => void;
  onNext: (s: NavSource) => void;
  onNextUnresolved: (s: NavSource) => void;
  onEscape: () => void;
}) {
  const cur = summary.blocks.findIndex((b) => b.id === summary.currentId) + 1 || 1;
  const left = summary.unresolved;
  const none = summary.total === 0;
  const live = !summary.enabled
    ? ""
    : none
      ? "No conflicts left."
      : `Conflict ${cur} of ${summary.total}. ${left === 0 ? "All conflicts decided." : `${plural(left, "conflict")} unresolved.`}`;
  return (
    <section
      className="gh-pill"
      aria-label="Conflict navigation"
      onKeyDown={(e) => {
        if (e.key !== "Escape") return;
        e.preventDefault();
        e.stopPropagation();
        onEscape();
      }}
    >
      <button type="button" className="gh-pill__btn" aria-label="Previous conflict (Shift+F3)" title="Previous conflict (Shift+F3)" onClick={(e) => onPrev(sourceOf(e))} aria-disabled={none || undefined}>
        <IconChevronLeft />
      </button>
      <span className="gh-pill__count" aria-hidden="true">
        {!summary.enabled ? (
          "…"
        ) : none ? (
          "No conflicts left"
        ) : (
          <>
            <span className="gh-pill__long">
              {cur} of {summary.total}
            </span>
            <span className="gh-pill__short">
              {cur}/{summary.total}
            </span>
          </>
        )}
      </span>
      <button type="button" className="gh-pill__btn" aria-label="Next conflict (F3)" title="Next conflict (F3)" onClick={(e) => onNext(sourceOf(e))} aria-disabled={none || undefined}>
        <IconChevronRight />
      </button>
      {summary.enabled && !none && (
        <>
          <span className="gh-pill__sep" aria-hidden="true" />
          {left === 0 ? (
            <span className="gh-pill__stat gh-pill__stat--ok" aria-hidden="true" data-testid="pill-all-decided">
              <IconCheck size={14} />
              <span className="gh-pill__long">All decided</span>
            </span>
          ) : (
            <button
              type="button"
              className="gh-pill__stat gh-pill__stat--un"
              aria-label={`${plural(left, "conflict")} unresolved. Jump to the next one`}
              title="Jump to the next unresolved conflict"
              onClick={(e) => onNextUnresolved(sourceOf(e))}
            >
              <span className="gh-pill__sq" aria-hidden="true" />
              <span className="gh-pill__short">{left}</span>
              <span className="gh-pill__long">{left} unresolved</span>
            </button>
          )}
        </>
      )}
      <span className="gh-visually-hidden" role="status">
        {live}
      </span>
    </section>
  );
}

interface UndoRedoProps {
  onUndo: () => void;
  onRedo: () => void;
  mod: string;
  shift: string;
}

export function UndoRedo({ onUndo, onRedo, mod, shift }: UndoRedoProps) {
  return (
    <span className="gh-edit__ur">
      <button type="button" className="gh-edit__btn gh-edit__btn--icon" aria-label={`Undo (${mod}+Z)`} title={`Undo (${mod}+Z). Chip changes and typing share one history.`} onClick={onUndo}>
        <IconUndo />
      </button>
      <button type="button" className="gh-edit__btn gh-edit__btn--icon" aria-label={`Redo (${mod}+${shift}+Z)`} title={`Redo (${mod}+${shift}+Z)`} onClick={onRedo}>
        <IconRedo />
      </button>
    </span>
  );
}

/**
 * specs/edit-in-diff.md FR-579: below 760px of editor column Undo and Redo live here; their shortcuts keep working in the text.
 * Esc closes and returns to the trigger without leaving the editor.
 */
export function OverflowMenu({ onUndo, onRedo, mod, shift }: UndoRedoProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLSpanElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const uid = useId();
  useEffect(() => {
    if (!open) return;
    menuRef.current?.querySelector<HTMLElement>("[role=menuitem]")?.focus();
    const away = (e: Event) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, [open]);
  const items = [
    { label: "Undo", keys: `${mod}+Z`, run: onUndo },
    { label: "Redo", keys: `${mod}+${shift}+Z`, run: onRedo },
  ];
  const onMenuKey = (e: ReactKeyboardEvent<HTMLElement>) => {
    const all = Array.from(menuRef.current?.querySelectorAll<HTMLElement>("[role=menuitem]") ?? []);
    const i = all.indexOf(document.activeElement as HTMLElement);
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
      triggerRef.current?.focus();
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      all[(i + (e.key === "ArrowDown" ? 1 : -1) + all.length) % all.length]?.focus();
    } else if (e.key === "Tab") setOpen(false);
  };
  return (
    <span className="gh-edit__ovf" ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className="gh-edit__btn gh-edit__btn--icon"
        aria-label="More editor actions"
        title="More editor actions"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? `${uid}-menu` : undefined}
        onClick={() => setOpen((o) => !o)}
      >
        <IconMoreHorizontal />
      </button>
      {open && (
        <div id={`${uid}-menu`} ref={menuRef} className="gh-edit__menu" role="menu" aria-label="Editor actions" onKeyDown={onMenuKey}>
          {items.map((it) => (
            <button
              key={it.label}
              type="button"
              role="menuitem"
              className="gh-edit__menuitem"
              onClick={() => {
                setOpen(false);
                it.run();
              }}
            >
              {it.label}
              <span className="gh-edit__menukeys">{it.keys}</span>
            </button>
          ))}
        </div>
      )}
    </span>
  );
}

/** The toast outlives a keyboard user's path to its Undo: the parent holds its timer while it is hovered or focused (specs/edit-in-diff.md FR-570). */
export function ConflictToast({ message, onUndo, onHold }: { message: string; onUndo: () => void; onHold?: (held: boolean) => void }) {
  return (
    <div
      className="gh-cf-toast"
      role="status"
      onMouseEnter={() => onHold?.(true)}
      onMouseLeave={() => onHold?.(false)}
      onFocus={() => onHold?.(true)}
      onBlur={() => onHold?.(false)}
    >
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
