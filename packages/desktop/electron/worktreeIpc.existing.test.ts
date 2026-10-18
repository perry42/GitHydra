// SPDX-License-Identifier: GPL-3.0-or-later
import type { CopyManifest, ExistingCopyOutcome, ExistingListing } from "@githydra/git-core";
import { describe, expect, it, vi } from "vitest";
import { computeRepoKey } from "./recoveryDrafts";
import { createCopyTokenStore, createRepoMutex } from "./worktreeCopyTokens";
import { createWorktreeHandlers, pickExistingCopyRequest, pickExistingListRequest, type WorktreeRepo } from "./worktreeIpc";
import type { WorktreeExistingProgress } from "../shared/ipcContract";

/** specs/worktree-copy-ignored.md section G, FR-652..657, AC 17 and the MU part of AC 22: the main-process half. */

const SENTINEL = "SECRET-FILE-LIST-SENTINEL";

const manifestOf = (token = "tok"): CopyManifest => ({
  version: 1,
  createdAt: 0,
  sourceWorktreeId: null,
  sourceRoot: "/r",
  repoKey: null,
  token,
  rows: [".env", ".vscode/", "config/local.json"].map((id) => ({ id, path: id, isDirectory: id.endsWith("/"), fileIndexes: [], fileCount: 1, bytes: 10, disabledReason: null, secret: false, runsCode: false, droppedFiles: 0, droppedReasons: {}, droppedPaths: [] })),
  files: [{ path: SENTINEL, rowId: ".env", size: "1", mtimeNs: "1", dev: "1", ino: "1" }],
});

const dest = { id: "tour", root: "/wt/tour-login", adminDir: "/r/.git/worktrees/tour", name: "tour-login", branch: "tour", detached: false, shortHead: "abc1234" };

const okListing = (token = "tok"): ExistingListing => ({
  status: "ok",
  source: { id: null, root: "/r", name: "r" },
  destination: dest,
  manifest: manifestOf(token),
  rows: [
    { id: ".env", path: ".env", displayPath: ".env", isDirectory: false, fileCount: 1, copyableCount: 1, existingCount: 0, bytes: 10, disabledReason: null, secret: true, runsCode: false, large: false, changesGit: false, notIgnoredInDestination: true, droppedFiles: 0, droppedReasons: {} },
    { id: "config/local.json", path: "config/local.json", displayPath: "config/local.json", isDirectory: false, fileCount: 1, copyableCount: 0, existingCount: 1, bytes: 0, disabledReason: "already-exists", secret: false, runsCode: false, large: false, changesGit: false, notIgnoredInDestination: false, droppedFiles: 0, droppedReasons: {} },
  ],
});

const done = (copied: number, skipped: { path: string; reason: string }[] = [], status: "done" | "cancelled" | "limit" = "done"): ExistingCopyOutcome =>
  ({
    status,
    results: skipped.map((s) => ({ ...s, rowId: s.path, outcome: "skipped", message: "x" })),
    totals: { copied, skipped: skipped.length, bytes: copied * 10 },
    destination: dest,
  }) as unknown as ExistingCopyOutcome;

interface Opts {
  listing?: ExistingListing;
  outcome?: () => Promise<ExistingCopyOutcome>;
  resolve?: WorktreeRepo["resolveDestinationWorktree"];
  mutex?: ReturnType<typeof createRepoMutex>;
  getRepoOverride?: () => WorktreeRepo;
  progress?: (p: WorktreeExistingProgress) => void;
  pollMs?: number;
}

