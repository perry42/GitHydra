// SPDX-License-Identifier: GPL-3.0-or-later
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { decide, decideInitialTicks, type CopyCandidateRow, type CopyMemoryRecord } from "@githydra/git-core";
import type {
  GitHydraApi,
  WorktreeExistingCopyRequest,
  WorktreeExistingCopyResult,
  WorktreeExistingProgress,
  WorktreeExistingRow,
} from "../../shared/ipcContract";
import { LIST_FAILED, measureSelection, rowEnabled, rowNeedsExplicitCopy, rowWithheldFromPreTick, selectionReadout } from "../lib/worktreeCopyExisting";
import { applyCopyDecision, readCopyRecord } from "../lib/worktreeCopyMemory";
import { dropNestedRows } from "../lib/worktreeCopyRows";
import { unwrap } from "./gitHydraClient";

/** FR-651: "on failure or over 5 s". */
export const COPY_INTO_LIST_TIMEOUT_MS = 5000;
/** FR-657: nothing about progress is shown before this mark; a faster copy goes straight to the banner. */
export const COPY_INTO_PROGRESS_AFTER_MS = 2000;
/** Shown for a copy that failed in a way main did not type (never a raw error, FR-657). */
export const COPY_UNFINISHED = "The copy did not finish. Check the worktree, then try again.";

export type CopyIntoPhase = "checking" | "ready" | "failed" | "copying" | "refused";

export interface CopyIntoRowView {
  row: WorktreeExistingRow;
  inInclude: boolean;
  remembered: boolean;
}

export interface CopyIntoListingMeta {
  sourceName: string;
  destName: string;
  destPath: string;
}

export interface UseCopyIntoExistingOptions {
  api: GitHydraApi;
  destId: string | null;
  /** The controller runs the redeem and puts the banner up, so both outlive this dialog (a tab switch unmounts it mid-copy). */
  runCopy: (request: WorktreeExistingCopyRequest) => Promise<WorktreeExistingCopyResult>;
  /** The copy ran (any result but a typed refusal): close the dialog. */
  onDone: () => void;
}

const asCandidate = (r: WorktreeExistingRow): CopyCandidateRow => ({
  path: r.path,
  isDirectory: r.isDirectory,
  fileCount: r.fileCount,
  bytes: r.bytes,
  // Disabled rows are never ticked and never forgotten (FR-654): the pure functions only need to know they are not tickable.
  disabledReason: r.disabledReason === null ? null : "name-not-allowed",
  secret: r.secret,
  runsCode: r.runsCode,
});

/** FR-654: a cancelled or limited copy saves only if it wrote something; a copy where every file was skipped by main still counts. */
export function copyCountsAsDecision(result: Exclude<WorktreeExistingCopyResult, { status: "refused" }>): boolean {
  return result.status === "done" || result.copied > 0;
}

/**
 * specs/worktree-copy-ignored.md FR-651..654, 657: the dialog's listing, ticks, memory and copy run. The list is advice; main holds
 * the manifest and re-checks everything at copy time (FR-653). Memory is the same per-repo record the Create dialog uses.
 */
