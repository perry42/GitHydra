// SPDX-License-Identifier: GPL-3.0-or-later
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import type { DiffHunk, HunkSelection } from "@githydra/git-core";
import type { PartialAction, PartialActionSummary } from "../../hooks/useChangesPanel";
import { ContextMenu } from "../ContextMenu/ContextMenu";

/**
 * specs/hunk-line-staging.md FR-453: wiring for hunk/line controls. Only the Changes panel passes
 * this, for a Staged or Unstaged file; the commit DetailPanel/Compare never do, so they stay read-only.
 * Controls still render only when the diff itself reports `partialStaging.eligible` (FR-452).
 */
export interface PartialStagingControls {
  side: "unstaged" | "staged";
  /** An operation is in flight: controls stay focusable but ignore activation. */
  busy: boolean;
  onAction: (action: PartialAction, selection: HunkSelection[], summary: PartialActionSummary) => void;
  /** Reports the line-selection context menu open/closed so global keybindings can defer to it (FR-221). */
  onContextMenuOpenChange?: (open: boolean) => void;
}

interface LineSelection {
  hunk: number;
  anchor: number;
  focus: number;
}

function changedLineCount(hunk: DiffHunk): number {
  return hunk.lines.reduce((n, l) => (l.type === "context" ? n : n + 1), 0);
}

