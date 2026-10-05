// SPDX-License-Identifier: GPL-3.0-or-later
import { useCallback, useEffect, useRef, useState } from "react";
import type { IgnoreReport, IgnoreScope, IgnoreTarget } from "@githydra/git-core";
import type { GitHydraApi } from "../../shared/ipcContract";
import { unwrap } from "./gitHydraClient";
import type { FileRow } from "../lib/fileSelection";
import { readLastIgnoreTarget, writeLastIgnoreTarget } from "../lib/ignorePrefs";
import { summarizeIgnoreReport, type IgnoreNotice } from "../lib/ignoreMessages";

/**
 * specs/ignore-and-multiselect.md FR-494..FR-502 (D2, D3, D9): the Ignore flow after a scope was picked. Step "target" is the
 * "Add to" popover; step "tracked" is the Ignore only / Ignore and Stop Tracking confirmation, shown only when a selected
 * file is tracked. Every step reads a git-core preview (`planIgnore`), so the wording and counts come from git, not guesses.
 */
export type IgnorePreview =
  | { status: "loading" }
  | { status: "ready"; report: IgnoreReport }
  | { status: "error"; message: string };

export interface PendingIgnore {
  paths: string[];
  scope: IgnoreScope;
  target: IgnoreTarget;
  step: "target" | "tracked";
  preview: IgnorePreview;
  running: boolean;
  error: string | null;
}

export interface UseIgnoreFlowResult {
  pending: PendingIgnore | null;
  begin: (rows: FileRow[], scope: IgnoreScope) => void;
  setTarget: (target: IgnoreTarget) => void;
  /** Step "target" to "tracked" when a selected file is tracked, else applies directly. */
  next: () => void;
  apply: (stopTracking: boolean) => void;
  cancel: () => void;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Rows that will actually be written or are tracked and not refused, from a preview. */
export function trackedRowCount(report: IgnoreReport): number {
  return report.rows.filter((r) => r.tracked && r.outcome !== "refused").length;
}

export function writableRowCount(report: IgnoreReport): number {
  return report.rows.filter((r) => r.outcome === "will-write").length;
}

export function useIgnoreFlow(options: {
  api: GitHydraApi;
  repoKey: string | null;
  /** Called after any write attempt (even a failed one may have changed files) so the list is re-read. */
  onChanged: () => void;
  onResult: (notice: IgnoreNotice) => void;
}): UseIgnoreFlowResult {
  const { api, repoKey, onChanged, onResult } = options;
  const [pending, setPending] = useState<PendingIgnore | null>(null);
  const seqRef = useRef(0);
  const inFlightRef = useRef(false);
  const pendingRef = useRef<PendingIgnore | null>(null);
  pendingRef.current = pending;

  const begin = useCallback(
    (rows: FileRow[], scope: IgnoreScope) => {
      if (inFlightRef.current || rows.length === 0) return;
      seqRef.current += 1;
      setPending({
        paths: rows.map((r) => r.path),
        scope,
        target: readLastIgnoreTarget(repoKey),
        step: "target",
        preview: { status: "loading" },
        running: false,
        error: null,
      });
    },
    [repoKey],
  );

  // The preview follows the open dialog's choices; the sequence number drops answers to superseded questions.
  const open = pending !== null;
  const paths = pending?.paths;
  const scope = pending?.scope;
  const target = pending?.target;
  const step = pending?.step;
  useEffect(() => {
    if (!open || !paths || !scope || !target || !step) return;
    const seq = ++seqRef.current;
    setPending((cur) => (cur ? { ...cur, preview: { status: "loading" } } : cur));
    void (async () => {
      try {
        const report = unwrap(await api.planIgnore({ paths, scope, target, stopTracking: step === "tracked" }));
        if (seq === seqRef.current) setPending((cur) => (cur ? { ...cur, preview: { status: "ready", report } } : cur));
      } catch (err) {
        if (seq === seqRef.current) setPending((cur) => (cur ? { ...cur, preview: { status: "error", message: messageOf(err) } } : cur));
      }
    })();
  }, [api, open, paths, scope, target, step]);

  const setTarget = useCallback(
    (t: IgnoreTarget) => {
      writeLastIgnoreTarget(repoKey, t);
      setPending((cur) => (cur && !cur.running ? { ...cur, target: t, error: null } : cur));
    },
    [repoKey],
  );

  const cancel = useCallback(() => {
    if (inFlightRef.current) return;
    seqRef.current += 1;
    setPending(null);
  }, []);

  const apply = useCallback(
    (stopTracking: boolean) => {
      const p = pendingRef.current;
      if (!p || p.running || inFlightRef.current) return;
      inFlightRef.current = true;
      const seq = ++seqRef.current;
      setPending({ ...p, running: true, error: null });
      void (async () => {
        const request = { paths: p.paths, scope: p.scope, target: p.target };
        try {
          const report = unwrap(await (stopTracking ? api.ignoreAndStopTracking(request) : api.ignorePaths(request)));
          if (seq === seqRef.current) setPending(null);
          onResult(summarizeIgnoreReport(report));
        } catch (err) {
          if (seq === seqRef.current) setPending((cur) => (cur ? { ...cur, running: false, error: messageOf(err) } : cur));
        } finally {
          inFlightRef.current = false;
          onChanged();
        }
      })();
    },
    [api, onChanged, onResult],
  );

  const next = useCallback(() => {
    const p = pendingRef.current;
    if (!p || p.running || p.preview.status !== "ready") return;
    if (trackedRowCount(p.preview.report) > 0) setPending({ ...p, step: "tracked", error: null });
    else apply(false);
  }, [apply]);

  return { pending, begin, setTarget, next, apply, cancel };
}
