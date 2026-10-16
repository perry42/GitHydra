// SPDX-License-Identifier: GPL-3.0-or-later
import type { CopyManifest } from "@githydra/git-core";
import { describe, expect, it } from "vitest";
import { COPY_TOKEN_TTL_MS, createCopyTokenStore } from "./worktreeCopyTokens";

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
