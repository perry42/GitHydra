// SPDX-License-Identifier: GPL-3.0-or-later
import { useEffect, useLayoutEffect, useRef } from "react";

/**
 * specs/live-refresh.md FR-465: the single "is the user busy?" signal. Plain refs behind a stable object, so
 * `useRepositoryGraph`'s watcher callbacks read the live value without stale closures. The hook creating the gate
 * runs before the hooks that own the busy state, hence sources are pushed in rather than computed here.
 */
export interface IdleGate {
  /** True when no source is busy. */
  isIdle(): boolean;
  setBusy(source: string, busy: boolean): void;
  /** Fires on each busy-to-idle transition; returns the unsubscribe function. */
  subscribe(listener: () => void): () => void;
}

export function createIdleGate(): IdleGate {
  const busy = new Set<string>();
  const listeners = new Set<() => void>();
  return {
    isIdle: () => busy.size === 0,
    setBusy(source, isBusy) {
      if (isBusy) {
        busy.add(source);
        return;
      }
      if (!busy.delete(source) || busy.size > 0) return;
      for (const listener of [...listeners]) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** Always idle: the default when no caller supplies a gate (standalone hook tests). */
export const ALWAYS_IDLE_GATE: IdleGate = {
  isIdle: () => true,
  setBusy: () => {},
  subscribe: () => () => {},
};

export function useIdleGate(): IdleGate {
  const ref = useRef<IdleGate | null>(null);
  if (ref.current === null) ref.current = createIdleGate();
  return ref.current;
}

/**
 * Mirrors a record of busy flags into the gate. A layout effect so the flag is set before the browser can deliver
 * an event that would read a stale "idle"; cleared on unmount so a closed overlay can never pin the app busy.
 */
export function useIdleSources(gate: IdleGate, sources: Record<string, boolean>): void {
  const keys = Object.keys(sources).sort();
  const signature = keys.map((k) => `${k}:${sources[k] ? 1 : 0}`).join("|");
  const keysRef = useRef(keys);
  keysRef.current = keys;
  useLayoutEffect(() => {
    for (const k of keys) gate.setBusy(k, sources[k] === true);
    // `signature` captures every value read above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gate, signature]);
  useEffect(
    () => () => {
      for (const k of keysRef.current) gate.setBusy(k, false);
    },
    [gate],
  );
}
