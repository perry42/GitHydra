import * as fs from "node:fs/promises";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { configure, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "./App";
import { createRealGitHydraApi, type RealGitHydraHandle } from "./test/realGitHydraApi";
import { cleanup, commitAll, git, initRepo, writeFile } from "./test/gitFixture";

// Real `git` child-process spawns underneath every `waitFor`, same rationale as
// `App.stash.e2e.test.tsx`/`App.cherryPick.e2e.test.tsx` (RTL's default 1000ms timeout is too
// tight for that).
configure({ asyncUtilTimeout: 12000 });

/**
 * specs/image-diff-preview.md — the acceptance-criteria sweep that needs the REAL running app,
 * not a mocked `window.gitHydra`: does selecting a real image-eligible file in ChangesPanel or
 * DetailPanel actually round-trip real base64 bytes read by real git-core (`cat-file`/`fs.readFile`)
 * all the way into a real `<img src="data:...">` in the DOM, does an `.svg` (which git itself would
 * happily text-diff) really take the image path instead, does a non-image binary really keep the
 * unchanged generic message, and — the boundary-crossing property this spec cares about most
 * (AC9) — is the resulting DiffView markup identical whether reached via ChangesPanel (a
 * working-directory change) or DetailPanel (a historical commit). Every test here renders the REAL
 * `<App/>` component tree against a REAL `GitHydraApi` backed by a REAL `RepoSession`/`Repository`
 * shelling out to a REAL `git` binary against a REAL temp repo on disk (`./test/realGitHydraApi.ts`)
 * — no git-core mocking anywhere in this file.
 *
 * Each test opens its own independent temp repo (no shared fixture state, no ordering dependency).
 */

const handles: RealGitHydraHandle[] = [];
const dirs: string[] = [];

afterEach(async () => {
  // @ts-expect-error test cleanup of the global bridge
  delete window.gitHydra;
  // Same grace window App.stash.e2e.test.tsx/App.cherryPick.e2e.test.tsx use before disposing.
  await new Promise((resolve) => setTimeout(resolve, 350));
  while (handles.length) handles.pop()!.dispose();
  while (dirs.length) {
    const dir = dirs.pop()!;
    try {
      await cleanup(dir);
    } catch {
      // Best-effort: an occasional Windows file-lock shouldn't fail this test's own assertions.
    }
  }
});

async function openAppOn(dir: string): Promise<RealGitHydraHandle> {
  const handle = createRealGitHydraApi();
  handles.push(handle);
  handle.setDialogPath(dir);
  window.gitHydra = handle.api;
  render(<App />);
  await userEvent.click(screen.getByRole("button", { name: "Open a repository" }));
  await screen.findByRole("button", { name: /stashes/i }, { timeout: 10000 });
  return handle;
}

async function openChangesPanel(): Promise<HTMLElement> {
  await userEvent.click(await screen.findByRole("button", { name: /^changes/i }));
  return screen.findByRole("complementary", { name: "Changes" });
}

async function graphRegion(): Promise<HTMLElement> {
  return screen.findByRole("listbox", { name: /commit graph/i });
}

async function rowFor(subject: string): Promise<HTMLElement> {
  const graph = await graphRegion();
  const text = await within(graph).findByText(subject);
  const row = text.closest('[role="option"]');
  if (!row) throw new Error(`row not found for subject: ${subject}`);
  return row as HTMLElement;
}

/** Writes raw (possibly non-UTF-8) bytes — unlike `gitFixture.ts`'s `writeFile()`, which is
 * utf8-text-only. Test-only helper local to this file (not a shared fixture edit). */
async function writeBinaryFile(repoDir: string, relPath: string, data: Buffer): Promise<void> {
  const full = path.join(repoDir, relPath);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, data);
}

