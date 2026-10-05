// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getDiscardFingerprint, type DiscardBackupInfo } from "../src/discardGuard";
import { discardTrackedFileChanges, discardUntrackedFile } from "../src/staging";
import { runInMutationQueue } from "../src/gitProcess";
import { DiscardFingerprintError, InvalidArgumentError, StaleDiffError } from "../src/errors";
import { git, initRepo, writeFile, commit, cleanup } from "./testRepo";

const dirs: string[] = [];
afterEach(async () => {
  while (dirs.length) await cleanup(dirs.pop()!);
});

async function fixture(): Promise<string> {
  const dir = await initRepo();
  dirs.push(dir);
  await git(dir, ["config", "core.autocrlf", "false"]);
  await writeFile(dir, "f.txt", "one\ntwo\n");
  await commit(dir, "base");
  return dir;
}

const read = (dir: string, p: string): Promise<string> => fs.readFile(path.join(dir, p), "utf8");
const fp = (dir: string, p: string, k: "tracked" | "untracked" = "tracked"): Promise<string> => getDiscardFingerprint(dir, p, k);

describe("getDiscardFingerprint", () => {
  it("is stable for an unchanged file and changes on a content edit", async () => {
    const dir = await fixture();
    await writeFile(dir, "f.txt", "edited\n");
    const a = await fp(dir, "f.txt");
    expect(await fp(dir, "f.txt")).toBe(a);
    await writeFile(dir, "f.txt", "edited!\n");
    expect(await fp(dir, "f.txt")).not.toBe(a);
  });

  it("changes when the index changes (git add), when HEAD changes, and on an index mode change", async () => {
    const dir = await fixture();
    await writeFile(dir, "f.txt", "edited\n");
    const a = await fp(dir, "f.txt");
    await git(dir, ["add", "f.txt"]);
    const b = await fp(dir, "f.txt");
    expect(b).not.toBe(a);
    await commit(dir, "second");
    const c = await fp(dir, "f.txt");
    expect(c).not.toBe(b);
    await git(dir, ["update-index", "--chmod=+x", "f.txt"]);
    expect(await fp(dir, "f.txt")).not.toBe(c);
  });

  it.skipIf(process.platform === "win32")("changes on a worktree exec-bit change", async () => {
    const dir = await fixture();
    const a = await fp(dir, "f.txt");
    await fs.chmod(path.join(dir, "f.txt"), 0o755);
    expect(await fp(dir, "f.txt")).not.toBe(a);
  });

  it("changes when the file is replaced by a symlink (when symlinks can be created)", async () => {
    const dir = await fixture();
    const a = await fp(dir, "f.txt");
    await fs.rm(path.join(dir, "f.txt"));
    try {
      await fs.symlink("elsewhere", path.join(dir, "f.txt"));
    } catch {
      return; // no symlink privilege on this Windows host
    }
    expect(await fp(dir, "f.txt")).not.toBe(a);
  });

  it("covers binary content and a deleted worktree file", async () => {
    const dir = await fixture();
    await fs.writeFile(path.join(dir, "b.bin"), Buffer.from([0, 1, 2, 255]));
    await commit(dir, "bin");
    const clean = await fp(dir, "b.bin");
    await fs.writeFile(path.join(dir, "b.bin"), Buffer.from([0, 1, 2, 254]));
    const edited = await fp(dir, "b.bin");
    expect(edited).not.toBe(clean);
    await fs.rm(path.join(dir, "b.bin"));
    expect(await fp(dir, "b.bin")).not.toBe(edited);
  });

  it("handles an unborn HEAD and non-ASCII names", async () => {
    const dir = await initRepo();
    dirs.push(dir);
    await writeFile(dir, "ünï/日本.txt", "x");
    const a = await fp(dir, "ünï/日本.txt", "untracked");
    await writeFile(dir, "ünï/日本.txt", "y");
    expect(await fp(dir, "ünï/日本.txt", "untracked")).not.toBe(a);
  });

  it("differs between kinds and refuses a symlinked parent folder and traversal", async () => {
    const dir = await fixture();
    expect(await fp(dir, "f.txt", "tracked")).not.toBe(await fp(dir, "f.txt", "untracked"));
    await expect(fp(dir, "../x", "tracked")).rejects.toThrow();
    const outside = path.join(dir, "..", `${path.basename(dir)}-outside`);
    await fs.mkdir(outside);
    try {
      await fs.symlink(outside, path.join(dir, "link"), "junction");
    } catch {
      await fs.rm(outside, { recursive: true });
      return;
    }
    await writeFile(outside, "s.txt", "secret");
    await expect(fp(dir, "link/s.txt", "untracked")).rejects.toBeInstanceOf(DiscardFingerprintError);
    await fs.rm(outside, { recursive: true, force: true });
  });
});

