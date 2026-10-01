// SPDX-License-Identifier: GPL-3.0-or-later

/** Splits on the last "/" — git paths always use "/" regardless of platform. */
export function splitPath(path: string): { dir: string; name: string } {
  const i = path.lastIndexOf("/");
  return i < 0 ? { dir: "", name: path } : { dir: path.slice(0, i), name: path.slice(i + 1) };
}

/**
 * specs/changes-panel-layout.md FR-487: the file name first and always intact, then the directory
 * dimmed and truncated from the LEFT (so the part nearest the file survives). The directory span is
 * `direction: rtl` to move the ellipsis to the left edge; the inner `<bdi>` keeps the path itself
 * reading left-to-right so slashes do not hop to the wrong end.
 */
export function FilePath({ path, oldPath }: { path: string; oldPath?: string }) {
  const { dir, name } = splitPath(path);
  return (
    <span className="gh-changes-panel__file-path gh-mono" title={oldPath ? `${oldPath} → ${path}` : path}>
      <span className="gh-changes-panel__file-name">{name}</span>
      {dir && (
        <span className="gh-changes-panel__file-dir">
          <bdi>{dir}</bdi>
        </span>
      )}
      {oldPath && <span className="gh-visually-hidden"> (renamed from {oldPath})</span>}
    </span>
  );
}
