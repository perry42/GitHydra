// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { WorkingDirectoryChanges } from "@githydra/git-core";
import { useChangesPanel } from "./useChangesPanel";
import { makeMockGitHydra } from "../test/mockGitHydra";

const changes: WorkingDirectoryChanges = {
  staged: [],
  unstaged: [
    { path: "a.ts", status: "modified", category: "unstaged" },
    { path: "b.ts", status: "modified", category: "unstaged" },
  ],
  untracked: [],
  conflicted: [],
};

function setup() {
  const api = makeMockGitHydra({ workingDirectoryChanges: changes });
  const hook = renderHook(() =>
    useChangesPanel({ api, changes, onWorkingDirChanged: () => {}, onCommitCreated: () => {} }),
  );
  return { api, ...hook };
}

describe("whole-file discard baseline binding (security review L-A, Info 5)", () => {
  it("a stale confirm closure for file A never uses file B's baseline (identical bytes) and discards nothing", async () => {
    const { api, result } = setup();
    act(() => result.current.requestDiscard("unstaged", "a.ts"));
    await waitFor(() => expect(result.current.pendingDiscard?.path).toBe("a.ts"));
    const staleConfirm = result.current.confirmDiscard;
    act(() => result.current.requestDiscard("unstaged", "b.ts"));
    await waitFor(() => expect(result.current.pendingDiscard?.path).toBe("b.ts"));
    act(() => staleConfirm());
    await new Promise((r) => setTimeout(r, 20));
    expect(api.discardTrackedFileChanges).not.toHaveBeenCalled();
    act(() => result.current.confirmDiscard());
    await waitFor(() => expect(api.discardTrackedFileChanges).toHaveBeenCalledWith("b.ts", "fp-default"));
  });

  it("a failed baseline read for B closes dialog A and shows B's error", async () => {
    const { api, result } = setup();
    act(() => result.current.requestDiscard("unstaged", "a.ts"));
    await waitFor(() => expect(result.current.pendingDiscard?.path).toBe("a.ts"));
    vi.mocked(api.getDiscardFingerprint).mockResolvedValue({ ok: false, error: { name: "DiscardFingerprintError", message: "Cannot verify b.ts" } });
    act(() => result.current.requestDiscard("unstaged", "b.ts"));
    await waitFor(() => expect(result.current.actionError).toMatch(/cannot verify b\.ts/i));
    expect(result.current.pendingDiscard).toBeNull();
  });
});
