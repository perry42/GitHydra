// SPDX-License-Identifier: GPL-3.0-or-later

/** Well under Windows' 32,767-char CreateProcess limit (specs/ignore-and-multiselect.md FR-507), which also applies to `git.exe` shims. */
export const ARGV_BUDGET_CHARS = 16_000;

/** Quoting can double backslashes and escape quotes, so those count extra; a lone oversized item still gets its own batch. */
export function batchArgs(items: readonly string[], fixedChars = 0, budget = ARGV_BUDGET_CHARS): string[][] {
  const batches: string[][] = [];
  let cur: string[] = [];
  let used = fixedChars;
  for (const item of items) {
    let cost = item.length + 3;
    for (let i = 0; i < item.length; i++) {
      const c = item.charCodeAt(i);
      if (c === 0x22 || c === 0x5c) cost++;
    }
    if (cur.length > 0 && used + cost > budget) {
      batches.push(cur);
      cur = [];
      used = fixedChars;
    }
    cur.push(item);
    used += cost;
  }
  if (cur.length > 0) batches.push(cur);
  return batches;
}
