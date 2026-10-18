// SPDX-License-Identifier: GPL-3.0-or-later
import { useRef } from "react";
import { ContextMenu, type ContextMenuItem } from "../ContextMenu/ContextMenu";

export interface OpenInChooserProps {
  ariaLabel: string;
  /** Build the item with `wrap` around every callback so a chosen action keeps the focus it moves to. */
  buildItem: (wrap: (fn: () => void) => () => void) => ContextMenuItem;
  onClose: () => void;
}

/**
 * specs/external-programs.md FR-617/FR-625: the accordion on its own, opened expanded, for the palette surfaces that have no menu row to
 * host it ("Worktree: Open..." Right arrow, "Open repository in external program"). Esc or an outside click returns focus to the
 * control that had it before; choosing a program leaves the focus to whatever that action opens.
 */
export function OpenInChooser({ ariaLabel, buildItem, onClose }: OpenInChooserProps) {
  const opener = useRef<HTMLElement | null>(document.activeElement as HTMLElement | null);
  const chosen = useRef(false);
  const wrap = (fn: () => void) => () => {
    chosen.current = true;
    fn();
  };
  const close = () => {
    const back = opener.current;
    onClose();
    if (!chosen.current && back && back.isConnected) queueMicrotask(() => back.focus());
  };
  const x = Math.max(8, Math.round(window.innerWidth / 2 - 150));
  return <ContextMenu x={x} y={120} ariaLabel={ariaLabel} items={[buildItem(wrap)]} onClose={close} />;
}
