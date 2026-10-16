// SPDX-License-Identifier: GPL-3.0-or-later
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AddWorktreeResult, PostCheckoutHookInfo } from "@githydra/git-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { computeRepoKey } from "./recoveryDrafts";
import { createFileHookTrustStore } from "./worktreeHookTrust";
import { createWorktreeHandlers, type WorktreeRepo } from "./worktreeIpc";

/** specs/worktrees.md FR-644, AC 21: the main-process half of the hook consent. */

const hex = (n: number): string => n.toString(16).padStart(64, "0");
const FP = hex(7);
const hook = (over: Partial<Extract<PostCheckoutHookInfo, { present: true }>> = {}): PostCheckoutHookInfo => ({
  present: true,
  hookPath: "/r/.git/hooks/post-checkout",
  hooksDir: "/r/.git/hooks",
  hooksPathConfig: null,
  hooksPathRelative: false,
  contentSha256: hex(1),
  size: 10,
  executable: true,
  otherHooks: [],
  fingerprint: FP,
  preview: "echo hi",
  previewTruncated: false,
  previewLineCount: 1,
  previewIsBinary: false,
  ...over,
});
const created: AddWorktreeResult = { ok: true, path: "/x", entry: null, branch: "b", head: "h", createdBranch: false, warning: null };

let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "gh-hook-ipc-"));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

let counter = 0;
function setup(info: () => PostCheckoutHookInfo, add: WorktreeRepo["addWorktree"] = vi.fn(async () => created)) {
  const repo = {
    listWorktrees: vi.fn(async () => ({ commonDir: "/r/.git", mainPath: "/r", entries: [] })),
    detectPostCheckoutHook: vi.fn(async () => info()),
    addWorktree: add,
  } as unknown as WorktreeRepo;
  const trust = createFileHookTrustStore(path.join(dir, String(++counter)));
  const h = createWorktreeHandlers(() => repo, { trust, realpath: async (p) => p, platform: "linux" });
  return { repo, h, trust, key: computeRepoKey("/r/.git", "linux") };
}
const req = (extra: Record<string, unknown> = {}) => ({ destination: "/d", source: { kind: "branch", branch: "f" }, ...extra });

describe("hook info (FR-644)", () => {
  it("returns the detection plus the remembered choice, only while the fingerprint matches", async () => {
    const { h, trust, key } = setup(() => hook());
    expect(await h.hookInfo()).toMatchObject({ present: true, fingerprint: FP, remembered: null });
    await trust.set(key, { choice: "run", fingerprint: FP, at: 1 });
    expect(await h.hookInfo()).toMatchObject({ remembered: "run" });
    await trust.set(key, { choice: "run", fingerprint: hex(8), at: 2 });
    expect(await h.hookInfo()).toMatchObject({ remembered: null });
  });

  it("never reports a remembered choice for a relative core.hooksPath, and none when there is no hook", async () => {
    const rel = setup(() => hook({ hooksPathRelative: true, hooksPathConfig: "hooks" }));
    await rel.trust.set(rel.key, { choice: "run", fingerprint: FP, at: 1 });
    expect(await rel.h.hookInfo()).toMatchObject({ remembered: null });
    expect(await setup(() => ({ present: false })).h.hookInfo()).toEqual({ present: false, remembered: null });
  });

  it("takes no argument and derives the repo key from the session's common dir (no key-for-path oracle)", async () => {
    const { h } = setup(() => hook());
    expect(h.hookInfo.length).toBe(0);
  });

  it("without a trust store nothing is ever recalled", async () => {
    const repo = { listWorktrees: vi.fn(), detectPostCheckoutHook: vi.fn(async () => hook()) } as unknown as WorktreeRepo;
    expect(await createWorktreeHandlers(() => repo).hookInfo()).toMatchObject({ remembered: null });
  });
});

