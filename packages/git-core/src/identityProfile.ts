// SPDX-License-Identifier: GPL-3.0-or-later
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { runGit, runGitAllowingExitCodes } from "./gitProcess";
import { InvalidArgumentError, UnmanagedIdentityConfigConflictError } from "./errors";
import type { IdentityConfigConflictEntry } from "./errors";

/**
 * specs/git-identity-profiles.md FR-329 through FR-337: the git-core surface for this feature —
 * applying/removing a profile's `user.name`/`user.email`/`core.sshCommand` against a single
 * repo's LOCAL git config, and (per specs/online-sync-security-flags.md #3, "the single
 * highest-value single review in this milestone") constructing and validating `core.sshCommand`
 * so an adversarial SSH identity-file path can never become a shell command git itself executes.
 *
 * Explicitly OUT of scope here — a separate ui-graphics pass builds these on top of this module:
 *  - The profile *library* itself (create/edit/delete a named profile) and its persistence. A
 *    "profile" (FR-329) is an app-storage concept; this module has no notion of a profile's
 *    identity or name at all, only of the three git-config values one carries and whether THIS
 *    repo's local config currently reflects a GitHydra-applied set of them.
 *  - FR-332's native-OS-file-dialog requirement — this module cannot verify *where* a path came
 *    from, only validate its *content* regardless of origin (defense-in-depth, matching this
 *    package's standing convention of never trusting compile-time/UI-layer guarantees alone; see
 *    `reset.ts`'s `RESET_MODES` runtime allow-list for the identical reasoning).
 *
 * security-reviewer finding (post-initial-pass, 2026-09-17): "did GitHydra write this" used to be
 * tracked with a `githydra.managed-*` marker kept ENTIRELY inside the target repo's own local
 * `.git/config`, computed by comparing two values that both live in that same file. That is not a
 * valid trust boundary: GitHydra opens repos from arbitrary sources (an extracted zip, a cloned
 * bare repo, a coworker's checkout — see PRODUCT.md's "works with any git repo"), so a
 * hand-crafted `.git/config` shipped alongside such a repo is squarely in this app's threat model.
 * Anyone who can plant that file can forge a matching marker+value pair, tricking a later
 * `getIdentityConfigState()`/`removeIdentityProfileApplication()` call into treating a value THEY
 * set as something GitHydra itself applied — defeating FR-334's overwrite-confirmation (a
 * profile-apply would silently clobber it) or FR-336's "only remove what we wrote" guarantee (a
 * later removal would silently unset it), neither of which requires the user to have ever touched
 * GitHydra's identity feature on that repo at all.
 *
 * Fix: the authoritative record of "GitHydra applied profile X to repo Y with exactly these
 * values" now lives OUTSIDE the repo entirely, in the app's own local storage (owned by
 * ui-graphics's `useIdentityApplications.ts` — never synced, no backend, matching FR-329's own
 * storage model for the profile library itself). This module has no access to that storage (it's
 * renderer-side); every function that needs to know what's actually managed now takes an
 * `ExpectedIdentityApplication | null` parameter — the caller's own best current understanding of
 * what's recorded for this repo — and treats a config key as GitHydra-managed ONLY when the LIVE
 * `.git/config` value still matches that caller-supplied record, never by consulting anything
 * read from the repo's own config file. A repo whose `.git/config` and app-storage record
 * disagree is therefore always treated as "not ours" (fails safe toward requiring confirmation /
 * refusing to remove), never the other way around.
 *
 * The `githydra.managed-*` marker keys this module previously wrote have been removed entirely —
 * not merely demoted — since a value that must never be trusted for anything security-relevant
 * and is redundant with the (now-authoritative) app-storage record has no remaining purpose here,
 * and keeping unused security-adjacent bookkeeping around is itself a hazard (a future change
 * could accidentally start trusting it again). If a coarse in-repo diagnostic hint is ever wanted,
 * it belongs in the UI layer's own storage, not in this module.
 *
 * Known limitation: applying a profile writes up to three separate `git config` invocations —
 * there is no multi-key `git config` transaction to make this atomic. A failure partway through
 * (e.g. a hook/disk error on the second call) can leave a partial write. This matches every other
 * multi-step mutating sequence in this package (nothing here attempts an automatic rollback);
 * errors are never swallowed, so a caller always knows a partial apply may have happened rather
 * than being told it fully succeeded when it didn't.
 */

