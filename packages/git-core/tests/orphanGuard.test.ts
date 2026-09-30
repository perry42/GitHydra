// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect, afterEach } from "vitest";
import * as path from "node:path";
import {
  getOrphanedHeadCommits,
  sanitizeSubject,
  ORPHAN_COUNT_CAP,
  ORPHAN_SHOWN_MAX,
  ORPHAN_SUBJECT_MAX_LENGTH,
} from "../src/orphanGuard";
import { switchBranch, switchToCommit, createBranch, createBranchAtCommit } from "../src/branches";
import {
  HeadMovedError,
  InvalidArgumentError,
  InvalidRefNameError,
  BranchCreationFailedError,
} from "../src/errors";
import { Repository } from "../src/index";
import { git, initRepo, writeFile, commit, cleanup, makeTempDir, seedLinearHistoryViaFastImport } from "./testRepo";

const cleanupDirs: string[] = [];
afterEach(async () => {
  while (cleanupDirs.length) await cleanup(cleanupDirs.pop()!);
});

/** main has c1; HEAD is detached with `orphanCount` extra commits no ref reaches. */
async function detachedWithOrphans(orphanCount: number): Promise<{ dir: string; base: string; orphans: string[] }> {
  const dir = await initRepo();
  cleanupDirs.push(dir);
  await writeFile(dir, "a.txt", "1\n");
  const base = await commit(dir, "base");
  await git(dir, ["checkout", "-q", "--detach"]);
  const orphans: string[] = [];
  for (let i = 1; i <= orphanCount; i++) {
    await writeFile(dir, "a.txt", `${i + 1}\n`);
    orphans.push(await commit(dir, `orphan ${i}`));
  }
  return { dir, base, orphans };
}

async function headSha(dir: string): Promise<string> {
  return (await git(dir, ["rev-parse", "HEAD"])).stdout.trim();
}

