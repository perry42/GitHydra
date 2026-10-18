// SPDX-License-Identifier: GPL-3.0-or-later
import type { WorktreeEntry, WorktreeList } from "@githydra/git-core";
import { COPY_HERE_LABEL, copyIntoReason } from "../../lib/worktreeCopyExisting";
import type { ContextMenuItem } from "../ContextMenu/ContextMenu";
import { IconWorktree } from "../Icon/Icon";

/**
 * specs/worktree-copy-ignored.md FR-649/650: the "Copy ignored files here..." menu item for one worktree. A refused destination stays
 * focusable (`aria-disabled`, never a native `disabled`) and spells its reason as the second line; "no ignored files" is not a reason
 * because it is known only after the listing.
 */
export function buildCopyHereItem(
  entry: WorktreeEntry,
  list: WorktreeList,
  source: WorktreeEntry | null,
  onCopy: (entry: WorktreeEntry) => void,
  wrap: (fn: () => void) => () => void = (fn) => fn,
): ContextMenuItem {
  const reason = copyIntoReason(entry, { source, list });
  return {
    label: COPY_HERE_LABEL,
    icon: <IconWorktree size={14} />,
    softDisabled: reason !== null,
    description: reason ?? undefined,
    onSelect: wrap(() => onCopy(entry)),
  };
}
