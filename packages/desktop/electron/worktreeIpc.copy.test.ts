// SPDX-License-Identifier: GPL-3.0-or-later
import type { CopyManifest, CopyOutcome } from "@githydra/git-core";
import { describe, expect, it, vi } from "vitest";
import { computeRepoKey } from "./recoveryDrafts";
import { createCopyTokenStore } from "./worktreeCopyTokens";
import { createWorktreeHandlers, pickCopyRequest, type WorktreeRepo } from "./worktreeIpc";

/** specs/worktree-copy-ignored.md FR-629, FR-643, AC 10: the main-process half of the copy. */

const manifestOf = (rowIds: string[], token = "tok"): CopyManifest => ({
  version: 1,
  createdAt: 0,
  sourceWorktreeId: null,
  sourceRoot: "/r",
  repoKey: null,
  token,
  rows: rowIds.map((id) => ({ id, path: id, isDirectory: id.endsWith("/"), fileIndexes: [], fileCount: 1, bytes: 10, disabledReason: null })),
  files: [{ path: "SECRET-FILE-LIST-SENTINEL", rowId: rowIds[0] ?? "", size: "1", mtimeNs: "1", dev: "1", ino: "1" }],
});

const done = (copied: number, skipped: { path: string; reason: string; message: string }[] = [], bytes = 0): CopyOutcome =>
  ({
    status: "done",
    results: skipped.map((s) => ({ ...s, rowId: s.path, outcome: "skipped" })),
    totals: { copied, skipped: skipped.length, bytes },
  }) as unknown as CopyOutcome;

function setup(opts: { manifest?: CopyManifest; outcome?: CopyOutcome | (() => Promise<CopyOutcome>); add?: WorktreeRepo["addWorktree"]; realpath?: (p: string) => Promise<string>; clock?: { t: number } } = {}) {
  const manifest = opts.manifest ?? manifestOf([".env", ".vscode/", "config/local.json"]);
  const clock = opts.clock ?? { t: 0 };
  const calls: string[] = [];
  const repo = {
    path: "/r",
    listWorktrees: vi.fn(async () => ({ commonDir: "/r/.git", mainPath: "/r", entries: [] })),
    validateWorktreeDestination: vi.fn(async (d: string) => ({ ok: true as const, path: d, realPath: d })),
    detectPostCheckoutHook: vi.fn(async () => ({ present: false as const })),
    addWorktree:
      opts.add ??
      vi.fn(async (d: string) => {
        calls.push("add");
        return { ok: true as const, path: d, entry: null, branch: "feature-x", head: "h", createdBranch: false, warning: null };
      }),
    buildCopyManifest: vi.fn(async () => ({ status: "ok" as const, manifest })),
    readWorktreeInclude: vi.fn(async () => ({ status: "absent" as const })),
    copyFromManifest: vi.fn(async () => {
      calls.push("copy");
      return typeof opts.outcome === "function" ? opts.outcome() : (opts.outcome ?? done(1, [], 5));
    }),
  } as unknown as WorktreeRepo;
  const tokens = createCopyTokenStore({ now: () => clock.t, platform: "linux" });
  const h = createWorktreeHandlers(() => repo, { copyTokens: tokens, realpath: async (p) => p, destinationRealpath: opts.realpath ?? (async (p) => p), platform: "linux" });
  return { repo, h, tokens, calls, clock };
}

const addReq = (copy: unknown, destination = "/w/x") => ({ destination, source: { kind: "branch", branch: "feature-x" }, copy });

describe("copy candidates (FR-626, FR-643)", () => {
  it("returns tagged rows and an opaque token, and never the manifest itself", async () => {
    const { h, repo } = setup();
    const out = await h.copyCandidates();
    expect(out.status).toBe("ok");
    if (out.status !== "ok") return;
    expect(out.token).toBe("tok");
    const env = out.rows.find((r) => r.id === ".env")!;
    expect(env).toMatchObject({ secret: true, runsCode: false });
    expect(out.rows.find((r) => r.id === ".vscode/")).toMatchObject({ runsCode: true });
    const wire = JSON.stringify(out);
    expect(wire).not.toContain("SECRET-FILE-LIST-SENTINEL");
    expect(wire).not.toContain("sourceRoot");
    expect(wire).not.toContain("mtimeNs");
    // The source is main's own session repo; no argument exists to change it.
    expect(vi.mocked(repo.buildCopyManifest).mock.calls[0]![0]).toBe("/r");
    expect(h.copyCandidates.length).toBe(0);
  });

  it("returns the include match and the rejected patterns as data", async () => {
    const { h, repo } = setup();
    vi.mocked(repo.readWorktreeInclude).mockResolvedValue({
      status: "ok",
      matchedFiles: [".env"],
      matchedRows: [".env"],
      skipped: [{ line: 3, pattern: "../x", reason: "parent-directory-segment" }],
    });
    const out = await h.copyCandidates();
    expect(out).toMatchObject({ include: { status: "ok", matchedRows: [".env"], skipped: [{ line: 3, pattern: "../x", reason: "parent-directory-segment" }] } });
  });

  it("a listing failure is typed data; zero rows hands out no token", async () => {
    const failing = setup();
    vi.mocked(failing.repo.buildCopyManifest).mockResolvedValue({ status: "failed", reason: "timeout" });
    expect(await failing.h.copyCandidates()).toEqual({ status: "failed", reason: "timeout" });
    const empty = setup({ manifest: manifestOf([]) });
    expect(await empty.h.copyCandidates()).toMatchObject({ status: "ok", token: "", rows: [] });
  });

  it("the key IPC takes NO argument and is the sha256 of the common dir's realpath (FR-629)", async () => {
    const { h } = setup();
    expect(h.repoKey.length).toBe(0);
    expect(await h.repoKey()).toBe(computeRepoKey("/r/.git", "linux"));
  });
});

