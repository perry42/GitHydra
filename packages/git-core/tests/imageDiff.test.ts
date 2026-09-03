import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  getImageDiff,
  isImageEligiblePath,
  IMAGE_EXTENSION_MIME_TYPES,
  MAX_IMAGE_SIDE_BYTES,
} from "../src/imageDiff";
import { Repository } from "../src/index";
import { InvalidArgumentError } from "../src/errors";
import type { ImageDiffResult } from "../src/types";
import {
  git,
  initRepo,
  writeFile,
  commit,
  cleanup,
  makeTempDir,
  fileExists,
  setUpMaliciousFsmonitorRepo,
} from "./testRepo";

const cleanupDirs: string[] = [];
afterEach(async () => {
  while (cleanupDirs.length) await cleanup(cleanupDirs.pop()!);
});

/** Writes raw (possibly non-UTF-8) bytes, unlike `testRepo.ts`'s `writeFile()` (utf8 text only). */
async function writeBinaryFile(dir: string, relPath: string, data: Buffer): Promise<void> {
  const full = path.join(dir, relPath);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, data);
}

/** A tiny "PNG-shaped" byte sequence: real PNG magic bytes plus a marker byte and trailing bytes
 * (0xff 0xfe) that are NOT valid UTF-8 on their own — proves `getImageDiff` round-trips bytes
 * exactly (via `runGitBuffer`) rather than corrupting them the way `runGit`'s UTF-8 string
 * decoding would (any invalid sequence silently becomes U+FFFD). */
function pngBytes(marker: number): Buffer {
  return Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, marker, 0xff, 0xfe, 0x00, 0x01]);
}

function decodeBlob(result: ImageDiffResult, side: "old" | "new"): Buffer {
  if (result.status !== "ok") throw new Error(`expected ok, got ${result.status}`);
  const blob = result[side];
  if (!blob) throw new Error(`expected a ${side} blob, got null`);
  return Buffer.from(blob.base64, "base64");
}

describe("isImageEligiblePath / IMAGE_EXTENSION_MIME_TYPES (FR-139)", () => {
  it("is eligible for every extension on the fixed allowlist, case-insensitively", () => {
    for (const ext of Object.keys(IMAGE_EXTENSION_MIME_TYPES)) {
      expect(isImageEligiblePath(`file${ext}`)).toBe(true);
      expect(isImageEligiblePath(`file${ext.toUpperCase()}`)).toBe(true);
      expect(isImageEligiblePath(`nested/dir/file${ext}`)).toBe(true);
    }
  });

  it("maps each extension to the expected MIME type", () => {
    expect(IMAGE_EXTENSION_MIME_TYPES[".png"]).toBe("image/png");
    expect(IMAGE_EXTENSION_MIME_TYPES[".ico"]).toBe("image/x-icon");
    expect(IMAGE_EXTENSION_MIME_TYPES[".jpg"]).toBe("image/jpeg");
    expect(IMAGE_EXTENSION_MIME_TYPES[".jpeg"]).toBe("image/jpeg");
    expect(IMAGE_EXTENSION_MIME_TYPES[".gif"]).toBe("image/gif");
    expect(IMAGE_EXTENSION_MIME_TYPES[".bmp"]).toBe("image/bmp");
    expect(IMAGE_EXTENSION_MIME_TYPES[".svg"]).toBe("image/svg+xml");
  });

  it("is not eligible for an extension outside the fixed list, or no extension at all", () => {
    expect(isImageEligiblePath("archive.zip")).toBe(false);
    expect(isImageEligiblePath("document.pdf")).toBe(false);
    expect(isImageEligiblePath("design.psd")).toBe(false);
    expect(isImageEligiblePath("modern.webp")).toBe(false);
    expect(isImageEligiblePath("noextension")).toBe(false);
  });
});

