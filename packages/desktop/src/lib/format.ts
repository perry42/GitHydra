import type { ChangedFile } from "@githydra/git-core";

/** ISO 8601 -> a readable, locale-aware absolute date/time (no relative "3 days ago" guessing —
 * exact timestamps matter more than approximations for a git history tool). */
export function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

export function formatAuthor(name: string, email: string): string {
  if (!name && !email) return "Unknown";
  if (!email) return name;
  if (!name) return `<${email}>`;
  return `${name} <${email}>`;
}

const STATUS_LABEL: Record<ChangedFile["status"], string> = {
  added: "Added",
  modified: "Modified",
  deleted: "Deleted",
  renamed: "Renamed",
  copied: "Copied",
  "type-changed": "Type changed",
  unmerged: "Unmerged",
  unknown: "Unknown",
};

export function changedFileStatusLabel(status: ChangedFile["status"]): string {
  return STATUS_LABEL[status];
}

/** CSS var name for the fixed, never-themed status palette (DESIGN.md "Tokens — status"). */
export function changedFileStatusColorVar(status: ChangedFile["status"]): string {
  switch (status) {
    case "added":
      return "var(--gh-status-good)";
    case "modified":
    case "type-changed":
    case "copied":
      return "var(--gh-status-warning)";
    case "renamed":
      return "var(--gh-status-warning)";
    case "unmerged":
      return "var(--gh-status-serious)";
    case "deleted":
    case "unknown":
      return "var(--gh-status-critical)";
    default:
      return "var(--gh-status-critical)";
  }
}

/** A single-line, hard-truncated preview — belt-and-suspenders against the "extremely long
 * commit message bodies" edge case even though CSS ellipsis already handles the common case. */
export function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 1)}…`;
}
