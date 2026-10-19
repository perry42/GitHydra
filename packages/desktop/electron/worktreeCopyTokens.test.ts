// SPDX-License-Identifier: GPL-3.0-or-later
import type { CopyManifest } from "@githydra/git-core";
import { describe, expect, it } from "vitest";
import { COPY_TOKEN_TTL_MS, createCopyTokenStore, createRepoMutex } from "./worktreeCopyTokens";

/** specs/worktree-copy-ignored.md FR-643 / AC 10: single use, expiry, and the bindings. */

const manifest = (token = "tok"): CopyManifest => ({ version: 1, createdAt: 0, sourceWorktreeId: null, sourceRoot: "/src", repoKey: "k", token, rows: [], files: [] });
const ctx = { repoKey: "k", sourceRoot: "/src" };

function setup() {
  let t = 1000;
  const store = createCopyTokenStore({ now: () => t, platform: "linux" });
  return { store, advance: (ms: number) => (t += ms) };
}

describe("copy token store (FR-643)", () => {
  it("is single-use: a consume after a successful consume is refused", () => {
    const { store } = setup();
    const token = store.issue(manifest(), "k", "/src");
    expect(store.bind(token, ctx, "/dest", ["a"]).ok).toBe(true);
    expect(store.consume(token, ctx, "/dest", ["a"]).ok).toBe(true);
    expect(store.consume(token, ctx, "/dest", ["a"])).toEqual({ ok: false, reason: "unknown" });
  });

  it("expires after 10 minutes (fake clock)", () => {
    const { store, advance } = setup();
    const token = store.issue(manifest(), "k", "/src");
    advance(COPY_TOKEN_TTL_MS - 1);
    expect(store.bind(token, ctx, "/d", ["a"]).ok).toBe(true);
    advance(2);
    expect(store.consume(token, ctx, "/d", ["a"])).toEqual({ ok: false, reason: "expired" });
    expect(store.hasToken()).toBe(false);
  });

  it("is refused for another repository or another source worktree", () => {
    const { store } = setup();
    const token = store.issue(manifest(), "k", "/src");
    expect(store.bind(token, { repoKey: "other", sourceRoot: "/src" }, "/d", ["a"])).toEqual({ ok: false, reason: "other-repository" });
    expect(store.bind(token, { repoKey: "k", sourceRoot: "/elsewhere" }, "/d", ["a"])).toEqual({ ok: false, reason: "other-source" });
    // A wrong context does not burn the token for the right one.
    expect(store.bind(token, ctx, "/d", ["a"]).ok).toBe(true);
  });

  it("a token from an older listing is refused once a newer one is issued", () => {
    const { store } = setup();
    const first = store.issue(manifest("one"), "k", "/src");
    store.issue(manifest("two"), "k", "/src");
    expect(store.bind(first, ctx, "/d", ["a"])).toEqual({ ok: false, reason: "unknown" });
  });

  it("is invalidated by a different selection or destination after binding", () => {
    const a = setup();
    const t1 = a.store.issue(manifest(), "k", "/src");
    a.store.bind(t1, ctx, "/d", ["a", "b"]);
    expect(a.store.consume(t1, ctx, "/d", ["a"])).toEqual({ ok: false, reason: "selection-changed" });
    expect(a.store.hasToken()).toBe(false);

    const b = setup();
    const t2 = b.store.issue(manifest(), "k", "/src");
    b.store.bind(t2, ctx, "/d", ["a"]);
    expect(b.store.consume(t2, ctx, "/other", ["a"])).toEqual({ ok: false, reason: "destination-changed" });
    expect(b.store.hasToken()).toBe(false);

    const c = setup();
    const t3 = c.store.issue(manifest(), "k", "/src");
    c.store.bind(t3, ctx, "/d", ["a"]);
    expect(c.store.bind(t3, ctx, "/d", ["a", "b"])).toEqual({ ok: false, reason: "selection-changed" });
  });

  it("the id order does not matter, duplicates do not count", () => {
    const { store } = setup();
    const token = store.issue(manifest(), "k", "/src");
    store.bind(token, ctx, "/d", ["b", "a", "a"]);
    expect(store.consume(token, ctx, "/d", ["a", "b"]).ok).toBe(true);
  });

  it("a failed add (unbind) keeps the token usable for a changed retry", () => {
    const { store } = setup();
    const token = store.issue(manifest(), "k", "/src");
    store.bind(token, ctx, "/d", ["a"]);
    store.unbind(token);
    expect(store.bind(token, ctx, "/d2", ["a", "b"]).ok).toBe(true);
  });

  it("consume without a binding is refused, release drops the token", () => {
    const { store } = setup();
    const token = store.issue(manifest(), "k", "/src");
    expect(store.consume(token, ctx, "/d", ["a"])).toEqual({ ok: false, reason: "not-bound" });
    store.release();
    expect(store.bind(token, ctx, "/d", ["a"])).toEqual({ ok: false, reason: "unknown" });
  });

  it("compares destinations case-insensitively on Windows only", () => {
    let t = 0;
    const win = createCopyTokenStore({ now: () => t, platform: "win32" });
    const token = win.issue(manifest(), "k", "C:\\Src");
    const wctx = { repoKey: "k", sourceRoot: "c:/src" };
    win.bind(token, wctx, "C:\\Work\\X", ["a"]);
    expect(win.consume(token, wctx, "c:/work/x", ["a"]).ok).toBe(true);
    t += 1;
    const lin = createCopyTokenStore({ now: () => t, platform: "linux" });
    const t2 = lin.issue(manifest(), "k", "/src");
    lin.bind(t2, ctx, "/Work/X", ["a"]);
    expect(lin.consume(t2, ctx, "/work/x", ["a"]).ok).toBe(false);
  });
});