describe("discardTrackedFileChanges with a fingerprint", () => {
  it("discards when the fingerprint matches and leaves the staged part of a mixed file", async () => {
    const dir = await fixture();
    await writeFile(dir, "f.txt", "staged\n");
    await git(dir, ["add", "f.txt"]);
    await writeFile(dir, "f.txt", "staged\nunstaged\n");
    const expectedFingerprint = await fp(dir, "f.txt");
    await discardTrackedFileChanges(dir, "f.txt", { expectedFingerprint });
    expect(await read(dir, "f.txt")).toBe("staged\n");
    expect((await git(dir, ["diff", "--cached", "--name-only"])).stdout.trim()).toBe("f.txt");
  });

  it("a stale fingerprint throws STALE_DIFF and changes nothing", async () => {
    const dir = await fixture();
    await writeFile(dir, "f.txt", "edit 1\n");
    const expectedFingerprint = await fp(dir, "f.txt");
    await writeFile(dir, "f.txt", "edit 2 landed late\n");
    const err = await discardTrackedFileChanges(dir, "f.txt", { expectedFingerprint }).catch((e) => e);
    expect(err).toBeInstanceOf(StaleDiffError);
    expect((err as StaleDiffError).code).toBe("STALE_DIFF");
    expect(await read(dir, "f.txt")).toBe("edit 2 landed late\n");
  });

  it("a stale index state also refuses", async () => {
    const dir = await fixture();
    await writeFile(dir, "f.txt", "edit\n");
    const expectedFingerprint = await fp(dir, "f.txt");
    await git(dir, ["add", "f.txt"]);
    await expect(discardTrackedFileChanges(dir, "f.txt", { expectedFingerprint })).rejects.toBeInstanceOf(StaleDiffError);
    expect(await read(dir, "f.txt")).toBe("edit\n");
  });

  it("verifies AFTER waiting for a running queued mutation, not before", async () => {
    const dir = await fixture();
    await writeFile(dir, "f.txt", "edit\n");
    const expectedFingerprint = await fp(dir, "f.txt");
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const blocker = runInMutationQueue(async () => {
      await gate;
      await writeFile(dir, "f.txt", "written by the earlier mutation\n");
    });
    const discard = discardTrackedFileChanges(dir, "f.txt", { expectedFingerprint }).catch((e) => e);
    await new Promise((r) => setTimeout(r, 100)); // the discard must be parked behind the blocker
    release();
    await blocker;
    expect(await discard).toBeInstanceOf(StaleDiffError);
    expect(await read(dir, "f.txt")).toBe("written by the earlier mutation\n");
  });

  it("keeps the pre-discard content as a loose blob and reports it", async () => {
    const dir = await fixture();
    await writeFile(dir, "f.txt", "precious unsaved work\n");
    let info: DiscardBackupInfo | undefined;
    await discardTrackedFileChanges(dir, "f.txt", { expectedFingerprint: await fp(dir, "f.txt"), onBackup: (i) => (info = i) });
    expect(await read(dir, "f.txt")).toBe("one\ntwo\n");
    expect(info?.oid).toMatch(/^[0-9a-f]{40,64}$/);
    expect((await git(dir, ["cat-file", "-p", info!.oid!])).stdout).toBe("precious unsaved work\n");
  });

  it("backs up binary content byte for byte and ignores clean filters", async () => {
    const dir = await fixture();
    await git(dir, ["config", "core.autocrlf", "true"]);
    const bytes = Buffer.from([0, 13, 10, 200, 255]);
    await fs.writeFile(path.join(dir, "f.txt"), bytes);
    let info: DiscardBackupInfo | undefined;
    await discardTrackedFileChanges(dir, "f.txt", { onBackup: (i) => (info = i) });
    await fs.writeFile(path.join(dir, "ref.bin"), bytes);
    const expected = (await git(dir, ["hash-object", "--no-filters", "ref.bin"])).stdout.trim();
    expect(info!.oid).toBe(expected);
  });

  it("still works without a fingerprint (existing callers) and backs up anyway", async () => {
    const dir = await fixture();
    await writeFile(dir, "f.txt", "x\n");
    let info: DiscardBackupInfo | undefined;
    await discardTrackedFileChanges(dir, "f.txt", { onBackup: (i) => (info = i) });
    expect(await read(dir, "f.txt")).toBe("one\ntwo\n");
    expect(info?.oid).not.toBeNull();
  });

  it("refuses without touching anything when the safety copy cannot be written", async () => {
    const dir = await fixture();
    await writeFile(dir, "f.txt", "keep me\n");
    // A broken object directory makes `hash-object -w` fail.
    const objects = path.join(dir, ".git", "objects");
    await fs.rename(objects, `${objects}-away`);
    await fs.writeFile(objects, "not a directory");
    try {
      const err = await discardTrackedFileChanges(dir, "f.txt").catch((e) => e);
      expect(err).toBeDefined();
      expect(await read(dir, "f.txt")).toBe("keep me\n");
    } finally {
      await fs.rm(objects, { force: true });
      await fs.rename(`${objects}-away`, objects);
    }
  });
});

