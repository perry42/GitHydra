import type { RefDecoration, RefInfo } from "@githydra/git-core";

/**
 * specs/graph-head-indicator-and-refresh-alerting.md Addendum 2, Problem 1a.
 *
 * Mirrors `packages/git-core/src/refs.ts`'s `indexRefsBySha()`/`headDecoration()` and
 * `commitLog.ts`'s `enrich()` — the pairing that decides which `RefDecoration[]` gets baked into
 * a `CommitInfo.refs` when a row is first loaded. The renderer can't import that runtime code
 * directly (only `import type` from `@githydra/git-core` is used anywhere in this package —
 * git-core's module graph shells out to `git` via `child_process`, which has no business being
 * pulled into the renderer bundle; see CLAUDE.md's "never shell out to git directly from
 * packages/desktop" boundary), so this is a small, intentionally duplicated pure
 * re-implementation, not a shortcut around it. Used only to re-decorate rows that are already in
 * memory after a refresh — never to decorate a row for the first time (that stays git-core's job).
 */
export function indexRefsBySha(refs: readonly RefInfo[]): Map<string, RefDecoration[]> {
  const map = new Map<string, RefDecoration[]>();
  for (const ref of refs) {
    const decoration: RefDecoration = {
      name: ref.shortName,
      fullName: ref.fullName,
      type: ref.type,
      isAnnotatedTag: ref.isAnnotatedTag || undefined,
      isSymbolic: ref.isSymbolic || undefined,
    };
    const list = map.get(ref.targetCommitSha);
    if (list) list.push(decoration);
    else map.set(ref.targetCommitSha, [decoration]);
  }
  return map;
}

export function decorateRefsForSha(
  sha: string,
  refsBySha: ReadonlyMap<string, RefDecoration[]>,
  headSha: string | null,
): RefDecoration[] {
  const refs = [...(refsBySha.get(sha) ?? [])];
  if (headSha && sha === headSha) {
    refs.unshift({ name: "HEAD", fullName: null, type: "head" });
  }
  return refs;
}

function sameRefDecoration(a: RefDecoration, b: RefDecoration): boolean {
  return (
    a.name === b.name &&
    a.fullName === b.fullName &&
    a.type === b.type &&
    Boolean(a.isAnnotatedTag) === Boolean(b.isAnnotatedTag) &&
    Boolean(a.isSymbolic) === Boolean(b.isSymbolic)
  );
}

function sameRefs(a: readonly RefDecoration[], b: readonly RefDecoration[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (!sameRefDecoration(a[i]!, b[i]!)) return false;
  }
  return true;
}

/**
 * Re-decorates only the rows whose ref data actually changed against fresh `refs`/`headSha` —
 * a targeted correction of just the `commit.refs` field on already-in-memory rows, not a
 * re-fetch of commit objects and not a change to how rows are decorated on initial load (see this
 * module's doc comment). Returns the exact same array reference, and reuses every unaffected
 * row's object identity, when nothing actually changed — the common case on most refreshes,
 * where most rows' HEAD/branch/tag decorations didn't move.
 */
export function redecorateRows<T extends { commit: { sha: string; refs: RefDecoration[] } }>(
  rows: readonly T[],
  refs: readonly RefInfo[],
  headSha: string | null,
): T[] {
  const refsBySha = indexRefsBySha(refs);
  let changed = false;
  const next = rows.map((row) => {
    const nextRefs = decorateRefsForSha(row.commit.sha, refsBySha, headSha);
    if (sameRefs(row.commit.refs, nextRefs)) return row;
    changed = true;
    return { ...row, commit: { ...row.commit, refs: nextRefs } };
  });
  return changed ? next : (rows as T[]);
}