/** specs/worktree-copy-ignored.md FR-653, AC 17: the copy-into-existing purpose and the shared per-repo mutex. */
describe("purpose-bound token (section G, FR-653, M8)", () => {
  const dest = { id: "dest", root: "/wt/dest" };
  const fresh = { destId: "dest", destRoot: "/wt/dest" };

  it("a Create token is refused here and an existing-destination token is refused by Create, each as purposeMismatch, and neither is burned", () => {
    const { store } = setup();
    const create = store.issue(manifest("c"), "k", "/src");
    const existing = store.issueExisting(manifest("e"), "k", "/src", dest);
    expect(store.checkExisting(create, ctx, ["a"])).toEqual({ ok: false, reason: "purpose-mismatch" });
    expect(store.bind(existing, ctx, "/d", ["a"])).toEqual({ ok: false, reason: "purpose-mismatch" });
    expect(store.consume(existing, ctx, "/d", ["a"])).toEqual({ ok: false, reason: "purpose-mismatch" });
    expect(store.hasToken()).toBe(true);
    expect(store.hasExistingToken()).toBe(true);
    expect(store.bind(create, ctx, "/d", ["a"]).ok).toBe(true);
    expect(store.checkExisting(existing, ctx, ["a"]).ok).toBe(true);
  });

  it("is single-use: the second redeem is tokenInvalid ('unknown')", () => {
    const { store } = setup();
    const t = store.issueExisting(manifest(), "k", "/src", dest);
    expect(store.consumeExisting(t, ctx, ["a"], fresh).ok).toBe(true);
    expect(store.consumeExisting(t, ctx, ["a"], fresh)).toEqual({ ok: false, reason: "unknown" });
  });

  it("expires at 10 minutes (fake clock)", () => {
    const { store, advance } = setup();
    const t = store.issueExisting(manifest(), "k", "/src", dest);
    advance(COPY_TOKEN_TTL_MS - 1);
    expect(store.checkExisting(t, ctx, ["a"]).ok).toBe(true);
    advance(2);
    expect(store.consumeExisting(t, ctx, ["a"], fresh)).toEqual({ ok: false, reason: "expired" });
    expect(store.hasExistingToken()).toBe(false);
  });

  it("one test per binding: repo key, source, destination id, destination realpath, selected row ids", () => {
    const cases: [string, () => ReturnType<ReturnType<typeof setup>["store"]["consumeExisting"]>][] = [];
    const make = () => {
      const { store } = setup();
      return { store, token: store.issueExisting(manifest(), "k", "/src", dest) };
    };
    cases.push(["other-repository", () => { const { store, token } = make(); return store.consumeExisting(token, { repoKey: "x", sourceRoot: "/src" }, ["a"], fresh); }]);
    cases.push(["other-source", () => { const { store, token } = make(); return store.consumeExisting(token, { repoKey: "k", sourceRoot: "/other" }, ["a"], fresh); }]);
    cases.push(["destination-changed", () => { const { store, token } = make(); return store.consumeExisting(token, ctx, ["a"], { destId: "other", destRoot: "/wt/dest" }); }]);
    cases.push(["destination-changed", () => { const { store, token } = make(); return store.consumeExisting(token, ctx, ["a"], { destId: "dest", destRoot: "/wt/swapped" }); }]);
    cases.push(["selection-changed", () => { const { store, token } = make(); store.checkExisting(token, ctx, ["a", "b"]); return store.consumeExisting(token, ctx, ["a"], fresh); }]);
    cases.push(["selection-changed", () => { const { store, token } = make(); store.checkExisting(token, ctx, ["a"]); return store.consumeExisting(token, ctx, ["a", "b"], fresh); }]);
    for (const [reason, run] of cases) expect(run(), reason).toEqual({ ok: false, reason });
  });

  it("an invalid redeem cannot burn a valid token (wrong context leaves it usable)", () => {
    const { store } = setup();
    const t = store.issueExisting(manifest(), "k", "/src", dest);
    expect(store.consumeExisting(t, { repoKey: "x", sourceRoot: "/src" }, ["a"], fresh).ok).toBe(false);
    expect(store.consumeExisting("bogus", ctx, ["a"], fresh)).toEqual({ ok: false, reason: "unknown" });
    expect(store.consumeExisting(t, ctx, ["a"], fresh).ok).toBe(true);
  });

  it("a second listing of the same purpose kills the first token; closing the dialog kills it", () => {
    const { store } = setup();
    const first = store.issueExisting(manifest("one"), "k", "/src", dest);
    const second = store.issueExisting(manifest("two"), "k", "/src", dest);
    expect(store.checkExisting(first, ctx, ["a"])).toEqual({ ok: false, reason: "unknown" });
    expect(store.checkExisting(second, ctx, ["a"]).ok).toBe(true);
    store.releaseExisting();
    expect(store.checkExisting(second, ctx, ["a"])).toEqual({ ok: false, reason: "unknown" });
  });

  it("a listing or release of the OTHER purpose never touches a live token", () => {
    const { store } = setup();
    const existing = store.issueExisting(manifest("e"), "k", "/src", dest);
    store.issue(manifest("c"), "k", "/src");
    store.release();
    expect(store.hasExistingToken()).toBe(true);
    expect(store.checkExisting(existing, ctx, ["a"]).ok).toBe(true);
    const create = store.issue(manifest("c2"), "k", "/src");
    store.issueExisting(manifest("e2"), "k", "/src", dest);
    store.releaseExisting();
    expect(store.bind(create, ctx, "/d", ["a"]).ok).toBe(true);
  });
});

