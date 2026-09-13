// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * ROADMAP.md "Open tech debt — repo-open dedup uses exact string equality, no path normalization":
 * which real-world filesystem this code is running on decides whether a path-segment case
 * difference alone is a genuine divergence (Linux — case-SENSITIVE default filesystem) or a
 * trivial spelling variant of the exact same directory (Windows/macOS — case-preserving but
 * case-INSENSITIVE default filesystem). Folding case unconditionally would be actively wrong on
 * Linux: it could make two genuinely different, case-differing directories look like "the same
 * path" and collapse two legitimately distinct tabs into one — the one thing this file's own
 * `looksLikeSamePath` doc comment promises never happens.
 *
 * Detection order: Node's `process.platform` first (authoritative, and the only signal available
 * in the main process — this file is compiled under both `tsconfig.electron.json`, which has
 * Node's ambient types, and the renderer's plain `tsconfig.json`, which deliberately doesn't, so
 * `process` is read via `globalThis` below rather than as a bare identifier — never a hard
 * dependency on `@types/node` from this shared file); `navigator`-based sniffing second (the
 * renderer's real production environment, where Electron intentionally does not expose `process`
 * — mirrors `src/lib/platform.ts`'s `isMac()` convention, just widened to distinguish all three
 * platforms instead of only mac-or-not). Falls back to `"unknown"` — never a guess — if neither
 * signal is available, which `isCaseInsensitiveFileSystem`'s default arm then treats as
 * case-SENSITIVE (the safe default: a missed dedup is a cosmetic UX gap, per this ticket's own
 * "not a data-corruption risk" framing, whereas an unwarranted case-fold risks the opposite).
 *
 * Exported (alongside `isCaseInsensitiveFileSystem`, which takes the detected platform as an
 * explicit, optional override) so tests can drive both deterministically without needing to stub
 * `process.platform`/`navigator` globals — see `pathEquivalence.test.ts`.
 */
export function detectPlatform(): "win32" | "darwin" | "linux" | "unknown" {
  const nodeProcess = (globalThis as { process?: { platform?: string } }).process;
  if (nodeProcess && typeof nodeProcess.platform === "string") {
    if (nodeProcess.platform === "win32" || nodeProcess.platform === "darwin" || nodeProcess.platform === "linux") {
      return nodeProcess.platform;
    }
    return "unknown";
  }
  if (typeof navigator !== "undefined") {
    const ua = `${navigator.platform || ""} ${navigator.userAgent || ""}`;
    if (/mac/i.test(ua)) return "darwin";
    if (/win/i.test(ua)) return "win32";
    if (/linux/i.test(ua)) return "linux";
  }
  return "unknown";
}

export function isCaseInsensitiveFileSystem(platform: string = detectPlatform()): boolean {
  return platform === "win32" || platform === "darwin";
}

/**
 * specs/repo-open-feedback-fixes.md FR-202/FR-203, AC7/AC8: a cheap, deliberately
 * non-canonicalizing "do these two path strings plausibly refer to the exact same directory"
 * check — never full `fs.realpath` symlink resolution (see this module's `resolveOpenedPath` doc
 * comment for where and why that's handled instead). Normalizes only what's needed to stop git's
 * own always-forward-slash `rev-parse --show-toplevel`-equivalent output from looking like a
 * "different path" than an equivalent native-Windows-backslash input for the exact same directory
 * (AC7 requires the common, non-divergent case to render "exactly as it does today" — including
 * the ORIGINAL path's own spelling/separator style — so callers must NOT unconditionally prefer
 * one spelling over the other; this check exists so they can tell "trivial spelling variant" apart
 * from "a genuinely different directory"), and — on a case-insensitive filesystem, per
 * `isCaseInsensitiveFileSystem` above — to match that filesystem's own case-insensitivity so a
 * drive-letter or path-segment case difference alone doesn't look like a real divergence there
 * either. A trailing separator is stripped for the same reason. Shared between the main process
 * (`resolveOpenedPath` below) and the renderer (`useRepoTabs.ts`'s dedup checks, `useRecentRepos.ts`'s
 * persisted-list dedup) so every side agrees on what counts as "the same path" without independent
 * copies drifting out of sync with each other.
 *
 * `caseInsensitive` is an optional override (default: the real detected platform, via
 * `isCaseInsensitiveFileSystem()`) purely for deterministic testing — no production call site
 * passes it explicitly.
 */
