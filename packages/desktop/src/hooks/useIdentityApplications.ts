// SPDX-License-Identifier: GPL-3.0-or-later
import { useCallback, useState } from "react";

/**
 * specs/git-identity-profiles.md FR-329/FR-334/FR-336 — app-storage half of the "did GitHydra
 * apply an identity profile to this repo, and with exactly which values" question.
 *
 * security-reviewer finding (post git-core pass): the `githydra.managed-*` markers `identityProfile.ts`
 * writes into the target repo's OWN `.git/config` cannot serve as a trust boundary on their own —
 * that file is exactly what FR-334/FR-336 need to protect against, and this app opens repos from
 * arbitrary sources (including an extracted zip, per PRODUCT.md's "works with any git repo"),
 * putting a hand-crafted `.git/config` containing a forged marker inside this app's threat model.
 * Someone who can plant that file can otherwise trick a later `getIdentityConfigState()`/
 * `removeIdentityProfileApplication()` call into treating a value THEY set as something GitHydra
 * itself applied — letting a profile-apply silently clobber it (defeating FR-334) or a later
 * removal silently unset it (defeating FR-336), neither of which requires the user to have ever
 * touched GitHydra's identity feature at all.
 *
 * Fix (this module): the AUTHORITATIVE record of "GitHydra applied profile X to repo Y, with
 * exactly these values" now lives here — GitHydra's own local app storage (`localStorage`, same
 * mechanism/try-catch-guarded pattern as `useRecentRepos.ts`/`useIdentityProfiles.ts`, never
 * synced, no backend) — keyed by the repo's resolved root path (`OpenRepoResult.path` /
 * `graph.repoPath`, the same key `App.tsx` already uses for `lastFetchedAtByPath`). The
 * `githydra.managed-*` config markers are NOT removed by this change (a follow-up git-core pass
 * owns that) — they're demoted to a best-effort diagnostic hint, no longer the trust source.
 *
 * Shape note for the follow-up git-core pass (per the coordinator's explicit ask not to change
 * `getIdentityConfigState()`/`removeIdentityProfileApplication()`'s own signatures here): each
 * stored `IdentityApplicationRecord`'s `userName`/`userEmail`/`sshCommand` fields are exactly the
 * three values `applyIdentityProfile()` writes to `user.name`/`user.email`/`core.sshCommand` —
 * `sshCommand` already holds the fully-constructed `buildSshCommandValue()` output (e.g.
 * `ssh -i '/path' -o IdentitiesOnly=yes`), not just the raw identity-file path, so a future
 * `getIdentityConfigState(cwd, expected)` can compare it against a live `core.sshCommand` read
 * with no reconstruction step. `null` means "this apply didn't set `core.sshCommand` at all" (no
 * value to assert for that key), matching `applyIdentityProfile`'s own "omitted `sshIdentityFilePath`"
 * semantics. `profileId`/`profileDisplayName`/`appliedAt` are UI-only metadata (e.g. "Applied:
 * Work identity, 3 days ago") — never consulted for the trust comparison itself, so editing or
 * deleting the source profile afterward can never invalidate an already-applied record.
 */
export interface IdentityApplicationRecord {
  /** The profile's id at the moment it was applied — kept even if that profile is later edited or
   * deleted from the library (this record's own value fields below remain authoritative either
   * way). Not used for the trust comparison itself, only for UI attribution. */
  profileId: string;
  /** Display name captured at apply time, for UI attribution only (e.g. "Applied: Work identity") —
   * never re-read from the live profile, so a later rename doesn't retroactively relabel history. */
  profileDisplayName: string;
  /** The exact value written to this repo's local `user.name`. */
  userName: string;
  /** The exact value written to this repo's local `user.email`. */
  userEmail: string;
  /** The exact, fully-constructed value written to this repo's local `core.sshCommand`, or `null`
   * when the applied profile had no SSH identity file (and therefore asserts nothing for this key —
   * see `applyIdentityProfile`'s own doc comment, git-core's `identityProfile.ts`, for why that's
   * different from "expect this key to be unset"). */
  sshCommand: string | null;
  /** ISO-8601 timestamp of when this application was recorded. */
  appliedAt: string;
}

