# PRD: Image Diff Preview

Status: draft — small, contained addition; not part of the v1 build order (v1 is complete per
`CLAUDE.md`)
Owner: product-manager

Extends `specs/stage-unstage-diff.md`'s FR-21 ("binary files ... instead of attempting [a text
diff]"), which was never image-aware — every binary file renders the same flat "Binary file —
content not shown." message today (`DiffView.tsx`), regardless of type. This was a gap left open
by FR-21, not a deliberate v1 non-goal (images aren't mentioned in that spec's "Non-goals" section
at all).

## Problem

A developer who changes an icon, a screenshot fixture, or any other image asset sees the exact
same unhelpful "Binary file — content not shown." message a `.zip` or `.pdf` would produce — no
way to tell *what* changed without leaving GitHydra for a file manager or image tool. Every
comparable git GUI (GitKraken, Sourcetree, Fork) shows the image itself.

## Target user

Same as `specs/stage-unstage-diff.md`: a developer working against any local-only, GitHub/GitLab/
Bitbucket/self-hosted, or no-remote repo, viewing an image change either in the Changes panel
(working-directory diff) or the commit DetailPanel (a historical commit's diff) — both callers of
the shared `DiffView` component must work identically.

## Must-have behavior

### Data & git semantics (git-core-engineer) — extends `packages/git-core`

- FR-139: **Image-eligibility is extension-only**, case-insensitive, against a fixed list: `.png`,
  `.ico`, `.jpg`, `.jpeg`, `.gif`, `.bmp`, `.svg`. This check is independent of
  `FileDiffResult.status` — an `.svg` (which git usually treats as text, not binary, so
  `getFileDiff` would normally return `status: "ok"` with hunks) is still image-eligible and takes
  the image-preview path instead of a text hunk diff. A binary file whose extension isn't on this
  list (`.zip`, `.pdf`, `.psd`, `.webp`, ...) is unaffected by this spec and keeps today's generic
  binary message. For a rename, either side's extension qualifying is enough (e.g. `.png` renamed
  to `.jpg` is still image-eligible). No content-sniffing/magic-byte detection — a misnamed file
  (a PNG saved as `.txt`) is not treated as an image, the same trade-off extension-based detection
  always makes; not a goal to close (see Non-goals).