// --- FR-331/FR-333: core.sshCommand construction and validation -------------------------------

/**
 * FR-333(b)'s defined "shell metacharacter" set, for the TARGET platform's shell — which, per
 * this package's own established precedent (`README.md`'s `continueInProgressOperation()` note:
 * "git always invokes the configured editor through its own bundled shell — including Git for
 * Windows' bundled MSYS `sh.exe`, even when the host OS is Windows"), is POSIX `sh` on every
 * platform GitHydra runs on, not `cmd.exe`/PowerShell. `core.sshCommand`/`GIT_SSH_COMMAND` is
 * documented by git itself to be "interpolated... and the result executed by the shell" — this
 * was also verified directly and empirically in this exact environment (2026-09-17): setting
 * `core.sshCommand` to a value containing a shell command and then running `git ls-remote` against
 * an unreachable `ssh://` URL executed that embedded command (a marker file was created) even
 * though the subsequent actual SSH connection then failed — proving the shell-parsing step happens
 * unconditionally, before git ever gets as far as actually dialing a host. See
 * `tests/identityProfile.test.ts`'s "positive control" test for the reproduction.
 *
 * Each entry rejects exactly one character that would let an adversarial path escape being a
 * single, inert argument inside the single-quoted `'<path>'` token `buildSshCommandValue()`
 * constructs below:
 *  - `'` — the only character that has ANY special meaning inside a POSIX single-quoted string at
 *    all (it ends the quoted string early). Forbidding it is what makes single-quoting the path
 *    safe in the first place; every other character below is inert once inside single quotes, but
 *    is still forbidden as defense-in-depth against a future change to how this value is built
 *    (e.g. switching to double quotes, or interpolating the path into a different position).
 *  - `"`, `` ` ``, `$` — meaningful inside POSIX *double*-quoted strings (closing quote, command
 *    substitution, variable/command expansion) — not reachable through the single-quoting this
 *    function actually uses, but rejected anyway so this validation is safe independent of exactly
 *    how the value gets quoted, now or later.
 *  - `;`, `|`, `&` — POSIX command separators/connectors, dangerous the moment they appear
 *    *outside* any quoting at all (e.g. if a future caller ever interpolates this path unquoted).
 *  - `\n`, `\r` — a newline (or Windows-style CRLF) can terminate the current shell command and
 *    start a new one, and separately would corrupt the single-line `core.sshCommand` config value
 *    itself (git config values are stored/read per physical line; see `git config`'s own
 *    multi-line-value escaping rules, which this module never opts into).
 *
 * Deliberately NOT included (and safe to omit, given the above): parentheses/backslash/redirection
 * characters (`(`, `)`, `\`, `<`, `>`) have no way to reach shell-special meaning here — command
 * substitution needs `$` or backticks (already forbidden) to trigger, and a `<`/`>` embedded inside
 * a single-quoted token is just a literal character, never a separate shell token, since the whole
 * path is always exactly one quoted argument, never split into multiple tokens.
 */
export const SSH_PATH_FORBIDDEN_CHARACTERS: ReadonlyArray<{ readonly char: string; readonly label: string }> = [
  { char: "'", label: "a single quote (')" },
  { char: '"', label: 'a double quote (")' },
  { char: "`", label: "a backtick (`)" },
  { char: "$", label: "a dollar sign ($)" },
  { char: ";", label: "a semicolon (;)" },
  { char: "|", label: "a pipe (|)" },
  { char: "&", label: "an ampersand (&)" },
  { char: "\n", label: "a newline" },
  { char: "\r", label: "a carriage return" },
];

