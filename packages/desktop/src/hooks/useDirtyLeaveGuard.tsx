// SPDX-License-Identifier: GPL-3.0-or-later
import { createContext, createElement, useContext, useEffect, useRef, type ReactNode } from "react";

/**
 * specs/edit-in-diff.md FR-535: the ONE place every "this would drop an unsaved buffer" path asks. An editor registers a
 * source; a path that navigates away calls `confirmLeave()` first and proceeds only when it resolves true.
 * Slice B wires the in-panel paths (switch file, Back to diff, Esc); App-level paths (tabs, drawer, commit select, other
 * panels, app close) plug into the same registry by providing it above the Changes panel.
 */
export interface DirtyLeaveSource {
  isDirty(): boolean;
  /** Resolves true when the caller may proceed (clean, saved, or discarded) and false on Cancel or a failed save. */
  requestLeave(): Promise<boolean>;
}

export interface DirtyLeaveRegistry {
  register(source: DirtyLeaveSource): () => void;
  isDirty(): boolean;
  confirmLeave(): Promise<boolean>;
  /** Fires after a source registers, unregisters or reports a dirty change; App mirrors it to main for the close guard (FR-535). */
  subscribe(listener: () => void): () => void;
  /** A source's dirty state changed. */
  notify(): void;
  /**
   * Runs `proceed` now when nothing is dirty (keeping the clean path synchronous), else only after `confirmLeave()` allows it.
   * Every App-level path that would unmount the editor goes through this one function.
   */
  guard(proceed: () => void): void;
}

export function createDirtyLeaveRegistry(): DirtyLeaveRegistry {
  const sources = new Set<DirtyLeaveSource>();
  const listeners = new Set<() => void>();
  const notify = () => [...listeners].forEach((l) => l());
  const registry: DirtyLeaveRegistry = {
    register(source) {
      sources.add(source);
      notify();
      return () => {
        sources.delete(source);
        notify();
      };
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    notify,
    guard(proceed) {
      if (!registry.isDirty()) return proceed();
      void registry.confirmLeave().then((ok) => {
        if (ok) proceed();
      });
    },
    isDirty: () => [...sources].some((s) => s.isDirty()),
    async confirmLeave() {
      // One at a time so two dirty sources never stack dialogs.
      for (const s of [...sources]) {
        if (!s.isDirty()) continue;
        if (!(await s.requestLeave())) return false;
      }
      return true;
    },
  };
  return registry;
}

const DirtyLeaveContext = createContext<DirtyLeaveRegistry | null>(null);

export function DirtyLeaveGuardProvider({ registry, children }: { registry: DirtyLeaveRegistry; children: ReactNode }) {
  return createElement(DirtyLeaveContext.Provider, { value: registry }, children);
}

/** The registry from an App-level provider when there is one, else a private one for this component tree. */
export function useDirtyLeaveGuard(): DirtyLeaveRegistry {
  const provided = useContext(DirtyLeaveContext);
  const own = useRef<DirtyLeaveRegistry | null>(null);
  if (provided) return provided;
  own.current ??= createDirtyLeaveRegistry();
  return own.current;
}

/** Registers `source` for the lifetime of the calling component; always reads the latest closure. */
export function useRegisterDirtyLeaveSource(registry: DirtyLeaveRegistry, source: DirtyLeaveSource): void {
  const ref = useRef(source);
  ref.current = source;
  useEffect(
    () => registry.register({ isDirty: () => ref.current.isDirty(), requestLeave: () => ref.current.requestLeave() }),
    [registry],
  );
}