describe("strict copy payload (FR-643)", () => {
  it("accepts exactly {token, rowIds}", () => {
    expect(pickCopyRequest(undefined)).toBeNull();
    expect(pickCopyRequest({ token: "t", rowIds: ["a"] })).toEqual({ token: "t", rowIds: ["a"] });
  });

  it("refuses extra keys, a path, a manifest, bad shapes and the caps", () => {
    for (const bad of [
      null,
      "x",
      [],
      { token: "t" },
      { rowIds: [] },
      { token: "", rowIds: [] },
      { token: "t", rowIds: "a" },
      { token: "t", rowIds: [1] },
      { token: "t", rowIds: [""] },
      { token: "t", rowIds: ["a"], path: "/etc" },
      { token: "t", rowIds: ["a"], manifest: {} },
      { token: "t", rowIds: ["a"], runPostCheckoutHook: true },
      { token: "t", rowIds: new Array(2001).fill("a") },
      { token: "t", rowIds: ["x".repeat(1025)] },
      { token: "x".repeat(257), rowIds: [] },
    ]) {
      expect(() => pickCopyRequest(bad), JSON.stringify(bad).slice(0, 60)).toThrow();
    }
    expect(pickCopyRequest({ token: "t", rowIds: new Array(2000).fill("a") })?.rowIds).toHaveLength(2000);
    expect(pickCopyRequest({ token: "t", rowIds: ["x".repeat(1024)] })).not.toBeNull();
  });

  it("add refuses a renderer-supplied manifest, path or hook option before anything runs", async () => {
    const { h, repo } = setup();
    await h.copyCandidates();
    for (const extra of [{ manifest: {} }, { sourcePath: "/etc" }, { paths: ["/etc/passwd"] }, { runPostCheckoutHook: true }, { copy: { token: "tok", rowIds: ["a"], path: "/x" } }]) {
      await expect(h.add({ ...addReq({ token: "tok", rowIds: [".env"] }), ...extra })).rejects.toThrow();
    }
    expect(repo.addWorktree).not.toHaveBeenCalled();
    expect(repo.copyFromManifest).not.toHaveBeenCalled();
  });
});