/** First forbidden character found in `filePath`, or `null` if none. Exported so a caller (e.g. a
 * future UI-side pre-check) can name the exact offending character without duplicating this list. */
export function findForbiddenSshPathCharacter(
  filePath: string,
): { char: string; label: string } | null {
  for (const forbidden of SSH_PATH_FORBIDDEN_CHARACTERS) {
    if (filePath.includes(forbidden.char)) return forbidden;
  }
  return null;
}

/**
 * True for a Windows UNC (network share) path, in every spelling this module needs to reject
 * regardless of which host OS it happens to run on: `\\server\share\...`, its forward-slash
 * variant `//server/share/...`, and the extended-length `\\?\UNC\server\share\...` form.
 * Deliberately does NOT match the extended-length LOCAL path prefix `\\?\C:\...` — that is still
 * an ordinary local drive path (no network access involved), just spelled unusually; a native file
 * dialog never produces this form, but there is no reason to reject it as if it were a network
 * path when it plainly isn't one.
 *
 * security-reviewer finding: `path.isAbsolute()` alone accepts a UNC path (Node's `win32`
 * implementation treats a leading `\\`/`//` pair as absolute), so nothing before this check
 * stopped one from reaching `fs.stat()` — which, on Windows, means the OS attempts an SMB/NTLM
 * handshake against whatever host the path names before this module even gets to report "not a
 * regular file." That handshake alone (independent of whether the "file" exists) is exactly the
 * forced-authentication technique a network path is used for in this class of attack, so refusing
 * it here — before any filesystem call at all — closes the gap regardless of where the path came
 * from, matching this validator's own "holds regardless of origin" contract.
 */
function isUncPath(filePath: string): boolean {
  if (/^\\\\\?\\[A-Za-z]:[\\/]/.test(filePath)) return false; // \\?\C:\... — local, not a UNC path
  return /^[\\/]{2}/.test(filePath); // \\server\share..., //server/share..., \\?\UNC\server\share...
}

/**
 * FR-333(b) plus a non-empty/absolute-path/non-UNC check. Synchronous — no filesystem access — so
 * this can run before ANY I/O and reject instantly. Throws `InvalidArgumentError` naming the
 * specific offending character (spec acceptance criterion 3), never silently escapes/truncates/
 * rewrites the path and proceeds anyway (the spec's explicit "rejected outright... never
 * escaped/sanitized"). This contract holds regardless of where `filePath` came from — this
 * function has no way to verify FR-332's "native dialog only" requirement, only to validate
 * content, so it must be safe against a `filePath` that bypassed the dialog entirely.
 *
 * Requiring an absolute, non-UNC path is defense-in-depth beyond the spec's literal text: FR-332
 * says the path is meant to always come from a native file dialog (which only ever returns a
 * local, absolute path), so anything else here is already a sign of a caller bypassing that dialog
 * — better to refuse outright than resolve it against some ambient cwd the user never saw, or let
 * it trigger a network handshake to a host the user never approved (see `isUncPath()`'s own doc
 * comment for that second case specifically).
 */
export function assertSafeSshIdentityPathSyntax(filePath: string): void {
  if (!filePath || !filePath.trim()) {
    throw new InvalidArgumentError("SSH identity file path must not be empty.");
  }
  if (!path.isAbsolute(filePath)) {
    throw new InvalidArgumentError(
      `SSH identity file path must be absolute (it should come from the native file picker, ` +
        `FR-332): ${JSON.stringify(filePath)}`,
    );
  }
  if (isUncPath(filePath)) {
    throw new InvalidArgumentError(
      `SSH identity file path must be a local path, not a network (UNC) path: ` +
        `${JSON.stringify(filePath)}`,
    );
  }
  const forbidden = findForbiddenSshPathCharacter(filePath);
  if (forbidden) {
    throw new InvalidArgumentError(
      `SSH identity file path contains ${forbidden.label}, which is not allowed: ` +
        `${JSON.stringify(filePath)}`,
    );
  }
}

