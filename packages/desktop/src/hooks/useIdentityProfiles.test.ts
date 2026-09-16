// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import {
  addPersistedIdentityProfile,
  getPersistedIdentityProfiles,
  removePersistedIdentityProfile,
  updatePersistedIdentityProfile,
  useIdentityProfiles,
} from "./useIdentityProfiles";

afterEach(() => {
  window.localStorage.clear();
});

/** specs/git-identity-profiles.md FR-329. */
describe("useIdentityProfiles persistence", () => {
  it("a fresh profile (of the app) has no persisted identity profiles", () => {
    expect(getPersistedIdentityProfiles()).toEqual([]);
  });

  it("creating a profile persists it with a generated id and every given field", () => {
    const { created } = addPersistedIdentityProfile({
      displayName: "Work",
      userName: "Jane Doe",
      userEmail: "jane@work.example",
      sshIdentityFilePath: "/home/jane/.ssh/id_work",
    });
    expect(created.id).toBeTruthy();
    expect(getPersistedIdentityProfiles()).toEqual([created]);
  });

  it("creating a second profile never collides ids with the first", () => {
    const { created: a } = addPersistedIdentityProfile({ displayName: "Work", userName: "a", userEmail: "a@x.com", sshIdentityFilePath: null });
    const { created: b } = addPersistedIdentityProfile({ displayName: "Personal", userName: "b", userEmail: "b@x.com", sshIdentityFilePath: null });
    expect(a.id).not.toBe(b.id);
    expect(getPersistedIdentityProfiles().map((p) => p.id)).toEqual([a.id, b.id]);
  });

  it("updating a profile changes only that profile's fields, leaving others untouched", () => {
    const { created: a } = addPersistedIdentityProfile({ displayName: "Work", userName: "a", userEmail: "a@x.com", sshIdentityFilePath: null });
    const { created: b } = addPersistedIdentityProfile({ displayName: "Personal", userName: "b", userEmail: "b@x.com", sshIdentityFilePath: null });
    updatePersistedIdentityProfile(a.id, { displayName: "Work (renamed)", userName: "a2", userEmail: "a2@x.com", sshIdentityFilePath: "/k" });
    const list = getPersistedIdentityProfiles();
    expect(list.find((p) => p.id === a.id)).toEqual({ id: a.id, displayName: "Work (renamed)", userName: "a2", userEmail: "a2@x.com", sshIdentityFilePath: "/k" });
    expect(list.find((p) => p.id === b.id)).toEqual(b);
  });

  it("FR-329: deleting a profile never touches any other profile", () => {
    const { created: a } = addPersistedIdentityProfile({ displayName: "Work", userName: "a", userEmail: "a@x.com", sshIdentityFilePath: null });
    const { created: b } = addPersistedIdentityProfile({ displayName: "Personal", userName: "b", userEmail: "b@x.com", sshIdentityFilePath: null });
    removePersistedIdentityProfile(a.id);
    expect(getPersistedIdentityProfiles()).toEqual([b]);
  });

  it("removing an absent id is a harmless no-op", () => {
    const { created } = addPersistedIdentityProfile({ displayName: "Work", userName: "a", userEmail: "a@x.com", sshIdentityFilePath: null });
    removePersistedIdentityProfile("does-not-exist");
    expect(getPersistedIdentityProfiles()).toEqual([created]);
  });

  it("degrades to an empty list (never throws) when localStorage is corrupt", () => {
    window.localStorage.setItem("githydra:identityProfiles", "{not valid json");
    expect(getPersistedIdentityProfiles()).toEqual([]);
  });

  it("degrades to an empty list when the stored value isn't an array", () => {
    window.localStorage.setItem("githydra:identityProfiles", JSON.stringify({ not: "an array" }));
    expect(getPersistedIdentityProfiles()).toEqual([]);
  });

  it("filters out malformed entries from a hand-tampered stored array, keeping valid ones", () => {
    const valid = { id: "1", displayName: "Work", userName: "a", userEmail: "a@x.com", sshIdentityFilePath: null };
    window.localStorage.setItem("githydra:identityProfiles", JSON.stringify([valid, { garbage: true }, null, "nope"]));
    expect(getPersistedIdentityProfiles()).toEqual([valid]);
  });

  it("degrades to a no-op (never throws) when localStorage.setItem throws", () => {
    const original = window.localStorage.setItem;
    window.localStorage.setItem = () => {
      throw new Error("storage unavailable");
    };
    expect(() => addPersistedIdentityProfile({ displayName: "Work", userName: "a", userEmail: "a@x.com", sshIdentityFilePath: null })).not.toThrow();
    window.localStorage.setItem = original;
  });
});

describe("useIdentityProfiles hook", () => {
  it("starts empty on a fresh profile (of the app)", () => {
    const { result } = renderHook(() => useIdentityProfiles());
    expect(result.current.profiles).toEqual([]);
  });

  it("createProfile updates both the returned state and the persisted store, returning the created record", () => {
    const { result } = renderHook(() => useIdentityProfiles());
    let created!: ReturnType<typeof result.current.createProfile>;
    act(() => {
      created = result.current.createProfile({ displayName: "Work", userName: "a", userEmail: "a@x.com", sshIdentityFilePath: null });
    });
    expect(result.current.profiles).toEqual([created]);
    expect(getPersistedIdentityProfiles()).toEqual([created]);
  });

  it("updateProfile and deleteProfile update both the returned state and the persisted store", () => {
    const { result } = renderHook(() => useIdentityProfiles());
    let id!: string;
    act(() => {
      id = result.current.createProfile({ displayName: "Work", userName: "a", userEmail: "a@x.com", sshIdentityFilePath: null }).id;
    });
    act(() => result.current.updateProfile(id, { displayName: "Work2", userName: "a2", userEmail: "a2@x.com", sshIdentityFilePath: "/k" }));
    expect(result.current.profiles[0]!.displayName).toBe("Work2");
    act(() => result.current.deleteProfile(id));
    expect(result.current.profiles).toEqual([]);
    expect(getPersistedIdentityProfiles()).toEqual([]);
  });

  it("a second hook instance sees a fresh-read seed from whatever was already persisted", () => {
    addPersistedIdentityProfile({ displayName: "Work", userName: "a", userEmail: "a@x.com", sshIdentityFilePath: null });
    const { result } = renderHook(() => useIdentityProfiles());
    expect(result.current.profiles).toHaveLength(1);
  });
});
