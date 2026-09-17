# PRD: Git Identity & SSH Key Profiles

Status: draft — **Phase 2 of 5** of V2's online-sync milestone. Deliberately NOT named
"multi-account management" — that label oversells what is actually built (see Non-goals). Pure
repo-local git-config feature with no network dependency, but sequenced after Fetch so it ships
before Push needs it.

Sequencing: git-core-engineer builds first (profile apply/remove plumbing, `core.sshCommand`
construction and validation); ui-graphics builds second (profile library UI, per-repo apply/status
display). **security-reviewer review required before merge — the `core.sshCommand` construction is
the single highest-value review in this milestone**; see `specs/online-sync-security-flags.md`.

## Problem

A developer using separate work/personal (or per-client) git accounts has no way to keep a repo's
commit identity or SSH key straight inside GitHydra — every repo silently inherits whatever global
`user.name`/`user.email`/SSH default is configured. That is exactly the "committed as the wrong
account" mistake GitKraken charges for a fix to: "multiple profiles" is a named paid-only feature
on their pricing page, while identity is pure local git config with no hosted component whatsoever.

## Target user

Developers maintaining more than one git identity across repos — work vs. personal, a client's
account vs. their own, a fork vs. an employer's org — the same population `PRODUCT.md`'s Users
section already describes.

## Must-have behavior

- **FR-329:** A **profile** is a named, locally-stored (GitHydra's own app storage — never synced,
  no backend) record: display name, `user.name`, `user.email`, and an optional SSH identity-file
  path. Profiles are reusable across repos; creating, editing, or deleting a profile never touches
  any repo's git config by itself.
- **FR-330:** **Applying** a profile to the currently open repo writes ONLY that repo's LOCAL git
  config: `git config --local user.name "<name>"` and `git config --local user.email "<email>"`.
  Never `--global`, never any other repo.
- **FR-331:** If the profile specifies an SSH identity file, applying it also writes
  `git config --local core.sshCommand` to a value invoking ssh with exactly that identity file and
  `IdentitiesOnly=yes` (so ssh never silently falls back to a different key from the agent or
  default). Constructed defensively per FR-333 — never string-concatenated from unvalidated input.
- **FR-332:** The SSH identity-file path is selected via the native OS file dialog only — never a
  free-text field the app trusts blindly.
- **FR-333:** Before writing FR-331's value, validate the selected path: (a) it exists and is a
  regular file, and (b) it contains none of a defined set of shell metacharacters (quotes,
  backticks, `$`, `;`, `|`, `&`, newlines) for the target platform's shell. A path failing (b) is
  **rejected outright with a specific error** — never escaped/sanitized and written anyway.
  Rationale: `core.sshCommand`'s value is itself parsed as a shell command by git when it invokes
  ssh — a materially different risk class than this codebase's existing argv-array convention,
  which protects only how *we* invoke git, not what git does with a config value we hand it.
- **FR-334:** Before overwriting an existing local `user.name`/`user.email`/`core.sshCommand` value
  that GitHydra did not itself set via a prior profile-apply (tracked via a marker GitHydra keeps
  of "did we write this"), warn and require confirmation — never silently clobber a value the user
  or another tool configured for their own reason, e.g. a pre-existing `core.sshCommand` used for a
  corporate SSH proxy.
- **FR-335:** A repo screen shows its current local `user.name`/`user.email`/`core.sshCommand`
  state, distinguishing "set locally" from "inherited from global config" — so applying a profile
  is understood as an override, never an invisible change.
- **FR-336:** **Removing** a profile's application from a repo unsets exactly the keys GitHydra
  itself set for that profile (`git config --local --unset user.name`, etc.) — never touches keys
  it didn't write, never touches global config.
- **FR-337:** GitHydra never reads, transmits, logs, or displays the CONTENTS of any SSH private
  key — only a file path is ever stored, exactly like a profile's other fields, in local app
  storage only.

## Non-goals

- **HTTPS/PAT credential-account switching.** Delegated entirely to the user's own credential
  helper (e.g. Git Credential Manager, which already supports multiple stored accounts per host).
  GitHydra never stores a password or token.
- **Generating, importing, or managing SSH key material.** GitHydra only references an existing key
  file by path.
- **Editing `~/.ssh/config`**, managing an SSH agent's loaded keys, or any file outside the target
  repo's own `.git/config`. This is the genuinely expensive half of "multi-account" and is deferred
  indefinitely, not to a later phase — it can break the user's working git setup *outside*
  GitHydra, and it duplicates what modern credential managers already do well.
- **Global config changes of any kind.**
- **Syncing profiles across machines**, or per-org/team shared profiles.
- **Auto-selecting a profile** from remote-URL/host heuristics — always an explicit user action.

## Acceptance criteria

1. Creating two profiles and applying each to two different repos results in each repo's own
   `git config --local --get user.email` matching its applied profile, independently, verified per
   repo.
2. Applying a profile with an SSH key never writes anything to `~/.ssh/config` or global git config
   — verified by inspecting both locations before and after.
3. Selecting a path containing a shell metacharacter is rejected before any `git config` write
   occurs, with a specific error naming the offending character.
