// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from "vitest";
import type { IdentityConfigState } from "@githydra/git-core";
import {
  computeIdentityNetworkOpDisabledReason,
  describeIdentityLossOnRemoveNotice,
  describeNoSshKeyApplyNotice,
} from "./identityNotices";

function makeState(overrides: Partial<IdentityConfigState> = {}): IdentityConfigState {
  const empty = { localValue: null, globalValue: null, managedByGitHydra: false };
  return { userName: { ...empty }, userEmail: { ...empty }, sshCommand: { ...empty }, ...overrides };
}

/** specs/git-identity-profiles.md, Amendment (2026-09-17): FR-378. */
describe("describeNoSshKeyApplyNotice", () => {
  it("no override currently exists: names that the apply is name/email-only and leaves the resolved SSH key untouched", () => {
    const message = describeNoSshKeyApplyNotice(false);
    expect(message).toMatch(/has no SSH key configured/i);
    expect(message).toMatch(/only change this repo's name and email/i);
    expect(message).toMatch(/stays exactly as it is/i);
    expect(message).not.toMatch(/remove the SSH override/i);
  });

  it("a previously-applied profile's override is currently in effect: names that this apply clears it", () => {
    const message = describeNoSshKeyApplyNotice(true);
    expect(message).toMatch(/has no SSH key configured/i);
    expect(message).toMatch(/remove the SSH override left by the profile applied here previously/i);
    expect(message).toMatch(/falls back to its default SSH configuration/i);
    expect(message).not.toMatch(/stays exactly as it is/i);
  });
});

/** specs/git-identity-profiles.md, Amendment (2026-09-17): FR-379. */
describe("describeIdentityLossOnRemoveNotice", () => {
  it("returns null when state hasn't loaded yet", () => {
    expect(describeIdentityLossOnRemoveNotice(null)).toBeNull();
  });

  it("returns null when nothing is GitHydra-managed", () => {
    expect(describeIdentityLossOnRemoveNotice(makeState())).toBeNull();
  });

  it("returns null when a managed field still has a global fallback", () => {
    const state = makeState({
      userName: { localValue: "Jane", globalValue: "Global Jane", managedByGitHydra: true },
      userEmail: { localValue: "jane@work.example", globalValue: "jane@global.example", managedByGitHydra: true },
    });
    expect(describeIdentityLossOnRemoveNotice(state)).toBeNull();
  });

  it("AC9: names user.name only when it alone would end up unconfigured", () => {
    const state = makeState({
      userName: { localValue: "Jane", globalValue: null, managedByGitHydra: true },
      userEmail: { localValue: "jane@work.example", globalValue: "jane@global.example", managedByGitHydra: true },
    });
    const message = describeIdentityLossOnRemoveNotice(state);
    expect(message).toMatch(/user\.name/);
    expect(message).not.toMatch(/user\.email/);
    expect(message).toMatch(/git will refuse to commit here until it's set again/i);
  });

  it("names user.email only when it alone would end up unconfigured", () => {
    const state = makeState({
      userName: { localValue: "Jane", globalValue: "Global Jane", managedByGitHydra: true },
      userEmail: { localValue: "jane@work.example", globalValue: null, managedByGitHydra: true },
    });
    const message = describeIdentityLossOnRemoveNotice(state);
    expect(message).toMatch(/user\.email/);
    expect(message).not.toMatch(/user\.name unconfigured/i);
  });

  it("names both fields when both would end up unconfigured", () => {
    const state = makeState({
      userName: { localValue: "Jane", globalValue: null, managedByGitHydra: true },
      userEmail: { localValue: "jane@work.example", globalValue: null, managedByGitHydra: true },
    });
    const message = describeIdentityLossOnRemoveNotice(state);
    expect(message).toMatch(/user\.name and user\.email/);
    expect(message).toMatch(/git will refuse to commit here until at least one is set again/i);
  });

  it("a field with no local value at all (not managed) never contributes to the notice, even with no global fallback", () => {
    // managedByGitHydra: false means removal doesn't touch this key at all — it isn't "lost by
    // this removal," regardless of whether a global fallback exists.
    const state = makeState({
      userName: { localValue: null, globalValue: null, managedByGitHydra: false },
      userEmail: { localValue: "jane@work.example", globalValue: null, managedByGitHydra: true },
    });
    const message = describeIdentityLossOnRemoveNotice(state);
    expect(message).toMatch(/user\.email/);
    expect(message).not.toMatch(/user\.name/);
  });
});

/**
 * specs/identity-profile-network-interlock.md FR-380/FR-382, AC8: a black-box proof this is a pure
 * function (only booleans in, a string or null out — no IPC, no git-core import anywhere in
 * `identityNotices.ts`) that returns the FR-382 priority-ordered result for all 8 boolean
 * combinations of (isFetching, isPulling, isPushing).
 */
describe("computeIdentityNetworkOpDisabledReason", () => {
  it("returns null when nothing is in flight", () => {
    expect(computeIdentityNetworkOpDisabledReason(false, false, false)).toBeNull();
  });

  it("returns 'a fetch' when only fetching", () => {
    expect(computeIdentityNetworkOpDisabledReason(true, false, false)).toBe("a fetch");
  });

  it("returns 'a pull' when only pulling", () => {
    expect(computeIdentityNetworkOpDisabledReason(false, true, false)).toBe("a pull");
  });

  it("returns 'a push' when only pushing", () => {
    expect(computeIdentityNetworkOpDisabledReason(false, false, true)).toBe("a push");
  });

  it("AC4: fetch beats pull when both are in flight", () => {
    expect(computeIdentityNetworkOpDisabledReason(true, true, false)).toBe("a fetch");
  });

  it("fetch beats push when both are in flight", () => {
    expect(computeIdentityNetworkOpDisabledReason(true, false, true)).toBe("a fetch");
  });

  it("pull beats push when both are in flight (and fetch is not)", () => {
    expect(computeIdentityNetworkOpDisabledReason(false, true, true)).toBe("a pull");
  });

  it("fetch beats pull and push when all three are in flight", () => {
    expect(computeIdentityNetworkOpDisabledReason(true, true, true)).toBe("a fetch");
  });
});