describe("add with a hook choice (FR-644)", () => {
  it("refuses git-core option names and trust claims from the renderer, before git-core is reached", async () => {
    const { h, repo } = setup(() => hook());
    for (const extra of [{ runPostCheckoutHook: true }, { expectedHookFingerprint: FP }, { options: { runPostCheckoutHook: true } }, { trusted: true }, { remembered: "run" }]) {
      await expect(h.add(req(extra))).rejects.toThrow();
    }
    await expect(h.add(req({ hookChoice: "always" }))).rejects.toThrow();
    expect(repo.addWorktree).not.toHaveBeenCalled();
  });

  it("run: passes runPostCheckoutHook with the fingerprint main read from git-core itself", async () => {
    const { h, repo } = setup(() => hook());
    const res = await h.add(req({ hookChoice: "run", hookFingerprint: FP }));
    expect(res).toMatchObject({ ok: true });
    expect(vi.mocked(repo.addWorktree).mock.calls[0]).toEqual(["/d", { kind: "branch", branch: "f" }, { runPostCheckoutHook: true, expectedHookFingerprint: FP }]);
  });

  it("run with a stale fingerprint is refused as hookChanged and nothing is created", async () => {
    const { h, repo } = setup(() => hook({ fingerprint: hex(9) }));
    expect(await h.add(req({ hookChoice: "run", hookFingerprint: FP }))).toMatchObject({ ok: false, reason: "hookChanged" });
    expect(repo.addWorktree).not.toHaveBeenCalled();
  });

  it("run when the hook vanished is hookChanged; run without the shown fingerprint is hookFingerprintRequired", async () => {
    const gone = setup(() => ({ present: false }));
    expect(await gone.h.add(req({ hookChoice: "run", hookFingerprint: FP }))).toMatchObject({ ok: false, reason: "hookChanged" });
    const none = setup(() => hook());
    expect(await none.h.add(req({ hookChoice: "run" }))).toMatchObject({ ok: false, reason: "hookFingerprintRequired" });
    expect(none.repo.addWorktree).not.toHaveBeenCalled();
  });

  it("run with a relative core.hooksPath is refused hooksPathRelative", async () => {
    const { h, repo } = setup(() => hook({ hooksPathRelative: true, hooksPathConfig: "hooks" }));
    expect(await h.add(req({ hookChoice: "run", hookFingerprint: FP, remember: true }))).toMatchObject({ ok: false, reason: "hooksPathRelative" });
    expect(repo.addWorktree).not.toHaveBeenCalled();
  });

  it("surfaces git-core's configHooks refusal unchanged and remembers nothing", async () => {
    const refusal: AddWorktreeResult = { ok: false, reason: "configHooks", message: "m" };
    const { h, trust, key } = setup(() => hook(), vi.fn(async () => refusal));
    expect(await h.add(req({ hookChoice: "run", hookFingerprint: FP, remember: true }))).toEqual(refusal);
    expect(await trust.get(key, FP)).toBeNull();
  });

  it("remember is stored only after a successful create, and bound to the fingerprint", async () => {
    const failing = setup(() => hook(), vi.fn(async () => ({ ok: false, reason: "destination", message: "m" }) as AddWorktreeResult));
    await failing.h.add(req({ hookChoice: "run", hookFingerprint: FP, remember: true }));
    expect(await failing.trust.get(failing.key, FP)).toBeNull();

    const ok = setup(() => hook());
    await ok.h.add(req({ hookChoice: "run", hookFingerprint: FP, remember: true }));
    expect(await ok.trust.get(ok.key, FP)).toBe("run");
    expect(await ok.trust.get(ok.key, hex(9))).toBeNull();
  });

  it("without remember nothing is stored; a failing trust write does not fail the create", async () => {
    const plain = setup(() => hook());
    await plain.h.add(req({ hookChoice: "run", hookFingerprint: FP }));
    expect(await plain.trust.get(plain.key, FP)).toBeNull();

    const repo = { listWorktrees: vi.fn(async () => ({ commonDir: "/r/.git" })), detectPostCheckoutHook: vi.fn(async () => hook()), addWorktree: vi.fn(async () => created) } as unknown as WorktreeRepo;
    const h = createWorktreeHandlers(() => repo, { trust: { get: async () => null, set: async () => Promise.reject(new Error("disk")) }, realpath: async (p) => p });
    expect(await h.add(req({ hookChoice: "run", hookFingerprint: FP, remember: true }))).toMatchObject({ ok: true });
  });

  it("skip: hooks stay off (no options) and a remembered skip needs the shown fingerprint to still match", async () => {
    const a = setup(() => hook());
    await a.h.add(req({ hookChoice: "skip", hookFingerprint: FP, remember: true }));
    expect(vi.mocked(a.repo.addWorktree).mock.calls[0]).toEqual(["/d", { kind: "branch", branch: "f" }]);
    expect(await a.trust.get(a.key, FP)).toBe("skip");

    const stale = setup(() => hook({ fingerprint: hex(9) }));
    await stale.h.add(req({ hookChoice: "skip", hookFingerprint: FP, remember: true }));
    expect(await stale.trust.get(stale.key, FP)).toBeNull();
    expect(await stale.trust.get(stale.key, hex(9))).toBeNull();
  });
});
