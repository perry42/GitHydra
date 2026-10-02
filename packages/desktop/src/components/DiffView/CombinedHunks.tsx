// SPDX-License-Identifier: GPL-3.0-or-later
import { useEffect, useId, useMemo, useState, type KeyboardEvent, type MouseEvent } from "react";
import type { CombinedDiffHunk, CombinedLineRef } from "@githydra/git-core";
import {
  changedRowPositions,
  discardableRefs,
  hunkChangedRefs,
  hunkStagedState,
  lineAt,
  plural,
  posKey,
  rangeBetween,
  rangeToggleTarget,
  toRef,
  type RowPos,
} from "../../lib/combinedDiff";
import { ContextMenu, type ContextMenuItem } from "../ContextMenu/ContextMenu";

/**
 * specs/hunk-line-staging.md FR-453/FR-477/FR-478/FR-483: wiring for the checkbox (combined) diff. Only the
 * Changes panel passes this, and only when git-core reports the open file as eligible; DetailPanel/Compare
 * never do, so they stay read-only.
 */
export interface CombinedDiffControls {
  hunks: CombinedDiffHunk[];
  /** An operation is in flight. Clicks still queue (their tick is optimistic); this only marks the diff busy. */
  busy: boolean;
  onToggleLines: (lines: CombinedLineRef[], target: "stage" | "unstage", noun: string) => void;
  onToggleHunk: (hunkIndex: number) => void;
  onDiscardLines: (lines: CombinedLineRef[]) => void;
  onDiscardHunk: (hunkIndex: number) => void;
  /** The hunk under the cursor or focused checkbox, for the Command Palette's hunk commands (FR-483). */
  onActiveHunkChange?: (hunkIndex: number | null) => void;
  /** Reports the right-click menu open/closed so global keybindings can defer to it (FR-221). */
  onContextMenuOpenChange?: (open: boolean) => void;
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

const LABEL_TEXT_MAX = 40;
const truncate = (text: string) => (text.length > LABEL_TEXT_MAX ? `${text.slice(0, LABEL_TEXT_MAX)}…` : text);
const same = (a: RowPos | null, b: RowPos | null) => !!a && !!b && a.hunk === b.hunk && a.line === b.line;

interface MenuState {
  x: number;
  y: number;
  label: string;
  items: ContextMenuItem[];
}

/**
 * The combined diff: one checkbox per changed line (ticked = in the index), one per hunk, a row cursor for
 * the keyboard. Staged state comes in through `hunks`, already optimistic; this component owns only the cursor,
 * the Shift anchor and the context menu, so a reload that swaps `hunks` in place keeps all three.
 */
export function CombinedHunks({ controls }: { controls: CombinedDiffControls }) {
  const { hunks, busy, onToggleLines, onToggleHunk, onDiscardLines, onDiscardHunk, onActiveHunkChange, onContextMenuOpenChange } =
    controls;
  const uid = useId();
  const order = useMemo(() => changedRowPositions(hunks), [hunks]);
  const [cursor, setCursor] = useState<RowPos | null>(null);
  const [anchor, setAnchor] = useState<RowPos | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);

  const isChanged = (p: RowPos | null): p is RowPos => {
    const line = p ? hunks[p.hunk]?.lines[p.line] : undefined;
    return !!line && line.type !== "context";
  };
  // After an in-place reload the structure normally matches; if the file changed under us, drop what no longer exists.
  const cursorPos = isChanged(cursor) ? cursor : null;
  const anchorPos = isChanged(anchor) ? anchor : null;
  const rangeRows = useMemo(
    () => (cursorPos && anchorPos && !same(cursorPos, anchorPos) ? rangeBetween(order, anchorPos, cursorPos) : []),
    [order, cursorPos, anchorPos],
  );
  const rangeKeys = useMemo(() => new Set(rangeRows.map((p) => posKey(p.hunk, p.line))), [rangeRows]);

  const rowId = (p: RowPos) => `${uid}-r-${p.hunk}-${p.line}`;
  const lineNo = (p: RowPos) => {
    const l = lineAt(hunks, p)!;
    return l.newLineNumber ?? l.oldLineNumber;
  };

