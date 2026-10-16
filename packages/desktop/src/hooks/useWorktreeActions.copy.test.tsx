// SPDX-License-Identifier: GPL-3.0-or-later
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { WorktreeCopyResult } from "../../shared/ipcContract";
import { copyOutcomeNotice } from "../lib/worktreeNotices";
import { makeMockGitHydra, mockWorktreeEntry } from "../test/mockGitHydra";
import { createDirtyLeaveRegistry } from "./useDirtyLeaveGuard";
import { useWorktreeActions, type UseWorktreeActionsOptions } from "./useWorktreeActions";

/** specs/worktree-copy-ignored.md FR-643 "Result notices": persistent, in-flow, never mentions remembering. */

const copyResult = (over: Partial<WorktreeCopyResult> = {}): WorktreeCopyResult => ({
  status: "copied",
  copied: 3,
  total: 3,
  bytes: 4096,
  skipped: [],
  skippedTotal: 0,
  droppedFiles: 0,
  droppedReasons: [],
  from: "acme",
  ...over,
});

describe("copyOutcomeNotice", () => {
  it("copied: the exact success sentence", () => {
    expect(copyOutcomeNotice("feature-x", copyResult())).toMatchObject({
      tone: "success",
      text: 'Created worktree "feature-x". Copied 3 files (4 KB) from acme.',
    });
    expect(copyOutcomeNotice("f", copyResult({ copied: 1, total: 1, bytes: 10 })).text).toBe('Created worktree "f". Copied 1 file (10 B) from acme.');
  });

  it("partial: 'Copied 2 of 3 files. Not copied: config/local.json (already exists).'", () => {
    const n = copyOutcomeNotice(
      "feature-x",
      copyResult({ status: "partial", copied: 2, total: 3, skipped: [{ path: "config/local.json", reason: "already-exists", message: "already exists" }], skippedTotal: 1 }),
    );
    expect(n.tone).toBe("warning");
    expect(n.text).toBe('Created worktree "feature-x". Copied 2 of 3 files. Not copied: config/local.json (already exists).');
  });

  it("partial with many skipped names: three, then 'and N more'", () => {
    const skipped = ["a", "b", "c"].map((p) => ({ path: p, reason: "already-exists", message: "already exists" }));
    const n = copyOutcomeNotice("x", copyResult({ status: "partial", copied: 1, total: 6, skipped, skippedTotal: 5 }));
    expect(n.text).toContain("Not copied: a (already exists), b (already exists), c (already exists) and 2 more.");
  });

  it("nothing: 'but nothing was copied: <reason>.'", () => {
    const n = copyOutcomeNotice("feature-x", copyResult({ status: "refused", copied: 0, total: 0, bytes: 0, message: "the list of files expired" }));
    expect(n).toMatchObject({ tone: "warning", text: 'Created worktree "feature-x", but nothing was copied: the list of files expired.' });
    const all = copyOutcomeNotice("x", copyResult({ status: "nothing", copied: 0, total: 1, bytes: 0, skipped: [{ path: ".env", reason: "already-exists", message: "already exists" }], skippedTotal: 1 }));
    expect(all.text).toBe('Created worktree "x", but nothing was copied: .env (already exists).');
  });

  it("reports files that never reached the reviewed list (LOW-6)", () => {
    expect(copyOutcomeNotice("x", copyResult({ copied: 8, total: 8, bytes: 3072, droppedFiles: 2, droppedReasons: ["name not allowed"] })).text).toBe(
      'Created worktree "x". Copied 8 files (3 KB) from acme. 2 files not copied (name not allowed).',
    );
    const partial = copyOutcomeNotice(
      "x",
      copyResult({ status: "partial", copied: 1, total: 2, skipped: [{ path: "a", reason: "already-exists", message: "already exists" }], skippedTotal: 1, droppedFiles: 1, droppedReasons: ["symbolic link", "cannot be read"] }),
    );
    expect(partial.text).toBe('Created worktree "x". Copied 1 of 2 files. Not copied: a (already exists). 1 file not copied (symbolic link, cannot be read).');
    const only = copyOutcomeNotice("x", copyResult({ status: "nothing", copied: 0, total: 0, bytes: 0, droppedFiles: 3, droppedReasons: ["name not allowed"] }));
    expect(only.text).toBe('Created worktree "x", but nothing was copied: 3 files not copied (name not allowed).');
    expect(only.text).not.toMatch(/remember/i);
  });

  it("never mentions remembering and shows invisible characters in names", () => {
    const n = copyOutcomeNotice("x", copyResult({ status: "partial", copied: 1, total: 2, skipped: [{ path: "a‮b", reason: "r", message: "m" }], skippedTotal: 1 }));
    expect(n.text).not.toMatch(/remember/i);
    expect(n.text).toContain("a\\u{202e}b");
  });
});