/** A tiny "PNG-shaped" byte sequence: real PNG magic bytes plus a marker byte and trailing bytes
 * that are NOT valid UTF-8 on their own — proves the real base64 payload that crossed from
 * git-core through the IPC contract into the DOM's `<img src>` round-trips exactly, the same way
 * `imageDiff.test.ts` proves it at the git-core layer alone. */
function pngBytes(marker: number): Buffer {
  return Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, marker, 0xff, 0xfe, 0x00, 0x01]);
}

/** A real "binary" (non-text) payload by git's own NUL-byte content-sniffing heuristic — used for
 * AC6's non-image-extension binary file, which must be entirely unaffected by this spec. */
function binaryZipBytes(marker: number): Buffer {
  return Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00, marker, 0xff, 0x00, 0x00]);
}

/** Extracts and decodes the base64 payload from a rendered `<img src="data:...">`, so assertions
 * compare real decoded bytes rather than trusting the src string shape alone. */
function decodeImgSrc(img: Element): { mimeType: string; bytes: Buffer } {
  const src = img.getAttribute("src") ?? "";
  const match = /^data:([^;]+);base64,(.*)$/.exec(src);
  if (!match) throw new Error(`unexpected <img> src: ${src}`);
  return { mimeType: match[1]!, bytes: Buffer.from(match[2]!, "base64") };
}

/** Scopes queries to the currently-rendered `DiffView` region (`aria-label="Diff for ..."`),
 * regardless of which caller (ChangesPanel/DetailPanel) mounted it — the same region both callers
 * render into, per AC9. */
async function diffRegion(): Promise<HTMLElement> {
  return screen.findByRole("region", { name: /^Diff for /i });
}

