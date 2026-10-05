// SPDX-License-Identifier: GPL-3.0-or-later
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  EMPTY_SELECTION,
  reconcileSelection,
  selectOnly,
  selectRange,
  selectSection,
  toggleKey,
  type FileRow,
  type RowSection,
  type SelectionState,
} from "../lib/fileSelection";

/**
 * specs/ignore-and-multiselect.md FR-505/FR-511: the Changes list's multi-selection. The selection is kept by
 * path + section and re-pointed (or silently dropped) whenever the list changes, so a live refresh never
 * strands it. The owning panel remounts per repository, which clears it on a repo/tab change (FR-514).
 */
export interface UseFileSelectionResult {
  selectedRows: FileRow[];
  isSelected: (key: string) => boolean;
  only: (key: string) => void;
  toggle: (key: string) => void;
  extendTo: (key: string, additive: boolean, fallbackAnchor?: string) => void;
  selectAllIn: (section: RowSection) => void;
  clear: () => void;
}

export function useFileSelection(rows: readonly FileRow[]): UseFileSelectionResult {
  const [state, setState] = useState<SelectionState>(EMPTY_SELECTION);

  useEffect(() => {
    setState((cur) => reconcileSelection(cur, rows));
  }, [rows]);

  const selectedRows = useMemo(() => rows.filter((r) => state.keys.has(r.key)), [rows, state]);

  const isSelected = useCallback((key: string) => state.keys.has(key), [state]);
  const only = useCallback((key: string) => setState(selectOnly(key)), []);
  const toggle = useCallback((key: string) => setState((cur) => toggleKey(cur, key)), []);
  const extendTo = useCallback(
    (key: string, additive: boolean, fallbackAnchor?: string) =>
      setState((cur) => selectRange(cur, rows, key, additive, fallbackAnchor)),
    [rows],
  );
  const selectAllIn = useCallback((section: RowSection) => setState(selectSection(rows, section)), [rows]);
  const clear = useCallback(() => setState(EMPTY_SELECTION), []);

  return { selectedRows, isSelected, only, toggle, extendTo, selectAllIn, clear };
}