describe("discardUntrackedFile with a fingerprint", () => {
  it("removes a matching file and keeps a backup blob", async () => {
    const dir = await fixture();
    await writeFile(dir, "n.txt", "brand new\n");
    let info: DiscardBackupInfo | undefined;
    await discardUntrackedFile(dir, "n.txt", { expectedFingerprint: await fp(dir, "n.txt", "untracked"), onBackup: (i) => (info = i) });
    await expect(fs.access(path.join(dir, "n.txt"))).rejects.toThrow();
    expect((await git(dir, ["cat-file", "-p", info!.oid!])).stdout).toBe("brand new\n");
  });

  it("a stale fingerprint throws STALE_DIFF and deletes nothing", async () => {
    const dir = await fixture();
    await writeFile(dir, "n.txt", "v1\n");
    const expectedFingerprint = await fp(dir, "n.txt", "untracked");
    await writeFile(dir, "n.txt", "v2 written after the check\n");
    await expect(discardUntrackedFile(dir, "n.txt", { expectedFingerprint })).rejects.toBeInstanceOf(StaleDiffError);
    expect(await read(dir, "n.txt")).toBe("v2 written after the check\n");
  });

  it("a large file (above the safety-copy cap) is discarded without a copy and says so", async () => {
    const dir = await fixture();
    await fs.writeFile(path.join(dir, "big.bin"), Buffer.alloc(65 * 1024 * 1024, 7));
    let info: DiscardBackupInfo | undefined;
    await discardUntrackedFile(dir, "big.bin", { expectedFingerprint: await fp(dir, "big.bin", "untracked"), onBackup: (i) => (info = i) });
    expect(info).toEqual({ oid: null, skipped: "too-large" });
    await expect(fs.access(path.join(dir, "big.bin"))).rejects.toThrow();
  });

  it("refuses an untracked directory (git clean -f -- <dir> would delete it recursively)", async () => {
    const dir = await fixture();
    await writeFile(dir, "d/inner.txt", "inner");
    await expect(discardUntrackedFile(dir, "d", { expectedFingerprint: await fp(dir, "d", "untracked") })).rejects.toBeInstanceOf(InvalidArgumentError);
    expect(await read(dir, "d/inner.txt")).toBe("inner");
  });

  it("refuses a path through a symlinked parent folder", async () => {
    const dir = await fixture();
    const outside = path.join(dir, "..", `${path.basename(dir)}-out2`);
    await fs.mkdir(outside);
    try {
      await fs.symlink(outside, path.join(dir, "lnk"), "junction");
    } catch {
      await fs.rm(outside, { recursive: true });
      return;
    }
    await writeFile(outside, "s.txt", "secret");
    await expect(discardUntrackedFile(dir, "lnk/s.txt")).rejects.toBeInstanceOf(DiscardFingerprintError);
    expect(await fs.readFile(path.join(outside, "s.txt"), "utf8")).toBe("secret");
    await fs.rm(outside, { recursive: true, force: true });
  });
});
