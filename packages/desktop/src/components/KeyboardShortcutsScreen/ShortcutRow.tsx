// SPDX-License-Identifier: GPL-3.0-or-later
import { Fragment, useEffect, useRef, useState } from "react";
import { keyComboFromEvent } from "../../lib/keybindingOverrides";
import type { KeyCombo } from "../../lib/platform";
import { IconChanges } from "../Icon/Icon";
import { KeyCap } from "../KeyCap/KeyCap";

export interface ShortcutRowConflict {
  combo: KeyCombo;
  conflictLabel: string;
}

export interface ShortcutRowProps {
  /** The real registry command id — only ever rendered for FR-396-eligible rows (never a static
   * row or the synthetic "Switch to tab" summary row, which don't get an Edit affordance at all). */
  commandId: string;
  label: string;
  keybindings: KeyCombo[];
  /** FR-400: whether `commandId` currently carries ANY override (custom or "unbound") — governs
   * whether "Reset to default" is shown at all. */
  hasOverride: boolean;
  /** True while THIS row is the one being edited (capturing a new combo, or showing FR-399's
   * conflict warning) — at most one row in the whole screen is ever active at a time. */
  isActive: boolean;
  /** Non-null only while `isActive` and the just-captured combo conflicts with another command —
   * swaps the capture preview for FR-399's inline Reassign/Cancel warning. */
  conflict: ShortcutRowConflict | null;
  /** FR-397/398's inline rejection message, shown until the next edit starts on any row — `null`
   * the rest of the time. */
  message: string | null;
  /** True while a DIFFERENT row is currently active — disables this row's own Edit/Reset actions
   * so only one rebind is ever in flight. */
  disabled: boolean;
  onStartEdit: (commandId: string) => void;
  /** Fired once this row's capture ends (Escape excluded — see `onCancelEdit`): `combo` is the
   * last previewed candidate, or `null` if nothing was ever captured (a silent revert). */
  onCapture: (commandId: string, combo: KeyCombo | null) => void;
  /** Escape while capturing (not showing a conflict) — reverts with no message, unlike a rejected
   * `onCapture`. */
  onCancelEdit: (commandId: string) => void;
  onReassign: () => void;
  onCancelConflict: () => void;
  onResetToDefault: (commandId: string) => void;
}

/**
 * specs/keyboard-shortcut-rebinding.md FR-402: one eligible row's normal display (keycap chips +
 * Edit + conditional "Reset to default") plus its inline capture/conflict states. Extracted from
 * `KeyboardShortcutsScreen` so the capture mechanics (its own local `keydown`/outside-click
 * listeners — FR-403) live with the row they affect, while `KeyboardShortcutsScreen` itself stays
 * the one place that owns validation/conflict-lookup/persistence (via the callbacks above).
 */