/**
 * FR-333(a): the path exists and is a regular file. Uses `fs.stat` (metadata only) — this
 * function, and every other one in this module, NEVER calls `fs.readFile`/`readFileSync`/any
 * content-reading API against an identity-file path, matching FR-337's "never reads... the
 * CONTENTS of any SSH private key" exactly. See `tests/identityProfile.test.ts`'s FR-337 guard
 * test, which asserts this source file contains no such call at all.
 */
export async function assertSshIdentityFileExists(filePath: string): Promise<void> {
  let stat: import("node:fs").Stats;
  try {
    stat = await fs.stat(filePath);
  } catch {
    throw new InvalidArgumentError(
      `SSH identity file does not exist or is not accessible: ${filePath}`,
    );
  }
  if (!stat.isFile()) {
    throw new InvalidArgumentError(`SSH identity file path is not a regular file: ${filePath}`);
  }
}

/** FR-332/FR-333, combined: the single entry point `applyIdentityProfile()` uses before ever
 * building or writing a `core.sshCommand` value. Syntax is checked first (cheap, no I/O, catches
 * the injection-relevant case, including the UNC-path check) before the filesystem existence
 * check — a UNC path is rejected before it can ever reach `fs.stat()` and trigger a network
 * handshake. */
export async function assertValidSshIdentityFile(filePath: string): Promise<void> {
  assertSafeSshIdentityPathSyntax(filePath);
  await assertSshIdentityFileExists(filePath);
}

/**
 * FR-331: build the exact `core.sshCommand` value for `identityFilePath` — `ssh` invoked with
 * exactly that identity file (`-i`) and `IdentitiesOnly=yes` (so ssh can never silently fall back
 * to a different key from the agent or the default `~/.ssh/id_*` set). Git appends the original
 * ssh invocation's own arguments (host, port, etc.) after this string itself when it runs it, so
 * this never needs its own `"$@"`/host placeholder.
 *
 * `identityFilePath` is wrapped in single quotes, the ONE quoting style that needs no character
 * class to be considered further: inside POSIX single quotes, absolutely nothing is
 * special-cased except a literal `'` itself (which `assertSafeSshIdentityPathSyntax()` already
 * rejects) — no `$`-expansion, no backtick/command-substitution, no backslash-escaping rules to
 * reason about. This is why `SSH_PATH_FORBIDDEN_CHARACTERS` is sufficient on its own: with every
 * one of those characters absent, `'<identityFilePath>'` is GUARANTEED to be exactly one
 * literal, inert shell argument, regardless of what (validated) bytes appear inside it — including
 * spaces, which single quotes preserve as part of the one argument rather than needing separate
 * escaping.
 *
 * Re-runs `assertSafeSshIdentityPathSyntax()` itself (belt-and-suspenders): this function must
 * never trust a caller who might construct a value from an unvalidated path directly, bypassing
 * `assertValidSshIdentityFile()`.
 */
export function buildSshCommandValue(identityFilePath: string): string {
  assertSafeSshIdentityPathSyntax(identityFilePath);
  return `ssh -i '${identityFilePath}' -o IdentitiesOnly=yes`;
}

// --- git config read/write plumbing ------------------------------------------------------------

/** The three git config keys this module ever reads/writes. Always passed as a hardcoded literal
 * from this map — never derived from caller input — so there is no argument-injection surface on
 * the KEY side of any `git config` call this module makes (only the VALUE side takes untrusted
 * input, and that is proven safe as a plain positional argv token — see `writeLocalConfigValue`'s
 * doc comment below). */
const CONFIG_KEYS = {
  userName: "user.name",
  userEmail: "user.email",
  sshCommand: "core.sshCommand",
} as const;

type IdentityKey = keyof typeof CONFIG_KEYS;
const IDENTITY_KEYS: readonly IdentityKey[] = ["userName", "userEmail", "sshCommand"];

