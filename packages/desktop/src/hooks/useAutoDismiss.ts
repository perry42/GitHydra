// SPDX-License-Identifier: GPL-3.0-or-later
import { useCallback, useEffect, useRef, useState } from "react";
import type { FocusEvent } from "react";

/** specs/auto-dismiss-status-messages.md the default lifetime of a plain success banner. */
export const AUTO_DISMISS_DELAY_MS = 6000;
export const AUTO_DISMISS_MAX_MS = 10000;
const LONG_COPY_THRESHOLD_CHARS = 80;
const EXTRA_MS_PER_CHAR = 40;

/** 6s for short one-liners; copy past ~80 chars adds ~40ms/char, capped at 10s. */
export function autoDismissDelayFor(copyLength: number): number {
  const extra = Math.max(0, copyLength - LONG_COPY_THRESHOLD_CHARS) * EXTRA_MS_PER_CHAR;
  return Math.min(AUTO_DISMISS_MAX_MS, AUTO_DISMISS_DELAY_MS + extra);
}

export interface AutoDismissHandlers {
  onPointerEnter: () => void;
  onPointerLeave: () => void;
  onFocus: () => void;
  onBlur: (event: FocusEvent<HTMLElement>) => void;
}

function windowIsActive(): boolean {
  if (typeof document === "undefined") return true;
  return document.visibilityState !== "hidden" && document.hasFocus();
}

/**
 * Auto-dismisses a plain success banner `delayMs` after it appears. No animation: the banner is
 * simply removed by `onDismiss`, so this is inherently reduced-motion safe.
 *
 * The timer is paused (and, on resume, restarted with the FULL delay) while the pointer hovers the
 * banner, while focus is inside it, and while the window is unfocused or the document hidden.
 * `resetKey` (the feature's sequence counter) cancels any pending timer when a newer operation
 * starts, so a stale timer can never dismiss a newer banner. Spread the returned handlers onto the
 * banner element. Never steals focus.
 *
 * Only ever pass `active = true` for plain success/info banners — never errors, warnings,
 * in-flight, or actionable/persistent-state banners.
 */
export function useAutoDismiss(
  active: boolean,
  delayMs: number,
  onDismiss: () => void,
  resetKey: number | string = 0,
): AutoDismissHandlers {
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [windowActive, setWindowActive] = useState(windowIsActive);
  const onDismissRef = useRef(onDismiss);
  onDismissRef.current = onDismiss;

  useEffect(() => {
    const sync = () => setWindowActive(windowIsActive());
    window.addEventListener("focus", sync);
    window.addEventListener("blur", sync);
    document.addEventListener("visibilitychange", sync);
    return () => {
      window.removeEventListener("focus", sync);
      window.removeEventListener("blur", sync);
      document.removeEventListener("visibilitychange", sync);
    };
  }, []);

  // When the banner goes away, stale hover/focus state must not carry over to the next one.
  useEffect(() => {
    if (!active) {
      setHovered(false);
      setFocused(false);
    }
  }, [active, resetKey]);

  const paused = hovered || focused || !windowActive;

  useEffect(() => {
    if (!active || paused) return;
    const id = setTimeout(() => onDismissRef.current(), delayMs);
    return () => clearTimeout(id);
  }, [active, paused, delayMs, resetKey]);

  const onPointerEnter = useCallback(() => setHovered(true), []);
  const onPointerLeave = useCallback(() => setHovered(false), []);
  const onFocus = useCallback(() => setFocused(true), []);
  const onBlur = useCallback((event: FocusEvent<HTMLElement>) => {
    const next = event.relatedTarget as Node | null;
    if (next && event.currentTarget.contains(next)) return;
    setFocused(false);
  }, []);

  return { onPointerEnter, onPointerLeave, onFocus, onBlur };
}
