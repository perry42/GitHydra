// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import {
  clearPersistedIdentityApplication,
  getPersistedIdentityApplications,
  setPersistedIdentityApplication,
  useIdentityApplications,
  type IdentityApplicationRecord,
} from "./useIdentityApplications";

afterEach(() => {
  window.localStorage.clear();
});

function makeRecord(overrides: Partial<IdentityApplicationRecord> = {}): IdentityApplicationRecord {
  return {
    profileId: "p1",
    profileDisplayName: "Work",
    userName: "Jane Doe",
    userEmail: "jane@work.example",
    sshCommand: null,
    appliedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

/**
 * security-reviewer finding: the authoritative "did GitHydra apply X to repo Y, with exactly
 * these values" record lives here (app storage), not in the target repo's own attacker-writable
 * `.git/config` — see this module's own doc comment for the full threat-model reasoning.
 */
describe("useIdentityApplications persistence", () => {
  it("a fresh profile (of the app) has no persisted applications", () => {
    expect(getPersistedIdentityApplications()).toEqual({});
  });

  it("recording an application persists it keyed by repo path", () => {
    const record = makeRecord();
    setPersistedIdentityApplication("/repoA", record);
    expect(getPersistedIdentityApplications()).toEqual({ "/repoA": record });
  });

  it("recording a second repo's application never overwrites the first", () => {
    setPersistedIdentityApplication("/repoA", makeRecord({ profileDisplayName: "Work" }));
    setPersistedIdentityApplication("/repoB", makeRecord({ profileDisplayName: "Personal" }));
    const all = getPersistedIdentityApplications();
    expect(all["/repoA"]!.profileDisplayName).toBe("Work");
    expect(all["/repoB"]!.profileDisplayName).toBe("Personal");
  });

  it("re-recording the same repo path overwrites its prior entry (one applied identity per repo)", () => {
    setPersistedIdentityApplication("/repoA", makeRecord({ profileId: "p1" }));
    setPersistedIdentityApplication("/repoA", makeRecord({ profileId: "p2" }));
    expect(getPersistedIdentityApplications()["/repoA"]!.profileId).toBe("p2");
  });

  it("FR-336: clearing a repo's application removes exactly that entry, leaving others untouched", () => {
    setPersistedIdentityApplication("/repoA", makeRecord());
    setPersistedIdentityApplication("/repoB", makeRecord());
    clearPersistedIdentityApplication("/repoA");
    const all = getPersistedIdentityApplications();
    expect(all).not.toHaveProperty("/repoA");
    expect(all).toHaveProperty("/repoB");
  });

  it("clearing an absent repo path is a harmless no-op", () => {
    setPersistedIdentityApplication("/repoA", makeRecord());
    clearPersistedIdentityApplication("/does-not-exist");
    expect(getPersistedIdentityApplications()).toHaveProperty("/repoA");
  });

  it("preserves the exact sshCommand string (already the fully-constructed value, not just a path)", () => {
    const record = makeRecord({ sshCommand: "ssh -i '/home/jane/.ssh/id_work' -o IdentitiesOnly=yes" });
    setPersistedIdentityApplication("/repoA", record);
    expect(getPersistedIdentityApplications()["/repoA"]).toEqual(record);
  });

  it("degrades to an empty map (never throws) when localStorage is corrupt", () => {
    window.localStorage.setItem("githydra:identityApplications", "{not valid json");
    expect(getPersistedIdentityApplications()).toEqual({});
  });

  it("degrades to an empty map when the stored value isn't a plain object", () => {
    window.localStorage.setItem("githydra:identityApplications", JSON.stringify(["not", "an", "object"]));
    expect(getPersistedIdentityApplications()).toEqual({});
  });

  it("filters out a malformed entry from a hand-tampered stored map, keeping valid ones", () => {
    const valid = makeRecord();
    window.localStorage.setItem(
      "githydra:identityApplications",
      JSON.stringify({ "/repoA": valid, "/repoB": { garbage: true } }),
    );
    const all = getPersistedIdentityApplications();
    expect(all["/repoA"]).toEqual(valid);
    expect(all).not.toHaveProperty("/repoB");
  });

  it("degrades to a no-op (never throws) when localStorage.setItem throws", () => {
    const original = window.localStorage.setItem;
    window.localStorage.setItem = () => {
      throw new Error("storage unavailable");
    };
    expect(() => setPersistedIdentityApplication("/repoA", makeRecord())).not.toThrow();
    window.localStorage.setItem = original;
  });
});

describe("useIdentityApplications hook", () => {
  it("getApplication returns null for an unrecorded repo path, and for a null repoPath", () => {
    const { result } = renderHook(() => useIdentityApplications());
    expect(result.current.getApplication("/repoA")).toBeNull();
    expect(result.current.getApplication(null)).toBeNull();
  });

  it("recordApplication updates both the returned state and the persisted store", () => {
    const { result } = renderHook(() => useIdentityApplications());
    const record = makeRecord();
    act(() => result.current.recordApplication("/repoA", record));
    expect(result.current.getApplication("/repoA")).toEqual(record);
    expect(getPersistedIdentityApplications()).toEqual({ "/repoA": record });
  });

  it("clearApplication updates both the returned state and the persisted store", () => {
    const { result } = renderHook(() => useIdentityApplications());
    act(() => result.current.recordApplication("/repoA", makeRecord()));
    act(() => result.current.clearApplication("/repoA"));
    expect(result.current.getApplication("/repoA")).toBeNull();
    expect(getPersistedIdentityApplications()).toEqual({});
  });

  it("a second hook instance sees a fresh-read seed from whatever was already persisted", () => {
    setPersistedIdentityApplication("/repoA", makeRecord());
    const { result } = renderHook(() => useIdentityApplications());
    expect(result.current.getApplication("/repoA")).toEqual(makeRecord());
  });
});