describe("shared per-repo mutex (FR-653, M8)", () => {
  it("a second tryAcquire for the same repo is refused until release; other repos are independent", () => {
    const m = createRepoMutex();
    const release = m.tryAcquire("a");
    expect(release).not.toBeNull();
    expect(m.tryAcquire("a")).toBeNull();
    expect(m.tryAcquire("b")).not.toBeNull();
    release!();
    release!();
    expect(m.tryAcquire("a")).not.toBeNull();
  });

  it("run waits for a holder, runs alone in FIFO order, and tryAcquire is refused while anything waits", async () => {
    const m = createRepoMutex();
    const release = m.tryAcquire("a")!;
    const order: string[] = [];
    let unblock!: () => void;
    const gate = new Promise<void>((r) => (unblock = r));
    const first = m.run("a", async () => { order.push("remove-start"); await gate; order.push("remove-end"); });
    const second = m.run("a", async () => { order.push("prune"); });
    await Promise.resolve();
    expect(order).toEqual([]);
    expect(m.tryAcquire("a")).toBeNull();
    release();
    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual(["remove-start"]);
    expect(m.tryAcquire("a")).toBeNull();
    unblock();
    await Promise.all([first, second]);
    expect(order).toEqual(["remove-start", "remove-end", "prune"]);
    expect(m.isBusy("a")).toBe(false);
    expect(m.tryAcquire("a")).not.toBeNull();
  });

  it("a failing run releases the mutex", async () => {
    const m = createRepoMutex();
    await expect(m.run("a", async () => { throw new Error("x"); })).rejects.toThrow("x");
    expect(m.isBusy("a")).toBe(false);
  });
});