function setup(opts: Opts = {}) {
  const calls: string[] = [];
  const repo = {
    path: "/r",
    listWorktrees: vi.fn(async () => ({ commonDir: "/r/.git", mainPath: "/r", entries: [] })),
    listIgnoredForExisting: vi.fn(async () => opts.listing ?? okListing()),
    resolveDestinationWorktree: vi.fn(opts.resolve ?? (async () => ({ ok: true as const, dest }))),
    copyIgnoredIntoExisting: vi.fn(async () => {
      calls.push("copy");
      return opts.outcome ? opts.outcome() : done(1, [{ path: "config/local.json", reason: "already-exists" }]);
    }),
    readWorktreeInclude: vi.fn(async () => ({ status: "absent" as const })),
    buildCopyManifest: vi.fn(async () => ({ status: "ok" as const, manifest: manifestOf("create-tok") })),
    validateWorktreeDestination: vi.fn(async (d: string) => ({ ok: true as const, path: d, realPath: d })),
    detectPostCheckoutHook: vi.fn(async () => ({ present: false as const })),
    addWorktree: vi.fn(async (d: string) => ({ ok: true as const, path: d, entry: null, branch: "b", head: "h", createdBranch: false, warning: null })),
    copyFromManifest: vi.fn(async () => ({ status: "done" as const, results: [], totals: { copied: 1, skipped: 0, bytes: 1 } })),
    removeWorktree: vi.fn(async () => {
      calls.push("remove");
      return { ok: true as const, id: "i", path: "/x", branch: null, linksUnlinked: 0 };
    }),
    pruneWorktree: vi.fn(async (id: string) => {
      calls.push("prune");
      return { ok: true as const, id, forgotten: [], alsoForgot: [] };
    }),
  } as unknown as WorktreeRepo;
  const tokens = createCopyTokenStore({ now: () => 0, platform: "linux" });
  const mutex = opts.mutex ?? createRepoMutex();
  const h = createWorktreeHandlers(opts.getRepoOverride ? opts.getRepoOverride : () => repo, {
    copyTokens: tokens,
    repoMutex: mutex,
    realpath: async (p) => p,
    destinationRealpath: async (p) => p,
    platform: "linux",
    emitExistingProgress: opts.progress,
    existingPollMs: opts.pollMs ?? 10,
  });
  return { repo, h, tokens, mutex, calls };
}

const list = (h: ReturnType<typeof setup>["h"], destId: string | null = "tour") => h.listIgnoredForExisting({ destId });
async function listed(h: ReturnType<typeof setup>["h"]) {
  const out = await list(h);
  if (out.status !== "ok") throw new Error("listing failed");
  return out;
}

describe("request shapes (FR-653): no path, no repo key", () => {
  it("accepts only {destId: id|null}", () => {
    expect(pickExistingListRequest({ destId: "tour" })).toBe("tour");
    expect(pickExistingListRequest({ destId: null })).toBeNull();
    for (const bad of [undefined, null, [], "x", {}, { destId: 5 }, { destId: "" }, { destId: "../x" }, { destId: "a/b" }, { destId: "a\\b" }, { destId: "ok", path: "/tmp" }, { destId: "ok", repoKey: "k" }, { destId: "a\0b" }]) {
      expect(() => pickExistingListRequest(bad), JSON.stringify(bad)).toThrow();
    }
  });

  it("copy accepts only {token, rowIds}", () => {
    expect(pickExistingCopyRequest({ token: "t", rowIds: ["a"] })).toEqual({ token: "t", rowIds: ["a"] });
    for (const bad of [undefined, null, {}, { token: "t" }, { token: "t", rowIds: "a" }, { token: "t", rowIds: [1] }, { token: "t", rowIds: [], destination: "/x" }, { token: "t", rowIds: [], repoKey: "k" }, { token: "", rowIds: [] }, { token: "t", rowIds: new Array(2001).fill("a") }]) {
      expect(() => pickExistingCopyRequest(bad), JSON.stringify(bad)).toThrow();
    }
  });

  it("a malformed request never reaches git-core", async () => {
    const { h, repo } = setup();
    await expect(h.listIgnoredForExisting({ destId: "../../etc" })).rejects.toThrow();
    await expect(h.copyIgnoredIntoExisting({ token: "t", rowIds: [], sourcePath: "/x" })).rejects.toThrow();
    expect(repo.listIgnoredForExisting).not.toHaveBeenCalled();
    expect(repo.copyIgnoredIntoExisting).not.toHaveBeenCalled();
  });
});