export function useCopyIntoExisting({ api, destId, runCopy, onDone }: UseCopyIntoExistingOptions) {
  const [attempt, setAttempt] = useState(0);
  const [phase, setPhase] = useState<CopyIntoPhase>("checking");
  const [failMessage, setFailMessage] = useState(LIST_FAILED);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [meta, setMeta] = useState<CopyIntoListingMeta | null>(null);
  const [token, setToken] = useState("");
  const [views, setViews] = useState<CopyIntoRowView[]>([]);
  const [ticked, setTicked] = useState<ReadonlySet<string>>(new Set());
  const [progress, setProgress] = useState<WorktreeExistingProgress | null>(null);
  const [progressShown, setProgressShown] = useState(false);
  const loaded = useRef<{ repoKey: string | null; record: CopyMemoryRecord | null; initial: string[] } | null>(null);
  const apiRef = useRef(api);
  apiRef.current = api;
  const runCopyRef = useRef(runCopy);
  runCopyRef.current = runCopy;
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;

  useEffect(() => {
    let live = true;
    setPhase("checking");
    setRefusal(null);
    setFailMessage(LIST_FAILED);
    const timer = setTimeout(() => {
      if (!live) return;
      live = false;
      setPhase("failed");
    }, COPY_INTO_LIST_TIMEOUT_MS);
    void (async () => {
      let listing;
      let key: string | null = null;
      try {
        listing = unwrap(await apiRef.current.listIgnoredForExisting({ destId }));
      } catch {
        listing = null;
      }
      try {
        key = unwrap(await apiRef.current.getWorktreeRepoKey());
      } catch {
        key = null;
      }
      if (!live) return;
      live = false;
      clearTimeout(timer);
      if (listing === null || listing.status === "failed") {
        // A listing superseded by a newer one is not a failure the user should see.
        if (listing !== null && listing.reason === "cancelled") return void setPhase("checking");
        setFailMessage(listing !== null ? listing.message : LIST_FAILED);
        setPhase("failed");
        return;
      }
      const record = readCopyRecord(key);
      const rows = dropNestedRows(listing.rows);
      const includeOk = listing.include.status === "ok";
      const includeSet = new Set(includeOk ? listing.include.matchedRows : []);
      const remembered = new Set(record?.paths ?? []);
      const candidates = rows.map(asCandidate);
      const initial = decideInitialTicks({ candidates, record, includeMatches: includeOk ? listing.include.matchedRows : [] });
      const byPath = new Map(rows.map((r) => [r.path, r]));
      // FR-654 (M2): enabled rows only, and never a run-code row or a secret row this destination does not ignore.
      const start = initial.ticked.filter((p) => {
        const r = byPath.get(p);
        return r !== undefined && rowEnabled(r) && !rowWithheldFromPreTick(r);
      });
      const startSet = new Set(start);
      const rank = (r: WorktreeExistingRow): number => (startSet.has(r.path) ? 0 : includeSet.has(r.path) ? 1 : 2);
      // Order is fixed at load so rows do not jump while ticking: ticked, then `.worktreeinclude`, then the rest.
      const ordered = rows
        .map((row, i) => ({ row, i }))
        .sort((a, b) => rank(a.row) - rank(b.row) || a.i - b.i)
        .map(({ row }) => ({ row, inInclude: includeSet.has(row.path), remembered: remembered.has(row.path) }));
      loaded.current = { repoKey: key, record, initial: start };
      setMeta({ sourceName: listing.source.name, destName: listing.destination.name, destPath: listing.destination.path });
      setToken(listing.token);
      setViews(ordered);
      setTicked(new Set(ordered.filter((v) => startSet.has(v.row.path)).map((v) => v.row.id)));
      setPhase("ready");
    })();
    return () => {
      live = false;
      clearTimeout(timer);
      // FR-653: the token dies with the dialog, or with the attempt it belonged to.
      try {
        void Promise.resolve(apiRef.current.releaseIgnoredForExisting()).catch(() => undefined);
      } catch {
        /* nothing to release */
      }
    };
  }, [attempt, destId]);

  const rows = useMemo(() => views.map((v) => v.row), [views]);
  const selection = useMemo(() => measureSelection(rows, ticked), [rows, ticked]);
  const tickedRows = useMemo(() => views.filter((v) => ticked.has(v.row.id) && rowEnabled(v.row)).map((v) => v.row), [views, ticked]);
  const anyTicked = tickedRows.length > 0;
  const needsExplicitCopy = tickedRows.some(rowNeedsExplicitCopy);

  const toggleRow = useCallback((id: string) => {
    setTicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);
  const selectNone = useCallback(() => setTicked(new Set()), []);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  const copying = phase === "copying";
  const canCopy = phase === "ready" && anyTicked && !selection.overLimit && token !== "";

  // FR-657: the readout and bar appear at the 2 s mark, never before.
  useEffect(() => {
    if (!copying) {
      setProgressShown(false);
      setProgress(null);
      return;
    }
    const timer = setTimeout(() => setProgressShown(true), COPY_INTO_PROGRESS_AFTER_MS);
    const unsubscribe = apiRef.current.onIgnoredCopyIntoExistingProgress?.((p) => setProgress(p));
    return () => {
      clearTimeout(timer);
      unsubscribe?.();
    };
  }, [copying]);

  const startCopy = useCallback(async () => {
    if (!canCopy) return;
    const snapshot = { token, rowIds: tickedRows.map((r) => r.id) };
    const memory = loaded.current;
    const candidates = views.filter((v) => rowEnabled(v.row));
    const finalTicked = tickedRows.map((r) => r.path);
    setRefusal(null);
    setPhase("copying");
    let result: WorktreeExistingCopyResult;
    try {
      result = await runCopyRef.current(snapshot);
    } catch {
      setRefusal(COPY_UNFINISHED);
      setPhase("refused");
      return;
    }
    if (result.status === "refused") {
      setRefusal(result.message);
      setPhase("refused");
      return;
    }
    // FR-654: saved only once the copy phase started and wrote or skipped something; disabled rows keep their prior membership.
    if (memory && copyCountsAsDecision(result)) {
      const remembered = new Set(memory.record?.paths ?? []);
      const tickedSet = new Set(finalTicked);
      // A remembered row we withheld from the pre-tick and the user left alone must stay in the record untouched.
      const decidable = candidates.filter((v) => !(rowWithheldFromPreTick(v.row) && remembered.has(v.row.path) && !tickedSet.has(v.row.path)));
      applyCopyDecision(memory.repoKey, decide(memory.initial, finalTicked, true, decidable.map((v) => asCandidate(v.row)), memory.record, true));
    }
    onDoneRef.current();
  }, [canCopy, token, tickedRows, views]);

  const cancelCopy = useCallback(() => {
    try {
      void Promise.resolve(apiRef.current.cancelIgnoredCopyIntoExisting()).catch(() => undefined);
    } catch {
      /* the copy ends on its own */
    }
  }, []);

  return {
    phase,
    failMessage,
    refusal,
    meta,
    views,
    zero: phase === "ready" && views.length === 0,
    ticked,
    anyTicked,
    needsExplicitCopy,
    selection,
    readout: selectionReadout(selection, anyTicked),
    canCopy,
    toggleRow,
    selectNone,
    retry,
    startCopy,
    cancelCopy,
    progress: progressShown ? (progress ?? { filesDone: 0, filesTotal: selection.files, bytesDone: 0 }) : null,
  };
}

export type CopyIntoModel = ReturnType<typeof useCopyIntoExisting>;