export function ShortcutRow({
  commandId,
  label,
  keybindings,
  hasOverride,
  isActive,
  conflict,
  message,
  disabled,
  onStartEdit,
  onCapture,
  onCancelEdit,
  onReassign,
  onCancelConflict,
  onResetToDefault,
}: ShortcutRowProps) {
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const [preview, setPreview] = useState<KeyCombo | null>(null);
  // A mouse click outside the wrapper fires BOTH this row's own document-level `mousedown`
  // listener (below) AND, immediately after, a native `blur` on the wrapper (since focus moves
  // away as part of that same click) — without this guard, `handleBlur` would run a SECOND
  // finalize immediately after the mousedown-triggered one already ran, treating "outside click
  // while a just-computed conflict is showing" as an accidental Cancel. Set synchronously inside
  // the mousedown handler (which always fires before the browser's own blur) and consumed by the
  // very next blur; a genuine keyboard Tab-away (no preceding mousedown) never touches this ref.
  const suppressNextBlurRef = useRef(false);

  // Mount-only-per-activation focus — deliberately its own effect (not combined with the listener
  // effect below) so a live-preview update never steals focus back, the same fix
  // `useDialogChrome`'s `refocusWithEscapeEffect` doc comment already documents for this bug class.
  useEffect(() => {
    if (isActive) wrapperRef.current?.focus();
  }, [isActive]);

  useEffect(() => {
    if (!isActive) {
      setPreview(null);
      return;
    }

    function finalize() {
      if (conflict) {
        // Outside interaction while a conflict warning is showing backs out to plain capture,
        // mirroring Escape's own behavior here — never silently discards/saves through it.
        onCancelConflict();
        return;
      }
      onCapture(commandId, preview);
      setPreview(null);
    }

    function onKeyDown(e: KeyboardEvent) {
      // A bare Tab (no modifier) is never itself a capturable combo (FR-398) — let it move focus
      // normally instead of swallowing it, so keyboard-only users can Tab away to finalize
      // (the wrapper's onBlur below handles that path) rather than getting trapped in the row.
      if (e.key === "Tab" && !e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      if (e.key === "Escape") {
        if (conflict) {
          onCancelConflict();
          return;
        }
        setPreview(null);
        onCancelEdit(commandId);
        return;
      }
      if (conflict) return; // Only the Reassign/Cancel buttons act while a conflict is showing.
      const combo = keyComboFromEvent(e);
      if (combo) setPreview(combo);
    }

    function onMouseDown(e: MouseEvent) {
      if (wrapperRef.current?.contains(e.target as Node)) return;
      suppressNextBlurRef.current = true;
      finalize();
    }

    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("mousedown", onMouseDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("mousedown", onMouseDown);
    };
  }, [isActive, conflict, preview, commandId, onCapture, onCancelEdit, onCancelConflict]);

  function handleBlur(e: React.FocusEvent<HTMLDivElement>) {
    if (suppressNextBlurRef.current) {
      suppressNextBlurRef.current = false;
      return;
    }
    if (!isActive) return;
    if (wrapperRef.current?.contains(e.relatedTarget as Node)) return;
    if (conflict) {
      onCancelConflict();
      return;
    }
    onCapture(commandId, preview);
    setPreview(null);
  }

  return (
    <li className="gh-keyboard-shortcuts__item">
      <span className="gh-keyboard-shortcuts__label">{label}</span>
      {isActive ? (
        <div
          ref={wrapperRef}
          tabIndex={-1}
          onBlur={handleBlur}
          className="gh-shortcut-row__capture"
          role="group"
          aria-label={conflict ? `Editing shortcut for ${label} — conflict` : `Editing shortcut for ${label} — press a key combination`}
        >
          {conflict ? (
            <div className="gh-shortcut-row__conflict">
              <span className="gh-shortcut-row__conflict-text">
                <KeyCap combo={conflict.combo} /> is already used by &quot;{conflict.conflictLabel}&quot;.
              </span>
              <button type="button" className="gh-shortcut-row__conflict-reassign" onClick={onReassign}>
                Reassign
              </button>
              <button type="button" className="gh-shortcut-row__conflict-cancel" onClick={onCancelConflict}>
                Cancel
              </button>
            </div>
          ) : preview ? (
            <KeyCap combo={preview} variant="listening" />
          ) : (
            <span className="gh-shortcut-row__placeholder">Press a key combination…</span>
          )}
        </div>
      ) : (
        <>
          {message && (
            <span className="gh-shortcut-row__message" role="alert">
              {message}
            </span>
          )}
          <span className="gh-keyboard-shortcuts__shortcut">
            {keybindings.length > 0 ? (
              keybindings.map((combo, comboIndex) => (
                <Fragment key={comboIndex}>
                  {comboIndex > 0 && " / "}
                  <KeyCap combo={combo} />
                </Fragment>
              ))
            ) : (
              <span className="gh-shortcut-row__none">No shortcut</span>
            )}
          </span>
          {hasOverride && (
            <button
              type="button"
              className="gh-shortcut-row__reset"
              disabled={disabled}
              onClick={() => onResetToDefault(commandId)}
            >
              Reset to default
            </button>
          )}
          <button
            type="button"
            className="gh-shortcut-row__edit"
            aria-label={`Edit shortcut for ${label}`}
            title={`Edit shortcut for ${label}`}
            disabled={disabled}
            onClick={() => onStartEdit(commandId)}
          >
            <IconChanges />
          </button>
        </>
      )}
    </li>
  );
}