describe("specs/image-diff-preview.md — real App + real git-core integration", () => {
  it(
    "AC1: a modified .png in ChangesPanel (working directory) shows real Before/After images with byte-exact content and correct captions",
    async () => {
      const dir = await initRepo();
      dirs.push(dir);
      await writeBinaryFile(dir, "icon.png", pngBytes(1));
      await commitAll(dir, "base icon");
      await writeBinaryFile(dir, "icon.png", pngBytes(2));

      await openAppOn(dir);
      await openChangesPanel();
      const region = await diffRegion();

      await waitFor(() => expect(within(region).getAllByRole("img")).toHaveLength(2));
      expect(within(region).getByText(/^Before · 13 B$/, { selector: "figcaption" })).toBeInTheDocument();
      expect(within(region).getByText(/^After · 13 B$/, { selector: "figcaption" })).toBeInTheDocument();

      const images = within(region).getAllByRole("img");
      const before = decodeImgSrc(images[0]!);
      const after = decodeImgSrc(images[1]!);
      expect(before.mimeType).toBe("image/png");
      expect(before.bytes).toEqual(pngBytes(1));
      expect(after.mimeType).toBe("image/png");
      expect(after.bytes).toEqual(pngBytes(2));
    },
    30000,
  );

  it(
    "AC2: a newly added untracked .jpg in ChangesPanel shows only the new image, labeled Added, with no old-image slot",
    async () => {
      const dir = await initRepo();
      dirs.push(dir);
      await writeFile(dir, "readme.txt", "base\n");
      await commitAll(dir, "base");
      await writeBinaryFile(dir, "photo.jpg", pngBytes(9));

      await openAppOn(dir);
      await openChangesPanel();
      const region = await diffRegion();

      await waitFor(() => expect(within(region).getAllByRole("img")).toHaveLength(1));
      expect(within(region).getByText(/^Added · 13 B$/, { selector: "figcaption" })).toBeInTheDocument();
      expect(within(region).queryByText(/^Before/, { selector: "figcaption" })).not.toBeInTheDocument();

      const image = within(region).getByRole("img");
      const decoded = decodeImgSrc(image);
      expect(decoded.mimeType).toBe("image/jpeg");
      expect(decoded.bytes).toEqual(pngBytes(9));
    },
    30000,
  );

  it(
    "AC3: a staged deletion of a .gif in ChangesPanel shows only the old image, labeled Deleted",
    async () => {
      const dir = await initRepo();
      dirs.push(dir);
      await writeBinaryFile(dir, "anim.gif", pngBytes(1));
      await commitAll(dir, "base gif");
      await git(dir, ["rm", "-q", "anim.gif"]);

      await openAppOn(dir);
      await openChangesPanel();
      const region = await diffRegion();

      await waitFor(() => expect(within(region).getAllByRole("img")).toHaveLength(1));
      expect(within(region).getByText(/^Deleted · 13 B$/, { selector: "figcaption" })).toBeInTheDocument();
      expect(within(region).queryByText(/^Added/, { selector: "figcaption" })).not.toBeInTheDocument();

      const decoded = decodeImgSrc(within(region).getByRole("img"));
      expect(decoded.mimeType).toBe("image/gif");
      expect(decoded.bytes).toEqual(pngBytes(1));
    },
    30000,
  );

  it(
    "AC4: a renamed .ico with modified content, viewed in DetailPanel for the historical commit, sources Before from the old path's content and After from the new path's content",
    async () => {
      const dir = await initRepo();
      dirs.push(dir);
      await writeBinaryFile(dir, "old.ico", pngBytes(1));
      await commitAll(dir, "base icon");
      await git(dir, ["mv", "old.ico", "new.ico"]);
      await writeBinaryFile(dir, "new.ico", pngBytes(2));
      await commitAll(dir, "rename and tweak icon");

      await openAppOn(dir);
      await userEvent.click(await rowFor("rename and tweak icon"));
      await screen.findByRole("complementary", { name: "Commit details" });
      const region = await diffRegion();

      await waitFor(() => expect(within(region).getAllByRole("img")).toHaveLength(2));
      const images = within(region).getAllByRole("img");
      const before = decodeImgSrc(images[0]!);
      const after = decodeImgSrc(images[1]!);
      // Before must be sourced from old.ico's committed content, After from new.ico's — not both
      // accidentally reading the same (new) path, which would be the natural bug for a rename.
      expect(before.bytes).toEqual(pngBytes(1));
      expect(after.bytes).toEqual(pngBytes(2));
    },
    30000,
  );

  it(
    "AC5: an .svg selected in ChangesPanel renders as an image preview (real <img>, no text hunks) even though git itself would happily produce a real text diff for it",
    async () => {
      const dir = await initRepo();
      dirs.push(dir);
      await writeFile(dir, "logo.svg", "<svg><circle r='1'/></svg>\n");
      await commitAll(dir, "base svg");
      await writeFile(dir, "logo.svg", "<svg><circle r='2'/></svg>\n");

      // Ground truth: git itself treats this as ordinary, diffable TEXT (not binary) — proves the
      // image-preview path is a deliberate override, not a case that git's own binary detection
      // would have produced anyway.
      const { stdout: rawDiff } = await git(dir, ["diff", "--", "logo.svg"]);
      expect(rawDiff).toContain("@@");
      expect(rawDiff).not.toMatch(/^Binary files /m);

      await openAppOn(dir);
      await openChangesPanel();
      const region = await diffRegion();

      await waitFor(() => expect(within(region).getAllByRole("img")).toHaveLength(2));
      const images = within(region).getAllByRole("img");
      expect(decodeImgSrc(images[0]!).mimeType).toBe("image/svg+xml");
      expect(decodeImgSrc(images[1]!).mimeType).toBe("image/svg+xml");
      expect(decodeImgSrc(images[1]!).bytes.toString("utf8")).toContain("circle r='2'");
      // No text-hunk rendering anywhere in the diff region — the image path, not the text-diff
      // path, is what actually rendered.
      expect(region.querySelector(".gh-diff-view__hunks")).toBeNull();
      // Never inline markup (dangerouslySetInnerHTML) — only an <img>, so a hostile .svg can't
      // execute script the way an inline <svg>/<iframe> could.
      expect(region.querySelector("svg")).toBeNull();
    },
    30000,
  );

  it(
    "AC6: a non-image binary file (.zip, extension outside the FR-139 list) selected in ChangesPanel keeps the unchanged generic Binary file message — no image call, no <img>",
    async () => {
      const dir = await initRepo();
      dirs.push(dir);
      await writeBinaryFile(dir, "archive.zip", binaryZipBytes(1));
      await commitAll(dir, "base zip");
      await writeBinaryFile(dir, "archive.zip", binaryZipBytes(2));

      await openAppOn(dir);
      await openChangesPanel();
      const region = await diffRegion();

      await waitFor(() => expect(within(region).getByText(/binary file/i)).toBeInTheDocument());
      expect(within(region).queryByRole("img")).not.toBeInTheDocument();
      expect(within(region).queryByText(/^Before/, { selector: "figcaption" })).not.toBeInTheDocument();
    },
    30000,
  );

  it(
    "AC9: an equivalent modified image renders with the same structure (Before/After captions with byte sizes, two real <img> elements) whether reached via ChangesPanel (working directory) or DetailPanel (a historical commit)",
    async () => {
      const dir = await initRepo();
      dirs.push(dir);
      // File A: a working-directory (unstaged) image change, viewed via ChangesPanel.
      await writeBinaryFile(dir, "a.bmp", pngBytes(1));
      // File B: a fully historical image change (both versions committed), viewed via DetailPanel.
      await writeBinaryFile(dir, "b.bmp", pngBytes(3));
      await commitAll(dir, "base a and b");
      await writeBinaryFile(dir, "a.bmp", pngBytes(2)); // left unstaged — NOT added below
      await writeBinaryFile(dir, "b.bmp", pngBytes(4));
      // Stage/commit only b.bmp (not `commitAll`'s `git add -A`, which would also sweep up
      // a.bmp's edit above and defeat the point of this test: a.bmp must stay unstaged).
      await git(dir, ["add", "b.bmp"]);
      await git(dir, ["commit", "-q", "-m", "update b"]);

      await openAppOn(dir);

      // Via ChangesPanel: a.bmp's unstaged change.
      await openChangesPanel();
      const changesRegion = await diffRegion();
      await waitFor(() => expect(within(changesRegion).getAllByRole("img")).toHaveLength(2));
      expect(within(changesRegion).getByText(/^Before · 13 B$/, { selector: "figcaption" })).toBeInTheDocument();
      expect(within(changesRegion).getByText(/^After · 13 B$/, { selector: "figcaption" })).toBeInTheDocument();
      const changesImages = within(changesRegion).getAllByRole("img");
      expect(decodeImgSrc(changesImages[0]!).bytes).toEqual(pngBytes(1));
      expect(decodeImgSrc(changesImages[1]!).bytes).toEqual(pngBytes(2));

      // Via DetailPanel: b.bmp's fully-historical change in the "update b" commit — same caption
      // wording, same two-image structure, same byte-exact sourcing, reached through an entirely
      // different IPC channel (getCommitImageDiff vs. getUnstagedImageDiff).
      await userEvent.click(await rowFor("update b"));
      await screen.findByRole("complementary", { name: "Commit details" });
      const detailRegion = await diffRegion();
      await waitFor(() => expect(within(detailRegion).getAllByRole("img")).toHaveLength(2));
      expect(within(detailRegion).getByText(/^Before · 13 B$/, { selector: "figcaption" })).toBeInTheDocument();
      expect(within(detailRegion).getByText(/^After · 13 B$/, { selector: "figcaption" })).toBeInTheDocument();
      const detailImages = within(detailRegion).getAllByRole("img");
      expect(decodeImgSrc(detailImages[0]!).bytes).toEqual(pngBytes(3));
      expect(decodeImgSrc(detailImages[1]!).bytes).toEqual(pngBytes(4));
    },
    30000,
  );
});