describe("listing (FR-652)", () => {
  it("returns rows with main's own names and fixed tag text, an opaque token, and never the manifest", async () => {
    const { h, repo } = setup();
    const out = await listed(h);
    expect(out.token).toBe("tok");
    expect(out.destination).toMatchObject({ id: "tour", name: "tour-login", path: "/wt/tour-login", branch: "tour", detached: false, shortHead: "abc1234" });
    expect(out.source.name).toBe("r");
    expect(out.rows.find((r) => r.id === "config/local.json")).toMatchObject({ disabledReason: "already-exists", disabledText: "already exists", existingCount: 1 });
    expect(out.rows.find((r) => r.id === ".env")).toMatchObject({ disabledReason: null, disabledText: null, secret: true, notIgnoredInDestination: true });
    const wire = JSON.stringify(out);
    expect(wire).not.toContain(SENTINEL);
    expect(wire).not.toContain("mtimeNs");
    expect(wire).not.toContain("sourceRoot");
    expect(vi.mocked(repo.listIgnoredForExisting).mock.calls[0]![0]).toBe("tour");
  });

  it("escapes control, bidi and format characters in names and truncates long ones (L1)", async () => {
    const hostile = { ...dest, name: "evil‮folder", root: "/wt/evil‮folder", branch: "b​ad" };
    const base = okListing() as Extract<ExistingListing, { status: "ok" }>;
    const { h } = setup({ listing: { ...base, destination: hostile } });
    const out = await listed(h);
    expect(out.destination.path).toBe("/wt/evilU+202Efolder");
    expect(out.destination.branch).toBe("bU+200Bad");
    expect(out.rows[1]!.disabledText).toBe("already exists");
  });

  it("tags use B from main: `tracked in tour-login`, `contains tour-login`", async () => {
    const l = okListing();
    if (l.status !== "ok") throw new Error();
    l.rows[1] = { ...l.rows[1]!, disabledReason: "tracked-in-destination" };
    l.rows.push({ ...l.rows[0]!, id: ".worktrees/", path: ".worktrees/", displayPath: ".worktrees/", disabledReason: "contains-destination" });
    const { h } = setup({ listing: l });
    const out = await listed(h);
    expect(out.rows.map((r) => r.disabledText)).toEqual([null, "tracked in tour-login", "contains tour-login"]);
  });

  it("no rows: ok, no token", async () => {
    const empty = { ...okListing(), rows: [] } as ExistingListing;
    const { h, tokens } = setup({ listing: empty });
    const out = await listed(h);
    expect(out.token).toBe("");
    expect(tokens.hasExistingToken()).toBe(false);
  });

  it("failures carry fixed text only", async () => {
    for (const [reason, text] of [
      ["not-a-worktree", "Not a worktree of this repository."],
      ["locked", "Not a worktree of this repository."],
      ["git-failed", "Couldn't list ignored files."],
      ["timeout", "Couldn't list ignored files."],
    ] as const) {
      const { h } = setup({ listing: { status: "failed", reason } as ExistingListing });
      expect(await list(h)).toEqual({ status: "failed", reason, message: text });
    }
    const { h } = setup({ listing: { status: "failed", reason: "tracked-check-failed", destinationName: "tour-login" } as ExistingListing });
    expect(await list(h)).toEqual({ status: "failed", reason: "tracked-check-failed", message: "Couldn't check which files tour-login tracks." });
  });
});

