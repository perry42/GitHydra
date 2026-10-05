// SPDX-License-Identifier: GPL-3.0-or-later
import { useCallback, useRef, useState } from "react";
import type { BulkDiscardResult, BulkDiscardRow, BulkSkipped } from "@githydra/git-core";
import type { GitHydraApi } from "../../shared/ipcContract";
import { GitHydraIpcError, unwrap } from "./gitHydraClient";
import { DISCARD_TYPE_TO_CONFIRM_ABOVE, discardConfirmToken, toDiscardCandidate, type FileRow } from "../lib/fileSelection";

/**
 * specs/ignore-and-multiselect.md FR-508/FR-509 (D6, D7): the bulk discard confirmation. The dialog's rows and their
 * fingerprints are a snapshot taken when it opens; a live refresh never retargets it, and git-core refuses the whole batch
 * (StaleBatchError) if any file changed since. Nothing here ever discards by path alone.
 */
const STALE_PATHS_SHOWN = 20;

export type BulkDiscardMode = "selected" | "all";

export interface PendingBulkDiscard {
  mode: BulkDiscardMode;
  phase: "loading" | "ready" | "running" | "stale" | "error";
  /** Tracked rows (unstaged and partly staged: only the unstaged part goes, FR-31) with fingerprints. */
  tracked: BulkDiscardRow[];
  /** Untracked rows with fingerprints; only deleted when `includeUntracked` (D7), in both modes. */
  untracked: BulkDiscardRow[];
  /** Rows that cannot be discarded, with the reason (client-side ineligible + git-core fingerprint refusals). */
  skipped: BulkSkipped[];
  includeUntracked: boolean;
  typed: string;
  stalePaths: string[];
  /** Real size of the refused set; the paths above are only a bounded sample. */
  staleTotal: number;
  error: string | null;
}

export type BulkDiscardOutcome = { ok: true; result: BulkDiscardResult } | { ok: false; message: string };

export interface UseBulkDiscardResult {
  pending: PendingBulkDiscard | null;
  openSelected: (rows: FileRow[], extraSkipped?: BulkSkipped[]) => void;
  openAll: () => void;
  setIncludeUntracked: (value: boolean) => void;
  setTyped: (value: string) => void;
  /** Rows this confirmation will discard right now. */
  willDiscard: (p: PendingBulkDiscard) => number;
  needsTyping: (p: PendingBulkDiscard) => boolean;
  canConfirm: boolean;
  confirm: () => void;
  cancel: () => void;
}

export function bulkDiscardCount(p: PendingBulkDiscard): number {
  return p.tracked.length + (p.includeUntracked ? p.untracked.length : 0);
}

