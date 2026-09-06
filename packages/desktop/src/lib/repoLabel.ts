// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * specs/multi-repo-tabs.md Must-have 1: a tab's short label is always derived from its repo
 * path (the final path segment / folder name), with the full path available separately as a
 * tooltip — never user-editable (see the spec's Non-goals). Handles both POSIX (`/`) and Windows
 * (`\`) separators since a repo path can come from either platform's native "Open" dialog, and
 * tolerates a trailing separator (e.g. a path picked via a directory dialog).
 */
export function repoTabLabel(repoPath: string): string {
  const trimmed = repoPath.replace(/[\\/]+$/, "");
  const segments = trimmed.split(/[\\/]/).filter(Boolean);
  return segments[segments.length - 1] ?? repoPath;
}
