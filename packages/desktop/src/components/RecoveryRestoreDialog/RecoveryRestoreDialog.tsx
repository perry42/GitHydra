// SPDX-License-Identifier: GPL-3.0-or-later
import type { RestoreChoice, RestoreOffer } from "../../hooks/useRecoveryRestore";
import { RESTORE_CHANGED_WARNING, baseName } from "../../lib/editFile";
import { ConfirmDialog } from "../ConfirmDialog/ConfirmDialog";

export interface RecoveryRestoreDialogProps {
  offer: RestoreOffer;
  onChoose: (choice: RestoreChoice) => void;
}

/**
 * specs/edit-recovery-draft.md FR-549/551, AC11: Restore is the focused default, Discard is destructive and never focused,
 * Esc / backdrop is Not now. Focus return and the trap come from ConfirmDialog.
 */
// Bidi controls in a file name could reorder the surrounding sentence (a spoofing vector).
const stripBidi = (s: string): string => s.replace(/[\u202A-\u202E\u2066-\u2069]/g, "");

export function RecoveryRestoreDialog({ offer, onChoose }: RecoveryRestoreDialogProps) {
  const saved = new Date(offer.draft.savedAt).toLocaleString();
  return (
    <ConfirmDialog
      title={`Restore your unsaved edits to ${stripBidi(baseName(offer.path))}?`}
      message={`GitHydra kept a copy of your edits to ${stripBidi(offer.path)} from ${saved}. Restoring puts them back in the editor; nothing is written to the file until you save.`}
      notice={offer.changedOnDisk ? RESTORE_CHANGED_WARNING : undefined}
      confirmLabel="Restore"
      cancelLabel="Not now"
      secondaryAction={{ label: "Discard", destructive: true, onClick: () => onChoose("discard") }}
      onConfirm={() => onChoose("restore")}
      onCancel={() => onChoose("later")}
    />
  );
}