describe("create with a copy (FR-643)", () => {
  function setup(add: unknown) {
    const api = makeMockGitHydra({ repoPath: "/w/repo" });
    vi.mocked(api.addWorktree).mockResolvedValue({ ok: true, data: add as never });
    const opts: UseWorktreeActionsOptions = {
      api,
      worktrees: {
        status: "ready",
        list: { entries: [mockWorktreeEntry({ id: null, isMain: true, path: "/w/repo", branch: "main" })], untrusted: false, untrustedReason: null, commonDir: "/w/repo/.git", mainPath: "/w/repo", format: "nul", mainPathIsGitDir: false },
        errorMessage: null,
        index: { byBranch: new Map(), byHead: new Map() },
        reload: vi.fn(),
      },
      tabs: [],
      activeTabId: null,
      openInNewTab: vi.fn(async () => "opened" as const),
      focusTab: vi.fn(),
      closeTab: vi.fn(),
      activateTab: vi.fn(async () => true),
      isSwitching: () => false,
      getActiveTabId: () => null,
      dirtyGuard: createDirtyLeaveRegistry(),
      beginMutation: vi.fn(),
      refreshRefs: vi.fn(async () => undefined),
      refreshRefsAndRowsInBackground: vi.fn(async () => undefined),
      onBranchesChanged: vi.fn(),
      onOpenBranches: vi.fn(),
      currentBranchLabel: "main",
    };
    return { api, hook: renderHook(() => useWorktreeActions(opts)) };
  }
  const created = { ok: true, path: "/w/repo.worktrees/x", entry: null, branch: "feature-x", head: "h".repeat(40), createdBranch: false, warning: null };

  it("forwards the token and row ids, and pushes the persistent copied banner", async () => {
    const { api, hook } = setup({ ...created, copy: copyResult() });
    await act(async () => {
      await hook.result.current.submitCreate({ destination: "/d", source: { kind: "branch", branch: "feature-x" }, openAfter: false, copy: { token: "t", rowIds: [".env"] } });
    });
    expect(vi.mocked(api.addWorktree).mock.calls[0]![0]).toEqual({ destination: "/d", source: { kind: "branch", branch: "feature-x" }, copy: { token: "t", rowIds: [".env"] } });
    expect(hook.result.current.notices).toHaveLength(1);
    expect(hook.result.current.notices[0]).toMatchObject({ tone: "success", text: 'Created worktree "feature-x". Copied 3 files (4 KB) from acme.', actions: [] });
  });

  it("a copy that failed after a successful add still reports the add as created (and returns success so the memory saves)", async () => {
    const { hook } = setup({ ...created, copy: copyResult({ status: "refused", copied: 0, total: 0, bytes: 0, message: "the files could not be copied" }) });
    let failure: unknown = "unset";
    await act(async () => {
      failure = await hook.result.current.submitCreate({ destination: "/d", source: { kind: "branch", branch: "feature-x" }, openAfter: false, copy: { token: "t", rowIds: [".env"] } });
    });
    expect(failure).toBeNull();
    expect(hook.result.current.notices[0]).toMatchObject({ tone: "warning", text: 'Created worktree "feature-x", but nothing was copied: the files could not be copied.' });
  });

  it("a created-but-warned worktree keeps its own sentence and carries the copy news as a line", async () => {
    const { hook } = setup({ ...created, warning: { reason: "createdButFailed" }, copy: copyResult({ status: "refused", copied: 0, total: 0, bytes: 0, message: "git reported a problem while creating the worktree" }) });
    await act(async () => {
      await hook.result.current.submitCreate({ destination: "/d", source: { kind: "branch", branch: "feature-x" }, openAfter: false, copy: { token: "t", rowIds: [".env"] } });
    });
    const n = hook.result.current.notices[0]!;
    expect(n.text).toContain("but git reported a problem after creating it");
    expect(n.lines?.[0]?.text).toBe("Nothing was copied: git reported a problem while creating the worktree.");
  });

  it("no copy requested: the plain banner", async () => {
    const { hook } = setup(created);
    await act(async () => {
      await hook.result.current.submitCreate({ destination: "/d", source: { kind: "branch", branch: "feature-x" }, openAfter: false });
    });
    expect(hook.result.current.notices[0]).toMatchObject({ tone: "success", text: 'Created worktree "feature-x".' });
  });
});