export function looksLikeSamePath(
  a: string,
  b: string,
  caseInsensitive: boolean = isCaseInsensitiveFileSystem(),
): boolean {
  const normalize = (p: string) => {
    const withoutTrailingSep = p.replace(/\\/g, "/").replace(/\/+$/, "");
    return caseInsensitive ? withoutTrailingSep.toLowerCase() : withoutTrailingSep;
  };
  return normalize(a) === normalize(b);
}

/**
 * specs/repo-open-feedback-fixes.md FR-202/FR-203: the path recorded for a successful open — git's
 * own resolved toplevel (`RepositoryState.workdir`) for an ordinary repository, but ONLY when it
 * genuinely diverges from the raw caller-supplied `pickedPath` (e.g. the user picked a subfolder of
 * a larger repo's working tree, or a symlink/junction pointing at a repo — git's own toplevel
 * resolution already chases both of those, empirically confirmed against a real Windows junction:
 * `git rev-parse --show-toplevel`, run from inside a junction (at any depth — including a
 * parent-directory junction, not just one pointed straight at the repo root), prints the REAL
 * resolved path, never the junction's own spelling): AC7 requires the non-divergent common case to
 * render exactly as it always has, including the original path's own spelling — so this
 * deliberately does NOT unconditionally prefer `workdir`, which would otherwise cosmetically
 * reformat every ordinary open's displayed path (e.g. to forward slashes on Windows) even when
 * nothing about the resolved directory actually changed. A bare repository has no separate working
 * directory to resolve to, so `pickedPath` is used unchanged, matching this app's existing bare-repo
 * behavior everywhere else.
 *
 * Moved here (originally hand-duplicated function-for-function between `main.ts` and the test-only
 * `realGitHydraApi.ts`, per that file's own former doc comment) so there is exactly one
 * implementation instead of two copies that could silently drift apart — both now call this.
 *
 * Mapped-network-drive-letter vs. UNC path (e.g. `Z:\repo` vs. `\\server\share\repo` for the same
 * physical location) is a deliberately scoped-out non-goal here: neither `pickedPath` nor `workdir`
 * diverges from the other WITHIN a single open call in that scenario (git reports the toplevel using
 * whichever spelling the process's cwd already used), so no amount of comparing the two against each
 * other inside one `resolveOpenedPath` call can detect it — genuinely fixing this would require
 * canonicalizing every open's result against every OTHER already-open tab's result via
 * `fs.realpath.native` (empirically confirmed, via a local `subst`-mapped drive letter, to resolve a
 * virtual drive back to its real target — `fs.realpath`'s default, non-native form does NOT), which
 * would need a new cross-tab "canonical dedup key" threaded through the IPC contract and
 * `RepoTab`/`useRepositoryGraph`'s open-result plumbing. That's a materially larger change than this
 * ticket's other two sub-cases needed, untestable end-to-end in this environment anyway (no real UNC
 * share available), and low real-world impact (mapping a drive letter to a network share and then
 * separately opening the same repo via its raw UNC path in the same session is a narrow scenario) —
 * left as a documented follow-up rather than forced in here. See ROADMAP.md's tech-debt entry.
 */
export function resolveOpenedPath(pickedPath: string, state: { isBare: boolean; workdir: string | null }): string {
  if (state.isBare || !state.workdir) return pickedPath;
  if (looksLikeSamePath(pickedPath, state.workdir)) return pickedPath;
  return state.workdir;
}
