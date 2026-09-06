// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Deliberately NOT imported from `@githydra/git-core`'s `isImageEligiblePath` (confirmed by a real
 * launched-app crash, not just a lint rule): that module's top-level `import * as path from
 * "node:path"` gets pulled into this renderer's Vite bundle the instant anything runtime (not
 * type-only) is imported from it. Electron's sandboxed renderer has no Node built-ins, so Vite
 * silently externalizes `node:path` to a stub object — `path.extname` becomes `undefined`,
 * crashing the whole renderer (`a.extname is not a function`) the moment a changed file is
 * selected. The renderer must only ever reach git-core through the IPC bridge (preload.ts), never
 * via a direct import — this fixed, tiny allowlist is duplicated here (kept in sync with
 * `packages/git-core/src/imageDiff.ts`'s `IMAGE_EXTENSION_MIME_TYPES` by hand; both are FR-139's
 * same fixed list and change together) rather than sharing a runtime import across that boundary.
 */
const IMAGE_EXTENSIONS = new Set([".png", ".ico", ".jpg", ".jpeg", ".gif", ".bmp", ".svg"]);

/**
 * A pure-JS reimplementation of Node's `path.extname()` semantics (security-reviewer finding:
 * a naive `.endsWith(ext)` check disagreed with git-core's `path.extname()`-based check for a
 * file literally named `.png` — `path.extname` treats a leading-dot-only basename as a dotfile
 * with NO extension, same as `.gitignore`, so `path.extname(".png") === ""`). Matching this
 * exactly means both sides of the renderer/git-core boundary agree on every case, including this
 * one, without giving the renderer a reason to import the real `node:path` (see this file's other
 * doc comment for why that's unsafe here).
 */
function extname(filePath: string): string {
  const base = filePath.split(/[\\/]/).pop() ?? "";
  const dotIndex = base.lastIndexOf(".");
  // No dot at all, or the only dot is the leading character of a dotfile (`.png`, `.gitignore`) —
  // both cases have no extension per Node's own `path.extname()` behavior.
  return dotIndex <= 0 ? "" : base.slice(dotIndex);
}

function hasImageExtension(filePath: string): boolean {
  return IMAGE_EXTENSIONS.has(extname(filePath).toLowerCase());
}

/**
 * specs/image-diff-preview.md FR-139: a changed-file's path pair is image-eligible when EITHER
 * side's extension qualifies — for a rename, either the old or the new path qualifying is enough
 * (e.g. a `.png` renamed to `.jpg` is still image-eligible), matching `imageDiff.ts`'s own
 * eligibility check on the git-core side. Callers pass `oldPath` whenever it's known (a
 * rename/copy); omitted for every other change, where the single `path` check is the whole story.
 */
export function isImageEligibleChange(path: string, oldPath?: string | null): boolean {
  return hasImageExtension(path) || (oldPath ? hasImageExtension(oldPath) : false);
}
