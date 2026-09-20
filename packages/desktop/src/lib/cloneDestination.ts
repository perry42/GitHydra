// SPDX-License-Identifier: GPL-3.0-or-later
import { detectPlatform } from "../../shared/pathEquivalence";

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

/** Windows-reserved device names (case-insensitive) — `CON`, `PRN`, `AUX`, `NUL`, `COM0`-`COM9`,
 * `LPT0`-`LPT9`. Windows reserves these as *base* names: the reservation applies before any
 * extension (`con.txt` is just as unusable as bare `con`), so callers must check the segment's
 * base name (its text before the first `.`), not the segment verbatim. */
const WINDOWS_RESERVED_NAME = /^(CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])$/i;

/** True if `segment` collides with a Windows-reserved device name once any extension is stripped
 * (e.g. `NUL`, `nul`, `con.txt`, `Con.tar.gz`) — a folder with this name fails to create on
 * Windows regardless of what follows the first `.`. */
function isWindowsReservedName(segment: string): boolean {
  const base = segment.split(".")[0] ?? "";
  return WINDOWS_RESERVED_NAME.test(base);
}

/**
 * Derives a plausible repository folder name from a clone URL — the last non-empty path segment,
 * with a trailing `.git` stripped, working for every transport this app never restricts the shape
 * of (`https://host/owner/repo.git`, `git@host:owner/repo.git`, a bare local path on either
 * platform's separator). Falls back to `"repository"` for a URL with no usable trailing segment
 * (e.g. empty, or just a host) rather than ever producing an empty folder name — and likewise
 * falls back for a last segment of exactly `.` or `..`, since those are reserved filesystem
 * entries (never a real repo name) and combining them with `joinDestinationPath()` would resolve
 * outside the picked parent directory instead of naming a new folder inside it. Also falls back
 * for a last segment that collides with a Windows-reserved device name (see
 * `isWindowsReservedName()`) — checked on the already-`.git`-suffix-stripped segment, which covers
 * both a raw reserved segment (`.../CON`) and one only reserved after suffix-stripping
 * (`.../nul.git` -> `nul`), since the base-name check strips any further extension too
 * (`.../con.txt` -> base `con`). Such a URL would otherwise suggest a folder name that simply
 * cannot be created on Windows.
 */
export function deriveRepoNameFromUrl(url: string): string {
  const trimmed = url.trim().replace(/[/\\]+$/, "");
  if (!trimmed) return "repository";
  const withoutGitSuffix = trimmed.replace(/\.git$/i, "");
  const segments = withoutGitSuffix.split(/[/\\:]+/).filter(Boolean);
  const last = segments[segments.length - 1]?.trim();
  if (!last || last === "." || last === ".." || isWindowsReservedName(last)) {
    return "repository";
  }
  return last;
}

/** True for a path that structurally could only be Windows-styled: a drive letter (`C:\` /
 * `C:/`) or a UNC prefix (`\\server\share`). Content-sniffing for a bare backslash (the previous
 * heuristic) misfires on a legal POSIX path whose only segment happens to contain a literal `\`
 * with no `/` anywhere (e.g. a single relative segment `myrepo\`) — this checks Windows *shape*
 * instead, which a POSIX path can never structurally produce. */
function looksWindowsStyled(parentDir: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(parentDir) || parentDir.startsWith("\\\\");
}

/** Joins `parentDir` (native-separator-styled, as returned by the OS folder dialog) with
 * `repoName` using whichever separator `parentDir` itself structurally implies — a drive-letter
 * or UNC-prefixed path uses `\`, everything else uses `/`. `parentDir` only ever comes from
 * `api.openRepoDialog()` (the OS-native folder picker), so its separator style always matches the
 * shape checked here; this never needs to guess from arbitrary free-text content. */
export function joinDestinationPath(parentDir: string, repoName: string): string {
  const sep = looksWindowsStyled(parentDir) ? "\\" : "/";
  const trimmedParent = parentDir.replace(/[/\\]+$/, "");
  return `${trimmedParent}${sep}${repoName}`;
}

/**
 * ROADMAP.md "Clone: minor rough edges" — a relative destination `CloneDialog` hands to
 * `git-core`'s `clone()` resolves (via `path.resolve()`) against the Electron MAIN process's own
 * `cwd`, a working directory the user has no visibility into. Browse-picked destinations are
 * always absolute already (the native folder dialog only ever returns one), so this only matters
 * for a manually-typed destination — `CloneDialog` calls this before submit to reject a relative
 * one with an inline message instead of letting it silently resolve against that hidden cwd.
 *
 * Platform-aware rather than a single hard-coded rule, via the same `detectPlatform()` this app's
 * other cross-platform path logic (`pathEquivalence.ts`) already uses: on `win32`, a drive-letter
 * path (`C:\...`/`C:/...`) or a UNC path (`\\server\share\...`) counts as absolute, and so —
 * deliberately — does a leading `/` alone (Windows treats it as rooted to the current drive, and
 * this app's own `joinDestinationPath()` produces exactly this shape when Browse combines a
 * POSIX-styled parent with a repo name, e.g. running this app's own test suite under Node on
 * Windows). Everywhere else, only a leading `/` counts — a `C:\...`-shaped string is not a real
 * absolute path on a POSIX filesystem, just a filename that happens to contain colons and
 * backslashes.
 */
export function isAbsoluteDestinationPath(destination: string, platform: string = detectPlatform()): boolean {
  if (!destination) return false;
  if (platform === "win32") {
    return /^[A-Za-z]:[\\/]/.test(destination) || destination.startsWith("\\\\") || destination.startsWith("/");
  }
  return destination.startsWith("/");
}