/**
 * `git config <scope> --get <key>`, degrading a "not set" result (exit 1) to `null` rather than
 * throwing — the normal, expected outcome for a key nobody has ever set at that scope. Any other
 * non-zero exit still throws as an ordinary `GitCommandError` via `runGitAllowingExitCodes`'s own
 * contract. `--end-of-options` before `key` is defense-in-depth consistent with this package's
 * standing convention, even though `key` is always one of `CONFIG_KEYS`'s own hardcoded literals,
 * never caller-controlled, so it could never actually be misparsed as a flag regardless.
 *
 * A multi-valued key (set via `--add` outside GitHydra) is handled the same way `git config --get`
 * itself already handles it — returning the LAST value, matching git's own "last one wins"
 * effective-value semantics — rather than this function needing any special-case of its own
 * (verified empirically, 2026-09-17).
 */
async function readScopedValue(
  cwd: string,
  scope: "--local" | "--global",
  key: string,
): Promise<string | null> {
  const { exitCode, stdout } = await runGitAllowingExitCodes(
    ["config", scope, "--get", "--end-of-options", key],
    { cwd },
    [0, 1],
  );
  return exitCode === 0 ? stdout.replace(/\r?\n$/, "") : null;
}

/**
 * `git config --local --replace-all <key> <value>`. `--replace-all` (rather than the bare
 * two-positional-argument form) guarantees a single, unambiguous resulting value even if the key
 * already held more than one value from some other tool — `git config --local <key> <value>`
 * alone refuses with an ambiguity error in that case; `--replace-all` always fully replaces
 * whatever was there. `--end-of-options` precedes `key` (always one of `CONFIG_KEYS`'s own
 * hardcoded literals) for the same defense-in-depth reason as `readScopedValue`.
 *
 * `value` is the one truly untrusted input in this whole module (a profile's `userName`/
 * `userEmail`, or `buildSshCommandValue()`'s already-injection-proofed output) — it is passed as
 * its own, single argv array element, never concatenated into a string. Empirically verified
 * (2026-09-17, this exact `git` build) that `git config --local <key> <value>` treats `value` as
 * a plain positional argument REGARDLESS of its content, including values that are themselves the
 * literal spelling of a real `git config` flag (`--global`, `--add`, ...) — every one of those is
 * stored verbatim as the config value, never reinterpreted as a flag. There is therefore no
 * argument-injection surface on this call at all; the actual risk this whole module exists to
 * guard against is a DIFFERENT one — not "the value confuses `git config`'s own argv parsing", but
 * "the value, once safely stored as `core.sshCommand`, is later parsed as a shell command by git
 * itself when invoking ssh" (see `SSH_PATH_FORBIDDEN_CHARACTERS`'s doc comment).
 */
async function writeLocalConfigValue(cwd: string, key: string, value: string): Promise<void> {
  await runGit(["config", "--local", "--replace-all", "--end-of-options", key, value], {
    cwd,
    mutatesRepository: true,
  });
}

/**
 * `git config --local --unset-all <key>`, tolerating exit code 5 ("no such key") as a no-op
 * rather than throwing — removing a key that was already absent is not an error for this module's
 * callers (`removeIdentityProfileApplication()`, and `applyIdentityProfile()`'s own "profile omits
 * an SSH key" branch). `--unset-all` (rather than `--unset`) never fails on a key that happens to
 * hold more than one value, matching `writeLocalConfigValue()`'s own "always fully replace/clear,
 * never error on an ambiguous multi-value state" posture.
 */
async function unsetLocalConfigKey(cwd: string, key: string): Promise<void> {
  await runGitAllowingExitCodes(
    ["config", "--local", "--unset-all", "--end-of-options", key],
    { cwd, mutatesRepository: true },
    [0, 5],
  );
}

// --- public read/write API ----------------------------------------------------------------------

