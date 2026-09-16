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
