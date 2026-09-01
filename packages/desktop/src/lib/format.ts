import type { ChangedFile, StashInfo } from "@githydra/git-core";

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

/**
 * specs/stash.md FR-94/edge cases: `StashInfo.branch` is `null` for two genuinely different
 * situations that git-core's `parseStashSubject()` (stash.ts) deliberately can't tell apart from
 * the data alone: (1) a real detached-HEAD stash using git's own default message (`WIP on (no
 * branch): ...`), and (2) ANY stash created with a custom message (`-m`), regardless of whether
 * HEAD was attached to a branch or detached at the time — git's own "On <branch>: " wrapper is
 * intentionally not parsed for a custom message (see that module's doc comment), so this case's
 * true origin branch is unrecoverable, not merely unparsed.
 *
 * Bug found via manual end-to-end testing (a stash created with a custom message on a normal
 * branch, "master", showed a caption reading "(detached HEAD)" — actively wrong, not just vague,
 * since the repo was never detached): collapsing both null-reasons into the same "(detached
 * HEAD)" caption asserts something false about repo state for case (2). This distinguishes them
 * using the one extra signal available — whether `message` is genuinely git's detached-HEAD
 * default form — without needing any git-core change.
 */
export function stashBranchCaption(stash: Pick<StashInfo, "branch" | "message">): string {
  if (stash.branch) return stash.branch;
  if (/^WIP on \(no branch\):/.test(stash.message)) return "(detached HEAD)";
  return "(unknown — custom message)";
}
