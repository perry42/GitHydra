// SPDX-License-Identifier: GPL-3.0-or-later
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  decide,
  decideInitialTicks,
  formatCopySize,
  secretTickedPaths,
  validateCopyPath,
  type CopyCandidateRow,
  copyLineText,
  type CopyLineState,
  type CopyLineText,
  type CopyMemoryRecord,
} from "@githydra/git-core";
import type { GitHydraApi, WorktreeCopyInclude, WorktreeCopyRequest, WorktreeCopyRow } from "../../shared/ipcContract";
import { applyCopyDecision, readCopyRecord } from "../lib/worktreeCopyMemory";
import { dropNestedRows } from "../lib/worktreeCopyRows";
import { visibleText } from "../lib/worktrees";
import { unwrap } from "./gitHydraClient";

/** FR-628: "Listing failed or over 5 s". */
export const COPY_LIST_TIMEOUT_MS = 5000;

export const DISABLED_TEXT: Record<NonNullable<WorktreeCopyRow["disabledReason"]>, string> = {
  "nested-repository": "separate repository, not copied",
  "symbolic-link": "symbolic link, not copied",
  "not-a-regular-file": "not a regular file, not copied",
  "name-not-allowed": "name not allowed",
  "too-many-files": "too many files to list",
};

export interface CopyRowView {
  row: WorktreeCopyRow;
  /** Null: can be ticked. */
  disabledText: string | null;
  inInclude: boolean;
  remembered: boolean;
}

interface Loaded {
  token: string;
  repoKey: string | null;
  record: CopyMemoryRecord | null;
  rows: CopyRowView[];
  include: WorktreeCopyInclude;
  initial: string[];
  source: "memory" | "worktreeinclude" | "none";
  secretsInInclude: string[];
}

export type CopyPhase = "checking" | "ready" | "failed" | "none";

const filesLabel = (n: number): string => (n === 1 ? "1 file" : `${n} files`);

/**
 * specs/worktree-copy-ignored.md FR-626..629: the Create dialog's view of the copy. The list, the tick set and the memory are
 * hints; main holds the manifest and re-checks everything at Create (FR-643). Tick state lives only here until Create.
 */