/**
 * The caller's (app-storage-backed) record of what it believes is currently applied to a repo —
 * the ONLY trust source `getIdentityConfigState()`/`applyIdentityProfile()`/
 * `removeIdentityProfileApplication()` use to decide whether a config key is GitHydra-managed. See
 * this file's own module doc comment for why this replaced the earlier in-`.git/config` marker.
 *
 * Structurally, this is exactly the git-config-relevant subset of ui-graphics's
 * `IdentityApplicationRecord` (`useIdentityApplications.ts`) — `userName`/`userEmail`/`sshCommand`
 * only, never `profileId`/`profileDisplayName`/`appliedAt`, which are UI-only attribution metadata
 * this module has no use for. `sshCommand` is the fully-constructed `core.sshCommand` value (e.g.
 * `ssh -i '/path' -o IdentitiesOnly=yes`, i.e. `buildSshCommandValue()`'s own output) — not a raw
 * identity-file path — so a live `core.sshCommand` read can be compared with no reconstruction
 * step; `null` means "that application didn't set `core.sshCommand` at all", not "expect it to be
 * unset" (mirrors `IdentityProfileFields.sshIdentityFilePath`'s own `null`/omitted convention).
 */
export interface ExpectedIdentityApplication {
  userName: string;
  userEmail: string;
  sshCommand: string | null;
}

/** One config value's full picture: what's set locally (if anything), what's set globally (if
 * anything, purely informational — this module NEVER writes global config, FR-330/spec Non-goals),
 * and whether the CURRENT local value matches the caller-supplied `ExpectedIdentityApplication`
 * for this key. `managedByGitHydra` is always `false` when `localValue` is `null`, when no
 * `ExpectedIdentityApplication` was supplied at all, or when the live value simply doesn't match
 * the caller's record — an out-of-sync app-storage record (cleared, corrupted, or simply never
 * having recorded this repo) always fails safe toward "not ours". */
export interface LocalIdentityValue {
  localValue: string | null;
  globalValue: string | null;
  managedByGitHydra: boolean;
}

/** FR-335's data dependency: the current state of all three identity-related config keys for one
 * repo. Read fresh from disk on every call — no caching, matching this package's convention for
 * git config state (identical to e.g. `getWorkingDirectoryStatus()`). */
export interface IdentityConfigState {
  userName: LocalIdentityValue;
  userEmail: LocalIdentityValue;
  sshCommand: LocalIdentityValue;
}

/**
 * Read `user.name`/`user.email`/`core.sshCommand`'s current local value and global value (six
 * parallel `git config --get` reads, none of them mutating, so all run concurrently with no
 * queueing needed), and compute `managedByGitHydra` per key by comparing each LIVE local value
 * against `knownApplication` — the caller's own current app-storage record for this repo, or
 * `null` if it has none. This is the ONLY source of truth for "managed"; nothing inside the
 * repo's own `.git/config` is ever consulted for that decision (see this file's own module doc
 * comment for why). Works against a bare repository, a worktree, an empty (unborn-HEAD)
 * repository, and detached HEAD identically — `git config` itself never depends on any of those
 * states.
 */
export async function getIdentityConfigState(
  cwd: string,
  knownApplication: ExpectedIdentityApplication | null,
): Promise<IdentityConfigState> {
  const entries = await Promise.all(
    IDENTITY_KEYS.map(async (key) => {
      const [localValue, globalValue] = await Promise.all([
        readScopedValue(cwd, "--local", CONFIG_KEYS[key]),
        readScopedValue(cwd, "--global", CONFIG_KEYS[key]),
      ]);
      const expectedValue = knownApplication === null ? null : knownApplication[key];
      const value: LocalIdentityValue = {
        localValue,
        globalValue,
        managedByGitHydra: localValue !== null && expectedValue !== null && localValue === expectedValue,
      };
      return [key, value] as const;
    }),
  );
  const state = Object.fromEntries(entries) as Record<IdentityKey, LocalIdentityValue>;
  return { userName: state.userName, userEmail: state.userEmail, sshCommand: state.sshCommand };
}

/** FR-329's per-profile fields this module actually acts on — never a profile's display name or
 * ID, which this module has no concept of at all (see this file's own module doc comment). */