describe("getOrphanedHeadCommits", () => {
  it("lists commits reachable only from a detached HEAD, newest first", async () => {
    const { dir, orphans } = await detachedWithOrphans(3);
    const r = await getOrphanedHeadCommits(dir);
    expect(r.status).toBe("orphaned");
    expect(r.headSha).toBe(orphans[2]);
    expect(r.total).toBe(3);
    expect(r.totalIsCapped).toBe(false);
    expect(r.shown.map((c) => c.subject)).toEqual(["orphan 3", "orphan 2", "orphan 1"]);
    expect(r.shown[0]!.sha).toBe(orphans[2]);
    expect(orphans[2]!.startsWith(r.shown[0]!.shortSha)).toBe(true);
  });

  it("returns none when the detached HEAD is at a branch tip", async () => {
    const { dir } = await detachedWithOrphans(0);
    const r = await getOrphanedHeadCommits(dir);
    expect(r.status).toBe("none");
    expect(r.reason).toBe("no-orphans");
    expect(r.shown).toEqual([]);
  });

  it("does not count commits reachable from a tag", async () => {
    const { dir } = await detachedWithOrphans(2);
    await git(dir, ["tag", "keep"]);
    expect((await getOrphanedHeadCommits(dir)).status).toBe("none");
  });

  it("does not count commits reachable from a remote-tracking ref", async () => {
    const { dir, orphans } = await detachedWithOrphans(2);
    await git(dir, ["update-ref", "refs/remotes/origin/feature", orphans[1]!]);
    expect((await getOrphanedHeadCommits(dir)).status).toBe("none");
  });

  it("does not count commits reachable from a local branch", async () => {
    const { dir } = await detachedWithOrphans(2);
    await git(dir, ["branch", "saved"]);
    expect((await getOrphanedHeadCommits(dir)).status).toBe("none");
  });

  it("counts only the commits beyond a partially-reachable history", async () => {
    const { dir, orphans } = await detachedWithOrphans(3);
    await git(dir, ["branch", "saved", orphans[0]!]);
    const r = await getOrphanedHeadCommits(dir);
    expect(r.status).toBe("orphaned");
    expect(r.total).toBe(2);
  });

  it("treats a commit reachable only through refs/stash as still orphaned", async () => {
    const { dir } = await detachedWithOrphans(1);
    await writeFile(dir, "a.txt", "stashed\n");
    await git(dir, ["stash", "push", "-q"]);
    // Sanity: the stash commit's parent IS the orphan, so `--all` WOULD have hidden it.
    const viaAll = (await git(dir, ["rev-list", "--count", "HEAD", "--not", "--all"])).stdout.trim();
    expect(viaAll).toBe("0");
    const r = await getOrphanedHeadCommits(dir);
    expect(r.status).toBe("orphaned");
    expect(r.total).toBe(1);
  });

  it("returns none for an attached HEAD", async () => {
    const dir = await initRepo();
    cleanupDirs.push(dir);
    await writeFile(dir, "a.txt", "1\n");
    await commit(dir, "base");
    const r = await getOrphanedHeadCommits(dir);
    expect(r).toMatchObject({ status: "none", reason: "attached" });
  });

  it("returns none for an unborn (empty) repository", async () => {
    const dir = await initRepo();
    cleanupDirs.push(dir);
    const r = await getOrphanedHeadCommits(dir);
    expect(r.status).toBe("none");
  });

  it("returns none for a bare repository", async () => {
    const dir = await initRepo({ bare: true });
    cleanupDirs.push(dir);
    expect(await getOrphanedHeadCommits(dir)).toMatchObject({ status: "none", reason: "bare" });
  });

  it("returns none during an in-progress rebase (detached, but mid-operation)", async () => {
    const dir = await initRepo();
    cleanupDirs.push(dir);
    await writeFile(dir, "a.txt", "base\n");
    await commit(dir, "base");
    await git(dir, ["checkout", "-q", "-b", "other"]);
    await writeFile(dir, "a.txt", "other\n");
    await commit(dir, "other change");
    await git(dir, ["checkout", "-q", "main"]);
    await writeFile(dir, "a.txt", "main\n");
    await commit(dir, "main change");
    await expect(git(dir, ["rebase", "other"])).rejects.toThrow(); // conflicts, leaves rebase-merge state
    expect((await git(dir, ["symbolic-ref", "-q", "HEAD"]).catch(() => null))).toBeNull(); // detached
    expect(await getOrphanedHeadCommits(dir)).toMatchObject({ status: "none", reason: "operation-in-progress" });
  });

  it("caps the count at ORPHAN_COUNT_CAP and reports totalIsCapped, showing at most 5", async () => {
    const dir = await initRepo();
    cleanupDirs.push(dir);
    await seedLinearHistoryViaFastImport(dir, { count: ORPHAN_COUNT_CAP + 5, branch: "orph" });
    await git(dir, ["checkout", "-q", "--detach", "orph"]);
    await git(dir, ["branch", "-D", "orph"]);
    const r = await getOrphanedHeadCommits(dir);
    expect(r.status).toBe("orphaned");
    expect(r.total).toBe(ORPHAN_COUNT_CAP);
    expect(r.totalIsCapped).toBe(true);
    expect(r.shown).toHaveLength(ORPHAN_SHOWN_MAX);
  }, 60_000);

  it("sanitizes a hostile subject (bidi overrides, control chars, huge length)", async () => {
    const dir = await initRepo();
    cleanupDirs.push(dir);
    await writeFile(dir, "a.txt", "1\n");
    await commit(dir, "base");
    await git(dir, ["checkout", "-q", "--detach"]);
    await writeFile(dir, "a.txt", "2\n");
    await git(dir, ["add", "-A"]);
    const evil = "safe" + String.fromCodePoint(0x202e) + "gnp.exe" + String.fromCodePoint(0x2066) + "\u001b[31mred\u0007\u0085x";
    await git(dir, ["commit", "-q", "-m", evil]);
    await writeFile(dir, "a.txt", "3\n");
    await git(dir, ["add", "-A"]);
    await git(dir, ["commit", "-q", "-m", "x".repeat(5000)]);

    const r = await getOrphanedHeadCommits(dir);
    expect(r.status).toBe("orphaned");
    const long = r.shown[0]!.subject;
    expect(Array.from(long).length).toBe(ORPHAN_SUBJECT_MAX_LENGTH + 1); // + ellipsis
    const cleaned = r.shown[1]!.subject;
    for (const ch of cleaned) {
      const cp = ch.codePointAt(0)!;
      expect(cp).toBeGreaterThanOrEqual(0x20);
      expect(cp < 0x7f || cp > 0x9f).toBe(true);
      expect(cp === 0x202e || cp === 0x2066).toBe(false);
    }
    expect(cleaned.startsWith("safegnp.exe")).toBe(true);
  });

  it("strips zero-width, invisible, tag and variation-selector characters", () => {
    const cps = [0x200b, 0x200c, 0x200d, 0x2060, 0x2064, 0xad, 0x180e, 0xe0041, 0xe007f, 0xfe0f, 0xe0100];
    const invisible = String.fromCodePoint(...cps);
    expect(sanitizeSubject("re" + invisible + "lease")).toBe("release");
    expect(sanitizeSubject(invisible)).toBe("");
  });

  it("bounds the work done on an enormous input", () => {
    const huge = "x".repeat(5_000_000);
    expect(Array.from(sanitizeSubject(huge))).toHaveLength(ORPHAN_SUBJECT_MAX_LENGTH + 1);
  });

  it("keeps non-ASCII subjects intact and truncates by code point, not UTF-16 unit", async () => {
    const emoji = String.fromCodePoint(0x1f600);
    const s = sanitizeSubject(emoji.repeat(ORPHAN_SUBJECT_MAX_LENGTH + 10));
    expect(Array.from(s)).toHaveLength(ORPHAN_SUBJECT_MAX_LENGTH + 1);
    expect(sanitizeSubject("café 日本語")).toBe("café 日本語");
  });

  it("fails closed (status unknown, never an empty 'none') when git cannot read the repository", async () => {
    const dir = await makeTempDir(); // exists, but is not a repository
    cleanupDirs.push(dir);
    const r = await getOrphanedHeadCommits(path.join(dir, "does-not-exist"));
    expect(r.status).toBe("unknown");
    expect(r.reason).toBe("error");
    expect(r.shown).toEqual([]);
  });

  it("fails closed on a corrupted repository config", async () => {
    const { dir } = await detachedWithOrphans(1);
    await writeFile(dir, ".git/config", "[core\n\tbroken = = =\n");
    const r = await getOrphanedHeadCommits(dir);
    expect(r.status).toBe("unknown");
  });

  it("is exposed on Repository", async () => {
    const { dir, orphans } = await detachedWithOrphans(1);
    const repo = await Repository.open(dir);
    expect((await repo.getOrphanedHeadCommits()).headSha).toBe(orphans[0]);
  });
});

