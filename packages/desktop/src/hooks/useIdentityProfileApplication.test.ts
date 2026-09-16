// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { IdentityConfigState } from "@githydra/git-core";
import { makeMockGitHydra } from "../test/mockGitHydra";
import { useIdentityApplications } from "./useIdentityApplications";
import { useIdentityProfileApplication } from "./useIdentityProfileApplication";
import type { IdentityProfile } from "./useIdentityProfiles";

afterEach(() => {
  window.localStorage.clear();
});

const PROFILE: IdentityProfile = {
  id: "p1",
  displayName: "Work",
  userName: "Jane Doe",
  userEmail: "jane@work.example",
  sshIdentityFilePath: null,
};

function renderApplication(options: { api: ReturnType<typeof makeMockGitHydra>; repoPath: string | null }) {
  const onMutationStart = vi.fn();
  const onSettled = vi.fn();
  const { result } = renderHook(() => {
    const applications = useIdentityApplications();
    const application = useIdentityProfileApplication({
      api: options.api,
      repoPath: options.repoPath,
      applications,
      onMutationStart,
      onSettled,
    });
    return { applications, application };
  });
  return { result, onMutationStart, onSettled };
}

describe("useIdentityProfileApplication", () => {
  it("FR-335: fetches and exposes the repo's identity config state on mount", async () => {
    const identityConfigState: IdentityConfigState = {
      userName: { localValue: "Someone Else", globalValue: "Global Name", managedByGitHydra: false },
      userEmail: { localValue: null, globalValue: "global@example.com", managedByGitHydra: false },
      sshCommand: { localValue: null, globalValue: null, managedByGitHydra: false },
    };
    const api = makeMockGitHydra({ identityConfigState });
    const { result } = renderApplication({ api, repoPath: "/repo" });
    await waitFor(() => expect(result.current.application.status).toBe("ready"));
    expect(result.current.application.state).toEqual(identityConfigState);
  });

  it("stays idle with null state when no repo is open", () => {
    const api = makeMockGitHydra();
    const { result } = renderApplication({ api, repoPath: null });
    expect(result.current.application.status).toBe("idle");
    expect(result.current.application.state).toBeNull();
    expect(vi.mocked(api.getIdentityConfigState)).not.toHaveBeenCalled();
  });

  it("FR-330/FR-331: applyProfile writes the profile's fields, opening and closing the self-write gate", async () => {
    const api = makeMockGitHydra();
    const { result, onMutationStart, onSettled } = renderApplication({ api, repoPath: "/repo" });
    await waitFor(() => expect(result.current.application.status).toBe("ready"));

    act(() => result.current.application.applyProfile(PROFILE));
    await waitFor(() => expect(result.current.application.busy).toBe(false));

    expect(vi.mocked(api.applyIdentityProfile)).toHaveBeenCalledWith({
      userName: "Jane Doe",
      userEmail: "jane@work.example",
      sshIdentityFilePath: null,
      force: false,
    });
    expect(onMutationStart).toHaveBeenCalledTimes(1);
    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(result.current.application.error).toBeNull();
  });

  it("records an application entry (app storage) on a successful apply, with the exact written values", async () => {
    const sshProfile: IdentityProfile = { ...PROFILE, sshIdentityFilePath: "/home/jane/.ssh/id_work" };
    const api = makeMockGitHydra();
    const { result } = renderApplication({ api, repoPath: "/repo" });
    await waitFor(() => expect(result.current.application.status).toBe("ready"));

    act(() => result.current.application.applyProfile(sshProfile));
    await waitFor(() => expect(result.current.application.busy).toBe(false));

    const record = result.current.applications.getApplication("/repo");
    expect(record).toEqual({
      profileId: "p1",
      profileDisplayName: "Work",
      userName: "Jane Doe",
      userEmail: "jane@work.example",
      sshCommand: "ssh -i '/home/jane/.ssh/id_work' -o IdentitiesOnly=yes",
      appliedAt: expect.any(String),
    });
  });

  it("FR-334: a conflicting apply pauses as pendingConflict instead of forcing, and closes the gate anyway", async () => {
    const api = makeMockGitHydra({
      identityConfigState: {
        userName: { localValue: "Corp Bot", globalValue: null, managedByGitHydra: false },
        userEmail: { localValue: null, globalValue: null, managedByGitHydra: false },
        sshCommand: { localValue: null, globalValue: null, managedByGitHydra: false },
      },
    });
    const { result, onSettled } = renderApplication({ api, repoPath: "/repo" });
    await waitFor(() => expect(result.current.application.status).toBe("ready"));

    act(() => result.current.application.applyProfile(PROFILE));
    await waitFor(() => expect(result.current.application.pendingConflict).not.toBeNull());

    expect(result.current.application.pendingConflict!.message).toMatch(/user\.name/);
    expect(vi.mocked(api.applyIdentityProfile)).toHaveBeenCalledWith(expect.objectContaining({ force: false }));
    expect(onSettled).toHaveBeenCalledTimes(1);
    // Never recorded — nothing was actually written.
    expect(result.current.applications.getApplication("/repo")).toBeNull();
  });

  it("FR-334: confirmApplyWithForce retries the same profile with force: true, and clears the pause", async () => {
    const api = makeMockGitHydra({
      identityConfigState: {
        userName: { localValue: "Corp Bot", globalValue: null, managedByGitHydra: false },
        userEmail: { localValue: null, globalValue: null, managedByGitHydra: false },
        sshCommand: { localValue: null, globalValue: null, managedByGitHydra: false },
      },
    });
    const { result } = renderApplication({ api, repoPath: "/repo" });
    await waitFor(() => expect(result.current.application.status).toBe("ready"));
    act(() => result.current.application.applyProfile(PROFILE));
    await waitFor(() => expect(result.current.application.pendingConflict).not.toBeNull());

    act(() => result.current.application.confirmApplyWithForce());
    // `pendingConflict` clears synchronously (before the retry's async apply call even starts) —
    // wait on `busy` settling instead, or this assertion could observe the retry mid-flight.
    await waitFor(() => expect(result.current.application.busy).toBe(false));
    expect(result.current.application.pendingConflict).toBeNull();

    expect(vi.mocked(api.applyIdentityProfile)).toHaveBeenLastCalledWith(
      expect.objectContaining({ userName: "Jane Doe", force: true }),
    );
    expect(result.current.applications.getApplication("/repo")).not.toBeNull();
  });

  it("cancelApplyConflict clears the pause and writes nothing", async () => {
    const api = makeMockGitHydra({
      identityConfigState: {
        userName: { localValue: "Corp Bot", globalValue: null, managedByGitHydra: false },
        userEmail: { localValue: null, globalValue: null, managedByGitHydra: false },
        sshCommand: { localValue: null, globalValue: null, managedByGitHydra: false },
      },
    });
    const { result } = renderApplication({ api, repoPath: "/repo" });
    await waitFor(() => expect(result.current.application.status).toBe("ready"));
    act(() => result.current.application.applyProfile(PROFILE));
    await waitFor(() => expect(result.current.application.pendingConflict).not.toBeNull());

    act(() => result.current.application.cancelApplyConflict());
    expect(result.current.application.pendingConflict).toBeNull();
    expect(vi.mocked(api.applyIdentityProfile)).toHaveBeenCalledTimes(1); // no retry issued
  });

  it("FR-336: removeApplication unsets managed keys and clears the recorded application entry", async () => {
    const api = makeMockGitHydra();
    const { result } = renderApplication({ api, repoPath: "/repo" });
    await waitFor(() => expect(result.current.application.status).toBe("ready"));
    act(() => result.current.application.applyProfile(PROFILE));
    await waitFor(() => expect(result.current.applications.getApplication("/repo")).not.toBeNull());

    act(() => result.current.application.removeApplication());
    await waitFor(() => expect(result.current.application.busy).toBe(false));

    expect(vi.mocked(api.removeIdentityProfileApplication)).toHaveBeenCalledTimes(1);
    expect(result.current.applications.getApplication("/repo")).toBeNull();
  });

  it("surfaces a genuine InvalidArgumentError (e.g. a rejected SSH path) as `error`, not a conflict pause", async () => {
    const api = makeMockGitHydra();
    vi.mocked(api.applyIdentityProfile).mockResolvedValueOnce({
      ok: false,
      error: { name: "InvalidArgumentError", message: 'SSH identity file path contains a semicolon (;), which is not allowed: "/tmp/evil;rm"' },
    });
    const { result } = renderApplication({ api, repoPath: "/repo" });
    await waitFor(() => expect(result.current.application.status).toBe("ready"));

    act(() => result.current.application.applyProfile({ ...PROFILE, sshIdentityFilePath: "/tmp/evil;rm" }));
    await waitFor(() => expect(result.current.application.error).not.toBeNull());

    expect(result.current.application.error).toMatch(/semicolon/);
    expect(result.current.application.pendingConflict).toBeNull();
  });

  it("reloading a different repo path refetches its own identity state independently", async () => {
    const api = makeMockGitHydra({
      reposByPath: {
        "/repoA": { identityConfigState: { userName: { localValue: "A", globalValue: null, managedByGitHydra: false }, userEmail: { localValue: null, globalValue: null, managedByGitHydra: false }, sshCommand: { localValue: null, globalValue: null, managedByGitHydra: false } } },
        "/repoB": { identityConfigState: { userName: { localValue: "B", globalValue: null, managedByGitHydra: false }, userEmail: { localValue: null, globalValue: null, managedByGitHydra: false }, sshCommand: { localValue: null, globalValue: null, managedByGitHydra: false } } },
      },
    });
    // Mirrors this mock's own "openRepo switches the active record" convention — read the initial
    // repo once so `active()` points at /repoA before the hook's first fetch.
    await api.openRepo("/repoA");
    const { result, rerender } = renderHook(
      ({ repoPath }: { repoPath: string }) => {
        const applications = useIdentityApplications();
        return useIdentityProfileApplication({ api, repoPath, applications });
      },
      { initialProps: { repoPath: "/repoA" } },
    );
    await waitFor(() => expect(result.current.state?.userName.localValue).toBe("A"));

    await api.openRepo("/repoB");
    rerender({ repoPath: "/repoB" });
    await waitFor(() => expect(result.current.state?.userName.localValue).toBe("B"));
  });
});
