// SPDX-License-Identifier: GPL-3.0-or-later
import type { IdentityConfigState } from "@githydra/git-core";

/**
 * specs/git-identity-profiles.md, Amendment (2026-09-17): `user.name`/`user.email` are unverified
 * commit metadata; the SSH key is what actually authorizes a push. These two pure functions supply
 * `IdentityProfilesDialog`'s FR-378/FR-379 informational (never confirmation-gating) notices —
 * both read data `getIdentityConfigState()` already returns, no new git-core plumbing.
 */

/**
 * FR-378: exact copy for applying a profile whose `sshIdentityFilePath` is unset, selected by the
 * repo's CURRENT `core.sshCommand.managedByGitHydra` (read before the apply, via the same
 * `getIdentityConfigState()` call `IdentityProfilesDialog` already makes for FR-335's status rows)
 * — never gated behind its own confirmation click, shown on the primary Apply surface before the
 * user commits to Apply at all, independently of whether FR-334's separate conflict-confirmation
 * modal also triggers.
 */
export function describeNoSshKeyApplyNotice(sshCommandManagedByGitHydra: boolean): string {
  return sshCommandManagedByGitHydra
    ? "This profile has no SSH key configured. Applying it will remove the SSH override left by " +
        "the profile applied here previously, so this repo falls back to its default SSH " +
        "configuration for future pushes."
    : "This profile has no SSH key configured. Applying it will only change this repo's name and " +
        "email — it will not set an SSH override, so whatever SSH key this repo already resolves " +
        "to stays exactly as it is.";
}

/**
 * FR-379: re-checks `state` (the same `getIdentityConfigState()` result the remove flow already
 * needs) for whether `user.name`/`user.email` would end up with NO local value (removal unsets it,
 * since it's currently GitHydra-managed) AND no global fallback — i.e. genuinely unconfigured
 * anywhere after removal, not just locally cleared. Returns `null` when removal is safe (nothing
 * currently managed, or a global fallback exists for every managed field) or `state` isn't loaded
 * yet — never a confirmation gate, just the exact field(s) affected named in the returned copy.
 */
export function describeIdentityLossOnRemoveNotice(state: IdentityConfigState | null): string | null {
  if (!state) return null;
  const userNameLost = state.userName.managedByGitHydra && state.userName.globalValue === null;
  const userEmailLost = state.userEmail.managedByGitHydra && state.userEmail.globalValue === null;

  if (userNameLost && userEmailLost) {
    return (
      "Removing this profile's identity will leave this repo's user.name and user.email " +
      "unconfigured — no local value and no global fallback. Git will refuse to commit here " +
      "until at least one is set again."
    );
  }
  if (userNameLost) {
    return (
      "Removing this profile's identity will leave this repo's user.name unconfigured — no local " +
      "value and no global fallback. Git will refuse to commit here until it's set again."
    );
  }
  if (userEmailLost) {
    return (
      "Removing this profile's identity will leave this repo's user.email unconfigured — no local " +
      "value and no global fallback. Git will refuse to commit here until it's set again."
    );
  }
  return null;
}