// Range between anchor and focus, minus context lines: only add/remove lines are ever selectable (FR-453).
function selectedIndexes(hunk: DiffHunk | undefined, sel: LineSelection | null): number[] {
  if (!hunk || !sel) return [];
  const lo = Math.min(sel.anchor, sel.focus);
  const hi = Math.max(sel.anchor, sel.focus);
  const out: number[] = [];
  for (let i = lo; i <= hi; i++) if (hunk.lines[i] && hunk.lines[i]!.type !== "context") out.push(i);
  return out;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * FR-453: the interactive hunks. Hunk header row carries Stage/Unstage hunk (always visible) and, on
 * the unstaged side, Discard hunk (revealed on hover/focus by CSS, still in the tab order). Lines are
 * picked on the line-number gutter: drag, shift-click, or keyboard (arrows move between changed lines,
 * Shift+arrows extend, Enter/Space toggles, Escape clears) - never by color alone (aria-pressed plus a
 * marked gutter). A selection is confined to one hunk.
 */
export function PartialStagingHunks({ hunks, controls }: { hunks: DiffHunk[]; controls: PartialStagingControls }) {
  const { side, busy, onAction, onContextMenuOpenChange } = controls;
  const primary: PartialAction = side === "unstaged" ? "stage" : "unstage";
  const primaryWord = side === "unstaged" ? "Stage" : "Unstage";
  const canDiscard = side === "unstaged";

  const [sel, setSel] = useState<LineSelection | null>(null);
  const [active, setActive] = useState<{ hunk: number; line: number } | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const dragRef = useRef<{ hunk: number; anchor: number; moved: boolean; toggleOff: boolean } | null>(null);

  useEffect(() => {
    const end = () => {
      const d = dragRef.current;
      dragRef.current = null;
      if (d?.toggleOff && !d.moved) setSel(null);
    };
    window.addEventListener("mouseup", end);
    return () => window.removeEventListener("mouseup", end);
  }, []);

  useEffect(() => {
    onContextMenuOpenChange?.(menu !== null);
  }, [menu, onContextMenuOpenChange]);

  const indexes = useMemo(() => selectedIndexes(sel ? hunks[sel.hunk] : undefined, sel), [hunks, sel]);
  const selectedSet = useMemo(() => new Set(indexes), [indexes]);
  const lastSelected = indexes.length > 0 ? indexes[indexes.length - 1]! : -1;

  const firstChange = useMemo(() => {
    for (let h = 0; h < hunks.length; h++) {
      const i = hunks[h]!.lines.findIndex((l) => l.type !== "context");
      if (i >= 0) return { hunk: h, line: i };
    }
    return null;
  }, [hunks]);
  // Roving tabindex: one gutter button is a tab stop, arrows move between the rest.
  const tabStop = active ?? firstChange;

  const run = (action: PartialAction, selection: HunkSelection[], summary: PartialActionSummary) => {
    if (busy) return;
    setMenu(null);
    onAction(action, selection, summary);
  };
  const runHunk = (action: PartialAction, h: number) =>
    run(action, [{ hunkIndex: h }], { hunks: 1, lines: changedLineCount(hunks[h]!) });
  const runLines = (action: PartialAction) => {
    if (!sel || indexes.length === 0) return;
    run(action, [{ hunkIndex: sel.hunk, lineIndexes: indexes }], { hunks: 0, lines: indexes.length });
  };

  const onGutterMouseDown = (e: MouseEvent<HTMLButtonElement>, h: number, i: number) => {
    if (e.button !== 0) return;
    e.preventDefault(); // no text selection while dragging; focus is moved by hand below
    e.currentTarget.focus();
    setActive({ hunk: h, line: i });
    if (e.shiftKey && sel && sel.hunk === h) {
      setSel({ ...sel, focus: i });
      return;
    }
    const toggleOff = sel !== null && sel.hunk === h && sel.anchor === i && sel.focus === i;
    dragRef.current = { hunk: h, anchor: i, moved: false, toggleOff };
    setSel({ hunk: h, anchor: i, focus: i });
  };

  const onLineEnter = (h: number, i: number) => {
    const d = dragRef.current;
    if (!d || d.hunk !== h) return;
    if (i !== d.anchor) d.moved = true;
    setSel({ hunk: h, anchor: d.anchor, focus: i });
  };

  // detail === 0 means keyboard activation (Enter/Space); real mouse clicks are handled on mousedown.
  const onGutterClick = (e: MouseEvent<HTMLButtonElement>, h: number, i: number) => {
    if (e.detail !== 0) return;
    if (e.shiftKey && sel && sel.hunk === h) {
      setSel({ ...sel, focus: i });
      return;
    }
    const only = sel !== null && sel.hunk === h && sel.anchor === i && sel.focus === i;
    setSel(only ? null : { hunk: h, anchor: i, focus: i });
  };

  const onGutterKeyDown = (e: KeyboardEvent<HTMLButtonElement>, h: number, i: number) => {
    if (e.key === "Escape" && sel) {
      e.stopPropagation();
      setSel(null);
      return;
    }
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const scope = e.currentTarget.closest(".gh-diff-view__hunks") ?? document;
    const all = Array.from(scope.querySelectorAll<HTMLButtonElement>("button[data-gutter]"));
    const next = all[all.indexOf(e.currentTarget) + (e.key === "ArrowDown" ? 1 : -1)];
    if (!next) return;
    const nh = Number(next.dataset.hunk);
    const ni = Number(next.dataset.line);
    next.focus();
    setActive({ hunk: nh, line: ni });
    if (!e.shiftKey) return;
    // A selection never spans hunks: crossing a boundary restarts inside the new hunk.
    if (nh !== h) setSel({ hunk: nh, anchor: ni, focus: ni });
    else if (sel && sel.hunk === h) setSel({ ...sel, focus: ni });
    else setSel({ hunk: h, anchor: i, focus: ni });
  };

  const onLineContextMenu = (e: MouseEvent, h: number, i: number) => {
    if (!(sel && sel.hunk === h && selectedSet.has(i))) setSel({ hunk: h, anchor: i, focus: i });
    e.preventDefault();
    setMenu({ x: e.clientX, y: e.clientY });
  };

  const count = indexes.length;
  const menuItems = [
    { label: `${primaryWord} ${plural(count, "line")}`, onSelect: () => runLines(primary) },
    ...(canDiscard ? [{ label: `Discard ${plural(count, "line")}`, onSelect: () => runLines("discard") }] : []),
  ];

  return (
    <>
      {hunks.map((hunk, h) => (
        <div className="gh-diff-view__hunk" key={h} aria-busy={busy || undefined}>
          <div className="gh-diff-view__hunk-header gh-diff-view__hunk-header--actions">
            <span className="gh-diff-view__hunk-title">{hunk.header}</span>
            <span className="gh-diff-view__hunk-actions">
              <button
                type="button"
                className="gh-diff-view__hunk-btn"
                aria-disabled={busy || undefined}
                aria-label={`${primaryWord} hunk ${h + 1} of ${hunks.length}`}
                onClick={() => runHunk(primary, h)}
              >
                {primaryWord} hunk
              </button>
              {canDiscard && (
                <button
                  type="button"
                  className="gh-diff-view__hunk-btn gh-diff-view__hunk-btn--discard"
                  aria-disabled={busy || undefined}
                  aria-label={`Discard hunk ${h + 1} of ${hunks.length}`}
                  onClick={() => runHunk("discard", h)}
                >
                  Discard hunk
                </button>
              )}
            </span>
          </div>
          {hunk.lines.map((line, i) => {
            const isChange = line.type !== "context";
            const isSel = sel?.hunk === h && selectedSet.has(i);
            const kind = line.type === "add" ? "added" : "removed";
            const gutterNumbers = (
              <>
                <span className="gh-diff-view__line-no" aria-hidden="true">
                  {line.oldLineNumber ?? ""}
                </span>
                <span className="gh-diff-view__line-no" aria-hidden="true">
                  {line.newLineNumber ?? ""}
                </span>
              </>
            );
            return (
              <div
                key={i}
                className={`gh-diff-view__line gh-diff-view__line--${line.type}${isSel ? " gh-diff-view__line--selected" : ""}`}
                onMouseEnter={() => onLineEnter(h, i)}
                onContextMenu={isChange ? (e) => onLineContextMenu(e, h, i) : undefined}
              >
                {isChange ? (
                  <button
                    type="button"
                    className="gh-diff-view__gutter gh-diff-view__gutter--button"
                    data-gutter=""
                    data-hunk={h}
                    data-line={i}
                    tabIndex={tabStop && tabStop.hunk === h && tabStop.line === i ? 0 : -1}
                    aria-pressed={isSel}
                    aria-label={`Select ${kind} line ${line.newLineNumber ?? line.oldLineNumber}`}
                    onMouseDown={(e) => onGutterMouseDown(e, h, i)}
                    onClick={(e) => onGutterClick(e, h, i)}
                    onKeyDown={(e) => onGutterKeyDown(e, h, i)}
                    onFocus={() => setActive({ hunk: h, line: i })}
                  >
                    {gutterNumbers}
                  </button>
                ) : (
                  <span className="gh-diff-view__gutter">{gutterNumbers}</span>
                )}
                <span className="gh-diff-view__line-marker" aria-hidden="true">
                  {line.type === "add" ? "+" : line.type === "remove" ? "-" : " "}
                </span>
                <span className="gh-visually-hidden">{line.type === "add" ? "Added: " : line.type === "remove" ? "Removed: " : ""}</span>
                <span className="gh-diff-view__line-content">{line.content}</span>
                {sel?.hunk === h && i === lastSelected && (
                  <div
                    className="gh-diff-view__selection-bar"
                    role="toolbar"
                    aria-label={`Actions for ${plural(count, "selected line")}`}
                  >
                    <button type="button" aria-disabled={busy || undefined} onClick={() => runLines(primary)}>
                      {primaryWord} {plural(count, "line")}
                    </button>
                    {canDiscard && (
                      <button
                        type="button"
                        className="gh-diff-view__selection-bar-discard"
                        aria-disabled={busy || undefined}
                        onClick={() => runLines("discard")}
                      >
                        Discard {plural(count, "line")}
                      </button>
                    )}
                    <button type="button" aria-label="Clear selection" onClick={() => setSel(null)}>
                      ×
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      ))}
      {menu && count > 0 && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          ariaLabel={`Actions for ${plural(count, "selected line")}`}
          items={menuItems}
          onClose={() => setMenu(null)}
        />
      )}
    </>
  );
}