  useEffect(() => {
    onContextMenuOpenChange?.(menu !== null);
  }, [menu, onContextMenuOpenChange]);
  // Report the cursor's hunk only when it moves (never on mount: a mount-time "null" could land after a focus the
  // user just made on a hunk checkbox). Unmounting - another file opened - clears it so a stale index never
  // reaches a different file's hunks.
  useEffect(() => {
    if (cursorPos) onActiveHunkChange?.(cursorPos.hunk);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cursorPos?.hunk, cursorPos?.line]);
  useEffect(
    () => () => onActiveHunkChange?.(null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  // Keep the cursor row on screen; the sticky hunk header is accounted for by scroll-padding in the CSS.
  const cursorKey = cursorPos ? rowId(cursorPos) : null;
  useEffect(() => {
    if (cursorKey) document.getElementById(cursorKey)?.scrollIntoView?.({ block: "nearest" });
  }, [cursorKey]);

  const toggleRows = (rows: RowPos[]) => {
    const target = rangeToggleTarget(hunks, rows);
    const noun = rows.length === 1 ? `line ${lineNo(rows[0]!)}` : plural(rows.length, "line");
    onToggleLines(rows.map(toRef), target, noun);
  };

  const onGutterClick = (e: MouseEvent, h: number, i: number) => {
    const here = { hunk: h, line: i };
    onActiveHunkChange?.(h);
    if (e.shiftKey && anchorPos && !same(anchorPos, here)) {
      // One atomic op for the whole range under the shared FR-453 rule (same as the keyboard path).
      toggleRows(rangeBetween(order, anchorPos, here));
      setCursor(here);
    } else {
      toggleRows([here]);
      setCursor(here);
      setAnchor(here);
    }
    // Focus stays in the diff, on the cursor row (FR-454), so the keyboard continues from where the click was.
    (e.currentTarget as HTMLElement).closest<HTMLElement>("[data-combined-root]")?.focus({ preventScroll: true });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return; // the hunk checkboxes and Discard handle their own keys
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (order.length === 0) return;
      const dir = e.key === "ArrowDown" ? 1 : -1;
      const at = cursorPos ? order.findIndex((p) => same(p, cursorPos)) : -1;
      const next = order[at < 0 ? (dir > 0 ? 0 : order.length - 1) : Math.min(order.length - 1, Math.max(0, at + dir))]!;
      setAnchor(e.shiftKey ? (anchorPos ?? cursorPos ?? next) : next);
      setCursor(next);
    } else if (e.key === " " || e.key === "Spacebar") {
      e.preventDefault();
      if (!cursorPos) return;
      if (rangeRows.length > 1) toggleRows(rangeRows);
      else toggleRows([cursorPos]);
    } else if (e.key === "Escape" && rangeRows.length > 1) {
      e.stopPropagation();
      setAnchor(cursorPos);
    }
  };

  const openMenu = (e: MouseEvent, items: ContextMenuItem[], label: string) => {
    e.preventDefault();
    setMenu({ x: e.clientX, y: e.clientY, items, label });
  };

  const rowItems = (rows: RowPos[]): ContextMenuItem[] => {
    const refs = rows.map(toRef);
    const allStaged = rangeToggleTarget(hunks, rows) === "unstage";
    const noun = plural(refs.length, "line");
    // Every row in the menu's target decides the direction (all staged -> Unstage), not just the first.
    const items: ContextMenuItem[] = [
      {
        label: `${allStaged ? "Unstage" : "Stage"} ${noun}`,
        onSelect: () => onToggleLines(refs, allStaged ? "unstage" : "stage", noun),
      },
    ];
    const discardable = discardableRefs(hunks, refs);
    if (discardable.length > 0) {
      items.push({ label: `Discard ${plural(discardable.length, "line")}`, onSelect: () => onDiscardLines(discardable) });
    }
    return items;
  };

  const onRowContextMenu = (e: MouseEvent, h: number, i: number) => {
    const here = { hunk: h, line: i };
    let rows: RowPos[];
    if (rangeKeys.has(posKey(h, i))) rows = rangeRows;
    else {
      rows = [here];
      setCursor(here);
      setAnchor(here);
    }
    openMenu(e, rowItems(rows), `Actions for ${plural(rows.length, "selected line")}`);
  };

  const onHunkContextMenu = (e: MouseEvent, h: number) => {
    const hunk = hunks[h]!;
    const state = hunkStagedState(hunk);
    const refs = hunkChangedRefs(hunk, h);
    const items: ContextMenuItem[] = [
      { label: state === "all" ? "Unstage hunk" : "Stage hunk", onSelect: () => onToggleHunk(h) },
    ];
    if (discardableRefs(hunks, refs).length > 0) items.push({ label: "Discard hunk", onSelect: () => onDiscardHunk(h) });
    openMenu(e, items, `Actions for hunk ${h + 1}`);
  };

  const activeId = cursorPos ? rowId(cursorPos) : undefined;

  return (
    <>
      <p id={`${uid}-help`} className="gh-visually-hidden">
        Use Up and Down to move between changed lines, Space to stage or unstage the line, Shift with the arrow keys to
        select a range, Escape to clear the range. Tab reaches each hunk's checkbox.
      </p>
      <div
        className="gh-diff-view__partial"
        data-combined-root=""
        role="group"
        aria-label="Changed lines"
        aria-describedby={`${uid}-help`}
        aria-activedescendant={activeId}
        aria-busy={busy || undefined}
        tabIndex={0}
        onKeyDown={onKeyDown}
      >
        {hunks.map((hunk, h) => {
          const state = hunkStagedState(hunk);
          const canDiscard = discardableRefs(hunks, hunkChangedRefs(hunk, h)).length > 0;
          return (
            <div className="gh-diff-view__hunk" key={h}>
              <div
                className={`gh-diff-view__hunk-header gh-diff-view__hunk-header--${state}`}
                data-hunk-header={h}
                onContextMenu={(e) => onHunkContextMenu(e, h)}
              >
                <span className="gh-diff-view__hunk-check">
                  <button
                    type="button"
                    role="checkbox"
                    aria-checked={state === "some" ? "mixed" : state === "all"}
                    className={`gh-diff-view__hcb gh-diff-view__hcb--${state}`}
                    aria-label={`Hunk ${h + 1} of ${hunks.length}`}
                    title={state === "all" ? "Unstage this hunk" : "Stage this hunk"}
                    onClick={() => onToggleHunk(h)}
                    onFocus={() => onActiveHunkChange?.(h)}
                  >
                    <span className="gh-diff-view__hcb-box" aria-hidden="true" />
                  </button>
                </span>
                <HunkTitle header={hunk.header} />
                <span className="gh-diff-view__hunk-actions">
                  {canDiscard && (
                    <button
                      type="button"
                      className="gh-diff-view__discard"
                      aria-label={`Discard hunk ${h + 1} of ${hunks.length}`}
                      onClick={() => onDiscardHunk(h)}
                      onFocus={() => onActiveHunkChange?.(h)}
                    >
                      Discard
                    </button>
                  )}
                </span>
              </div>
              {hunk.lines.map((line, i) => {
                const pos = { hunk: h, line: i };
                const changed = line.type !== "context";
                const isCursor = same(cursorPos, pos);
                const inRange = rangeKeys.has(posKey(h, i));
                const cls = [
                  "gh-diff-view__line",
                  `gh-diff-view__line--${line.type}`,
                  changed ? "gh-diff-view__line--changed" : "",
                  changed && !line.staged ? "gh-diff-view__line--unstaged" : "",
                  isCursor ? "gh-diff-view__line--cursor" : "",
                  inRange ? "gh-diff-view__line--in-range" : "",
                ]
                  .filter(Boolean)
                  .join(" ");
                const numbers = (
                  <>
                    <span className="gh-diff-view__line-no" aria-hidden="true">
                      {line.oldLineNumber ?? ""}
                    </span>
                    <span className="gh-diff-view__line-no" aria-hidden="true">
                      {line.newLineNumber ?? ""}
                    </span>
                  </>
                );
                const text = line.content.trim();
                return (
                  <div
                    key={i}
                    id={changed ? rowId(pos) : undefined}
                    className={cls}
                    role={changed ? "checkbox" : undefined}
                    aria-checked={changed ? line.staged : undefined}
                    aria-label={
                      changed
                        ? `${line.type === "add" ? "Added" : "Removed"} line ${line.newLineNumber ?? line.oldLineNumber}${text ? `: ${truncate(text)}` : ""}`
                        : undefined
                    }
                    onContextMenu={changed ? (e) => onRowContextMenu(e, h, i) : undefined}
                  >
                    {changed ? (
                      <div
                        className="gh-diff-view__gutter gh-diff-view__gutter--check"
                        title={
                          line.staged ? "Staged. Click to unstage this line." : "Not staged. Click to stage this line. Shift-click for a range."
                        }
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={(e) => onGutterClick(e, h, i)}
                      >
                        <span className="gh-diff-view__cb-col" aria-hidden="true">
                          <span className={`gh-diff-view__cb${line.staged ? " gh-diff-view__cb--on" : ""}`} />
                        </span>
                        {numbers}
                      </div>
                    ) : (
                      <div className="gh-diff-view__gutter">
                        <span className="gh-diff-view__cb-col" aria-hidden="true" />
                        {numbers}
                      </div>
                    )}
                    <span className="gh-diff-view__line-marker" aria-hidden="true">
                      {line.type === "add" ? "+" : line.type === "remove" ? "-" : " "}
                    </span>
                    <span className="gh-diff-view__line-content">{line.content}</span>
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
      {menu && <ContextMenu x={menu.x} y={menu.y} ariaLabel={menu.label} items={menu.items} onClose={() => setMenu(null)} />}
    </>
  );
}