export function bulkDiscardNeedsTyping(p: PendingBulkDiscard): boolean {
  // FR-520: Discard all always asks for the count; a selection only above the threshold.
  return p.mode === "all" || bulkDiscardCount(p) > DISCARD_TYPE_TO_CONFIRM_ABOVE;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function useBulkDiscard(options: {
  api: GitHydraApi;
  onFinished: (outcome: BulkDiscardOutcome) => void;
}): UseBulkDiscardResult {
  const { api, onFinished } = options;
  const [pending, setPending] = useState<PendingBulkDiscard | null>(null);
  const seqRef = useRef(0);
  const inFlightRef = useRef(false);
  const pendingRef = useRef<PendingBulkDiscard | null>(null);
  pendingRef.current = pending;

  const open = useCallback((initial: PendingBulkDiscard, load: () => Promise<Partial<PendingBulkDiscard>>) => {
    const seq = ++seqRef.current;
    setPending(initial);
    void (async () => {
      try {
        const loaded = await load();
        if (seq !== seqRef.current) return;
        setPending((cur) => (cur ? { ...cur, ...loaded, phase: "ready" } : cur));
      } catch (err) {
        if (seq !== seqRef.current) return;
        setPending((cur) => (cur ? { ...cur, phase: "error", error: messageOf(err) } : cur));
      }
    })();
  }, []);

  const base = (mode: BulkDiscardMode, skipped: BulkSkipped[]): PendingBulkDiscard => ({
    mode,
    phase: "loading",
    tracked: [],
    untracked: [],
    skipped,
    includeUntracked: false,
    typed: "",
    stalePaths: [],
    staleTotal: 0,
    error: null,
  });

  const openSelected = useCallback(
    (rows: FileRow[], extraSkipped: BulkSkipped[] = []) => {
      if (inFlightRef.current) return;
      open(base("selected", extraSkipped), async () => {
        const fingerprints = unwrap(await api.getBulkDiscardFingerprints(rows.map(toDiscardCandidate)));
        const tracked: BulkDiscardRow[] = [];
        const untracked: BulkDiscardRow[] = [];
        const skipped: BulkSkipped[] = [...extraSkipped];
        for (const f of fingerprints) {
          if ("error" in f) skipped.push({ path: f.path, reason: f.error });
          else (f.section === "untracked" ? untracked : tracked).push(f);
        }
        // Only untracked rows were selected: the checkbox is the whole point of the dialog, so it starts ticked.
        return { tracked, untracked, skipped, includeUntracked: tracked.length === 0 && untracked.length > 0 };
      });
    },
    [api, open],
  );

  const openAll = useCallback(() => {
    if (inFlightRef.current) return;
    open(base("all", []), async () => {
      const plan = unwrap(await api.planDiscardAll());
      return { tracked: plan.tracked, untracked: plan.untracked, skipped: plan.skipped };
    });
  }, [api, open]);

  const cancel = useCallback(() => {
    if (inFlightRef.current) return;
    seqRef.current += 1;
    setPending(null);
  }, []);

  const confirm = useCallback(() => {
    const p = pendingRef.current;
    if (!p || p.phase !== "ready" || inFlightRef.current) return;
    if (bulkDiscardNeedsTyping(p) && p.typed.trim() !== discardConfirmToken(bulkDiscardCount(p))) return;
    const rows = [...p.tracked, ...(p.includeUntracked ? p.untracked : [])];
    if (rows.length === 0) return;
    inFlightRef.current = true;
    const seq = ++seqRef.current;
    setPending({ ...p, phase: "running" });
    void (async () => {
      try {
        const result = unwrap(await (p.mode === "all" ? api.discardAllChanges(rows, p.includeUntracked) : api.bulkDiscard(rows)));
        if (seq === seqRef.current) setPending(null);
        onFinished({ ok: true, result });
      } catch (err) {
        if (seq !== seqRef.current) return;
        // FR-508: a mismatch refuses the whole batch and changes nothing; the dialog stays so the user can read which paths.
        if (err instanceof GitHydraIpcError && err.errorName === "StaleBatchError") {
          // Display bound: never render an unbounded list, whatever the bridge sent.
          const all = Array.isArray(err.details?.paths) ? (err.details!.paths as unknown[]).filter((x): x is string => typeof x === "string") : [];
          const paths = all.slice(0, STALE_PATHS_SHOWN);
          const total = typeof err.details?.totalPaths === "number" ? Math.max(err.details.totalPaths, paths.length) : all.length;
          setPending((cur) => (cur ? { ...cur, phase: "stale", stalePaths: paths, staleTotal: total } : cur));
        } else {
          setPending((cur) => (cur ? { ...cur, phase: "error", error: messageOf(err) } : cur));
          onFinished({ ok: false, message: messageOf(err) });
        }
      } finally {
        inFlightRef.current = false;
      }
    })();
  }, [api, onFinished]);

  const setIncludeUntracked = useCallback((value: boolean) => {
    setPending((cur) => (cur && cur.phase === "ready" ? { ...cur, includeUntracked: value } : cur));
  }, []);
  const setTyped = useCallback((value: string) => {
    setPending((cur) => (cur && cur.phase === "ready" ? { ...cur, typed: value } : cur));
  }, []);

  const canConfirm =
    !!pending &&
    pending.phase === "ready" &&
    bulkDiscardCount(pending) > 0 &&
    (!bulkDiscardNeedsTyping(pending) || pending.typed.trim() === discardConfirmToken(bulkDiscardCount(pending)));

  return {
    pending,
    openSelected,
    openAll,
    setIncludeUntracked,
    setTyped,
    willDiscard: bulkDiscardCount,
    needsTyping: bulkDiscardNeedsTyping,
    canConfirm,
    confirm,
    cancel,
  };
}