describe("HEAD-bound guarded checkout (expectedDetachedHeadSha)", () => {
  it("switchBranch proceeds when HEAD is still detached at the expected commit", async () => {
    const { dir, orphans } = await detachedWithOrphans(1);
    const res = await switchBranch(dir, "main", { expectedDetachedHeadSha: orphans[0]! });
    expect(res.sha).not.toBe(orphans[0]);
    expect((await git(dir, ["symbolic-ref", "--short", "HEAD"])).stdout.trim()).toBe("main");
  });

  it("switchBranch throws HeadMovedError and changes nothing when HEAD moved", async () => {
    const { dir, base, orphans } = await detachedWithOrphans(2);
    const before = await headSha(dir);
    await expect(switchBranch(dir, "main", { expectedDetachedHeadSha: orphans[0]! })).rejects.toBeInstanceOf(HeadMovedError);
    expect(await headSha(dir)).toBe(before);
    expect(await git(dir, ["symbolic-ref", "-q", "HEAD"]).catch(() => "detached")).toBe("detached");
    expect(base).not.toBe(before);
  });

  it("throws HeadMovedError when HEAD has since been re-attached to a branch at the same commit", async () => {
    const { dir, orphans } = await detachedWithOrphans(1);
    await git(dir, ["switch", "-q", "-c", "saved"]);
    const err = await switchBranch(dir, "main", { expectedDetachedHeadSha: orphans[0]! }).catch((e) => e);
    expect(err).toBeInstanceOf(HeadMovedError);
    expect((err as HeadMovedError).nowAttached).toBe(true);
    expect((await git(dir, ["symbolic-ref", "--short", "HEAD"])).stdout.trim()).toBe("saved");
  });

  it("switchToCommit is guarded the same way (and accepts an upper-case expected sha)", async () => {
    const { dir, base, orphans } = await detachedWithOrphans(1);
    await expect(switchToCommit(dir, base, { expectedDetachedHeadSha: base })).rejects.toBeInstanceOf(HeadMovedError);
    const res = await switchToCommit(dir, base, { expectedDetachedHeadSha: orphans[0]!.toUpperCase() });
    expect(res.sha).toBe(base);
  });

  it("createBranch with switchToIt is guarded", async () => {
    const { dir, base, orphans } = await detachedWithOrphans(1);
    await expect(
      createBranch(dir, { name: "nb", startPoint: base, switchToIt: true, expectedDetachedHeadSha: base }),
    ).rejects.toBeInstanceOf(HeadMovedError);
    expect((await git(dir, ["branch", "--list", "nb"])).stdout.trim()).toBe("");
    const ok = await createBranch(dir, { name: "nb", switchToIt: true, expectedDetachedHeadSha: orphans[0]! });
    expect(ok.switched).toBe(true);
    expect((await git(dir, ["symbolic-ref", "--short", "HEAD"])).stdout.trim()).toBe("nb");
  });

  it("rejects a malformed expectedDetachedHeadSha before touching git", async () => {
    const { dir } = await detachedWithOrphans(1);
    const before = await headSha(dir);
    for (const bad of ["", "HEAD", "abc", "--force", "zz".repeat(20)]) {
      await expect(switchBranch(dir, "main", { expectedDetachedHeadSha: bad })).rejects.toBeInstanceOf(InvalidArgumentError);
    }
    expect(await headSha(dir)).toBe(before);
  });

  it("without the option behaves exactly as before", async () => {
    const { dir } = await detachedWithOrphans(1);
    await switchBranch(dir, "main");
    expect((await git(dir, ["symbolic-ref", "--short", "HEAD"])).stdout.trim()).toBe("main");
  });

  it("re-checks HEAD inside the queue slot: a queued mutation ahead of it that moves HEAD wins", async () => {
    const { dir, orphans } = await detachedWithOrphans(1);
    const repo = await Repository.open(dir);
    // Both calls are issued back-to-back; the first (an unguarded switch) runs first in the FIFO
    // queue and re-attaches HEAD, so the guarded one - queued behind it - must see that and abort.
    const first = repo.switchBranch("main");
    const second = repo.switchBranch("main", { expectedDetachedHeadSha: orphans[0]! });
    await first;
    await expect(second).rejects.toBeInstanceOf(HeadMovedError);
  });
});

