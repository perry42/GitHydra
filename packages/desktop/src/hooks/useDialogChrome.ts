// SPDX-License-Identifier: GPL-3.0-or-later
import { useEffect } from "react";
import type { DependencyList, MouseEvent as ReactMouseEvent } from "react";

export interface UseDialogChromeOptions {
  /**
   * Called on Escape while `escapeActive` (default `true`). Composes any dialog-specific
   * intercept-then-close behavior itself — this hook has no opinion beyond "call this on Escape".
   * E.g. `CloneDialog` cancels an in-flight clone instead of closing while
   * `clone.phase === "cloning"`; `IdentityProfilesDialog` closes whichever inner layer (an open
   * edit form) is on top first, only calling the real `onClose` once nothing is layered above it.
   */
  onEscape: () => void;
  /** Whether the Escape listener is installed at all. Default `true`. */
  escapeActive?: boolean;
  /**
   * Extra reactive values `onEscape`'s (and, when `refocusWithEscapeEffect` is true,
   * `getFocusTarget`'s) closures read — spread into the internal effect's dependency array
   * alongside `escapeActive`, exactly mirroring whichever dependency array the component being
   * migrated already declared for its own hand-written listener. Default `[]`.
   */
  escapeDeps?: DependencyList;
  /**
   * Returns the element to focus once the dialog opens — e.g.
   * `() => dialogRef.current?.querySelector<HTMLElement>("input,button") ?? null` for a
   * "focus the first control" dialog, or `() => confirmRef.current` for a dialog that always
   * focuses one specific control. Omit to skip mount focus entirely (a caller that manages its own,
   * e.g. `FindCommitsOverlay`, which isn't migrated onto this hook — see its own doc comment).
   */
  getFocusTarget?: () => HTMLElement | null;
  /**
   * `true`: the focus call lives in the SAME effect as the Escape listener, so it re-runs (and
   * re-focuses) every time `escapeDeps` changes — matches most of this codebase's dialogs' actual
   * hand-written behavior (a single combined effect keyed on `[onClose]` or similar).
   * `false` (default): a separate, deliberately mount-only effect, run exactly once regardless of
   * `escapeDeps` — matches `CloneDialog`/`IdentityProfilesDialog`'s explicit fix for the
   * input-stealing bug their own doc comments describe (re-running a combined effect on every
   * keystroke, because the escape callback's dependencies change every render, steals focus back to
   * the first control).
   */
  refocusWithEscapeEffect?: boolean;
  /** Called on a backdrop (overlay) click, via the returned `onOverlayMouseDown` handler, while
   * `backdropActive` (default `true`). Omit for a dialog that isn't dismissable this way. */
  onBackdropClick?: () => void;
  /** Whether a backdrop click currently dismisses the dialog. Default `true`. E.g. `CloneDialog`
   * sets this to `false` while `clone.phase === "cloning"`, so an in-flight clone is never silently
   * orphaned by an accidental backdrop click the way the "always dismissable" default would allow. */
  backdropActive?: boolean;
}

export interface UseDialogChromeResult {
  /**
   * Attach to the overlay/backdrop element as `onMouseDown`. Only fires `onBackdropClick` for a
   * genuine click ON the overlay itself (`e.target === e.currentTarget`) — a click that started
   * inside the dialog panel and bubbled up does nothing, matching every hand-written
   * `onMouseDown={(e) => e.target === e.currentTarget && onClose()}` this hook replaces.
   */
  onOverlayMouseDown: (e: ReactMouseEvent) => void;
}

/**
 * ROADMAP.md "Clone: minor rough edges" — the dialog focus/Escape/backdrop-click chrome
 * (a mount-time focus-first-control effect, an Escape-key listener that closes or intercepts-then-
 * closes the dialog, and a backdrop-mousedown-to-close handler) was hand-copied across this
 * codebase's dialog components rather than sharing one implementation. This hook is that shared
 * implementation — it fits the union of the real variance found across all of them (an optional
 * escape-intercept via `onEscape`'s own closure, an optional `backdropActive` gate, and the
 * mount-only vs. combined-with-escape-effect focus-timing split) rather than forcing any of them to
 * change behavior to fit it.
 *
 * Deliberately NOT adopted by every dialog-shaped component in this codebase — `FindCommitsOverlay`
 * isn't a backdrop-scrim modal at all (no overlay element, so no backdrop-click-to-close), and folds
 * outside-click, Escape, a re-trigger-key-combo close, and a tab-boundary force-close into one
 * "click outside dismisses without clearing" contract that's specific enough to that feature
 * (specs/find-commits-overlay.md FR-263's revision) that forcing it through this hook's shape would
 * cost more than it would de-duplicate.
 */
export function useDialogChrome(options: UseDialogChromeOptions): UseDialogChromeResult {
  const {
    onEscape,
    escapeActive = true,
    escapeDeps = [],
    getFocusTarget,
    refocusWithEscapeEffect = false,
    onBackdropClick,
    backdropActive = true,
  } = options;

  useEffect(() => {
    if (!escapeActive) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      onEscape();
    }
    document.addEventListener("keydown", onKeyDown);
    if (refocusWithEscapeEffect) getFocusTarget?.()?.focus();
    return () => document.removeEventListener("keydown", onKeyDown);
    // `onEscape`/`getFocusTarget` are intentionally excluded — they're recreated every render, and
    // this effect must only reinstall when the caller's own declared `escapeDeps` (the actual
    // reactive values those closures read) change, exactly mirroring the hand-written effects this
    // hook replaces.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [escapeActive, refocusWithEscapeEffect, ...escapeDeps]);

  useEffect(() => {
    if (refocusWithEscapeEffect) return; // handled by the effect above instead.
    getFocusTarget?.()?.focus();
    // Deliberately mount-only (empty deps) — see `refocusWithEscapeEffect`'s doc comment.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function onOverlayMouseDown(e: ReactMouseEvent) {
    if (e.target !== e.currentTarget) return;
    if (!backdropActive) return;
    onBackdropClick?.();
  }

  return { onOverlayMouseDown };
}