export function useCopyIgnored(api: GitHydraApi) {
  const [attempt, setAttempt] = useState(0);
  const [phase, setPhase] = useState<CopyPhase>("checking");
  const [noneKind, setNoneKind] = useState<"empty" | "bare">("empty");
  const [failReason, setFailReason] = useState<string | null>(null);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [ticked, setTicked] = useState<ReadonlySet<string>>(new Set());
  const [checkboxOn, setCheckboxOn] = useState(true);
  const apiRef = useRef(api);
  apiRef.current = api;

  useEffect(() => {
    let live = true;
    setPhase("checking");
    setFailReason(null);
    const timer = setTimeout(() => {
      if (!live) return;
      live = false;
      setPhase("failed");
    }, COPY_LIST_TIMEOUT_MS);
    void (async () => {
      let candidates;
      let key: string | null = null;
      try {
        candidates = unwrap(await apiRef.current.getWorktreeCopyCandidates());
      } catch {
        candidates = null;
      }
      try {
        key = unwrap(await apiRef.current.getWorktreeRepoKey());
      } catch {
        key = null;
      }
      if (!live) return;
      live = false;
      clearTimeout(timer);
      if (candidates === null || candidates.status === "failed") {
        // A listing that was superseded by a newer one is not a failure the user should see.
        setFailReason(candidates !== null ? candidates.reason : null);
        setPhase(candidates !== null && candidates.reason === "cancelled" ? "checking" : "failed");
        return;
      }
      if (candidates.bare || candidates.rows.length === 0) {
        setLoaded(null);
        setNoneKind(candidates.bare ? "bare" : "empty");
        setPhase("none");
        return;
      }
      const record = readCopyRecord(key);
      const allRows = dropNestedRows(candidates.rows);
      const rowsData: CopyCandidateRow[] = allRows;
      const includeOk = candidates.include.status === "ok";
      const initial = decideInitialTicks({ candidates: rowsData, record, includeMatches: includeOk ? candidates.include.matchedRows : [] });
      const includeSet = new Set(includeOk ? candidates.include.matchedRows : []);
      const remembered = new Set(record?.paths ?? []);
      const views: CopyRowView[] = allRows.map((row) => ({
        row,
        // Belt and braces: main already flags unsafe names, but the renderer never offers one to tick.
        disabledText: row.disabledReason ? DISABLED_TEXT[row.disabledReason] : validateCopyPath(row.path).ok ? null : DISABLED_TEXT["name-not-allowed"],
        inInclude: includeSet.has(row.path),
        remembered: remembered.has(row.path),
      }));
      const enabled = new Set(views.filter((v) => v.disabledText === null).map((v) => v.row.path));
      const start = initial.ticked.filter((p) => enabled.has(p));
      const startSet = new Set(start);
      // Stable order, fixed at load so rows do not jump while ticking: ticked, then `.worktreeinclude`, then the rest.
      const rank = (v: CopyRowView): number => (startSet.has(v.row.path) ? 0 : v.inInclude ? 1 : 2);
      const ordered = views.map((v, i) => ({ v, i })).sort((a, b) => rank(a.v) - rank(b.v) || a.i - b.i).map((x) => x.v);
      setLoaded({
        token: candidates.token,
        repoKey: key,
        record,
        rows: ordered,
        include: candidates.include,
        initial: start,
        source: start.length === 0 ? "none" : initial.source,
        secretsInInclude: initial.secretsInInclude,
      });
      setTicked(startSet);
      setPhase("ready");
    })();
    return () => {
      live = false;
      clearTimeout(timer);
      // FR-643: the token dies with the dialog (or with the attempt it belonged to).
      try {
        void Promise.resolve(apiRef.current.releaseWorktreeCopy()).catch(() => undefined);
      } catch {
        /* nothing to release */
      }
    };
  }, [attempt]);

  // An empty selection has no line checkbox: a stale "skipped this time" would make the next tick copy nothing.
  useEffect(() => {
    if (ticked.size === 0) setCheckboxOn(true);
  }, [ticked]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  const toggleRow = useCallback((id: string) => {
    setTicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);
  const selectNone = useCallback(() => setTicked(new Set()), []);

  const rows = loaded?.rows ?? [];
  const tickedRows = useMemo(() => rows.filter((v) => ticked.has(v.row.path)), [rows, ticked]);
  const edited = useMemo(() => {
    const initial = loaded?.initial ?? [];
    return initial.length !== ticked.size || initial.some((p) => !ticked.has(p));
  }, [loaded, ticked]);

  const totalBytes = tickedRows.reduce<number | null>((sum, v) => (sum === null || v.row.bytes === null ? null : sum + v.row.bytes), 0);
  // MED-2: directory rows count by what is inside them, not by their own name.
  const secretTicked = secretTickedPaths(rows.map((v) => v.row), [...ticked]).map(visibleText);
  const unticked = new Set(rows.filter((v) => !ticked.has(v.row.path)).map((v) => v.row.path));
  const secretsUnticked = (loaded?.secretsInInclude ?? []).filter((p) => unticked.has(p)).map(visibleText);

  /** The main line (FR-628). The wording "remembered" / "from .worktreeinclude" is dropped once the ticks were edited. */
  const lineState: CopyLineState = (() => {
    if (phase === "checking") return { kind: "checking" };
    if (phase === "failed") return { kind: "failed" };
    if (tickedRows.length === 0) return { kind: "none-ticked" };
    if (!checkboxOn) return { kind: "skipped-this-time", count: tickedRows.length };
    const names = tickedRows.map((v) => visibleText(v.row.path));
    if (!edited && loaded?.source === "worktreeinclude") return { kind: "from-include", count: tickedRows.length, bytes: totalBytes };
    return { kind: "from-memory", count: tickedRows.length, bytes: totalBytes, names };
  })();

  const line: CopyLineText = copyLineText(lineState);
  // `from-memory` is also how an edited selection reads; the muted note is true only while the ticks are the remembered ones.
  if (lineState.kind === "from-memory" && (edited || loaded?.source !== "memory")) delete line.note;

  const warnings: CopyLineText[] = [];
  if (phase === "ready" && checkboxOn && secretTicked.length > 0) warnings.push(copyLineText({ kind: "secret-ticked", names: secretTicked }));
  if (phase === "ready" && secretsUnticked.length > 0) warnings.push(copyLineText({ kind: "include-secrets-unticked", names: secretsUnticked }));

  const live =
    tickedRows.length === 0 ? "No files selected" : `${filesLabel(tickedRows.length)} selected${totalBytes === null ? "" : `, ${formatCopySize(totalBytes)}`}`;

  /** What Create sends: ids only (FR-643). Nothing when the line says "skipped this time", nothing ticked, or no listing. */
  const request = useCallback((): WorktreeCopyRequest | undefined => {
    if (phase !== "ready" || !loaded || loaded.token === "" || !checkboxOn || ticked.size === 0) return undefined;
    return { token: loaded.token, rowIds: [...ticked] };
  }, [phase, loaded, checkboxOn, ticked]);

  /** FR-629 save rule, called only after a successful add. */
  const rememberAfterAdd = useCallback(() => {
    if (phase !== "ready" || !loaded) return;
    const candidates: CopyCandidateRow[] = loaded.rows.map((v) => v.row);
    applyCopyDecision(loaded.repoKey, decide(loaded.initial, [...ticked], checkboxOn, candidates, loaded.record));
  }, [phase, loaded, ticked, checkboxOn]);

  return {
    phase,
    noneKind,
    failReason,
    rows,
    ticked,
    anyTicked: ticked.size > 0,
    checkboxOn,
    setCheckboxOn,
    toggleRow,
    selectNone,
    retry,
    lineKind: lineState.kind,
    line,
    warnings,
    live,
    include: loaded?.include ?? { status: "absent" as const, matchedRows: [], skipped: [] },
    request,
    rememberAfterAdd,
  };
}

export type CopyIgnoredModel = ReturnType<typeof useCopyIgnored>;