describe("getImageDiff (FR-140)", () => {
  it("returns the unstaged (worktree vs index) image diff, both sides byte-exact", async () => {
    const dir = await initRepo();
    cleanupDirs.push(dir);
    await writeBinaryFile(dir, "a.png", pngBytes(1));
    await commit(dir, "base png");
    await writeBinaryFile(dir, "a.png", pngBytes(2));

    const result = await getImageDiff(dir, { kind: "unstaged", path: "a.png" });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error("expected ok");
    expect(result.old!.mimeType).toBe("image/png");
    expect(result.new!.mimeType).toBe("image/png");
    expect(decodeBlob(result, "old")).toEqual(pngBytes(1));
    expect(decodeBlob(result, "new")).toEqual(pngBytes(2));
    expect(result.old!.byteSize).toBe(pngBytes(1).length);
    expect(result.new!.byteSize).toBe(pngBytes(2).length);
  });

  it("returns the staged (index vs HEAD) image diff, distinct from a further unstaged edit", async () => {
    const dir = await initRepo();
    cleanupDirs.push(dir);
    await writeBinaryFile(dir, "a.png", pngBytes(1));
    await commit(dir, "base png");
    await writeBinaryFile(dir, "a.png", pngBytes(2));
    await git(dir, ["add", "a.png"]);
    await writeBinaryFile(dir, "a.png", pngBytes(3));

    const staged = await getImageDiff(dir, { kind: "staged", path: "a.png" });
    const unstaged = await getImageDiff(dir, { kind: "unstaged", path: "a.png" });
    if (staged.status !== "ok" || unstaged.status !== "ok") throw new Error("expected ok");

    expect(decodeBlob(staged, "old")).toEqual(pngBytes(1)); // HEAD
    expect(decodeBlob(staged, "new")).toEqual(pngBytes(2)); // index
    expect(decodeBlob(unstaged, "old")).toEqual(pngBytes(2)); // index
    expect(decodeBlob(unstaged, "new")).toEqual(pngBytes(3)); // worktree
  });

  it("returns only a new-side blob for an untracked (newly added) image, old is null", async () => {
    const dir = await initRepo();
    cleanupDirs.push(dir);
    await writeFile(dir, "base.txt", "1");
    await commit(dir, "base");
    await writeBinaryFile(dir, "new.jpg", pngBytes(9));

    const result = await getImageDiff(dir, { kind: "untracked", path: "new.jpg" });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error("expected ok");
    expect(result.old).toBeNull();
    expect(result.new).not.toBeNull();
    expect(result.new!.mimeType).toBe("image/jpeg");
    expect(decodeBlob(result, "new")).toEqual(pngBytes(9));
  });

  it("returns only an old-side blob for an unstaged deletion (removed from worktree, still in index)", async () => {
    const dir = await initRepo();
    cleanupDirs.push(dir);
    await writeBinaryFile(dir, "a.gif", pngBytes(1));
    await commit(dir, "base gif");
    await fs.rm(path.join(dir, "a.gif"));

    const result = await getImageDiff(dir, { kind: "unstaged", path: "a.gif" });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error("expected ok");
    expect(result.new).toBeNull();
    expect(decodeBlob(result, "old")).toEqual(pngBytes(1));
  });

  it("returns only an old-side blob for a staged deletion (git rm), new is null", async () => {
    const dir = await initRepo();
    cleanupDirs.push(dir);
    await writeBinaryFile(dir, "a.gif", pngBytes(1));
    await commit(dir, "base gif");
    await git(dir, ["rm", "-q", "a.gif"]);

    const result = await getImageDiff(dir, { kind: "staged", path: "a.gif" });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error("expected ok");
    expect(result.new).toBeNull();
    expect(decodeBlob(result, "old")).toEqual(pngBytes(1));
  });

  it("diffs a historical commit's image against its parent", async () => {
    const dir = await initRepo();
    cleanupDirs.push(dir);
    await writeBinaryFile(dir, "a.bmp", pngBytes(1));
    await commit(dir, "first");
    await writeBinaryFile(dir, "a.bmp", pngBytes(2));
    const secondSha = await commit(dir, "second");
    const parentSha = (await git(dir, ["rev-parse", `${secondSha}^`])).stdout.trim();

    const result = await getImageDiff(dir, {
      kind: "commit",
      sha: secondSha,
      parents: [parentSha],
      path: "a.bmp",
    });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error("expected ok");
    expect(decodeBlob(result, "old")).toEqual(pngBytes(1));
    expect(decodeBlob(result, "new")).toEqual(pngBytes(2));
  });

  it("diffs a root commit's added image against the empty tree: old is null", async () => {
    const dir = await initRepo();
    cleanupDirs.push(dir);
    await writeBinaryFile(dir, "root.png", pngBytes(7));
    const rootSha = await commit(dir, "root");

    const result = await getImageDiff(dir, { kind: "commit", sha: rootSha, parents: [], path: "root.png" });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error("expected ok");
    expect(result.old).toBeNull();
    expect(decodeBlob(result, "new")).toEqual(pngBytes(7));
  });

  it("diffs a commit that deletes an image: new is null", async () => {
    const dir = await initRepo();
    cleanupDirs.push(dir);
    await writeBinaryFile(dir, "gone.gif", pngBytes(1));
    await commit(dir, "add gone.gif");
    await fs.rm(path.join(dir, "gone.gif"));
    const deleteSha = await commit(dir, "delete gone.gif");
    const parentSha = (await git(dir, ["rev-parse", `${deleteSha}^`])).stdout.trim();

    const result = await getImageDiff(dir, {
      kind: "commit",
      sha: deleteSha,
      parents: [parentSha],
      path: "gone.gif",
    });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error("expected ok");
    expect(result.new).toBeNull();
    expect(decodeBlob(result, "old")).toEqual(pngBytes(1));
  });

  it("diffs a renamed-with-extension-change image, sourcing each side from its own path/mimeType", async () => {
    const dir = await initRepo();
    cleanupDirs.push(dir);
    await writeBinaryFile(dir, "icon.png", pngBytes(1));
    await commit(dir, "base icon");
    await git(dir, ["mv", "icon.png", "icon.jpg"]);
    await writeBinaryFile(dir, "icon.jpg", pngBytes(2));
    const renameSha = await commit(dir, "rename and tweak icon");
    const parentSha = (await git(dir, ["rev-parse", `${renameSha}^`])).stdout.trim();

    const result = await getImageDiff(dir, {
      kind: "commit",
      sha: renameSha,
      parents: [parentSha],
      path: "icon.jpg",
      oldPath: "icon.png",
    });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error("expected ok");
    expect(result.old!.mimeType).toBe("image/png");
    expect(result.new!.mimeType).toBe("image/jpeg");
    expect(decodeBlob(result, "old")).toEqual(pngBytes(1));
    expect(decodeBlob(result, "new")).toEqual(pngBytes(2));
  });

  it("treats a .svg as image-eligible (independent of it being ordinary text to git)", async () => {
    const dir = await initRepo();
    cleanupDirs.push(dir);
    await writeFile(dir, "icon.svg", "<svg><circle r='1'/></svg>\n");
    await commit(dir, "base svg");
    await writeFile(dir, "icon.svg", "<svg><circle r='2'/></svg>\n");

    const result = await getImageDiff(dir, { kind: "unstaged", path: "icon.svg" });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error("expected ok");
    expect(result.old!.mimeType).toBe("image/svg+xml");
    expect(result.new!.mimeType).toBe("image/svg+xml");
    expect(decodeBlob(result, "new").toString("utf8")).toContain("circle r='2'");
  });

  it("rejects a file whose path is not image-eligible on either side", async () => {
    const dir = await initRepo();
    cleanupDirs.push(dir);
    await writeFile(dir, "base.txt", "1");
    await commit(dir, "base");
    await writeFile(dir, "archive.zip", "not an image");

    await expect(getImageDiff(dir, { kind: "untracked", path: "archive.zip" })).rejects.toBeInstanceOf(
      InvalidArgumentError,
    );
  });

  // Regression: the same arbitrary-file-read guard `diff.ts`'s "untracked"/"unstaged"/"staged"
  // sources already enforce (see `diff.test.ts`'s "path containment" describe block) must hold
  // here too, since `getImageDiff` reads working-tree bytes directly via `resolveRealPathWithinWorkdir`.
  describe("path containment (arbitrary-file-read guard)", () => {
    it("rejects a path-traversal escape for the untracked source, without leaking the target file's content", async () => {
      const outside = await makeTempDir();
      cleanupDirs.push(outside);
      await writeBinaryFile(outside, "secret.png", pngBytes(99));

      const dir = await initRepo();
      cleanupDirs.push(dir);
      await writeFile(dir, "base.txt", "1");
      await commit(dir, "base");

      const relTraversal = path
        .relative(dir, path.join(outside, "secret.png"))
        .split(path.sep)
        .join("/");
      expect(relTraversal.startsWith("..")).toBe(true);

      await expect(
        getImageDiff(dir, { kind: "untracked", path: relTraversal }),
      ).rejects.toBeInstanceOf(InvalidArgumentError);
    });

    it("rejects an absolute path for the unstaged/staged sources too (defense in depth)", async () => {
      const dir = await initRepo();
      cleanupDirs.push(dir);
      await writeFile(dir, "base.txt", "1");
      await commit(dir, "base");

      await expect(
        getImageDiff(dir, { kind: "unstaged", path: "../outside.png" }),
      ).rejects.toBeInstanceOf(InvalidArgumentError);
      await expect(
        getImageDiff(dir, { kind: "staged", path: "../outside.png" }),
      ).rejects.toBeInstanceOf(InvalidArgumentError);
    });
  });

  // Regression: any git invocation that refreshes working-tree/index state against an untrusted
  // repo must neutralize `core.fsmonitor` — see `gitProcess.ts`'s `withFsmonitorNeutralized` doc
  // comment and `diff.test.ts`'s identical guard for `getFileDiff`'s "unstaged"/"staged" sources.
  describe("fsmonitor argument-injection guard", () => {
    it("getImageDiff (unstaged/staged sources) does NOT execute a malicious core.fsmonitor command", async () => {
      const { dir, markerPath } = await setUpMaliciousFsmonitorRepo(cleanupDirs, { seedCommit: false });
      await writeBinaryFile(dir, "a.png", pngBytes(1));
      await git(dir, ["add", "a.png"]);
      await git(dir, ["commit", "-q", "-m", "base png"]);
      await writeBinaryFile(dir, "a.png", pngBytes(2));
      // Setup above used raw, unguarded `git()` calls, which DO trip the malicious hook — reset
      // the marker so the assertions below are isolated to `getImageDiff`'s own calls.
      await fs.rm(markerPath, { force: true });
      expect(await fileExists(markerPath)).toBe(false);

      const unstaged = await getImageDiff(dir, { kind: "unstaged", path: "a.png" });
      expect(unstaged.status).toBe("ok");
      expect(await fileExists(markerPath)).toBe(false);

      const staged = await getImageDiff(dir, { kind: "staged", path: "a.png" });
      expect(staged.status).toBe("ok");
      expect(await fileExists(markerPath)).toBe(false);
    });
  });
});

