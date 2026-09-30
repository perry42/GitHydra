// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * IPC-level coverage (through the same RepoSession + serializeError path main.ts uses, minus the
 * Electron transport) for specs/branch-panel-drag-merge.md FR-430's backend: the orphan query, the
 * HEAD-bound checkout options, and the narrow create-branch-at-commit call. Real git, real repo.
 */
import { describe, it, expect, afterEach } from "vitest";
import { createRealGitHydraApi, type RealGitHydraHandle } from "./realGitHydraApi";
import { git, initRepo, writeFile, commitAll, cleanup } from "./gitFixture";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function openDetachedWithOrphan(): Promise<{ handle: RealGitHydraHandle; dir: string; orphan: string }> {
  const dir = await initRepo();
  cleanups.push(() => cleanup(dir));
  await writeFile(dir, "a.txt", "1\n");
  await commitAll(dir, "base");
  await git(dir, ["checkout", "-q", "--detach"]);
  await writeFile(dir, "a.txt", "2\n");
  const orphan = await commitAll(dir, "orphan commit");
  const handle = createRealGitHydraApi();
  cleanups.push(() => handle.dispose());
  handle.setDialogPath(dir);
  const opened = await handle.api.openRepo(dir);
  expect(opened.ok).toBe(true);
  return { handle, dir, orphan };
}

describe("FR-430 IPC surface", () => {
  it("getOrphanedHeadCommits reports the orphaned commit and never needs a path argument", async () => {
    const { handle, orphan } = await openDetachedWithOrphan();
    const res = await handle.api.getOrphanedHeadCommits();
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.status).toBe("orphaned");
    expect(res.data.headSha).toBe(orphan);
    expect(res.data.shown[0]?.subject).toBe("orphan commit");
  });

  it("switchBranch with a stale expectedDetachedHeadSha fails with HeadMovedError and changes nothing", async () => {
    const { handle, dir, orphan } = await openDetachedWithOrphan();
    const wrong = "0".repeat(40);
    const res = await handle.api.switchBranch("main", { expectedDetachedHeadSha: wrong });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.name).toBe("HeadMovedError");
    expect(res.error.message).not.toContain(dir);
    expect((await git(dir, ["rev-parse", "HEAD"])).stdout.trim()).toBe(orphan);
    expect(await git(dir, ["symbolic-ref", "-q", "HEAD"]).catch(() => "detached")).toBe("detached");
  });

  it("switchBranch with the matching expectedDetachedHeadSha proceeds; unknown option keys are ignored", async () => {
    const { handle, dir, orphan } = await openDetachedWithOrphan();
    const res = await handle.api.switchBranch("main", {
      expectedDetachedHeadSha: orphan,
      // A renderer must not be able to smuggle other options through.
      ...({ somethingElse: "x" } as object),
    });
    expect(res.ok).toBe(true);
    expect((await git(dir, ["symbolic-ref", "--short", "HEAD"])).stdout.trim()).toBe("main");
  });

  it("createBranchAtCommit saves the orphan; invalid sha and duplicate names come back as typed errors without stderr", async () => {
    const { handle, dir, orphan } = await openDetachedWithOrphan();
    const bad = await handle.api.createBranchAtCommit("rescue", "HEAD");
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error.name).toBe("InvalidArgumentError");

    const good = await handle.api.createBranchAtCommit("rescue", orphan);
    expect(good.ok).toBe(true);
    expect((await git(dir, ["rev-parse", "rescue"])).stdout.trim()).toBe(orphan);

    const dup = await handle.api.createBranchAtCommit("rescue", orphan);
    expect(dup.ok).toBe(false);
    if (!dup.ok) {
      expect(dup.error.name).toBe("InvalidRefNameError");
      expect(dup.error.stderr).toBeUndefined();
      expect(dup.error.message).not.toContain(dir);
    }
    const after = await handle.api.getOrphanedHeadCommits();
    expect(after.ok && after.data.status).toBe("none");
  });
});
