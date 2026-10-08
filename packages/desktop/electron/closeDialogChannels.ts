// SPDX-License-Identifier: GPL-3.0-or-later
import type { NativeConfirmReason } from "./closeGuard";

/** Private to the close-prompt window's own preload; the main window's preload never exposes these. */
export const CLOSE_DIALOG_CHANNELS = {
  getReason: "closeDialog:getReason",
  ready: "closeDialog:ready",
  respond: "closeDialog:respond",
} as const;

export type CloseDialogChoice = "close" | "keep";

export const CLOSE_DIALOG_REASONS: readonly NativeConfirmReason[] = ["second-attempt", "unresponsive"];

export function parseChoice(value: unknown): CloseDialogChoice | null {
  return value === "close" || value === "keep" ? value : null;
}