describe("getImageDiff too-large guard (FR-141)", () => {
  // Deliberately real >25MB content (this guard is non-configurable, unlike `diff.ts`'s FR-22
  // guard, which tests override via `DiffOptions.maxFileSizeBytes` — there is no such override
  // here to use instead).
  const OVER_LIMIT_SIZE = MAX_IMAGE_SIDE_BYTES + 1024;
  const BIG_BYTES = Buffer.alloc(OVER_LIMIT_SIZE, 0x41);

  it("reports the old side too-large for a committed oversized image (blob-size guard), without reading its bytes", async () => {
    const dir = await initRepo();
    cleanupDirs.push(dir);
    await writeBinaryFile(dir, "a.png", BIG_BYTES);
    await commit(dir, "huge base png");
    await writeBinaryFile(dir, "a.png", pngBytes(1));
    await git(dir, ["add", "a.png"]);

    const result = await getImageDiff(dir, { kind: "staged", path: "a.png" });
    expect(result.status).toBe("too-large");
    if (result.status !== "too-large") throw new Error("expected too-large");
    expect(result.side).toBe("old");
  }, 30000);

  it("reports the new side too-large for an untracked oversized image (workdir-size guard), without reading its bytes", async () => {
    const dir = await initRepo();
    cleanupDirs.push(dir);
    await writeFile(dir, "base.txt", "1");
    await commit(dir, "base");
    await writeBinaryFile(dir, "huge.png", BIG_BYTES);

    const result = await getImageDiff(dir, { kind: "untracked", path: "huge.png" });
    expect(result.status).toBe("too-large");
    if (result.status !== "too-large") throw new Error("expected too-large");
    expect(result.side).toBe("new");
  }, 30000);

  it("reports both sides too-large when neither the index nor the worktree version fits", async () => {
    const dir = await initRepo();
    cleanupDirs.push(dir);
    await writeBinaryFile(dir, "c.png", BIG_BYTES);
    await commit(dir, "huge base");
    await writeBinaryFile(dir, "c.png", Buffer.alloc(OVER_LIMIT_SIZE, 0x42));

    const result = await getImageDiff(dir, { kind: "unstaged", path: "c.png" });
    expect(result.status).toBe("too-large");
    if (result.status !== "too-large") throw new Error("expected too-large");
    expect(result.side).toBe("both");
  }, 30000);
});

