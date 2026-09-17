// SPDX-License-Identifier: GPL-3.0-or-later
import { useCallback, useState } from "react";

/**
 * specs/git-identity-profiles.md FR-329: the profile *library* — named, locally-stored (app
 * storage only, never synced, no backend) records reusable across repos. Creating/editing/deleting
 * a profile here never touches any repo's git config by itself (that's `useIdentityProfileApplication`'s
 * job, one layer up). Same storage mechanism (`localStorage`) and try/catch-guarded read/write
 * pattern as `useRecentRepos.ts`/`useLayoutPreferences.ts` — deliberately not a new persistence
 * layer.
 */
export interface IdentityProfile {
  id: string;
  displayName: string;
  userName: string;
  userEmail: string;
  /** Absolute path to an SSH private key file (FR-332: always sourced from the native file
   * dialog), or `null` when this profile has no SSH identity of its own. */
  sshIdentityFilePath: string | null;
}

export type IdentityProfileInput = Omit<IdentityProfile, "id">;

const IDENTITY_PROFILES_KEY = "githydra:identityProfiles";

function generateProfileId(): string {
  // Renderer/jsdom-safe: prefer the real Web Crypto UUID (available in Electron's Chromium
  // renderer and in modern Node), fall back to a timestamp+random string so a test environment
  // (or a very old runtime) missing `crypto.randomUUID` still gets a collision-safe-enough id.
  // Never a simple incrementing counter (unlike this codebase's ephemeral IPC `requestId`s,
  // ROADMAP.md's `fetch-${++seq}` convention) — a profile id is PERSISTED, so a fresh per-session
  // counter starting back at 0 would collide with an already-stored profile's id after a relaunch.
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `profile-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function isValidProfile(v: unknown): v is IdentityProfile {
  if (!v || typeof v !== "object") return false;
  const p = v as Record<string, unknown>;
  return (
    typeof p.id === "string" &&
    typeof p.displayName === "string" &&
    typeof p.userName === "string" &&
    typeof p.userEmail === "string" &&
    (typeof p.sshIdentityFilePath === "string" || p.sshIdentityFilePath === null)
  );
}

function readStored(): IdentityProfile[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage?.getItem(IDENTITY_PROFILES_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isValidProfile);
  } catch {
    // Missing/corrupt/unavailable localStorage — degrade to "no profiles" rather than throw,
    // matching every other persisted-store read in this codebase.
    return [];
  }
}

function writeStored(list: IdentityProfile[]): void {
  try {
    window.localStorage?.setItem(IDENTITY_PROFILES_KEY, JSON.stringify(list));
  } catch {
    // localStorage unavailable — the library just won't persist across restarts.
  }
}

/** Read the persisted list directly — exported for tests, mirroring `getPersistedRecentRepos`. */
export function getPersistedIdentityProfiles(): IdentityProfile[] {
  return readStored();
}

export function addPersistedIdentityProfile(input: IdentityProfileInput): { list: IdentityProfile[]; created: IdentityProfile } {
  const created: IdentityProfile = { id: generateProfileId(), ...input };
  const list = [...readStored(), created];
  writeStored(list);
  return { list, created };
}

export function updatePersistedIdentityProfile(id: string, input: IdentityProfileInput): IdentityProfile[] {
  const list = readStored().map((p) => (p.id === id ? { ...p, ...input } : p));
  writeStored(list);
  return list;
}

/** FR-329: deleting a profile never touches any repo's git config by itself — a repo that had
 * this profile applied keeps whatever `getIdentityConfigState()` currently reports (the applied
 * *values*, tracked separately by `useIdentityApplications`, are independent of the source profile
 * continuing to exist in the library). */
export function removePersistedIdentityProfile(id: string): IdentityProfile[] {
  const list = readStored().filter((p) => p.id !== id);
  writeStored(list);
  return list;
}

export interface UseIdentityProfilesResult {
  profiles: IdentityProfile[];
  createProfile: (input: IdentityProfileInput) => IdentityProfile;
  updateProfile: (id: string, input: IdentityProfileInput) => void;
  deleteProfile: (id: string) => void;
}

/** React-state-backed wrapper around the persisted list above, mirroring `useRecentRepos`'s own
 * shape — one instance owned by `App.tsx` (or a dialog it renders). */
export function useIdentityProfiles(): UseIdentityProfilesResult {
  const [profiles, setProfiles] = useState<IdentityProfile[]>(() => getPersistedIdentityProfiles());

  const createProfile = useCallback((input: IdentityProfileInput) => {
    const { list, created } = addPersistedIdentityProfile(input);
    setProfiles(list);
    return created;
  }, []);

  const updateProfile = useCallback((id: string, input: IdentityProfileInput) => {
    setProfiles(updatePersistedIdentityProfile(id, input));
  }, []);

  const deleteProfile = useCallback((id: string) => {
    setProfiles(removePersistedIdentityProfile(id));
  }, []);

  return { profiles, createProfile, updateProfile, deleteProfile };
}