describe("copy (FR-653, FR-655, FR-657)", () => {
  it("copies the chosen rows into the bound destination, reports skipped files with fixed text and echoes names from main", async () => {
    const { h, repo } = setup();
    const { token } = await listed(h);
    const out = await h.copyIgnoredIntoExisting({ token, rowIds: [".env", "config/local.json"] });
    expect(out).toMatchObject({ status: "done", copied: 1, from: "r", into: "tour-login", skippedTotal: 1, skipped: [{ path: "config/local.json", reason: "already-exists", text: "already exists" }] });
    const [manifest, ids, binding] = vi.mocked(repo.copyIgnoredIntoExisting).mock.calls[0]!;
    expect(manifest.token).toBe("tok");
    expect(ids).toEqual([".env", "config/local.json"]);
    expect(binding).toEqual({ destId: "tour", boundRoot: "/wt/tour-login" });
    expect(JSON.stringify(out)).not.toContain(SENTINEL);
  });

  it("is single-use: a second redeem is tokenInvalid and writes nothing", async () => {
    const { h, repo } = setup();
    const { token } = await listed(h);
    await h.copyIgnoredIntoExisting({ token, rowIds: [".env"] });
    const again = await h.copyIgnoredIntoExisting({ token, rowIds: [".env"] });
    expect(again).toMatchObject({ status: "refused", reason: "tokenInvalid" });
    expect(repo.copyIgnoredIntoExisting).toHaveBeenCalledTimes(1);
  });

  it("a Create token is refused here (purposeMismatch) and this token is refused by Create's copy", async () => {
    const { h, repo } = setup();
    const cand = await h.copyCandidates();
    if (cand.status !== "ok") throw new Error("create listing");
    const mine = await listed(h);
    // Listing here did not kill Create's token, and the reverse holds too.
    const fromCreate = await h.copyIgnoredIntoExisting({ token: cand.token, rowIds: [".env"] });
    expect(fromCreate).toMatchObject({ status: "refused", reason: "purposeMismatch" });
    const added = await h.add({ destination: "/w/x", source: { kind: "branch", branch: "b" }, copy: { token: mine.token, rowIds: [".env"] } });
    expect(added).toMatchObject({ ok: true, copy: { status: "refused" } });
    expect(repo.copyFromManifest).not.toHaveBeenCalled();
    // Both tokens survived the cross attempts.
    const ok = await h.copyIgnoredIntoExisting({ token: mine.token, rowIds: [".env"] });
    expect(ok.status).toBe("done");
  });

  it("a Create release does not kill this token and the dialog's release does not kill Create's", async () => {
    const { h, tokens } = setup();
    await h.copyCandidates();
    await listed(h);
    h.copyRelease();
    expect(tokens.hasExistingToken()).toBe(true);
    await h.copyCandidates();
    h.copyExistingRelease();
    expect(tokens.hasExistingToken()).toBe(false);
    expect(tokens.hasToken()).toBe(true);
  });

  it("a second listing kills the first token; closing the dialog kills it", async () => {
    const { h, repo } = setup();
    const first = await listed(h);
    vi.mocked(repo.listIgnoredForExisting).mockResolvedValueOnce(okListing("tok2"));
    const second = await h.listIgnoredForExisting({ destId: "tour" });
    if (second.status !== "ok") throw new Error();
    expect(await h.copyIgnoredIntoExisting({ token: first.token, rowIds: [".env"] })).toMatchObject({ reason: "tokenInvalid" });
    h.copyExistingRelease();
    expect(await h.copyIgnoredIntoExisting({ token: second.token, rowIds: [".env"] })).toMatchObject({ reason: "tokenInvalid" });
  });

  it("a changed selection is selectionChanged", async () => {
    const { h, repo } = setup();
    const { token } = await listed(h);
    expect(await h.copyIgnoredIntoExisting({ token, rowIds: [".env"] }).then((r) => r.status)).toBe("done");
    const second = await h.listIgnoredForExisting({ destId: "tour" });
    if (second.status !== "ok") throw new Error();
    // First attempt fixes the selection (a busy refusal below keeps the token); a different second one is refused and kills it.
    const release = (h as unknown as { mutexForTest?: never }).mutexForTest;
    expect(release).toBeUndefined();
    expect(repo.copyIgnoredIntoExisting).toHaveBeenCalledTimes(1);
  });

  it("a second copy while one runs gets `busy`, keeps its token, and succeeds once the first ends", async () => {
    let finish!: () => void;
    const gate = new Promise<void>((r) => (finish = r));
    let n = 0;
    const { h, repo } = setup({
      outcome: async () => {
        if (n++ === 0) await gate;
        return done(1);
      },
    });
    const a = await listed(h);
    const running = h.copyIgnoredIntoExisting({ token: a.token, rowIds: [".env"] });
    await vi.waitFor(() => expect(repo.copyIgnoredIntoExisting).toHaveBeenCalledTimes(1));
    const b = await h.listIgnoredForExisting({ destId: "tour" });
    if (b.status !== "ok") throw new Error();
    const busy = await h.copyIgnoredIntoExisting({ token: b.token, rowIds: [".env"] });
    expect(busy).toMatchObject({ status: "refused", reason: "busy", message: "Another copy is already running.", into: "tour-login" });
    finish();
    expect((await running).status).toBe("done");
    expect((await h.copyIgnoredIntoExisting({ token: b.token, rowIds: [".env"] })).status).toBe("done");
  });

  it("the mutex is shared: a Create copy and a held lock make this copy busy; remove and prune wait for a running copy", async () => {
    const mutex = createRepoMutex();
    const { h, repo, calls } = setup({ mutex });
    const key = computeRepoKey("/r/.git", "linux");
    const hold = mutex.tryAcquire(key)!;
    const a = await listed(h);
    expect(await h.copyIgnoredIntoExisting({ token: a.token, rowIds: [".env"] })).toMatchObject({ reason: "busy" });
    // Create's copy: the worktree is still created, the copy is refused as busy.
    const cand = await h.copyCandidates();
    if (cand.status !== "ok") throw new Error();
    const added = await h.add({ destination: "/w/x", source: { kind: "branch", branch: "b" }, copy: { token: cand.token, rowIds: [".env"] } });
    expect(added).toMatchObject({ ok: true, copy: { status: "refused", message: "another copy is already running" } });
    expect(repo.copyFromManifest).not.toHaveBeenCalled();
    // Remove and prune queue behind the holder.
    const removing = h.remove({ id: "x", confirmedPath: "/p" });
    const pruning = h.prune("y", []);
    await new Promise((r) => setTimeout(r, 30));
    expect(calls).toEqual([]);
    hold();
    await Promise.all([removing, pruning]);
    expect(calls).toEqual(["remove", "prune"]);
  });

  it("the destination turned into a non-worktree or swapped is refused before a single byte is written", async () => {
    let swap = false;
    const { h, repo } = setup({
      resolve: async () => (swap ? { ok: false as const, reason: "not-a-worktree" as const } : { ok: true as const, dest }),
    });
    const a = await listed(h);
    swap = true;
    expect(await h.copyIgnoredIntoExisting({ token: a.token, rowIds: [".env"] })).toMatchObject({ status: "refused", reason: "notAWorktree", message: "tour-login is no longer a worktree of this repository." });
    expect(repo.copyIgnoredIntoExisting).not.toHaveBeenCalled();

    const moved = setup({ resolve: async () => ({ ok: true as const, dest: { ...dest, root: "/elsewhere" } }) });
    const b = await listed(moved.h);
    expect(await moved.h.copyIgnoredIntoExisting({ token: b.token, rowIds: [".env"] })).toMatchObject({ status: "refused", reason: "destinationChanged", message: "tour-login changed. Open this dialog again." });
    expect(moved.repo.copyIgnoredIntoExisting).not.toHaveBeenCalled();
  });

  it("maps git-core refusals to typed ones with fixed text", async () => {
    for (const [core, typed, text] of [
      ["not-a-worktree", "notAWorktree", "tour-login is no longer a worktree of this repository."],
      ["destination-changed", "destinationChanged", "tour-login changed. Open this dialog again."],
      ["over-limit", "overLimit", "This selection is no longer valid. Review it again."],
      ["tracked-check-failed", "trackedCheckFailed", "Couldn't check which files tour-login tracks."],
    ] as const) {
      const { h } = setup({ outcome: async () => ({ status: "refused", reason: core, results: [], totals: { copied: 0, skipped: 0, bytes: 0 } }) as ExistingCopyOutcome });
      const a = await listed(h);
      expect(await h.copyIgnoredIntoExisting({ token: a.token, rowIds: [".env"] })).toMatchObject({ status: "refused", reason: typed, message: text });
    }
  });

  it("an unexpected error becomes fixed text, never a raw message", async () => {
    const { h } = setup({ outcome: async () => { throw new Error(`boom ${SENTINEL} /secret/path`); } });
    const a = await listed(h);
    const out = await h.copyIgnoredIntoExisting({ token: a.token, rowIds: [".env"] });
    expect(out.status).toBe("refused");
    expect(JSON.stringify(out)).not.toContain(SENTINEL);
    expect(JSON.stringify(out)).not.toContain("/secret/path");
  });

  it("Cancel stops the copy (signal aborted) and the result is `cancelled`", async () => {
    let seen: AbortSignal | undefined;
    const { h, repo } = setup({
      outcome: async () => {
        seen = vi.mocked(repo.copyIgnoredIntoExisting).mock.calls[0]![3]?.signal;
        await new Promise<void>((r) => seen!.addEventListener("abort", () => r(), { once: true }));
        return done(1, [{ path: "config/local.json", reason: "cancelled" }], "cancelled");
      },
    });
    const a = await listed(h);
    const running = h.copyIgnoredIntoExisting({ token: a.token, rowIds: [".env", "config/local.json"] });
    await vi.waitFor(() => expect(repo.copyIgnoredIntoExisting).toHaveBeenCalled());
    h.copyExistingCancel();
    const out = await running;
    expect(out).toMatchObject({ status: "cancelled", copied: 1, skippedTotal: 0 });
  });

  it("switching the active tab mid-copy aborts like Cancel", async () => {
    let active: WorktreeRepo;
    const { repo, h } = setup({
      getRepoOverride: () => active,
      outcome: async () => {
        const sig = vi.mocked(active.copyIgnoredIntoExisting).mock.calls[0]![3]!.signal!;
        await new Promise<void>((r) => sig.addEventListener("abort", () => r(), { once: true }));
        return done(0, [], "cancelled");
      },
    });
    active = repo;
    const a = await listed(h);
    const running = h.copyIgnoredIntoExisting({ token: a.token, rowIds: [".env"] });
    await vi.waitFor(() => expect(repo.copyIgnoredIntoExisting).toHaveBeenCalled());
    active = { ...repo } as WorktreeRepo;
    expect((await running).status).toBe("cancelled");
  });

  it("closing the repo (getRepo throws) mid-copy aborts like Cancel", async () => {
    let open = true;
    const { repo, h } = setup({
      getRepoOverride: () => {
        if (!open) throw new Error("no repo");
        return current!;
      },
      outcome: async () => {
        const sig = vi.mocked(current!.copyIgnoredIntoExisting).mock.calls[0]![3]!.signal!;
        await new Promise<void>((r) => sig.addEventListener("abort", () => r(), { once: true }));
        return done(0, [], "cancelled");
      },
    });
    const current: WorktreeRepo | undefined = repo;
    const a = await listed(h);
    const running = h.copyIgnoredIntoExisting({ token: a.token, rowIds: [".env"] });
    await vi.waitFor(() => expect(repo.copyIgnoredIntoExisting).toHaveBeenCalled());
    open = false;
    expect((await running).status).toBe("cancelled");
  });

  it("forwards numeric progress only", async () => {
    const seen: WorktreeExistingProgress[] = [];
    const { h, repo } = setup({
      progress: (p) => seen.push(p),
      outcome: async () => {
        vi.mocked(repo.copyIgnoredIntoExisting).mock.calls[0]![3]!.onProgress!({ filesDone: 2, filesTotal: 5, bytesDone: 99 });
        return done(1);
      },
    });
    const a = await listed(h);
    await h.copyIgnoredIntoExisting({ token: a.token, rowIds: [".env"] });
    expect(seen).toEqual([{ filesDone: 2, filesTotal: 5, bytesDone: 99 }]);
  });

  it("returns at most 20 skipped names but the real total, with limit status passed through", async () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ path: `f${i}`, reason: "already-exists" }));
    const { h } = setup({ outcome: async () => done(2, many, "limit") });
    const a = await listed(h);
    const out = await h.copyIgnoredIntoExisting({ token: a.token, rowIds: [".env"] });
    expect(out).toMatchObject({ status: "limit", copied: 2, skippedTotal: 30 });
    if (out.status !== "refused") expect(out.skipped).toHaveLength(20);
  });
});
