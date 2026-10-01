// SPDX-License-Identifier: GPL-3.0-or-later
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type MutableRefObject } from "react";
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

// Keep the @@ range always visible; only the trailing function-context text ellipsizes.
function HunkTitle({ header }: { header: string }) {
  const m = /^(@@.*?@@)(.*)$/.exec(header);
  if (!m) return <span className="gh-diff-view__hunk-title">{header}</span>;
  return (
    <span className="gh-diff-view__hunk-title" title={header}>
      <span className="gh-diff-view__hunk-range">{m[1]}</span>
      <span className="gh-diff-view__hunk-context">{m[2]}</span>
    </span>
  );
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export interface FocusHint {
  hunk: number;
  line: number;
}

const LABEL_TEXT_MAX = 40;
const truncate = (text: string) => (text.length > LABEL_TEXT_MAX ? `${text.slice(0, LABEL_TEXT_MAX)}…` : text);

// "-a,b +c,d" -> "c–(c+d-1)": the working-tree side, which is what the user sees in the file.
function hunkRange(header: string): string | undefined {
  const m = /\+(\d+)(?:,(\d+))?/.exec(header);
  if (!m) return undefined;
  const start = Number(m[1]);
  const len = m[2] === undefined ? 1 : Number(m[2]);
  return len <= 1 ? `${start}` : `${start}–${start + len - 1}`;
}

// Nearest changed-line gutter button to `hint` (else a hunk header); focus must never drop to <body> (WCAG 2.4.3).
function focusNearestGutter(root: ParentNode | null, hint: FocusHint | null): boolean {
  if (!root || !hint) return false;
  const all = Array.from(root.querySelectorAll<HTMLButtonElement>("button[data-gutter]"));
  let best: HTMLButtonElement | null = null;
  let bestScore = Infinity;
  for (const b of all) {
    const score = Math.abs(Number(b.dataset.hunk) - hint.hunk) * 1_000_000 + Math.abs(Number(b.dataset.line) - hint.line);
    if (score < bestScore) {
      best = b;
      bestScore = score;
    }
  }
  if (best) {
    best.focus();
    return true;
  }
  const header = root.querySelector<HTMLElement>(`[data-hunk-header="${hint.hunk}"]`) ?? root.querySelector<HTMLElement>("[data-hunk-header]");
  header?.focus();
  return header !== null;
}

/**
 * FR-453: the interactive hunks. Hunk header row carries Stage/Unstage hunk (always visible) and, on
 * the unstaged side, Discard hunk (revealed on hover/focus by CSS, still in the tab order). Lines are
 * picked on the line-number gutter: drag, shift-click, or keyboard (arrows move between changed lines,
 * Shift+arrows extend, Enter/Space toggles, Escape clears) - never by color alone (aria-pressed plus a
 * marked gutter). A selection is confined to one hunk.
 */
export function PartialStagingHunks({
  hunks,
  controls,
  announce,
  focusHintRef,
}: {
  hunks: DiffHunk[];
  controls: PartialStagingControls;
  /** Polite live-region text owned by DiffView. */
  announce?: (message: string) => void;
  /** Survives this component's remount (new diff fingerprint after an action) so focus can be restored there. */
  focusHintRef?: MutableRefObject<FocusHint | null>;
}) {
  const { side, busy, onAction, onContextMenuOpenChange } = controls;
  const primary: PartialAction = side === "unstaged" ? "stage" : "unstage";
  const primaryWord = side === "unstaged" ? "Stage" : "Unstage";
  const canDiscard = side === "unstaged";

  const [sel, setSel] = useState<LineSelection | null>(null);
  const [active, setActive] = useState<{ hunk: number; line: number } | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  // The header actions can wrap and grow the header; holding them back until mouseup keeps rows from
  // shifting under the cursor mid-drag (found in real Electron: a short downward drag lost its second row).
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef<{ hunk: number; anchor: number; moved: boolean; toggleOff: boolean } | null>(null);

  useEffect(() => {
    const end = () => {
      const d = dragRef.current;
      dragRef.current = null;
      setDragging(false);
      if (d?.toggleOff && !d.moved) setSel(null);
    };
    window.addEventListener("mouseup", end);
    return () => window.removeEventListener("mouseup", end);
  }, []);

  // After an action the diff reloads under a new fingerprint and this component remounts: put focus back near
  // where the user was, but only if it was dropped (don't steal it from, say, the commit box).
  useEffect(() => {
    const hint = focusHintRef?.current;
    if (!hint) return;
    focusHintRef.current = null;
    const a = document.activeElement;
    if (!a || a === document.body) focusNearestGutter(rootRef.current, hint);
  }, [focusHintRef]);

  useEffect(() => {
    onContextMenuOpenChange?.(menu !== null);
  }, [menu, onContextMenuOpenChange]);

  const indexes = useMemo(() => selectedIndexes(sel ? hunks[sel.hunk] : undefined, sel), [hunks, sel]);
  const selectedSet = useMemo(() => new Set(indexes), [indexes]);
  const firstSelected = indexes.length > 0 ? indexes[0]! : -1;
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

  const run = (action: PartialAction, selection: HunkSelection[], summary: PartialActionSummary, hint: FocusHint) => {
    if (busy) return;
    setMenu(null);
    if (focusHintRef) focusHintRef.current = hint;
    onAction(action, selection, summary);
  };
  const runHunk = (action: PartialAction, h: number) =>
    run(
      action,
      [{ hunkIndex: h }],
      { hunks: 1, lines: changedLineCount(hunks[h]!), range: hunkRange(hunks[h]!.header) },
      { hunk: h, line: Math.max(0, hunks[h]!.lines.findIndex((l) => l.type !== "context")) },
    );
  const runLines = (action: PartialAction) => {
    if (!sel || indexes.length === 0) return;
    run(action, [{ hunkIndex: sel.hunk, lineIndexes: indexes }], { hunks: 0, lines: indexes.length }, { hunk: sel.hunk, line: sel.focus });
  };

  // Clearing from a control that is about to unmount (the header "x", Esc) must hand focus to a gutter button.
  const clearSelection = () => {
    const hint = active ?? (sel ? { hunk: sel.hunk, line: sel.focus } : null);
    setSel(null);
    focusNearestGutter(rootRef.current, hint);
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
    setDragging(true);
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
      clearSelection();
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

  const prevCount = useRef(0);
  useEffect(() => {
    if (count > 0) announce?.(`${plural(count, "line")} selected`);
    else if (prevCount.current > 0) announce?.(""); // reset so re-selecting the same count is announced again
    prevCount.current = count;
  }, [count, announce]);
  const menuItems = [
    { label: `${primaryWord} ${plural(count, "line")}`, onSelect: () => runLines(primary) },
    ...(canDiscard ? [{ label: `Discard ${plural(count, "line")}`, onSelect: () => runLines("discard") }] : []),
  ];

  return (
    <div className="gh-diff-view__partial" ref={rootRef}>
      {hunks.map((hunk, h) => (
        <div className="gh-diff-view__hunk" key={h} aria-busy={busy || undefined}>
          <div className="gh-diff-view__hunk-header gh-diff-view__hunk-header--actions" data-hunk-header={h} tabIndex={-1}>
            <HunkTitle header={hunk.header} />
            <span className="gh-diff-view__hunk-actions">
              {sel?.hunk === h && count > 0 && !dragging && (
                // Lives in the sticky header so the actions stay reachable while a tall selection scrolls (FR-453).
                <span
                  className="gh-diff-view__sel-actions"
                  role="group"
                  aria-label={`Actions for ${plural(count, "selected line")}`}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") {
                      e.stopPropagation();
                      clearSelection();
                    }
                  }}
                >
                  <span className="gh-diff-view__sel-count">{count} selected</span>
                  <button
                    type="button"
                    className="gh-diff-view__hunk-btn"
                    aria-disabled={busy || undefined}
                    onClick={() => runLines(primary)}
                  >
                    {primaryWord} {plural(count, "line")}
                  </button>
                  {canDiscard && (
                    <button
                      type="button"
                      className="gh-diff-view__hunk-btn gh-diff-view__hunk-btn--danger"
                      aria-disabled={busy || undefined}
                      onClick={() => runLines("discard")}
                    >
                      Discard {plural(count, "line")}
                    </button>
                  )}
                  <button type="button" className="gh-diff-view__hunk-btn" aria-label="Clear selection" onClick={clearSelection}>
                    ×
                  </button>
                </span>
              )}
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
            const inSelHunk = sel?.hunk === h && indexes.length > 0;
            const inRange = inSelHunk && i >= firstSelected && i <= lastSelected;
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
                className={`gh-diff-view__line gh-diff-view__line--${line.type}${isSel ? " gh-diff-view__line--selected" : ""}${inRange ? " gh-diff-view__line--in-range" : ""}${isSel && i === firstSelected ? " gh-diff-view__line--sel-first" : ""}${isSel && i === lastSelected ? " gh-diff-view__line--sel-last" : ""}`}
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
                    aria-label={`Select ${kind} line ${line.newLineNumber ?? line.oldLineNumber}${line.content.trim() ? `: ${truncate(line.content.trim())}` : ""}`}
                    title="Click or drag to select lines. Shift-click to extend."
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
    </div>
  );
}