export interface IdentityProfileFields {
  userName: string;
  userEmail: string;
  /** Absolute path to an SSH private key file, or `null`/`undefined` to leave `core.sshCommand`
   * untouched by this apply — UNLESS `knownApplication` says a PRIOR apply on this same repo
   * already set one, in which case this apply clears it. See `applyIdentityProfile()`'s own doc
   * comment for why. */
  sshIdentityFilePath?: string | null;
}

export interface ApplyIdentityProfileOptions extends IdentityProfileFields {
  /**
   * FR-334: must be explicitly `true` to proceed when applying would overwrite one or more local
   * config values not accounted for by `knownApplication`. Leave `false`/omitted for the first
   * attempt; on `UnmanagedIdentityConfigConflictError`, the caller should show the user an explicit
   * confirmation naming every conflicting key/value (the error's own `conflicts`) and only then
   * re-call with `force: true`. Never required to update a value `knownApplication` already
   * accounts for (re-applying, or applying an edited version of, an already-applied profile never
   * prompts).
   */
  force?: boolean;
  /**
   * The caller's (app-storage-backed) record of what it believes is currently applied to this
   * repo, or `null` if it has none — see `ExpectedIdentityApplication`'s own doc comment. This is
   * the sole basis for deciding which of this repo's PRE-EXISTING local values (if any) count as
   * "already GitHydra's own" for FR-334's conflict check below; a stale, missing, or forged
   * in-repo signal is never consulted for this decision.
   */
  knownApplication?: ExpectedIdentityApplication | null;
}

/**
 * FR-330/FR-331: apply a profile's fields to `cwd`'s repo-LOCAL git config only — never
 * `--global`, never any other repo (this module accepts exactly one `cwd`/repo per call, and
 * never touches anything outside it).
 *
 * Order of operations, none of which is skipped or reordered for any input:
 *  1. Validate `userName`/`userEmail` are non-empty (`InvalidArgumentError`).
 *  2. If `sshIdentityFilePath` is given, validate it in full (FR-332/FR-333:
 *     `assertValidSshIdentityFile` — syntax, including the UNC-path check, then existence) and
 *     build its `core.sshCommand` value (FR-331) — BEFORE any git config is read or written. A
 *     rejected path makes this function throw having made zero `git` calls at all, matching
 *     acceptance criterion 3's "rejected... before any git config write occurs".
 *  3. Read the repo's current `IdentityConfigState`, passing `options.knownApplication` through
 *     unchanged, and compute FR-334's conflict set: any of `user.name`/`user.email`, always, plus
 *     `core.sshCommand` only if this call is actually going to write it, whose CURRENT local value
 *     is set and NOT `managedByGitHydra` (i.e. not accounted for by `knownApplication`). If that
 *     set is non-empty and `options.force` isn't `true`, throw
 *     `UnmanagedIdentityConfigConflictError` — again, zero mutating git calls made.
 *  4. Only once every check above has passed does this function write anything: `user.name`,
 *     `user.email`, and (only if provided) `core.sshCommand`.
 *
 * One deliberate behavior beyond the spec's literal text, worth a specific security/product
 * look: if `sshIdentityFilePath` is OMITTED but `knownApplication` says this repo's
 * `core.sshCommand` is currently GitHydra-managed (i.e. a DIFFERENT, previously-applied profile
 * left one in place), this apply UNSETS it rather than leaving it untouched. Rationale: leaving a
 * prior profile's SSH identity file wired up while applying a new profile's name/email would mean
 * commits/pushes under the NEW identity silently authenticate as the OLD one's key — a real,
 * security-relevant mismatch a user switching between "work"/"personal" profiles would not expect
 * and might not notice. This never touches a value not accounted for by `knownApplication` (no
 * confirmation needed, same as any other update to an already-managed key), so it doesn't relax
 * FR-334's guarantee for unaccounted-for values at all.
 */
