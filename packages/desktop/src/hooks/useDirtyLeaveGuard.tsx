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
}

export function createDirtyLeaveRegistry(): DirtyLeaveRegistry {
  const sources = new Set<DirtyLeaveSource>();
  return {
    register(source) {
      sources.add(source);
      return () => void sources.delete(source);
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
