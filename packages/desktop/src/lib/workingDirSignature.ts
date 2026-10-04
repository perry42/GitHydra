// SPDX-License-Identifier: GPL-3.0-or-later
import type { WorkingDirectoryChanges } from "@githydra/git-core";

/**
 * specs/live-refresh.md FR-460/FR-462: order-sensitive fingerprint of a status listing. A refresh whose result has
 * the same signature keeps the previous object, so React (and the Changes panel's overlay re-sync) sees no change.
 */
export function workingDirSignature(changes: WorkingDirectoryChanges | null): string {
  if (changes === null) return "\0bare";
  const part = (list: WorkingDirectoryChanges["staged"]) =>
    list.map((e) => `${e.status}\t${e.path}\t${e.oldPath ?? ""}`).join("\n");
  return [part(changes.staged), part(changes.unstaged), part(changes.untracked), part(changes.conflicted)].join("\0");
}

export function sameWorkingDir(a: WorkingDirectoryChanges | null, b: WorkingDirectoryChanges | null): boolean {
  return a === b || workingDirSignature(a) === workingDirSignature(b);
}
