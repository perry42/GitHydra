// SPDX-License-Identifier: GPL-3.0-or-later
import type { IgnoreTarget } from "@githydra/git-core";

/** specs/ignore-and-multiselect.md D2: the last "Add to" choice, remembered per repository, locally. Never throws (storage can be blocked). */
const key = (repoKey: string): string => `githydra:ignoreTarget:${repoKey}`;

export function readLastIgnoreTarget(repoKey: string | null): IgnoreTarget {
  if (!repoKey) return "root";
  try {
    const v = window.localStorage.getItem(key(repoKey));
    return v === "root" || v === "nearest" || v === "exclude" ? v : "root";
  } catch {
    return "root";
  }
}

export function writeLastIgnoreTarget(repoKey: string | null, target: IgnoreTarget): void {
  if (!repoKey) return;
  try {
    window.localStorage.setItem(key(repoKey), target);
  } catch {
    /* a remembered default is a convenience, never worth failing the action */
  }
}
