// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useRepositoryGraph } from "./useRepositoryGraph";
import { makeMockGitHydra } from "../test/mockGitHydra";
import { makeCommit } from "../test/fixtures";

afterEach(() => {
  // @ts-expect-error test cleanup of the global bridge
  delete window.gitHydra;
  vi.restoreAllMocks();
});

// Escape on an empty Find overlay calls clearFilter(); a reload there blanked the graph and destroyed an open
// "+N" popover (CI-only failure of the refChipGutterVisualCheck popover specs at 1400x900).
describe("useRepositoryGraph — clearFilter with no filter active", () => {
  it("does not restart the graph read", async () => {
    const api = makeMockGitHydra({ commits: [makeCommit("c1")] });
    window.gitHydra = api;
    const { result } = renderHook(() => useRepositoryGraph());
    await act(async () => {
      await result.current.openRepo("/repo");
    });
    await waitFor(() => expect(result.current.status).toBe("ready"));
    const readersBefore = vi.mocked(api.createLogReader).mock.calls.length;

    act(() => result.current.clearFilter());

    expect(vi.mocked(api.createLogReader).mock.calls.length).toBe(readersBefore);
    expect(result.current.displayRows.length).toBeGreaterThan(0);
  });
});
