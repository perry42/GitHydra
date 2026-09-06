// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * specs/repo-open-feedback-fixes.md FR-202/FR-203, AC7/AC8: a cheap, deliberately
 * non-canonicalizing "do these two path strings plausibly refer to the exact same directory"
 * check — never full `fs.realpath` symlink resolution (a separately-tracked non-goal, per the
 * spec's own scope: "Full path canonicalization ... remains a separately-tracked non-goal").
 * Normalizes only what's needed to stop git's own always-forward-slash `rev-parse
 * --show-toplevel`-equivalent output from looking like a "different path" than an equivalent
 * native-Windows-backslash input for the exact same directory (AC7 requires the common,
 * non-divergent case to render "exactly as it does today" — including the ORIGINAL path's own
 * spelling/separator style — so callers must NOT unconditionally prefer one spelling over the
 * other; this check exists so they can tell "trivial spelling variant" apart from "a genuinely
 * different directory"), and to match this filesystem's own case-insensitivity (Windows/macOS
 * default) so a drive-letter or path-segment case difference alone doesn't look like a real
 * divergence either. A trailing separator is stripped for the same reason. Shared between the
 * main process (`main.ts`'s `resolveOpenedPath`) and the renderer (`useRepoTabs.ts`'s AC8 dedup
 * reconciliation) so both sides agree on what counts as "the same path" without two independent
 * copies drifting out of sync with each other.
 */
export function looksLikeSamePath(a: string, b: string): boolean {
  const normalize = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  return normalize(a) === normalize(b);
}
