// SPDX-License-Identifier: GPL-3.0-or-later
import type { CandidateDisabledReason, CopySkipReason } from "./worktreeCopyPure";

/**
 * Pure rules of section G, copy into an EXISTING worktree (specs/worktree-copy-ignored.md FR-649..657). No I/O and no Node
 * globals at load time (renderer-reachable, see rendererSafeLoad).
 */

/** FR-630 normative fold (amended 2026-10-19, L2): `NFD(toLowerCase(toUpperCase(NFC(x))))` per segment, on every OS. */
export function copyCollisionKey(relPath: string): string {
  return relPath
    .split("/")
    .map((seg) => seg.normalize("NFC").toUpperCase().toLowerCase().normalize("NFD"))
    .join("/");
}

const ESCAPE_RE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}]/u;
export const DISPLAY_NAME_MAX = 120;

/**
 * FR-651 (L1): control, bidi and format characters become visible `U+XXXX`; a single name longer than 120 characters is cut in the
 * middle. Used for every name main sends for display (folder names, the destination path, skipped names).
 */
export function escapeDisplayName(name: string, max = DISPLAY_NAME_MAX): string {
  let out = "";
  for (const ch of name) {
    if (ESCAPE_RE.test(ch)) out += `U+${ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`;
    else out += ch;
  }
  if (out.length <= max) return out;
  const keep = Math.max(2, max - 3);
  const head = Math.ceil(keep / 2);
  return `${out.slice(0, head)}...${out.slice(out.length - (keep - head))}`;
}

export type ExistingDisabledReason =
  | CandidateDisabledReason
  | "already-exists"
  | "destination-link"
  | "tracked-in-destination"
  | "inside-another-repository"
  | "contains-destination"
  | "could-not-be-checked";

/** FR-651 (settled 2026-10-19): the strongest tag of a row. */
export const EXISTING_REASON_ORDER = ["inside-another-repository", "destination-link", "tracked-in-destination", "already-exists"] as const;

export function strongestExistingReason(reasons: Iterable<ExistingDisabledReason>): ExistingDisabledReason | null {
  const seen = new Set(reasons);
  for (const r of EXISTING_REASON_ORDER) if (seen.has(r)) return r;
  for (const r of seen) return r;
  return null;
}

/** Fixed row tag text; `destName` is main's escaped name of the destination (never the renderer's own). */
export function existingReasonText(reason: ExistingDisabledReason, destName: string): string {
  switch (reason) {
    case "nested-repository":
      return "separate repository, not copied";
    case "symbolic-link":
      return "symbolic link, not copied";
    case "not-a-regular-file":
      return "not a regular file";
    case "name-not-allowed":
      return "name not allowed";
    case "too-many-files":
      return "too many files";
    case "already-exists":
      return "already exists";
    case "destination-link":
      return "destination folder is a link";
    case "tracked-in-destination":
      return `tracked in ${destName}`;
    case "inside-another-repository":
      return "inside another repository";
    case "contains-destination":
      return `contains ${destName}`;
    case "could-not-be-checked":
      return "could not be checked";
  }
}

/** FR-655 reason strings: a fixed table, never raw error text. */
export function existingSkipText(reason: CopySkipReason, destName: string): string {
  switch (reason) {
    case "already-exists":
    case "case-collision":
    case "destination-not-directory":
      return "already exists";
    case "tracked-in-destination":
      return `tracked in ${destName}`;
    case "changed-since-review":
      return "changed since you reviewed";
    case "source-symlink":
    case "source-parent-link":
      return "symbolic link";
    case "unsafe-path":
    case "row-disabled":
      return "name not allowed";
    case "destination-parent-link":
      return "destination folder is a link";
    case "inside-another-repository":
      return "inside another repository";
    case "contains-destination":
      return `contains ${destName}`;
    case "could-not-be-checked":
      return "could not be checked";
    case "source-unreadable":
      return "could not be read";
    case "not-regular-file":
      return "not a regular file";
    case "path-too-long":
      return "path too long";
    case "file-limit":
    case "size-limit":
    case "time-limit":
      return "over the limit";
    case "not-in-manifest":
      return "not found";
    case "cancelled":
      return "cancelled";
    case "write-failed":
      return "could not be written";
  }
}
