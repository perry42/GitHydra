// SPDX-License-Identifier: GPL-3.0-or-later
import { useRef, useState, type KeyboardEvent } from "react";
import type { BulkAction, Eligibility } from "../../lib/fileSelection";
import { plural } from "../../lib/fileSelection";
import { ActionIcon } from "./ActionIcon";
import "./BulkBar.css";

export interface BulkBarProps {
  selectedCount: number;
  eligibility: Record<"discard" | "ignore", Eligibility>;
  busy: boolean;
  onDiscard: () => void;
  /** Opens the Ignore popover anchored on the button. */
  onIgnore: (anchor: HTMLElement) => void;
  onClear: () => void;
}

const VERB: Record<"discard" | "ignore", string> = { discard: "Discard", ignore: "Ignore" };

/**
 * specs/ignore-and-multiselect.md FR-518b: one slim row pinned under the file list at two or more selected rows: the count and
 * the actions that have no section-header home (Discard, Ignore) plus Clear; Stage/Unstage live in the section headers.
 * Icon + label, icon-only when the column is narrow (container query). An action with nothing eligible stays focusable
 * (`aria-disabled`) so its reason is reachable by tooltip AND by assistive tech; the skipped count is in the same text and is
 * known before the action runs (FR-506). A toolbar is one tab stop; Left/Right/Home/End move within it (roving tabindex).
 */
export function BulkBar({ selectedCount, eligibility, busy, onDiscard, onIgnore, onClear }: BulkBarProps) {
  const barRef = useRef<HTMLDivElement | null>(null);
  const [active, setActive] = useState(0);
  const actions: BulkAction[] = ["discard", "ignore"];

  const move = (e: KeyboardEvent<HTMLDivElement>) => {
    const buttons = Array.from(barRef.current?.querySelectorAll<HTMLButtonElement>("button") ?? []);
    const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (i < 0) return;
    let next = i;
    if (e.key === "ArrowRight") next = (i + 1) % buttons.length;
    else if (e.key === "ArrowLeft") next = (i - 1 + buttons.length) % buttons.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = buttons.length - 1;
    else return;
    e.preventDefault();
    setActive(next);
    buttons[next]!.focus();
  };

  return (
    <div
      ref={barRef}
      className="gh-bulk-bar"
      role="toolbar"
      aria-label={`Actions for ${plural(selectedCount, "selected file")}`}
      onKeyDown={move}
    >
      <span className="gh-bulk-bar__count">{selectedCount} selected</span>
      {actions.map((action, index) => {
        const a = action as "discard" | "ignore";
        const { eligible, skipped } = eligibility[a];
        const unavailable = eligible.length === 0 || busy;
        const reason = eligible.length === 0 ? (skipped[0]?.reason ?? "Nothing selected applies.") : undefined;
        const skippedNote = skipped.length > 0 ? `${skipped.length} skipped: ${skipped[0]!.reason}` : undefined;
        const name = unavailable ? VERB[a] : `${VERB[a]} ${plural(eligible.length, "file")}…`;
        const detail = reason ?? skippedNote;
        return (
          <button
            key={a}
            type="button"
            className={`gh-bulk-bar__button${a === "discard" ? " gh-bulk-bar__button--danger" : ""}`}
            tabIndex={active === index ? 0 : -1}
            aria-label={name}
            aria-disabled={unavailable || undefined}
            aria-description={detail}
            aria-haspopup={a === "ignore" ? "dialog" : undefined}
            title={detail ? `${name}. ${detail}` : name}
            onFocus={() => setActive(index)}
            onClick={(e) => {
              if (unavailable) return;
              if (a === "discard") onDiscard();
              else onIgnore(e.currentTarget);
            }}
          >
            <ActionIcon kind={a} />
            <span className="gh-bulk-bar__label">{VERB[a]}</span>
          </button>
        );
      })}
      <button
        type="button"
        className="gh-bulk-bar__button gh-bulk-bar__button--clear"
        tabIndex={active === actions.length ? 0 : -1}
        aria-label="Clear"
        title="Clear selection (Esc)"
        onFocus={() => setActive(actions.length)}
        onClick={onClear}
      >
        <ActionIcon kind="clear" />
        <span className="gh-bulk-bar__label">Clear</span>
      </button>
    </div>
  );
}
