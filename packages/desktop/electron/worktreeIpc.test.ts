// SPDX-License-Identifier: GPL-3.0-or-later
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWorktreeHandlers, pickWorktreeSource, type WorktreeRepo } from "./worktreeIpc";

function fakeRepo(overrides: Partial<WorktreeRepo> = {}): WorktreeRepo {
  return {
    listWorktrees: vi.fn(async () => ({
      entries: [],
      untrusted: false,
      untrustedReason: null,
      commonDir: "/r/.git",
      mainPath: path.join(os.tmpdir(), "no-such-parent-xyz", "repo"),
      format: "nul" as const,
      mainPathIsGitDir: false,
    })),
    validateWorktreeDestination: vi.fn(async (d: string) => ({ ok: true as const, path: d, realPath: d })),
    detectPostCheckoutHook: vi.fn(async () => ({ present: false as const })),
    addWorktree: vi.fn(async () => ({ ok: true as const, path: "/x", entry: null, branch: "b", head: "h", createdBranch: false, warning: null })),
    verifyRegisteredWorktree: vi.fn(async (id: string) => ({ trusted: true as const, id, path: "/x", realPath: "/x" })),
    getWorktreeRemovalState: vi.fn(async () => ({ ok: true as const, count: 0, submodules: [], dirtySubmodules: [] })),
    getBranchMergeState: vi.fn(async () => ({ exists: true, merged: true, unmergedCommits: 0, reference: "HEAD" as const })),
    removeWorktree: vi.fn(async () => ({ ok: true as const, id: "i", path: "/x", branch: null, linksUnlinked: 0 })),
    removeWorktreeAndDeleteBranch: vi.fn(async () => ({
      ok: true as const,
      removed: { ok: true as const, id: "i", path: "/x", branch: null, linksUnlinked: 0 },
      branch: { status: "none" as const },
      outcomeDiffersFromPreview: false,
    })),
    pruneWorktree: vi.fn(async (id: string) => ({ ok: true as const, id, forgotten: [], alsoForgot: [] })),
    ...overrides,
  };
}

