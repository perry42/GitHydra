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
 *  - FR-335's repo-screen display — `getIdentityConfigState()` below returns exactly the
 *    local-vs-global-vs-managed data that screen needs, but rendering it is ui-graphics's job.
 *
 * "Did GitHydra write this" (needed for FR-334's overwrite-confirmation and FR-336's
 * remove-exactly-what-we-set) is tracked with a marker kept ENTIRELY inside the target repo's own
 * local `.git/config` — one `githydra.managed-*` key per managed value (`MARKER_KEYS` below),
 * holding a COPY of the value applied rather than a bare boolean (see `MARKER_KEYS`'s own doc
 * comment for why) — rather than in any separate app-storage record. This keeps the "did we write
 * this" fact
 * co-located with the fact it describes (so it can never drift out of sync with a config file
 * edited by hand, another git-core caller, or a different GitHydra install pointed at the same
 * repo) and needs no persistence layer at this layer of the stack at all — consistent with this
 * module never touching anything outside the target repo's own `.git/config`.
 *
 * Known limitation: applying a profile writes up to three separate `git config` invocations (plus
 * their markers) — there is no multi-key `git config` transaction to make this atomic. A failure
 * partway through (e.g. a hook/disk error on the second call) can leave a partial write. This
 * matches every other multi-step mutating sequence in this package (nothing here attempts an
 * automatic rollback); errors are never swallowed, so a caller always knows a partial apply may
 * have happened rather than being told it fully succeeded when it didn't.
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
 * FR-333(b) plus a non-empty/absolute-path check. Synchronous — no filesystem access — so this
 * can run before ANY I/O and reject instantly. Throws `InvalidArgumentError` naming the specific
 * offending character (spec acceptance criterion 3), never silently escapes/truncates/rewrites the
 * path and proceeds anyway (the spec's explicit "rejected outright... never escaped/sanitized").
 *
 * Requiring an absolute path is defense-in-depth beyond the spec's literal text: FR-332 says the
 * path is meant to always come from a native file dialog (which only ever returns absolute
 * paths), so a relative path here is already a sign of a caller bypassing that dialog — better to
 * refuse outright than resolve it against some ambient cwd the user never saw.
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
 * the injection-relevant case) before the filesystem existence check. */
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

/**
 * One companion marker key per `CONFIG_KEYS` entry, holding a COPY of the exact value this module
 * last wrote to that key — not a bare boolean. This is deliberate, found by this module's own test
 * suite (`tests/identityProfile.test.ts`): a boolean-only marker (`"true"`/`"false"`) can only ever
 * answer "did GitHydra write THIS KEY at some point", not "does the value sitting there RIGHT NOW
 * still match what GitHydra wrote" — and those are different questions. If a user (or another
 * tool) hand-edits `user.name` after GitHydra applied a profile, a boolean marker would still read
 * `"true"`, so `getIdentityConfigState()` would keep reporting the hand-edited value as
 * GitHydra-managed — which is exactly backwards for FR-334's purpose (that hand-edited value is
 * now precisely the kind of "GitHydra did not itself set this" value FR-334 exists to protect).
 * Storing the applied value itself lets `getIdentityConfigState()` do a direct comparison
 * (`markerValue === localValue`) instead: `managedByGitHydra` is only ever true when the live value
 * STILL matches what this module last wrote, so any out-of-band edit — including one that
 * coincidentally restores the exact same text — is judged the only way that's actually correct
 * (byte-for-byte identity, not "was this key ever managed once"). Storing the value itself has no
 * new security cost: it is always a value this module ALREADY wrote via the safe
 * `writeLocalConfigValue()` path to the real key one line above; recording an identical copy under
 * a second key doesn't introduce any new untrusted content and this marker's value is never fed
 * back into a shell command or any other sensitive sink.
 *
 * Namespaced under `githydra.*` so it can never collide with any real git config key. Git config
 * variable names allow letters/digits/`-` only (no `.` within a single key name), hence the dashed
 * spelling rather than e.g. `githydra.managed.user.name`.
 */