describe("create with copy (FR-643, AC 10)", () => {
  it("copies only AFTER a successful add, only manifest rows, and reports totals", async () => {
    const { h, repo, calls } = setup({ outcome: done(2, [{ path: "config/local.json", reason: "already-exists", message: "already exists" }], 4096) });
    await h.copyCandidates();
    const out = await h.add(addReq({ token: "tok", rowIds: [".env", ".vscode/", "not-listed"] }));
    expect(calls).toEqual(["add", "copy"]);
    const args = vi.mocked(repo.copyFromManifest).mock.calls[0]!;
    expect(args[1]).toEqual([".env", ".vscode/"]);
    expect(args[2]).toBe("/w/x");
    expect(out).toMatchObject({
      ok: true,
      copy: { status: "partial", copied: 2, bytes: 4096, from: "r", skippedTotal: 2 },
    });
    expect((out as { copy: { skipped: unknown[] } }).copy.skipped).toEqual([
      { path: "config/local.json", reason: "already-exists", message: "already exists" },
      { path: "not-listed", reason: "not-in-manifest", message: "not in the reviewed list" },
    ]);
  });

  it("a failed add copies nothing and leaves the token usable for a retry", async () => {
    const add = vi.fn(async () => ({ ok: false as const, reason: "branchExists" as const, message: "m" }));
    const { h, repo } = setup({ add });
    await h.copyCandidates();
    const first = await h.add(addReq({ token: "tok", rowIds: [".env"] }));
    expect(first).toMatchObject({ ok: false });
    expect(repo.copyFromManifest).not.toHaveBeenCalled();
    add.mockResolvedValueOnce({ ok: true, path: "/w/y", entry: null, branch: "b", head: "h", createdBranch: false, warning: null } as never);
    const second = await h.add(addReq({ token: "tok", rowIds: [".env", ".vscode/"] }, "/w/y"));
    expect(second).toMatchObject({ ok: true, copy: { status: "copied" } });
  });

  it("a copy that throws or is refused still returns the add as ok, with fixed text only", async () => {
    const boom = setup({ outcome: async () => { throw new Error("EPERM C:\\secret\\path leaked"); } });
    await boom.h.copyCandidates();
    const out = await boom.h.add(addReq({ token: "tok", rowIds: [".env"] }));
    expect(out).toMatchObject({ ok: true, copy: { status: "refused", message: "the files could not be copied" } });
    expect(JSON.stringify(out)).not.toContain("leaked");

    const refused = setup({ outcome: { status: "refused", reason: "destination-invalid", results: [], totals: { copied: 0, skipped: 0, bytes: 0 } } as CopyOutcome });
    await refused.h.copyCandidates();
    expect(await refused.h.add(addReq({ token: "tok", rowIds: [".env"] }))).toMatchObject({ ok: true, copy: { status: "refused" } });
  });

  it("is single-use: a second create with the same token copies nothing", async () => {
    const { h, repo } = setup();
    await h.copyCandidates();
    await h.add(addReq({ token: "tok", rowIds: [".env"] }));
    const again = await h.add(addReq({ token: "tok", rowIds: [".env"] }, "/w/z"));
    expect(again).toMatchObject({ ok: true, copy: { status: "refused", message: "the list of files was not available any more" } });
    expect(repo.copyFromManifest).toHaveBeenCalledTimes(1);
  });

  it("an expired token (fake clock) is refused, the worktree is still created", async () => {
    const { h, repo, clock } = setup();
    await h.copyCandidates();
    clock.t += 10 * 60 * 1000 + 1;
    const out = await h.add(addReq({ token: "tok", rowIds: [".env"] }));
    expect(out).toMatchObject({ ok: true, copy: { status: "refused", message: "the list of files expired" } });
    expect(repo.addWorktree).toHaveBeenCalledTimes(1);
    expect(repo.copyFromManifest).not.toHaveBeenCalled();
  });

  it("refuses a token for another repository (the open repo changed since the listing)", async () => {
    const { h, repo } = setup();
    await h.copyCandidates();
    vi.mocked(repo.listWorktrees).mockResolvedValue({ commonDir: "/other/.git", mainPath: "/other", entries: [] } as never);
    const out = await h.add(addReq({ token: "tok", rowIds: [".env"] }));
    expect(out).toMatchObject({ ok: true, copy: { status: "refused", message: "the list of files belongs to another repository" } });
    expect(repo.copyFromManifest).not.toHaveBeenCalled();
  });

  it("refuses when the new worktree resolves somewhere other than the validated destination", async () => {
    const { h, repo } = setup({ realpath: async () => "/elsewhere" });
    await h.copyCandidates();
    const out = await h.add(addReq({ token: "tok", rowIds: [".env"] }));
    expect(out).toMatchObject({ ok: true, copy: { status: "refused", message: "the folder changed after you reviewed" } });
    expect(repo.copyFromManifest).not.toHaveBeenCalled();
  });

  it("a second attempt with a different selection while bound invalidates the token", async () => {
    const { h, tokens, repo } = setup();
    await h.copyCandidates();
    const bound = tokens.bind("tok", { repoKey: computeRepoKey("/r/.git", "linux"), sourceRoot: "/r" }, "/w/x", [".env"]);
    expect(bound.ok).toBe(true);
    const out = await h.add(addReq({ token: "tok", rowIds: [".env", ".vscode/"] }));
    expect(out).toMatchObject({ ok: true, copy: { status: "refused" } });
    expect(repo.copyFromManifest).not.toHaveBeenCalled();
  });

  it("an empty selection is a plain create and does not touch the token", async () => {
    const { h, repo } = setup();
    await h.copyCandidates();
    const out = await h.add(addReq({ token: "tok", rowIds: [] }));
    expect(out).toMatchObject({ ok: true });
    expect(out).not.toHaveProperty("copy");
    expect(repo.copyFromManifest).not.toHaveBeenCalled();
    expect(await h.add(addReq({ token: "tok", rowIds: [".env"] }, "/w/q"))).toMatchObject({ copy: { status: "copied" } });
  });

  it("release drops the token", async () => {
    const { h } = setup();
    await h.copyCandidates();
    h.copyRelease();
    expect(await h.add(addReq({ token: "tok", rowIds: [".env"] }))).toMatchObject({ copy: { status: "refused" } });
  });

  it("a created-but-warned worktree is not copied into", async () => {
    const add = vi.fn(async (d: string) => ({ ok: true as const, path: d, entry: null, branch: "b", head: "h", createdBranch: false, warning: { reason: "createdButFailed" as const } }));
    const { h, repo } = setup({ add });
    await h.copyCandidates();
    expect(await h.add(addReq({ token: "tok", rowIds: [".env"] }))).toMatchObject({ ok: true, copy: { status: "refused" } });
    expect(repo.copyFromManifest).not.toHaveBeenCalled();
  });
});
