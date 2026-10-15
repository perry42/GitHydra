// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * specs/external-programs.md FR-617..625, FR-642: the plain data that crosses the bridge for "open a folder in a program".
 * The renderer only ever names a program by id and a target by worktree id or "repo root"; it never carries an exe or a folder
 * string, so a compromised renderer cannot register or start `C:\x\evil.exe`.
 */

/** The built-in choice that opens a worktree as a GitHydra tab. It is stored as the default like any program id. */
export const GITHYDRA_TAB_ID = "githydra-tab";

/** A program id is `[a-z0-9._-]`, never a path. Checked in main and again in the renderer-facing helpers. */
export const PROGRAM_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export interface ProgramView {
  id: string;
  name: string;
  /** The absolute program path (an `.app` bundle on macOS) as shown in the Programs dialog. */
  path: string;
  /** The realpath when it differs from `path` (symlinked launchers); shown as a tooltip. */
  resolvedPath: string | null;
  source: "detected" | "custom";
  hidden: boolean;
  /** False when the file is gone or no longer passes the exe rules; `unavailableReason` says why. */
  available: boolean;
  unavailableReason: string | null;
  isDefault: boolean;
}

export interface ProgramsSnapshot {
  programs: ProgramView[];
  /** The program id or `GITHYDRA_TAB_ID` that a plain click uses; `null` on first run (the click expands instead). */
  defaultId: string | null;
  /** Set when a stored default vanished: the stated reason GitHydra tab is used instead (FR-617). */
  fallbackReason: string | null;
}

export type ProgramRefusalReason =
  | "invalid-request"
  | "unknown-program"
  | "not-found"
  | "unsafe-location"
  | "refused-program"
  | "folder-not-allowed"
  | "spawn-failed"
  | "hidden"
  | "default-cannot-hide"
  | "already-added"
  | "confirm-expired"
  | "no-repository";

export interface ProgramRefusal {
  ok: false;
  reason: ProgramRefusalReason;
  /** Plain text, already redacted: it never carries a path, stderr or an environment value. */
  message: string;
}

/** Why a picked file cannot be saved as a program (FR-642 exe rules). Each has its own sentence. */
export type ExeProblem =
  | "relative"
  | "missing"
  | "directory"
  | "not-executable"
  | "interpreter"
  | "script-extension"
  | "not-windows-exe"
  | "unc";

export type AddProgramResult =
  | { status: "added"; program: ProgramView }
  | { status: "cancelled" }
  /** The picked file sits in a repository, a worktree or a world-writable folder: the user confirms with the full path (FR-642). */
  | { status: "needs-confirm"; pendingId: string; path: string; why: "repository" | "world-writable" }
  | { status: "rejected"; problem: ExeProblem; message: string }
  | ProgramRefusal;

export type LocateProgramResult = AddProgramResult;

export type LaunchTarget = { worktreeId: string } | { repoRoot: true } | { mainWorktree: true };

export interface LaunchProgramRequest {
  programId: string;
  target: LaunchTarget;
}

export type LaunchProgramResult =
  | { ok: true; programName: string; wasDefault: boolean }
  | ProgramRefusal;

export type SimpleProgramResult = { ok: true; snapshot: ProgramsSnapshot } | ProgramRefusal;