describe("createBranchAtCommit", () => {
  it("creates a branch at exactly the given commit without switching", async () => {
    const { dir, orphans } = await detachedWithOrphans(2);
    const res = await createBranchAtCommit(dir, " rescue/work ", orphans[1]!);
    expect(res).toMatchObject({ name: "rescue/work", fullName: "refs/heads/rescue/work", sha: orphans[1], switched: false });
    expect((await git(dir, ["rev-parse", "refs/heads/rescue/work"])).stdout.trim()).toBe(orphans[1]);
    expect(await headSha(dir)).toBe(orphans[1]);
    expect((await getOrphanedHeadCommits(dir)).status).toBe("none");
  });

  it("rejects anything that is not a full lowercase hex commit id", async () => {
    const { dir, orphans } = await detachedWithOrphans(1);
    const tree = (await git(dir, ["rev-parse", "HEAD^{tree}"])).stdout.trim();
    const bad = [
      "HEAD",
      "main",
      "--force",
      "-b",
      orphans[0]!.slice(0, 12),
      orphans[0]!.toUpperCase(),
      orphans[0] + "~1",
      "0".repeat(40), // well-formed but nonexistent
      tree, // exists, but is a tree, not a commit
    ];
    for (const sha of bad) {
      await expect(createBranchAtCommit(dir, "nb", sha)).rejects.toBeInstanceOf(InvalidArgumentError);
    }
    expect((await git(dir, ["branch", "--list", "nb"])).stdout.trim()).toBe("");
  });

  it("reuses branch-name validation (invalid, leading dash) and refuses to clobber an existing branch", async () => {
    const { dir, orphans } = await detachedWithOrphans(1);
    await expect(createBranchAtCommit(dir, "bad name", orphans[0]!)).rejects.toBeInstanceOf(InvalidRefNameError);
    await expect(createBranchAtCommit(dir, "", orphans[0]!)).rejects.toBeInstanceOf(InvalidRefNameError);
    await expect(createBranchAtCommit(dir, "-x", orphans[0]!)).rejects.toBeInstanceOf(InvalidArgumentError);
    const err = await createBranchAtCommit(dir, "main", orphans[0]!).catch((e) => e);
    expect(err).toBeInstanceOf(InvalidRefNameError);
    // main untouched
    expect((await git(dir, ["rev-parse", "main"])).stdout.trim()).not.toBe(orphans[0]);
  });

  it("supports non-ASCII branch names", async () => {
    const { dir, orphans } = await detachedWithOrphans(1);
    const name = "rescue-日本語-café";
    await createBranchAtCommit(dir, name, orphans[0]!);
    const listed = (await git(dir, ["-c", "core.quotepath=off", "branch", "--list"])).stdout;
    expect(listed).toContain(name);
  });

  it("never leaks git stderr or the repository path in error messages", async () => {
    const { dir, orphans } = await detachedWithOrphans(1);
    const errors: Error[] = [];
    for (const [n, s] of [
      ["bad name", orphans[0]!],
      ["main", orphans[0]!],
      ["ok", "0".repeat(40)],
    ] as const) {
      errors.push(await createBranchAtCommit(dir, n, s).catch((e) => e));
    }
    // Force the final `git branch` step to fail (a ref-directory conflict) -> generic error.
    await createBranchAtCommit(dir, "a", orphans[0]!);
    errors.push(await createBranchAtCommit(dir, "a/b", orphans[0]!).catch((e) => e));
    expect(errors[3]).toBeInstanceOf(BranchCreationFailedError);
    for (const e of errors) {
      expect(e.message).not.toContain(dir);
      expect(e.message).not.toMatch(/fatal:|error:/i);
    }
  });
});