4. Applying a profile to a repo that already has a `core.sshCommand` GitHydra didn't set requires
   explicit confirmation before overwriting; declining leaves the pre-existing value untouched.
5. Removing a profile's application unsets exactly the keys that profile-apply wrote — verified via
   `git config --local --list` before/after — and never removes an unrelated pre-existing local
   config key.
6. No profile's SSH key path content is ever read into memory beyond an existence/regular-file
   check — verified by confirming no `fs.readFile` call targets the identity-file path anywhere in
   this feature's code path.

## Amendment (2026-09-17): apply/remove honesty warnings

`user.name`/`user.email` are unverified commit metadata; the SSH key is what actually authorizes a
push. Because a profile's SSH key (FR-329) is optional, applying a keyless profile changes only
cosmetic name/email while leaving whatever SSH identity is already in effect on the repo untouched
— or, in one specific case, silently removes one. Both are cheap to make honest today using data
`getIdentityConfigState()` already returns; no new git-core plumbing required for either.

- **FR-378: No-SSH-key warning on apply.** When applying a profile whose `sshIdentityFilePath` is
  unset, `IdentityProfilesDialog` shows an inline, non-blocking notice on the primary Apply surface
  — visible before the user commits to Apply, independently of whether FR-334's separate
  conflict-confirmation modal also triggers for `user.name`/`user.email`/a foreign
  `core.sshCommand`. Never gated behind its own confirmation click — it's informational, not a
  destructive-overwrite gate (FR-334 already owns that). Exact copy, selected by reading the
  repo's current `core.sshCommand.managedByGitHydra` via the already-available
  `getIdentityConfigState()`:
  - `managedByGitHydra === false` (no GitHydra-set SSH override exists right now — nothing set, or
    a foreign value this module doesn't own): *"This profile has no SSH key configured. Applying it
    will only change this repo's name and email — it will not set an SSH override, so whatever SSH
    key this repo already resolves to stays exactly as it is."*
  - `managedByGitHydra === true` (a previously-applied profile's key is in effect and — per
    `applyIdentityProfile()`'s documented behavior — will be cleared by this apply): *"This profile
    has no SSH key configured. Applying it will remove the SSH override left by the profile applied
    here previously, so this repo falls back to its default SSH configuration for future pushes."*

  Neither line names or guesses which key SSH will actually resolve to next (agent default,
  `~/.ssh/config`, none) — only the mechanical fact of whether this apply touches `core.sshCommand`
  at all. Determining the actually-resolved key would need new `ssh -G <host>` plumbing; out of
  scope here, same as the base spec.

- **FR-379: No-identity-left warning on remove.** Before executing a profile removal (FR-336),
  `IdentityProfilesDialog` re-checks `getIdentityConfigState()` — the same read the remove flow
  already needs to know which fields are currently GitHydra-managed. For each of
  `user.name`/`user.email` where `managedByGitHydra === true` (so removal will unset it) AND
  `globalValue === null` (no global fallback), that field will end up with no configured value
  anywhere after removal. If either or both fields meet this, show an inline, non-blocking notice
  next to the remove control — informational, not a confirmation gate, since git itself will refuse
  the next commit rather than silently losing data:
  - Both fields: *"Removing this profile's identity will leave this repo's user.name and
    user.email unconfigured — no local value and no global fallback. Git will refuse to commit here
    until at least one is set again."*
  - `user.name` only: *"Removing this profile's identity will leave this repo's user.name
    unconfigured — no local value and no global fallback. Git will refuse to commit here until it's
    set again."*
  - `user.email` only: identical phrasing, substituting `user.email`.

  Removal proceeds on the existing remove action's normal confirmation — this notice adds no second
  click.

### Non-goals (amendment)

- **Same-SSH-key-across-two-profiles detection** (fingerprint-comparing two profiles' keys via
  `ssh-keygen -lf` to warn "these two profiles use the same key") is explicitly OUT of scope for
  this amendment. Deferred to its own future spec/increment — already decided with the user via
  AskUserQuestion. Do not fold it into FR-378/FR-379 or re-open this boundary without a new,
  separate product decision.
- Resolving which SSH key a plain `ssh`/git invocation would actually use (`ssh -G <host>` or
  equivalent) remains out of scope, exactly as in the base spec — FR-378 only ever describes
  whether *this apply* changes `core.sshCommand`, never which key wins.

### Acceptance criteria (amendment — continues the base spec's numbered list)

7. Applying a keyless profile to a repo with no GitHydra-managed `core.sshCommand` shows FR-378's
   first copy variant and performs no write to `core.sshCommand`, verified via
   `git config --local --get core.sshCommand` before/after.
8. Applying a keyless profile to a repo where a *different*, previously-applied profile's
   `core.sshCommand` is still GitHydra-managed shows FR-378's second copy variant, and the apply
   actually unsets `core.sshCommand` (and its marker) — verified via
   `git config --local --get core.sshCommand` returning nothing afterward.
9. Removing a profile's application from a repo with no global `user.name`/`user.email` fallback
   shows FR-379's notice naming exactly the field(s) left unconfigured, verified against
   `git config --global --get user.name`/`user.email` returning nothing at removal time.
10. Removing a profile's application from a repo where a global `user.name`/`user.email` fallback
    IS configured shows no FR-379 notice.
