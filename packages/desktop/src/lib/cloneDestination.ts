// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * specs/online-sync-clone.md FR-351: pure helpers for `CloneDialog`'s "Browse…" button. A native
 * OS folder-picker dialog (reused verbatim from `api.openRepoDialog()` — see that method's own
 * "Open a git repository" usage elsewhere in this app) can only return an EXISTING directory, but
 * `clone(url, destination)` needs a destination that does not yet exist (or is empty) — so Browse
 * picks the PARENT directory the new repo folder should live in, and this module derives a
 * sensible child folder name from the URL to combine with it, exactly like GitHub Desktop/
 * GitKraken's own "clone into" pickers. The combined result is only ever a *starting point*: the
 * destination field itself stays a plain, freely-editable text input (see `CloneDialog.tsx`), so a
 * user can always override the suggestion.
 */

/**
 * Derives a plausible repository folder name from a clone URL — the last non-empty path segment,
 * with a trailing `.git` stripped, working for every transport this app never restricts the shape
 * of (`https://host/owner/repo.git`, `git@host:owner/repo.git`, a bare local path on either
 * platform's separator). Falls back to `"repository"` for a URL with no usable trailing segment
 * (e.g. empty, or just a host) rather than ever producing an empty folder name — and likewise
 * falls back for a last segment of exactly `.` or `..`, since those are reserved filesystem
 * entries (never a real repo name) and combining them with `joinDestinationPath()` would resolve
 * outside the picked parent directory instead of naming a new folder inside it.
 */
export function deriveRepoNameFromUrl(url: string): string {
  const trimmed = url.trim().replace(/[/\\]+$/, "");
  if (!trimmed) return "repository";
  const withoutGitSuffix = trimmed.replace(/\.git$/i, "");
  const segments = withoutGitSuffix.split(/[/\\:]+/).filter(Boolean);
  const last = segments[segments.length - 1]?.trim();
  return last && last !== "." && last !== ".." ? last : "repository";
}

/** Joins `parentDir` (native-separator-styled, as returned by the OS folder dialog) with
 * `repoName` using whichever separator `parentDir` itself already uses — never assumes `/`
 * unconditionally, since a Windows-picked path is backslash-styled. Falls back to `/` for a
 * `parentDir` that contains neither separator (e.g. a bare drive letter or single segment). */
export function joinDestinationPath(parentDir: string, repoName: string): string {
  const sep = parentDir.includes("\\") && !parentDir.includes("/") ? "\\" : "/";
  const trimmedParent = parentDir.replace(/[/\\]+$/, "");
  return `${trimmedParent}${sep}${repoName}`;
}
