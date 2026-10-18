// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * git can list both `config/` and `config/local.json` for the same file (every file of a not-ignored directory ignored by a
 * file-level rule). A path inside another listed directory row is never offered or counted a second time; git-core drops them too,
 * this is the renderer's own guard (specs/worktree-copy-ignored.md FR-626, FR-628).
 */
export function dropNestedRows<T extends { path: string }>(rows: readonly T[]): T[] {
  const dirs = new Set(rows.filter((r) => r.path.endsWith("/")).map((r) => r.path));
  const seen = new Set<string>();
  return rows.filter((r) => {
    if (seen.has(r.path)) return false;
    seen.add(r.path);
    const body = r.path.endsWith("/") ? r.path.slice(0, -1) : r.path;
    for (let i = body.indexOf("/"); i !== -1; i = body.indexOf("/", i + 1)) if (dirs.has(body.slice(0, i + 1))) return false;
    return true;
  });
}