- FR-140: New function reading raw blob bytes for both sides of a change, reusing the exact same
  `DiffSource` union `getFileDiff` (`packages/git-core/src/diff.ts`) already accepts —
  `unstaged`/`staged`/`untracked`/`commit`, no new source vocabulary. For each side that exists
  (working tree, index, or a commit's tree object, matching `getFileDiff`'s own base-selection
  logic — absent entirely for an added/untracked file's "old" side or a deleted file's "new"
  side), read the raw bytes via one `git cat-file` call (or a filesystem read for a working-tree
  side, mirroring `statWorkdirFileSize`'s existing pattern) and base64-encode them. Returns:
  ```ts
  interface ImageBlob { base64: string; byteSize: number; mimeType: string; }
  type ImageDiffResult =
    | { status: "ok"; old: ImageBlob | null; new: ImageBlob | null }
    | { status: "too-large"; side: "old" | "new" | "both" };
  ```
  `mimeType` is derived from the qualifying extension (`image/png`, `image/x-icon`,
  `image/jpeg`, `image/gif`, `image/bmp`, `image/svg+xml`). `old`/`new` are never both `null` for
  a valid change (at least one side always exists). Exact module placement
  (`packages/git-core/src/imageDiff.ts` vs. extending `diff.ts`) is git-core-engineer's call.
- FR-141: **Separate size guard from FR-22** — FR-22's guard doesn't apply here today anyway
  (`getFileDiff` returns `status: "binary"` for a binary file *before* its own file-size check
  ever runs, per `diff.ts`'s early return). Add a new, non-configurable default cap — **25MB per
  side** — checked via the same size read (`lstat`/`cat-file -s`) `getNewSideSizeBytes` already
  performs, before any byte content is read or base64-encoded. Either side over the cap returns
  `status: "too-large"` (naming which side) instead of materializing that side's bytes — this
  guards renderer memory, since a base64 data URI is ~33% larger than the raw bytes and this
  payload crosses the IPC boundary and lands in a DOM `<img src>`.
- FR-142: Repository-level convenience wrappers mirroring the existing FR-20 methods 1:1:
  `getUnstagedImageDiff(path)`, `getStagedImageDiff(path)`, `getUntrackedImageDiff(path)`,
  `getCommitImageDiff(commit, file)` — same signatures as their `*FileDiff` counterparts, each
  just plumbing to FR-140 with the matching `DiffSource`. Same bare-repo `null`/guard convention
  the existing FR-20 methods already use — no new edge-case handling invented here.
- FR-143: No network call anywhere in this function; identical behavior regardless of remote host
  (GitHub/GitLab/Bitbucket/self-hosted) or absence of one — every byte comes from git's own object
  store or the local working tree, never fetched from anywhere.

### Rendering & interaction (ui-graphics) — `packages/desktop`

- FR-144: `DiffView` (or its caller) checks FR-139's image-eligibility on the selected file's
  extension(s) before falling into the existing binary/too-large/ok branching. When eligible, it
  calls the matching FR-142 IPC method (four new channels, `getUnstagedImageDiff`/
  `getStagedImageDiff`/`getUntrackedImageDiff`/`getCommitImageDiff`, added to `IPC_CHANNELS`
  and `preload.ts`'s `GitHydraApi` exactly the way the four existing `*FileDiff` channels already
  are — one narrow typed method each, no generic passthrough, per `preload.ts`'s existing security
  comment) instead of the text-diff loader, and renders:
  - **Added** (new side only): a single rendered image, labeled "Added".
  - **Deleted** (old side only): a single rendered image, labeled "Deleted".
  - **Modified or renamed with both sides present**: both images side by side, labeled "Before" /
    "After" — static side-by-side only, no slider/toggle (see Non-goals).
  - Each image is an actual `<img>` element via a `data:` URI built from `mimeType` + `base64` —
    not just a filename/size label; that visual is the entire point of this feature.
  - A rename's existing "oldPath -> path" heading (`DiffView`'s existing `fileLabel` prop) is left
    unchanged and needs no new code — it already communicates the old/new path pairing.
- FR-145: Each image shows a caption with byte size, reusing `DiffView`'s existing `formatBytes`
  helper. Images are visually capped (max-width/max-height within the diff pane, CSS only) so a
  large image can't blow out the layout — a display constraint only, never a re-encode/resize of
  the underlying bytes reaching the renderer.
- FR-146: An FR-141 `"too-large"` result reuses `DiffView`'s existing "Diff too large to display
  inline" text/pattern — no new visual state is designed for this.
- FR-147: An IPC/load failure for the image call reuses `DiffView`'s existing generic
  "Could not load diff: ..." error state — no new error UI.

### Edge cases & constraints

An image-eligible file that's also empty (0 bytes) still renders — an `<img>` with a 0-byte data
URI simply fails to decode visually the same way any other tool would show a broken/empty image;
no special-cased message required. A `.svg` containing malformed/hostile markup is rendered by the
browser exactly as an `<img src="data:...">` (not injected as inline markup/DOM), so it cannot
execute script the way inline SVG or an `<iframe>` could — this is a property of using `<img>`
rather than `dangerouslySetInnerHTML`, not a new sanitization step to build.

## Non-goals (v1)

- **Before/after slider or blend/toggle control.** Static side-by-side only for v1 — a real
  GitKraken-style affordance, but a separate, larger interaction surface than this spec needs;
  fast-follow candidate if requested.
- **Pixel-level diffing / highlighting changed regions of the image.** Out of scope entirely —
  this is a visual preview, not an image-diff algorithm.
- **Zoom/pan on the preview images.** Browser-native image sizing only.
- **Image formats beyond the fixed six extensions** (`.webp`, `.tiff`, `.avif`, `.psd`, ...) — a
  deliberately small, named list per the task; expanding it is a fast-follow, not silently rolled
  in now.
- **Content-sniffing/magic-byte-based image detection.** Extension-only, per FR-139 — a mismatch
  between extension and actual content is out of scope, same trade-off as today's extension-driven
  syntax highlighting elsewhere in the app (if any).
- **Any change to the existing text-diff path for non-image binary files.** `.zip`, `.pdf`, and
  everything else outside the FR-139 list keep today's unchanged "Binary file" message.
- **Editing/annotating images from within GitHydra.** View-only.
- **Any network call or telemetry.** None — every image byte is local, per product principles.

## Acceptance criteria

1. Selecting a modified `.png` file (in ChangesPanel or DetailPanel) shows the old and new images
   side by side as real rendered `<img>` content — not the generic binary message — each labeled
   Before/After with its byte size shown.
2. Selecting a newly added (untracked, or staged-add) `.jpg` shows only the new image, labeled
   "Added"; no old-image slot is rendered.
3. Selecting a deleted `.gif` (staged, unstaged, or in a historical commit) shows only the old
   image, labeled "Deleted".
4. Selecting a renamed `.ico` file with modified content in DetailPanel shows before/after images
   correctly sourced from the old path (before) and new path (after) respectively.
5. Selecting a `.svg` file renders it as an image preview, not as a text hunk diff, even though
   git itself would treat it as a non-binary text file.
6. Selecting a binary file with an extension outside the FR-139 list (e.g. `.zip`) still shows
   today's unchanged "Binary file — content not shown." message.
7. An image file whose old or new side exceeds 25MB shows the existing "too large to display"
   state, not a hang or an out-of-memory renderer crash.
8. Zero outbound network requests occur while previewing image diffs, verified on repos configured
   against GitHub, GitLab, Bitbucket, a self-hosted remote, and a purely local repo with no remote.
9. Behavior is identical whether the image change is reached via ChangesPanel (working-directory)
   or DetailPanel (a historical commit) — same rendering, same labels, same size guard.
10. A bare repository (or any other condition where the existing FR-20 methods already return
    `null`/refuse) behaves the same way for the new FR-142 methods — no new crash or dead-end
    introduced by this spec.

## References

- `specs/stage-unstage-diff.md` FR-20/FR-21/FR-22 — the diff-content/binary/too-large contract
  this spec extends, and the size-guard precedent FR-141 deliberately diverges from (with reasons
  stated).
- `packages/git-core/src/diff.ts` (`DiffSource`, `getFileDiff`, `getNewSideSizeBytes`,
  `statWorkdirFileSize`) — the exact source-kind union and size-read pattern FR-140/FR-141 reuse.
- `packages/desktop/src/components/DiffView/DiffView.tsx` — existing binary/too-large/ok/error
  rendering branches FR-144/FR-146/FR-147 extend rather than replace.
- `packages/desktop/electron/preload.ts` — the "one narrow typed method per operation, never a
  generic passthrough" security convention FR-144's four new IPC channels follow exactly.
