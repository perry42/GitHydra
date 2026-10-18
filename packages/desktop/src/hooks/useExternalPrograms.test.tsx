// SPDX-License-Identifier: GPL-3.0-or-later
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { GITHYDRA_TAB_ID } from "../../shared/programsContract";
import { buildOpenInProgramItem, resolveDefault } from "../lib/openInProgram";
import { makeMockGitHydra, mockProgram } from "../test/mockGitHydra";
import { useExternalPrograms } from "./useExternalPrograms";

/** specs/external-programs.md AC2: the default message, the fallback, and a failed launch naming program + path. */

function setup(externalPrograms: Parameters<typeof makeMockGitHydra>[0] extends infer O ? (O extends { externalPrograms?: infer E } ? E : never) : never) {
  const api = makeMockGitHydra({ externalPrograms });
  const notify = vi.fn();
  const onManagePrograms = vi.fn();
  const hook = renderHook(() => useExternalPrograms({ api, notify, onManagePrograms }));
  return { api, notify, onManagePrograms, hook };
}

const PROGRAMS = [{ id: "vscode", name: "Visual Studio Code" }, { id: "cursor", name: "Cursor", path: "C:/Tools/cursor/Cursor.exe" }];

describe("useExternalPrograms (FR-617, FR-622)", () => {
  it("loads the list and re-reads it on refresh (the stat when a menu opens)", async () => {
    const { api, hook } = setup({ programs: PROGRAMS, defaultId: "vscode" });
    await waitFor(() => expect(hook.result.current.snapshot?.defaultId).toBe("vscode"));
    expect(api.listExternalPrograms).toHaveBeenCalledTimes(1);
    act(() => hook.result.current.refresh());
    await waitFor(() => expect(api.listExternalPrograms).toHaveBeenCalledTimes(2));
  });

  it("choosing a non-default program says 'Opened in Cursor. Cursor is now your default.'", async () => {
    const { api, notify, hook } = setup({ programs: PROGRAMS, defaultId: "vscode" });
    await waitFor(() => expect(hook.result.current.snapshot).not.toBeNull());
    await act(() => hook.result.current.launch("cursor", { worktreeId: "wt" }));
    expect(api.launchExternalProgram).toHaveBeenCalledWith({ programId: "cursor", target: { worktreeId: "wt" } });
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ tone: "success", text: "Opened in Cursor. Cursor is now your default." }));
    await waitFor(() => expect(hook.result.current.snapshot?.defaultId).toBe("cursor"));
  });

  it("launching the existing default says nothing", async () => {
    const { notify, hook } = setup({ programs: PROGRAMS, defaultId: "cursor" });
    await waitFor(() => expect(hook.result.current.snapshot).not.toBeNull());
    await act(() => hook.result.current.launch("cursor", { repoRoot: true }));
    expect(notify).not.toHaveBeenCalled();
  });

  it("the first launch on a fresh install also makes the program the default, and says so", async () => {
    const { notify, hook } = setup({ programs: PROGRAMS, defaultId: null });
    await waitFor(() => expect(hook.result.current.snapshot).not.toBeNull());
    await act(() => hook.result.current.launch("vscode", { repoRoot: true }));
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ text: "Opened in Visual Studio Code. Visual Studio Code is now your default." }));
  });

  it("choosing GitHydra tab opens the tab and, if it was not the default, says it is now", async () => {
    const { api, notify, hook } = setup({ programs: PROGRAMS, defaultId: "cursor" });
    await waitFor(() => expect(hook.result.current.snapshot).not.toBeNull());
    const openTab = vi.fn();
    act(() => hook.result.current.chooseTab(openTab));
    expect(openTab).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(api.setDefaultExternalProgram).toHaveBeenCalledWith(GITHYDRA_TAB_ID));
    await waitFor(() => expect(notify).toHaveBeenCalledWith(expect.objectContaining({ text: "Opened in GitHydra tab. GitHydra tab is now your default." })));
  });

  it("a failed start names the program and its path, offers Manage programs, and is not retried", async () => {
    const { api, notify, hook } = setup({ programs: PROGRAMS, defaultId: "cursor" });
    await waitFor(() => expect(hook.result.current.snapshot).not.toBeNull());
    vi.mocked(api.launchExternalProgram).mockResolvedValueOnce({ ok: true, data: { ok: false, reason: "spawn-failed", message: "Cursor could not be started." } });
    await act(() => hook.result.current.launch("cursor", { worktreeId: "wt" }));
    expect(api.launchExternalProgram).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({ tone: "error", text: expect.stringContaining("Could not start Cursor at C:/Tools/cursor/Cursor.exe"), actions: [{ kind: "managePrograms", label: "Manage programs" }] }),
    );
  });

  it("other refusals show main's redacted sentence", async () => {
    const { api, notify, hook } = setup({ programs: PROGRAMS });
    await waitFor(() => expect(hook.result.current.snapshot).not.toBeNull());
    vi.mocked(api.launchExternalProgram).mockResolvedValueOnce({ ok: true, data: { ok: false, reason: "folder-not-allowed", message: "That folder cannot be opened." } });
    await act(() => hook.result.current.launch("cursor", { worktreeId: "x" }));
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ tone: "error", text: "That folder cannot be opened." }));
  });
});

describe("resolveDefault / buildOpenInProgramItem", () => {
  const snap = (over: object) => ({ programs: [mockProgram({ id: "cursor", name: "Cursor" }), mockProgram({ id: "zed", name: "Zed", available: false, unavailableReason: "Not found at C:/z.exe" })], defaultId: "cursor", fallbackReason: null, ...over });

  it("resolves the default program, the tab, or nothing", () => {
    expect(resolveDefault(snap({}), true)).toEqual({ kind: "program", id: "cursor", name: "Cursor" });
    expect(resolveDefault(snap({ defaultId: GITHYDRA_TAB_ID }), true)).toEqual({ kind: "tab" });
    expect(resolveDefault(snap({ defaultId: null }), true)).toBeNull();
    expect(resolveDefault(null, true)).toBeNull();
    // Split button: no tab choice, so a tab default cannot run anything there.
    expect(resolveDefault(snap({ defaultId: GITHYDRA_TAB_ID }), false)).toBeNull();
    expect(resolveDefault(snap({ defaultId: "zed" }), true)).toEqual({ kind: "tab" });
  });

  it("omits the GitHydra tab row for the folder split button and keeps Manage programs last", () => {
    const item = buildOpenInProgramItem({ snapshot: snap({}), refresh: vi.fn(), openInTab: vi.fn(), openInProgram: vi.fn(), managePrograms: vi.fn() }, { label: "Open folder in editor", includeTab: false });
    const keys = item.accordion!.children.map((c) => c.key);
    expect(keys).toEqual(["cursor", "zed", "manage"]);
    expect(item.accordion!.children.find((c) => c.key === "zed")).toMatchObject({ disabled: true, reason: "Not found at C:/z.exe" });
  });
});
