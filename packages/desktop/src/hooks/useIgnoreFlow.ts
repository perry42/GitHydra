// SPDX-License-Identifier: GPL-3.0-or-later
import { useCallback, useEffect, useRef, useState } from "react";
import type { IgnoreReport, IgnoreScope, IgnoreTarget } from "@githydra/git-core";
import type { GitHydraApi } from "../../shared/ipcContract";
import { GitHydraIpcError, unwrap } from "./gitHydraClient";
import type { FileRow } from "../lib/fileSelection";
import { readLastIgnoreTarget, writeLastIgnoreTarget } from "../lib/ignorePrefs";
import { scopeOptions, summarizeIgnoreReport, type IgnoreNotice } from "../lib/ignoreMessages";

/**
 * specs/ignore-and-multiselect.md FR-494..FR-502 (D1, D2, D3, D9), reshaped into ONE anchored popover: scope, destination and
 * blast radius are decided on one surface. Every scope's rule text comes from a git-core `planIgnore` preview (read-only), so
 * wording and counts come from git, not guesses. A newer preview replaces an older one only when it arrives, so the popover
 * never flashes a "Checking..." state between choices.
 */
export type ScopePlan = { status: "ready"; report: IgnoreReport } | { status: "error"; message: string };

/** Where the popover opens: below `y`, or above `yAbove` when there is no room below. */
export interface PopoverAnchor {
  x: number;
  y: number;
  yAbove: number;
}

export interface PendingIgnore {
  paths: string[];
  /** Snapshot of the rows at open time: which scopes apply is decided from these, never from a later refresh. */
  rows: FileRow[];
  anchor: PopoverAnchor;
  scope: IgnoreScope;
  target: IgnoreTarget;
  /** Latest preview per scope, tagged with the (target, refreshKey) it was read for. */
  plans: Partial<Record<IgnoreScope, { key: string; plan: ScopePlan }>>;
  running: boolean;
  error: string | null;
  /** Bumped to re-read the previews (e.g. after IGNORE_PLAN_CHANGED) without changing any choice. */
  refreshKey: number;
}

export const PLAN_CHANGED_MESSAGE =
  "The files to stop tracking changed since you previewed them. Review the updated list below and try again.";

const ALL_SCOPES: IgnoreScope[] = ["name", "extension", "directory"];
/** Above this many paths only the chosen scope is previewed: three git reads of hundreds of paths per keystroke is not cheap. */
const PREVIEW_ALL_SCOPES_UP_TO = 25;

export interface UseIgnoreFlowResult {
  pending: PendingIgnore | null;
  begin: (rows: FileRow[], anchor: PopoverAnchor) => void;
  setScope: (scope: IgnoreScope) => void;
  setTarget: (target: IgnoreTarget) => void;
  apply: (stopTracking: boolean) => void;
  cancel: () => void;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export const planKey = (p: Pick<PendingIgnore, "target" | "refreshKey">): string => `${p.target}|${p.refreshKey}`;

/** The chosen scope's preview, and whether it is still the one read for the current target (false while a newer one is on its way). */
export function currentPlan(p: PendingIgnore, scope: IgnoreScope = p.scope): { plan: ScopePlan | null; fresh: boolean } {
  const entry = p.plans[scope];
  return { plan: entry?.plan ?? null, fresh: entry?.key === planKey(p) };
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
    (allRows: FileRow[], anchor: PopoverAnchor) => {
      // A partly staged file is two rows but one path (specs/hunk-line-staging.md FR-482).
      const seenPaths = new Set<string>();
      const rows = allRows.filter((r) => !seenPaths.has(r.path) && !!seenPaths.add(r.path));
      if (inFlightRef.current || rows.length === 0) return;
      seqRef.current += 1;
      setPending({
        paths: rows.map((r) => r.path),
        rows,
        anchor,
        scope: "name",
        target: readLastIgnoreTarget(repoKey),
        plans: {},
        running: false,
        error: null,
        refreshKey: 0,
      });
    },
    [repoKey],
  );

  const open = pending !== null;
  const paths = pending?.paths;
  const target = pending?.target;
  const refreshKey = pending?.refreshKey;
  const many = (paths?.length ?? 0) > PREVIEW_ALL_SCOPES_UP_TO;
  // Only a large selection re-plans on a scope change; otherwise all scopes are already in flight.
  const scopeDep = many ? pending?.scope : null;
  useEffect(() => {
    const cur = pendingRef.current;
    if (!cur || !paths || !target || refreshKey === undefined) return;
    const key = `${target}|${refreshKey}`;
    const applicable = new Set(scopeOptions(cur.rows).filter((o) => o.disabledReason === null).map((o) => o.scope));
    const wanted = (many ? [cur.scope] : ALL_SCOPES).filter((s) => applicable.has(s) && cur.plans[s]?.key !== key);
    if (wanted.length === 0) return;
    const seq = ++seqRef.current;
    void (async () => {
      const settled = await Promise.all(
        wanted.map(async (s): Promise<[IgnoreScope, ScopePlan]> => {
          try {
            // stopTracking is always planned: the popover decides tracked or not from the report, in one read.
            return [s, { status: "ready", report: unwrap(await api.planIgnore({ paths, scope: s, target, stopTracking: true })) }];
          } catch (err) {
            return [s, { status: "error", message: messageOf(err) }];
          }
        }),
      );
      if (seq !== seqRef.current) return;
      setPending((c) => {
        if (!c) return c;
        const plans = { ...c.plans };
        for (const [s, plan] of settled) plans[s] = { key, plan };
        return { ...c, plans };
      });
    })();
  }, [api, open, paths, target, refreshKey, scopeDep, many]);

  const setScope = useCallback((s: IgnoreScope) => {
    setPending((cur) => (cur && !cur.running ? { ...cur, scope: s, error: null } : cur));
  }, []);

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
      const { plan, fresh } = currentPlan(p);
      if (!fresh || plan?.status !== "ready") return;
      inFlightRef.current = true;
      const seq = ++seqRef.current;
      setPending({ ...p, running: true, error: null });
      void (async () => {
        // Security finding L2: send back exactly the untrack set the user was shown, so git-core refuses if it moved since.
        const previewed = plan.report.stopTracking?.paths;
        const request = {
          paths: p.paths,
          scope: p.scope,
          target: p.target,
          ...(stopTracking && previewed ? { expectedUntrackPaths: previewed } : {}),
        };
        try {
          const report = unwrap(await (stopTracking ? api.ignoreAndStopTracking(request) : api.ignorePaths(request)));
          if (seq === seqRef.current) setPending(null);
          onResult(summarizeIgnoreReport(report));
        } catch (err) {
          const planChanged =
            err instanceof GitHydraIpcError && (err.code === "IGNORE_PLAN_CHANGED" || err.errorName === "IgnorePlanChangedError");
          if (seq === seqRef.current) {
            setPending((cur) =>
              cur
                ? planChanged
                  ? { ...cur, running: false, error: PLAN_CHANGED_MESSAGE, refreshKey: cur.refreshKey + 1 }
                  : { ...cur, running: false, error: messageOf(err) }
                : cur,
            );
          }
        } finally {
          inFlightRef.current = false;
          onChanged();
        }
      })();
    },
    [api, onChanged, onResult],
  );

  return { pending, begin, setScope, setTarget, apply, cancel };
}