describe("Repository facade (FR-142)", () => {
  it("getUnstagedImageDiff/getStagedImageDiff/getUntrackedImageDiff/getCommitImageDiff wire through to getImageDiff correctly", async () => {
    const dir = await initRepo();
    cleanupDirs.push(dir);
    await writeBinaryFile(dir, "a.png", pngBytes(1));
    const firstSha = await commit(dir, "first");
    await writeBinaryFile(dir, "a.png", pngBytes(2));
    const secondSha = await commit(dir, "second");
    await writeBinaryFile(dir, "a.png", pngBytes(3));
    await git(dir, ["add", "a.png"]);
    await writeBinaryFile(dir, "a.png", pngBytes(4));
    await writeBinaryFile(dir, "untracked.jpg", pngBytes(5));

    const repo = await Repository.open(dir);

    const unstaged = await repo.getUnstagedImageDiff("a.png");
    if (unstaged.status !== "ok") throw new Error("expected ok");
    expect(decodeBlob(unstaged, "old")).toEqual(pngBytes(3));
    expect(decodeBlob(unstaged, "new")).toEqual(pngBytes(4));

    const staged = await repo.getStagedImageDiff("a.png");
    if (staged.status !== "ok") throw new Error("expected ok");
    expect(decodeBlob(staged, "old")).toEqual(pngBytes(2));
    expect(decodeBlob(staged, "new")).toEqual(pngBytes(3));

    const untracked = await repo.getUntrackedImageDiff("untracked.jpg");
    if (untracked.status !== "ok") throw new Error("expected ok");
    expect(untracked.old).toBeNull();
    expect(decodeBlob(untracked, "new")).toEqual(pngBytes(5));

    const parentSha = (await git(dir, ["rev-parse", `${secondSha}^`])).stdout.trim();
    expect(parentSha).toBe(firstSha);
    const historical = await repo.getCommitImageDiff(
      { sha: secondSha, parents: [parentSha] },
      { path: "a.png" },
    );
    if (historical.status !== "ok") throw new Error("expected ok");
    expect(decodeBlob(historical, "old")).toEqual(pngBytes(1));
    expect(decodeBlob(historical, "new")).toEqual(pngBytes(2));
  });

  it("throws a typed InvalidArgumentError (same bare-repo convention as the FR-20 *FileDiff methods) for unstaged/staged/untracked against a bare repo", async () => {
    const dir = await initRepo({ bare: true });
    cleanupDirs.push(dir);
    const repo = await Repository.open(dir);

    await expect(repo.getUnstagedImageDiff("a.png")).rejects.toBeInstanceOf(InvalidArgumentError);
    await expect(repo.getStagedImageDiff("a.png")).rejects.toBeInstanceOf(InvalidArgumentError);
    await expect(repo.getUntrackedImageDiff("a.png")).rejects.toBeInstanceOf(InvalidArgumentError);
  });

  it("getCommitImageDiff still works against a bare repo (no working directory required), same as getCommitFileDiff", async () => {
    const dir = await initRepo();
    cleanupDirs.push(dir);
    await writeBinaryFile(dir, "a.png", pngBytes(1));
    await commit(dir, "first");
    await writeBinaryFile(dir, "a.png", pngBytes(2));
    const secondSha = await commit(dir, "second");
    const parentSha = (await git(dir, ["rev-parse", `${secondSha}^`])).stdout.trim();

    const bareDir = await initRepo({ bare: true });
    cleanupDirs.push(bareDir);
    await git(dir, ["push", "-q", bareDir, "main"]).catch(async () => {
      await git(bareDir, ["fetch", "-q", dir, "main:main"]);
    });

    const repo = await Repository.open(bareDir);
    const result = await repo.getCommitImageDiff({ sha: secondSha, parents: [parentSha] }, { path: "a.png" });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error("expected ok");
    expect(decodeBlob(result, "new")).toEqual(pngBytes(2));
  });
});