const MARKER_KEYS = {
  userName: "githydra.managed-user-name",
  userEmail: "githydra.managed-user-email",
  sshCommand: "githydra.managed-ssh-command",
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

/** Read back the value-copy `MARKER_KEYS`'s matching key holds, or `null` if this module has
 * never written that marker (or it was cleared by `removeIdentityProfileApplication()`). See
 * `MARKER_KEYS`'s own doc comment for why this stores/compares a value rather than a boolean. */
async function readMarkerValue(cwd: string, markerKey: string): Promise<string | null> {
  return readScopedValue(cwd, "--local", markerKey);
}

/**
 * `git config --local --replace-all <key> <value>`. `--replace-all` (rather than the bare
 * two-positional-argument form) guarantees a single, unambiguous resulting value even if the key
 * already held more than one value from some other tool — `git config --local <key> <value>`
 * alone refuses with an ambiguity error in that case; `--replace-all` always fully replaces
 * whatever was there. `--end-of-options` precedes `key` (always one of `CONFIG_KEYS`'s/
 * `MARKER_KEYS`'s own hardcoded literals) for the same defense-in-depth reason as `readScopedValue`.
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

/** One config value's full picture: what's set locally (if anything), what's set globally (if
 * anything, purely informational — this module NEVER writes global config, FR-330/spec Non-goals),
 * and whether the CURRENT local value is one this module itself wrote via a prior
 * `applyIdentityProfile()` call. `managedByGitHydra` is always `false` when `localValue` is `null`
 * — a marker left over after the real key was unset by something else (git, the user, a manual
 * `git config --unset`) never counts as "GitHydra owns an empty slot". */
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
 * Read `user.name`/`user.email`/`core.sshCommand`'s current local value, global value, and
 * GitHydra-managed marker, all in one call (six parallel `git config --get` reads plus three
 * marker reads, none of them mutating, so all nine run concurrently with no queueing needed).
 * Works against a bare repository, a worktree, an empty (unborn-HEAD) repository, and detached
 * HEAD identically — `git config` itself never depends on any of those states.
 */
export async function getIdentityConfigState(cwd: string): Promise<IdentityConfigState> {
  const entries = await Promise.all(
    IDENTITY_KEYS.map(async (key) => {
      const [localValue, globalValue, markerValue] = await Promise.all([
        readScopedValue(cwd, "--local", CONFIG_KEYS[key]),
        readScopedValue(cwd, "--global", CONFIG_KEYS[key]),
        readMarkerValue(cwd, MARKER_KEYS[key]),
      ]);
      const value: LocalIdentityValue = {
        localValue,
        globalValue,
        // See MARKER_KEYS's doc comment: managed only when the LIVE value still matches the
        // value-copy this module itself last recorded, not merely "was this key ever managed".
        managedByGitHydra: localValue !== null && markerValue !== null && markerValue === localValue,
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
   * (and its GitHydra-managed marker, if any) untouched by this apply — UNLESS a prior apply on
   * this same repo already left a GitHydra-managed `core.sshCommand` in place, in which case this
   * apply clears it. See `applyIdentityProfile()`'s own doc comment for why. */
  sshIdentityFilePath?: string | null;
}

export interface ApplyIdentityProfileOptions extends IdentityProfileFields {
  /**
   * FR-334: must be explicitly `true` to proceed when applying would overwrite one or more local
   * config values this module did not itself set. Leave `false`/omitted for the first attempt; on
   * `UnmanagedIdentityConfigConflictError`, the caller should show the user an explicit
   * confirmation naming every conflicting key/value (the error's own `conflicts`) and only then
   * re-call with `force: true`. Never required to update a value this module already manages
   * (re-applying, or applying an edited version of, an already-applied profile never prompts).
   */
  force?: boolean;
}

/**
 * FR-330/FR-331: apply a profile's fields to `cwd`'s repo-LOCAL git config only — never
 * `--global`, never any other repo (this module accepts exactly one `cwd`/repo per call, and
 * never touches anything outside it).
 *
 * Order of operations, none of which is skipped or reordered for any input:
 *  1. Validate `userName`/`userEmail` are non-empty (`InvalidArgumentError`).
 *  2. If `sshIdentityFilePath` is given, validate it in full (FR-332/FR-333:
 *     `assertValidSshIdentityFile` — syntax then existence) and build its `core.sshCommand` value
 *     (FR-331) — BEFORE any git config is read or written. A rejected path makes this function
 *     throw having made zero `git` calls at all, matching acceptance criterion 3's "rejected...
 *     before any git config write occurs".
 *  3. Read the repo's current `IdentityConfigState` and compute FR-334's conflict set: any of
 *     `user.name`/`user.email`, always, plus `core.sshCommand` only if this call is actually going
 *     to write it, whose CURRENT local value is set and NOT `managedByGitHydra`. If that set is
 *     non-empty and `options.force` isn't `true`, throw `UnmanagedIdentityConfigConflictError` —
 *     again, zero mutating git calls made.
 *  4. Only once every check above has passed does this function write anything: `user.name`,
 *     `user.email`, and (only if provided) `core.sshCommand`, each paired with setting its own
 *     `githydra.managed-*` marker to a copy of the value just written (see `MARKER_KEYS`'s doc
 *     comment for why a value-copy rather than a bare boolean).
 *
 * One deliberate behavior beyond the spec's literal text, worth a specific security/product
 * look: if `sshIdentityFilePath` is OMITTED but this repo's `core.sshCommand` is currently
 * `managedByGitHydra` (i.e. a DIFFERENT, previously-applied profile left one in place), this apply
 * UNSETS it (and its marker) rather than leaving it untouched. Rationale: leaving a prior
 * profile's SSH identity file wired up while applying a new profile's name/email would mean
 * commits/pushes under the NEW identity silently authenticate as the OLD one's key — a real,
 * security-relevant mismatch a user switching between "work"/"personal" profiles would not expect
 * and might not notice. This never touches a value GitHydra didn't already own (no confirmation
 * needed, same as any other update to a GitHydra-managed key), so it doesn't relax FR-334's
 * guarantee for foreign values at all.
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

  const state = await getIdentityConfigState(cwd);

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

  // Each marker is written with a COPY of the exact value just written to its real key (see
  // MARKER_KEYS's own doc comment for why a value-copy, not a bare boolean, is required for
  // `getIdentityConfigState()` to correctly detect a later out-of-band edit as "no longer ours").
  await writeLocalConfigValue(cwd, CONFIG_KEYS.userName, options.userName);
  await writeLocalConfigValue(cwd, MARKER_KEYS.userName, options.userName);
  await writeLocalConfigValue(cwd, CONFIG_KEYS.userEmail, options.userEmail);
  await writeLocalConfigValue(cwd, MARKER_KEYS.userEmail, options.userEmail);

  if (sshCommandValue !== null) {
    await writeLocalConfigValue(cwd, CONFIG_KEYS.sshCommand, sshCommandValue);
    await writeLocalConfigValue(cwd, MARKER_KEYS.sshCommand, sshCommandValue);
  } else if (state.sshCommand.managedByGitHydra) {
    // See this function's own doc comment: never leave a PRIOR profile's managed SSH identity
    // silently in effect for a profile that specifies none of its own.
    await unsetLocalConfigKey(cwd, CONFIG_KEYS.sshCommand);
    await unsetLocalConfigKey(cwd, MARKER_KEYS.sshCommand);
  }
}

/** Which config keys `removeIdentityProfileApplication()` actually unset — a subset (possibly
 * empty) of `["user.name", "user.email", "core.sshCommand"]`, in that fixed order. */
export interface RemoveIdentityProfileResult {
  removedKeys: readonly ("user.name" | "user.email" | "core.sshCommand")[];
}

/**
 * FR-336: unset exactly the local config keys THIS module itself set (tracked via `MARKER_KEYS`,
 * re-read fresh from disk here, never trusted from a caller-supplied value) — never a key the user
 * or another tool configured, never anything global. Has no notion of "which profile" was applied
 * (see this file's own module doc comment) — it simply clears whatever this repo's local config
 * currently has GitHydra-managed, which is exactly the set one `applyIdentityProfile()` call could
 * have produced (there is only ever one applied identity at a time per repo at the git-config
 * layer). A repo with nothing GitHydra-managed at all is a no-op, not an error — `removedKeys`
 * is simply empty.
 */
export async function removeIdentityProfileApplication(
  cwd: string,
): Promise<RemoveIdentityProfileResult> {
  const state = await getIdentityConfigState(cwd);
  const removedKeys: Array<"user.name" | "user.email" | "core.sshCommand"> = [];

  if (state.userName.managedByGitHydra) {
    await unsetLocalConfigKey(cwd, CONFIG_KEYS.userName);
    await unsetLocalConfigKey(cwd, MARKER_KEYS.userName);
    removedKeys.push("user.name");
  }
  if (state.userEmail.managedByGitHydra) {
    await unsetLocalConfigKey(cwd, CONFIG_KEYS.userEmail);
    await unsetLocalConfigKey(cwd, MARKER_KEYS.userEmail);
    removedKeys.push("user.email");
  }
  if (state.sshCommand.managedByGitHydra) {
    await unsetLocalConfigKey(cwd, CONFIG_KEYS.sshCommand);
    await unsetLocalConfigKey(cwd, MARKER_KEYS.sshCommand);
    removedKeys.push("core.sshCommand");
  }

  return { removedKeys };
}