/** Keyed by the repo's resolved root path (`graph.repoPath` — see this module's own doc comment
 * for why that's the right key, matching `App.tsx`'s `lastFetchedAtByPath`). */
export type IdentityApplicationsByRepoPath = Record<string, IdentityApplicationRecord>;

const IDENTITY_APPLICATIONS_KEY = "githydra:identityApplications";

function readStored(): IdentityApplicationsByRepoPath {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage?.getItem(IDENTITY_APPLICATIONS_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    const result: IdentityApplicationsByRepoPath = {};
    for (const [repoPath, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!value || typeof value !== "object") continue;
      const v = value as Record<string, unknown>;
      if (
        typeof v.profileId === "string" &&
        typeof v.profileDisplayName === "string" &&
        typeof v.userName === "string" &&
        typeof v.userEmail === "string" &&
        (typeof v.sshCommand === "string" || v.sshCommand === null) &&
        typeof v.appliedAt === "string"
      ) {
        result[repoPath] = {
          profileId: v.profileId,
          profileDisplayName: v.profileDisplayName,
          userName: v.userName,
          userEmail: v.userEmail,
          sshCommand: v.sshCommand as string | null,
          appliedAt: v.appliedAt,
        };
      }
    }
    return result;
  } catch {
    // Missing/corrupt/unavailable localStorage — degrade to "no known applications" rather than
    // throw, matching every other persisted-store read in this codebase.
    return {};
  }
}

function writeStored(map: IdentityApplicationsByRepoPath): void {
  try {
    window.localStorage?.setItem(IDENTITY_APPLICATIONS_KEY, JSON.stringify(map));
  } catch {
    // localStorage unavailable — this record just won't persist across restarts.
  }
}

/** Read the persisted map directly — exported for tests, mirroring `getPersistedRecentRepos`. */
export function getPersistedIdentityApplications(): IdentityApplicationsByRepoPath {
  return readStored();
}

/** Records (overwriting any prior entry for the same repo path — a repo has at most one applied
 * identity at a time, matching git-core's own `applyIdentityProfile`/`removeIdentityProfileApplication`
 * "one managed set per repo" model) that `record` was just successfully applied to `repoPath`. */
export function setPersistedIdentityApplication(repoPath: string, record: IdentityApplicationRecord): IdentityApplicationsByRepoPath {
  const map = readStored();
  const next = { ...map, [repoPath]: record };
  writeStored(next);
  return next;
}

/** Clears `repoPath`'s recorded application (FR-336: called after a successful
 * `removeIdentityProfileApplication()`) — a no-op if nothing was recorded for it. */
export function clearPersistedIdentityApplication(repoPath: string): IdentityApplicationsByRepoPath {
  const map = readStored();
  if (!(repoPath in map)) return map;
  const next = { ...map };
  delete next[repoPath];
  writeStored(next);
  return next;
}

export interface UseIdentityApplicationsResult {
  applications: IdentityApplicationsByRepoPath;
  /** The current repo's recorded application, or `null` if none/`repoPath` is `null`. */
  getApplication: (repoPath: string | null) => IdentityApplicationRecord | null;
  recordApplication: (repoPath: string, record: IdentityApplicationRecord) => void;
  clearApplication: (repoPath: string) => void;
}

/** React-state-backed wrapper around the persisted map above, mirroring `useRecentRepos`'s own
 * shape — one instance owned by `App.tsx`, handed to the identity dialog/hook that actually
 * performs apply/remove calls. */
export function useIdentityApplications(): UseIdentityApplicationsResult {
  const [applications, setApplications] = useState<IdentityApplicationsByRepoPath>(() => getPersistedIdentityApplications());

  const getApplication = useCallback(
    (repoPath: string | null) => (repoPath ? (applications[repoPath] ?? null) : null),
    [applications],
  );

  const recordApplication = useCallback((repoPath: string, record: IdentityApplicationRecord) => {
    setApplications(setPersistedIdentityApplication(repoPath, record));
  }, []);

  const clearApplication = useCallback((repoPath: string) => {
    setApplications(clearPersistedIdentityApplication(repoPath));
  }, []);

  return { applications, getApplication, recordApplication, clearApplication };
}