export async function applyIdentityProfile(
  cwd: string,
  options: ApplyIdentityProfileOptions,
): Promise<void> {
  if (!options.userName || !options.userName.trim()) {
    throw new InvalidArgumentError("Profile user.name must not be empty.");
  }
  if (!options.userEmail || !options.userEmail.trim()) {
    throw new InvalidArgumentError("Profile user.email must not be empty.");
  }

  const sshIdentityFilePath = options.sshIdentityFilePath ?? null;
  let sshCommandValue: string | null = null;
  if (sshIdentityFilePath !== null) {
    await assertValidSshIdentityFile(sshIdentityFilePath);
    sshCommandValue = buildSshCommandValue(sshIdentityFilePath);
  }

  const knownApplication = options.knownApplication ?? null;
  const state = await getIdentityConfigState(cwd, knownApplication);

  const conflicts: IdentityConfigConflictEntry[] = [];
  if (state.userName.localValue !== null && !state.userName.managedByGitHydra) {
    conflicts.push({ key: "user.name", currentValue: state.userName.localValue });
  }
  if (state.userEmail.localValue !== null && !state.userEmail.managedByGitHydra) {
    conflicts.push({ key: "user.email", currentValue: state.userEmail.localValue });
  }
  if (
    sshCommandValue !== null &&
    state.sshCommand.localValue !== null &&
    !state.sshCommand.managedByGitHydra
  ) {
    conflicts.push({ key: "core.sshCommand", currentValue: state.sshCommand.localValue });
  }

  if (conflicts.length > 0 && !options.force) {
    throw new UnmanagedIdentityConfigConflictError(conflicts);
  }

  await writeLocalConfigValue(cwd, CONFIG_KEYS.userName, options.userName);
  await writeLocalConfigValue(cwd, CONFIG_KEYS.userEmail, options.userEmail);

  if (sshCommandValue !== null) {
    await writeLocalConfigValue(cwd, CONFIG_KEYS.sshCommand, sshCommandValue);
  } else if (state.sshCommand.managedByGitHydra) {
    // See this function's own doc comment: never leave a PRIOR profile's managed SSH identity
    // silently in effect for a profile that specifies none of its own.
    await unsetLocalConfigKey(cwd, CONFIG_KEYS.sshCommand);
  }
}

/** Which config keys `removeIdentityProfileApplication()` actually unset — a subset (possibly
 * empty) of `["user.name", "user.email", "core.sshCommand"]`, in that fixed order. */
export interface RemoveIdentityProfileResult {
  removedKeys: readonly ("user.name" | "user.email" | "core.sshCommand")[];
}

/**
 * FR-336: unset exactly the local config keys accounted for by `knownApplication` — the caller's
 * (app-storage-backed) record of what it believes is currently applied to this repo, or `null` if
 * it has none. Never a key the user or another tool configured, never anything global, and never
 * decided by anything read from the repo's own `.git/config` (see this file's own module doc
 * comment for why an in-repo signal alone is not a valid trust boundary here). Has no notion of
 * "which profile" was applied beyond what `knownApplication` itself carries — it simply clears
 * whatever this repo's local config currently has that matches it. `knownApplication: null`
 * (nothing recorded) is always a no-op, never an error — `removedKeys` is simply empty.
 */
export async function removeIdentityProfileApplication(
  cwd: string,
  knownApplication: ExpectedIdentityApplication | null,
): Promise<RemoveIdentityProfileResult> {
  const state = await getIdentityConfigState(cwd, knownApplication);
  const removedKeys: Array<"user.name" | "user.email" | "core.sshCommand"> = [];

  if (state.userName.managedByGitHydra) {
    await unsetLocalConfigKey(cwd, CONFIG_KEYS.userName);
    removedKeys.push("user.name");
  }
  if (state.userEmail.managedByGitHydra) {
    await unsetLocalConfigKey(cwd, CONFIG_KEYS.userEmail);
    removedKeys.push("user.email");
  }
  if (state.sshCommand.managedByGitHydra) {
    await unsetLocalConfigKey(cwd, CONFIG_KEYS.sshCommand);
    removedKeys.push("core.sshCommand");
  }

  return { removedKeys };
}