describe("worktree IPC handlers (specs/worktrees.md)", () => {
  it("rebuilds the add source field by field and never passes an options argument (no hook can run, FR-638/FR-644)", async () => {
    const repo = fakeRepo();
    const h = createWorktreeHandlers(() => repo);
    await h.add({
      destination: "/d",
      source: { kind: "branch", branch: "feature", runPostCheckoutHook: true, expectedHookFingerprint: "x" },
      runPostCheckoutHook: true,
    });
    expect(repo.addWorktree).toHaveBeenCalledTimes(1);
    expect(vi.mocked(repo.addWorktree).mock.calls[0]).toEqual(["/d", { kind: "branch", branch: "feature" }]);
  });

  it("refuses a malformed source, a non-string destination and an unknown kind before git-core is reached", async () => {
    const repo = fakeRepo();
    const h = createWorktreeHandlers(() => repo);
    expect(() => pickWorktreeSource({ kind: "shell", branch: "x" })).toThrow();
    expect(() => pickWorktreeSource({ kind: "branch", branch: 3 })).toThrow();
    expect(() => pickWorktreeSource({ kind: "newBranch", branch: "a" })).toThrow();
    await expect(h.add({ destination: 5, source: { kind: "branch", branch: "a" } })).rejects.toThrow();
    await expect(h.add({ destination: "a\0b", source: { kind: "branch", branch: "a" } })).rejects.toThrow();
    expect(repo.addWorktree).not.toHaveBeenCalled();
  });

  it("detects the hook but reveals only whether one exists", async () => {
    const repo = fakeRepo({
      detectPostCheckoutHook: vi.fn(async () => ({
        present: true as const,
        hookPath: "/secret/hook",
        hooksDir: "/secret",
        hooksPathConfig: null,
        hooksPathRelative: false,
        contentSha256: "a",
        size: 1,
        executable: true,
        otherHooks: [],
        fingerprint: "f",
        preview: "rm -rf /",
        previewTruncated: false,
        previewLineCount: 1,
        previewIsBinary: false,
      })),
    });
    expect(await createWorktreeHandlers(() => repo).hook()).toEqual({ present: true });
  });

  it("removal forwards the id and the confirmed path; force only for an explicit true", async () => {
    const repo = fakeRepo();
    const h = createWorktreeHandlers(() => repo);
    await h.remove({ id: "wt", confirmedPath: "/p", force: "yes" });
    await h.remove({ id: "wt", confirmedPath: "/p", force: true });
    expect(vi.mocked(repo.removeWorktree).mock.calls).toEqual([
      ["wt", { confirmedPath: "/p", force: false }],
      ["wt", { confirmedPath: "/p", force: true }],
    ]);
    await expect(h.remove({ id: "wt" })).rejects.toThrow();
    await expect(h.remove({ confirmedPath: "/p" })).rejects.toThrow();
  });

  it("remove-and-delete-branch passes expectedMerged only when it is a boolean", async () => {
    const repo = fakeRepo();
    const h = createWorktreeHandlers(() => repo);
    await h.removeAndDeleteBranch({ id: "wt", confirmedPath: "/p", expectedMerged: false });
    await h.removeAndDeleteBranch({ id: "wt", confirmedPath: "/p", expectedMerged: "no" });
    expect(vi.mocked(repo.removeWorktreeAndDeleteBranch).mock.calls).toEqual([
      ["wt", { confirmedPath: "/p", force: false, expectedMerged: false }],
      ["wt", { confirmedPath: "/p", force: false }],
    ]);
  });

  it("prune accepts only a bounded list of string ids", async () => {
    const repo = fakeRepo();
    const h = createWorktreeHandlers(() => repo);
    await h.prune("wt", ["a", "b"]);
    expect(vi.mocked(repo.pruneWorktree).mock.calls[0]).toEqual(["wt", { acceptAlsoForgotten: ["a", "b"] }]);
    await expect(h.prune("wt", "a")).rejects.toThrow();
    await expect(h.prune("wt", [1])).rejects.toThrow();
    await expect(h.prune("wt", new Array(201).fill("a"))).rejects.toThrow();
  });

  describe("setup hints (FR-632/FR-633)", () => {
    let dir: string;
    beforeEach(async () => {
      dir = await fs.mkdtemp(path.join(os.tmpdir(), "gh-wt-hints-"));
    });
    afterEach(async () => {
      await fs.rm(dir, { recursive: true, force: true });
    });

    it("reports a dependency manifest and .gitmodules from fixed names in a verified worktree", async () => {
      await fs.writeFile(path.join(dir, "package.json"), "{}");
      await fs.writeFile(path.join(dir, "package-lock.json"), "{}");
      await fs.writeFile(path.join(dir, ".gitmodules"), "");
      const repo = fakeRepo({ verifyRegisteredWorktree: vi.fn(async (id: string) => ({ trusted: true as const, id, path: dir, realPath: dir })) });
      expect(await createWorktreeHandlers(() => repo).setupHints("wt")).toEqual({
        dependency: { kind: "npm", manifest: "package.json" },
        hasSubmodules: true,
      });
    });

    it("looks at nothing for an untrusted worktree", async () => {
      await fs.writeFile(path.join(dir, "go.mod"), "");
      const repo = fakeRepo({ verifyRegisteredWorktree: vi.fn(async () => ({ trusted: false as const, reason: "backlink-mismatch" as const })) });
      expect(await createWorktreeHandlers(() => repo).setupHints("wt")).toEqual({ dependency: null, hasSubmodules: false });
    });

    it("never follows a symlink planted as a manifest", async () => {
      const target = path.join(dir, "real.txt");
      await fs.writeFile(target, "x");
      try {
        await fs.symlink(target, path.join(dir, "Cargo.toml"));
      } catch {
        return; // symlinks need privileges on some Windows setups; the lstat rule is the same code path
      }
      const repo = fakeRepo({ verifyRegisteredWorktree: vi.fn(async (id: string) => ({ trusted: true as const, id, path: dir, realPath: dir })) });
      expect((await createWorktreeHandlers(() => repo).setupHints("wt")).dependency).toBeNull();
    });
  });

  it("the default folder is derived from the main worktree and skips names that already exist", async () => {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), "gh-wt-default-"));
    try {
      const main = path.join(parent, "acme");
      await fs.mkdir(path.join(parent, "acme.worktrees", "feature-x"), { recursive: true });
      const repo = fakeRepo({
        listWorktrees: vi.fn(async () => ({
          entries: [],
          untrusted: false,
          untrustedReason: null,
          commonDir: path.join(main, ".git"),
          mainPath: main,
          format: "nul" as const,
          mainPathIsGitDir: false,
        })),
      });
      const h = createWorktreeHandlers(() => repo);
      expect(await h.defaultPath("feature/x")).toBe(path.join(parent, "acme.worktrees", "feature-x-2"));
      expect(await h.defaultPath("other")).toBe(path.join(parent, "acme.worktrees", "other"));
    } finally {
      await fs.rm(parent, { recursive: true, force: true });
    }
  });
});
