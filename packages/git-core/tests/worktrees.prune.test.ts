// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { parsePruneVerbose, pruneWorktree } from "../src/worktrees";
import { listWorktrees } from "../src/worktreeList";
import { _setWorktreeGitVersionForTests, _setWorktreeRunnerForTests } from "../src/worktreeRunner";
import { git, cleanup, fileExists, makeRepoInTempParent, snapshotTree } from "./testRepo";
import { recordingRunner } from "./worktreeKit";

/** specs/worktrees.md AC7 and FR-604: `git worktree prune` has no per-entry form, so the dry run decides. */
const dirs: string[] = [];
beforeEach(() => {
  _setWorktreeGitVersionForTests(undefined);
  _setWorktreeRunnerForTests(null);
});
afterEach(async () => {
  _setWorktreeRunnerForTests(null);
  while (dirs.length) await cleanup(dirs.pop()!);
});

async function twoMissing() {
  const { parent, repo } = await makeRepoInTempParent();
  dirs.push(parent);
  const live = path.join(parent, "live");
  await git(repo, ["worktree", "add", "-q", live, "-b", "live"]);
  for (const n of ["gone-a", "gone-b"]) {
    await git(repo, ["worktree", "add", "-q", path.join(parent, n), "-b", n]);
    await fs.rm(path.join(parent, n), { recursive: true, force: true });
  }
  return { parent, repo, live, adminDir: (id: string) => path.join(repo, ".git", "worktrees", id) };
}

describe("pruneWorktree (AC7)", () => {
  it("cleaning A when B would also be pruned asks for confirmation listing B and removes nothing", async () => {
    const f = await twoMissing();
    const { runner, calls } = recordingRunner();
    _setWorktreeRunnerForTests(runner);
    const before = await snapshotTree(f.parent);

    const res = await pruneWorktree(f.repo, "gone-a");
    expect(res).toMatchObject({ ok: false, reason: "confirmationRequired" });
    const also = (res as { alsoForgotten: { id: string; path: string | null }[] }).alsoForgotten;
    expect(also.map((a) => a.id)).toEqual(["gone-b"]);
    expect(also[0]!.path).toMatch(/gone-b$/);

    expect(await snapshotTree(f.parent)).toEqual(before);
    const prunes = calls.filter((c) => c.args.includes("prune"));
    expect(prunes).toHaveLength(1);
    expect(prunes[0]!.args).toEqual(expect.arrayContaining(["--dry-run", "--verbose"]));
  });

  it("after confirmation both go, the dry run ran first, and no worktree folder content is deleted", async () => {
    const f = await twoMissing();
    const { runner, calls } = recordingRunner();
    _setWorktreeRunnerForTests(runner);

    const res = await pruneWorktree(f.repo, "gone-a", { acceptAlsoForgotten: ["gone-b"] });
    expect(res).toMatchObject({ ok: true, id: "gone-a", alsoForgot: [] });
    expect((res as { forgotten: { id: string }[] }).forgotten.map((x) => x.id).sort()).toEqual(["gone-a", "gone-b"]);

    const prunes = calls.filter((c) => c.args.includes("prune"));
    expect(prunes.map((c) => c.args.includes("--dry-run"))).toEqual([true, false]);
    expect((await listWorktrees(f.repo)).entries.map((e) => e.id)).toEqual([null, "live"]);
    expect(await fileExists(path.join(f.live, "a.txt"))).toBe(true);
    expect(await fileExists(path.join(f.repo, "a.txt"))).toBe(true);
  });

  it("a single stale entry is cleaned without any confirmation", async () => {
    const { parent, repo } = await makeRepoInTempParent();
    dirs.push(parent);
    await git(repo, ["worktree", "add", "-q", path.join(parent, "gone"), "-b", "gone"]);
    await fs.rm(path.join(parent, "gone"), { recursive: true, force: true });
    const res = await pruneWorktree(repo, "gone");
    expect(res).toMatchObject({ ok: true, id: "gone", alsoForgot: [] });
    expect((await listWorktrees(repo)).entries).toHaveLength(1);
  });

  it("reports an extra entry the real run forgot that the dry run did not list", async () => {
    const f = await twoMissing();
    // Simulate the race: the dry run only knew about A, then B also went stale before the real run.
    const { runner } = recordingRunner((args) =>
      args.includes("--dry-run") ? { stdout: () => "Removing worktrees/gone-a: gitdir file points to non-existent location\n" } : undefined,
    );
    _setWorktreeRunnerForTests(runner);
    const res = await pruneWorktree(f.repo, "gone-a");
    expect(res).toMatchObject({ ok: true });
    expect((res as { alsoForgot: { id: string }[] }).alsoForgot.map((x) => x.id)).toEqual(["gone-b"]);
  });

  it("refuses an entry git does not consider stale, a locked one and an unknown id", async () => {
    const f = await twoMissing();
    expect(await pruneWorktree(f.repo, "live")).toMatchObject({ ok: false, reason: "notPrunable" });
    expect(await pruneWorktree(f.repo, "nope")).toMatchObject({ ok: false, reason: "notFound" });
    await git(f.repo, ["worktree", "lock", "--reason", "x", path.join(f.parent, "gone-a")]);
    expect(await pruneWorktree(f.repo, "gone-a")).toMatchObject({ ok: false, reason: "locked" });
    expect(await fileExists(f.adminDir("gone-a"))).toBe(true);
    expect(await fileExists(f.adminDir("gone-b"))).toBe(true);
  });

  it("parsePruneVerbose reads git's `Removing worktrees/<id>: <reason>` lines", () => {
    expect(parsePruneVerbose("Removing worktrees/a b: gitdir file does not exist\r\nnoise\nRemoving worktrees/c: reason: with colon\n")).toEqual([
      { id: "a b", reason: "gitdir file does not exist" },
      { id: "c", reason: "reason: with colon" },
    ]);
  });
});
