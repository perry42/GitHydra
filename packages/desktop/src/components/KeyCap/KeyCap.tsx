// SPDX-License-Identifier: GPL-3.0-or-later
import { Fragment } from "react";
import { keyComboLabel, keyComboParts, type KeyCombo } from "../../lib/platform";
import "./KeyCap.css";

export interface KeyCapProps {
  /** The combo to render as a row of individual keycap chips. */
  combo: KeyCombo;
  /** Extra class(es) on the outer group wrapper — a layout hook only; chip visuals are fixed by
   * `DESIGN.md`'s system, not overridable per call site. */
  className?: string;
}

/**
 * specs/keyboard-shortcuts-visual-redesign.md FR-387/388: one flat, bordered, rounded "keycap"
 * chip per individual key in `combo` (e.g. `Ctrl+K` renders as a "Ctrl" chip, a `+` glyph, then a
 * "K" chip — never one chip containing the whole string), joined by small `+` glyphs. Reuses
 * `keyComboParts` — the same mod/shift/key decomposition `keyComboLabel` already has — so there is
 * exactly one place deciding key ordering/capitalization, not a second one duplicated here.
 *
 * The whole group carries a single `aria-label` (the flattened `keyComboLabel` string, e.g.
 * `"Ctrl+K"`) and hides its per-chip DOM from assistive tech (`aria-hidden` on every chip/glyph) —
 * a screen reader should hear one clean "Ctrl K", not each keycap and `+` glyph announced as a
 * separate item. `role="text"` flattens the element's accessible children into that single name
 * the same way Safari/VoiceOver's own convention for "visually segmented, one logical label" text
 * does — harmless in engines that don't recognize it (falls back to an unstyled generic role that
 * still exposes `aria-label`).
 */
export function KeyCap({ combo, className }: KeyCapProps) {
  const parts = keyComboParts(combo);
  return (
    <span
      className={`gh-keycap-group${className ? ` ${className}` : ""}`}
      role="text"
      aria-label={keyComboLabel(combo)}
    >
      {parts.map((part, index) => (
        <Fragment key={index}>
          {index > 0 && (
            <span className="gh-keycap__plus" aria-hidden="true">
              +
            </span>
          )}
          <span className="gh-keycap gh-mono" aria-hidden="true">
            {part}
          </span>
        </Fragment>
      ))}
    </span>
  );
}
