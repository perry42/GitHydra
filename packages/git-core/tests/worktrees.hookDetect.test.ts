// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect, afterEach } from "vitest";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { detectPostCheckoutHook } from "../src/worktreeHook";
import { git, cleanup, makeRepoInTempParent, snapshotTree } from "./testRepo";

/** specs/worktrees.md FR-644 (git-core half) and AC21: read-only detection with fingerprint inputs. */
const dirs: string[] = [];
afterEach(async () => {
  while (dirs.length) await cleanup(dirs.pop()!);
});

async function repoWith(hookBody?: string) {
  const f = await makeRepoInTempParent();
  dirs.push(f.parent);
  const hooks = path.join(f.repo, ".git", "hooks");
  await fs.mkdir(hooks, { recursive: true });
  if (hookBody !== undefined) {
    const hook = path.join(hooks, "post-checkout");
    await fs.writeFile(hook, hookBody);
    await fs.chmod(hook, 0o755);
  }
  return { ...f, hooks };
}

describe("detectPostCheckoutHook (FR-644)", () => {
  it("reports nothing when there is no hook, or only a .sample", async () => {
    const f = await repoWith();
    expect(await detectPostCheckoutHook(f.repo)).toEqual({ present: false });
    await fs.writeFile(path.join(f.hooks, "post-checkout.sample"), "#!/bin/sh\necho sample\n");
    expect(await detectPostCheckoutHook(f.repo)).toEqual({ present: false });
  });

  it("a directory called post-checkout is not a hook", async () => {
    const f = await repoWith();
    await fs.mkdir(path.join(f.hooks, "post-checkout"));
    expect(await detectPostCheckoutHook(f.repo)).toEqual({ present: false });
  });

  it("finds the hook with its path, content hash, config value and a preview", async () => {
    const body = "#!/bin/sh\necho hello\n# second line\n";
    const f = await repoWith(body);
    const info = await detectPostCheckoutHook(f.repo);
    expect(info).toMatchObject({ present: true, hooksPathConfig: null, hooksPathRelative: false, size: Buffer.byteLength(body), truncated: false });
    if (!info.present) throw new Error("unreachable");
    expect(info.hookPath.toLowerCase()).toBe(path.join(f.hooks, "post-checkout").toLowerCase());
    expect(info.contentSha256).toBe(createHash("sha256").update(body).digest("hex"));
    expect(info.preview).toBe("#!/bin/sh\necho hello\n# second line\n");
    expect(info.fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it("the fingerprint changes with the content and with core.hooksPath", async () => {
    const f = await repoWith("#!/bin/sh\necho one\n");
    const a = await detectPostCheckoutHook(f.repo);
    await fs.writeFile(path.join(f.hooks, "post-checkout"), "#!/bin/sh\necho two\n");
    const b = await detectPostCheckoutHook(f.repo);

    const elsewhere = path.join(f.parent, "shared-hooks");
    await fs.mkdir(elsewhere);
    await fs.writeFile(path.join(elsewhere, "post-checkout"), "#!/bin/sh\necho two\n");
    await git(f.repo, ["config", "core.hooksPath", elsewhere.replace(/\\/g, "/")]);
    const c = await detectPostCheckoutHook(f.repo);

    if (!a.present || !b.present || !c.present) throw new Error("hooks expected");
    expect(a.fingerprint).not.toBe(b.fingerprint);
    expect(b.contentSha256).toBe(c.contentSha256);
    expect(b.fingerprint).not.toBe(c.fingerprint);
    expect(c.hooksPathConfig).toBe(elsewhere.replace(/\\/g, "/"));
    expect(path.resolve(c.hooksDir).toLowerCase()).toBe(path.resolve(elsewhere).toLowerCase());
  });

  it("core.hooksPath replaces the default hooks dir: a hook left in .git/hooks no longer counts", async () => {
    const f = await repoWith("#!/bin/sh\necho in-default\n");
    const empty = path.join(f.parent, "empty-hooks");
    await fs.mkdir(empty);
    await git(f.repo, ["config", "core.hooksPath", empty.replace(/\\/g, "/")]);
    expect(await detectPostCheckoutHook(f.repo)).toEqual({ present: false });
  });

  it("a relative core.hooksPath is flagged, since it resolves inside the new worktree", async () => {
    const f = await repoWith();
    await fs.mkdir(path.join(f.repo, ".husky"));
    await fs.writeFile(path.join(f.repo, ".husky", "post-checkout"), "#!/bin/sh\n");
    await git(f.repo, ["config", "core.hooksPath", ".husky"]);
    const info = await detectPostCheckoutHook(f.repo);
    expect(info).toMatchObject({ present: true, hooksPathRelative: true, hooksPathConfig: ".husky" });
  });

  it("uses the common hooks dir when asked from a linked worktree", async () => {
    const f = await repoWith("#!/bin/sh\necho shared\n");
    const linked = path.join(f.parent, "linked");
    await git(f.repo, ["worktree", "add", "-q", "--no-checkout", linked, "-b", "l"]);
    expect(await detectPostCheckoutHook(linked)).toMatchObject({ present: true });
  });

  it("is read-only: the repository and its parent are byte-identical afterwards", async () => {
    const f = await repoWith("#!/bin/sh\necho x\n");
    const before = await snapshotTree(f.parent);
    await detectPostCheckoutHook(f.repo);
    expect(await snapshotTree(f.parent)).toEqual(before);
  });
});
