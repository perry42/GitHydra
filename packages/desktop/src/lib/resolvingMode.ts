// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * specs/edit-in-diff.md FR-593..FR-600: the conflict view's read-only-first mode. The two owner-open questions live here as
 * single switches so the owner can flip an answer in one line.
 */

/** Q1 (owner answered: false). `true`: block text is locked in Resolving too. `false`: block text is typable there, only text outside blocks is locked. */
export const LOCK_BLOCK_TEXT_IN_RESOLVING = false;

/** Q2: Esc from Editing steps back to Resolving (dirty or clean). `false`: Esc from Editing leaves the file as before. */
export const ESC_STEPS_BACK_TO_RESOLVING = true;

export const READ_ONLY_HINT_LOCKED = "Read-only. Double-click or press E to edit.";
export const READ_ONLY_HINT_BLOCKS_EDITABLE = "Conflict text is editable. Double-click elsewhere or press E to edit the whole file.";
export const READ_ONLY_ANNOUNCE = "Read-only. Press E to edit.";
